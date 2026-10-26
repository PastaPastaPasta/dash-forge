#!/usr/bin/env node
/**
 * Allow each exported page's own inline scripts, and no others, by hash. A page gets a second CSP
 * <meta>, first in its <head>, with only a `script-src`: the layout's sources without
 * `'unsafe-inline'`, plus a `'sha256-…'` source for every inline script in that page (Next's
 * bootstrap and RSC payload `self.__next_f.push(…)`, the prehydration script, next-themes' theme
 * script and, in the IPFS variant, the base script scripts/ipfs-postbuild.mjs adds). A browser
 * enforces every policy of a page, so a script must pass both: a script the host injects into the
 * HTML (Cloudflare does) is refused, and cannot run on the origin that keeps the signing-key vault.
 *
 * Why a second <meta> and not the hashes in the layout's own (app/layout.tsx): React renders that
 * one, and the RSC payload carries a copy of it inside the very scripts being hashed, so it cannot
 * hold their hashes. A layout <meta> that differs from its copy is taken for a foreign node when
 * the page hydrates, and React adds its own beside it. The added <meta> is outside React's tree;
 * hydration skips it like any node a host or extension adds to <head>.
 *
 * Run it after every step that edits the pages (ipfs-postbuild) and before build-manifest, so the
 * manifest covers the final bytes. A page fails the build if its layout CSP is not the expected
 * one, if it was already hashed, or if it cannot be read with certainty (an inline `<!--`, which
 * changes where a script ends; an inline event handler or a `javascript:` URL, which no hash can
 * allow). Deterministic (files in sorted order, hashes sorted), so the IPFS build stays
 * reproducible.
 *
 * Usage: node scripts/csp-hashes.mjs [out-dir]
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Where the hashed policy goes: before every script, so all of them are checked against it.
const HEAD_START = '<head><meta charSet="utf-8"/>'
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const CSP_META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"\/?>/g
// An event handler attribute or a `javascript:` URL, in markup outside the scripts.
const INLINE_HANDLER = /<[a-z][^>]*?\son[a-z]+\s*=/i
const JS_URL = /<[a-z][^>]*?\s(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/i

// React writes a `'` in an attribute as `&#x27;`.
const attr = (value) => value.replaceAll("'", '&#x27;')
const unattr = (value) => value.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&')

/** The CSP source that allows an inline script with this text (the parser turns CR LF into LF). */
export function scriptHash(text) {
  const normalized = text.replace(/\r\n?/g, '\n')
  return `'sha256-${createHash('sha256').update(normalized, 'utf8').digest('base64')}'`
}

/** The text of every inline script in a page, in order. Refuses a page it cannot split with certainty. */
export function inlineScripts(html, file = 'page') {
  const scripts = []
  for (const [, attrs, text] of html.matchAll(SCRIPT)) {
    if (/\ssrc\s*=/i.test(` ${attrs}`)) continue
    // `<!--` inside a script switches the parser to states where `</script>` may not end it.
    if (text.includes('<!--')) throw new Error(`${file}: an inline script contains "<!--"; its end cannot be found reliably`)
    scripts.push(text)
  }
  const markup = html.replace(SCRIPT, '')
  if (INLINE_HANDLER.test(markup)) throw new Error(`${file}: an inline event handler, which a script hash cannot allow`)
  if (JS_URL.test(markup)) throw new Error(`${file}: a javascript: URL, which a script hash cannot allow`)
  return scripts
}

/** The `script-src` sources of each CSP <meta> of a page, in document order ([] for one without). */
export function scriptPolicies(html) {
  return [...html.matchAll(CSP_META)].map(([, content]) => {
    const directive = unattr(content)
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src '))
    return directive === undefined ? [] : directive.split(/\s+/).slice(1)
  })
}

/** Whether a `script-src` allows an inline script with this text (a hash turns `'unsafe-inline'` off). */
function allows(sources, text) {
  const hashed = sources.some((s) => /^'(sha(256|384|512)-|nonce-|strict-dynamic')/.test(s))
  return hashed ? sources.includes(scriptHash(text)) : sources.includes("'unsafe-inline'")
}

/** The page with a hashed `script-src` policy added first in its <head>. */
export function hashPage(html, file = 'page') {
  const policies = scriptPolicies(html)
  if (policies.length !== 1) throw new Error(`${file}: expected the layout's one CSP <meta>, found ${policies.length} (rebuild the app first)`)
  const [layout] = policies
  if (!layout.includes("'unsafe-inline'")) throw new Error(`${file}: the layout's script-src has no 'unsafe-inline' for the hashes to replace`)
  if (!html.includes(HEAD_START)) throw new Error(`${file}: no ${HEAD_START} to put the policy after`)
  const hashes = [...new Set(inlineScripts(html, file).map(scriptHash))].sort()
  const sources = [...layout.filter((s) => s !== "'unsafe-inline'"), ...hashes]
  const meta = `<meta http-equiv="Content-Security-Policy" content="${attr(`script-src ${sources.join(' ')}`)}"/>`
  return html.replace(HEAD_START, () => `${HEAD_START}${meta}`)
}

/**
 * Why a page's CSP would refuse one of its own inline scripts, or allow any other one; null if
 * neither. The check the e2e suite and the unit tests run on a built page.
 */
export function cspProblem(html, file = 'page') {
  const policies = scriptPolicies(html)
  if (policies.length === 0 || policies.some((p) => p.length === 0)) return `${file}: a CSP <meta> without script-src`
  // A policy only governs what the parser reaches after it: the strict one must precede every inline script.
  const strict = policies.findIndex((p) => !allows(p, '/* a script the page did not ship */'))
  if (strict < 0) return `${file}: no policy refuses an inline script it does not list`
  const firstInline = html.search(/<script\b(?![^>]*\ssrc\s*=)[^>]*>/i)
  if (firstInline >= 0 && [...html.matchAll(CSP_META)][strict].index > firstInline) return `${file}: an inline script comes before the hashed CSP`
  const scripts = inlineScripts(html, file)
  const refused = scripts.filter((s) => !policies.every((p) => allows(p, s)))
  return refused.length === 0 ? null : `${file}: ${refused.length} inline script(s) refused, the first: ${refused[0].slice(0, 80)}`
}

/** Every `.html` file under `dir` outside `_next/`, sorted, relative to it. */
function pages(dir, rel = '') {
  return readdirSync(join(dir, rel))
    .sort()
    .flatMap((name) => {
      const path = rel ? `${rel}/${name}` : name
      if (statSync(join(dir, path)).isDirectory()) return path === '_next' ? [] : pages(dir, path)
      return path.endsWith('.html') ? [path] : []
    })
}

/** Hash every page of the export in `dir` in place; returns how many pages and distinct hashes. */
export function cspHashes(dir) {
  const all = new Set()
  const list = pages(dir)
  if (list.length === 0) throw new Error(`${dir}: no pages (build the app first)`)
  for (const rel of list) {
    const file = join(dir, rel)
    const html = hashPage(readFileSync(file, 'utf8'), rel)
    const problem = cspProblem(html, rel)
    if (problem !== null) throw new Error(problem)
    for (const s of scriptPolicies(html)[0]) if (s.startsWith("'sha256-")) all.add(s)
    writeFileSync(file, html)
  }
  return { pages: list.length, hashes: all.size }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'out'
  const { pages: n, hashes } = cspHashes(dir)
  process.stdout.write(`csp-hashes: ${n} pages, ${hashes} distinct inline script hashes in ${dir}\n`)
}

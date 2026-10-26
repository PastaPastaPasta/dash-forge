import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { cspHashes, cspProblem, hashPage, inlineScripts, scriptHash, scriptPolicies } from './csp-hashes.mjs'

const WEB = join(__dirname, '..')

// The shape of an exported page (trimmed from `out/explore/index.html`).
const csp = (scriptSrc: string) =>
  `<meta http-equiv="Content-Security-Policy" content="default-src &#x27;self&#x27;; script-src ${scriptSrc.replaceAll("'", '&#x27;')}; base-uri &#x27;self&#x27;"/>`
const LAYOUT = "'self' 'wasm-unsafe-eval' 'unsafe-inline'"
const page = (body = '', scriptSrc = LAYOUT) =>
  '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>' +
  '<script src="/_next/static/chunks/main-app-c33c.js" async=""></script>' +
  csp(scriptSrc) +
  '<script>window.__forgePrehydration={}</script></head><body>' +
  '<a href="/explore/">Explore</a>' +
  body +
  '<script>(self.__next_f=self.__next_f||[]).push([0])</script>' +
  '<script>self.__next_f.push([1,"0:[\\"$\\",\\"meta\\",null,{\\"content\\":\\"x\\"}]\\n"])</script>' +
  '</body></html>'
const PAGE = page()

/** A hash as a browser computes it, independently of the module under test. */
const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`

describe('the CSP of an exported page', () => {
  const out = hashPage(PAGE)

  it("adds, first in <head>, the layout's script-src without 'unsafe-inline' and with every inline script's hash", () => {
    const hashes = [
      sha('window.__forgePrehydration={}'),
      sha('(self.__next_f=self.__next_f||[]).push([0])'),
      sha('self.__next_f.push([1,"0:[\\"$\\",\\"meta\\",null,{\\"content\\":\\"x\\"}]\\n"])'),
    ].sort()
    expect(scriptPolicies(out)).toEqual([["'self'", "'wasm-unsafe-eval'", ...hashes], ["'self'", "'wasm-unsafe-eval'", "'unsafe-inline'"]])
    expect(out.startsWith('<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><meta http-equiv="Content-Security-Policy" content="script-src &#x27;self&#x27;')).toBe(true)
    expect(cspProblem(out)).toBeNull()
    // Nothing else changed: the layout's own <meta> stays as React rendered it.
    expect(out.replace(/<meta http-equiv="Content-Security-Policy" content="script-src [^"]*"\/>/, '')).toBe(PAGE)
  })

  it('skips scripts loaded by URL and lists a repeated script once', () => {
    const twice = page('<script>window.__forgePrehydration={}</script>')
    expect(inlineScripts(twice)).toHaveLength(4)
    expect(scriptPolicies(hashPage(twice))[0]?.filter((s: string) => s.startsWith("'sha256-"))).toHaveLength(3)
  })

  it('hashes what the parser sees: CR LF becomes LF', () => {
    expect(scriptHash('a\r\nb\rc')).toBe(sha('a\nb\nc'))
  })

  it('finds a script that is not allowed, or a page that allows any', () => {
    // A script injected after the build (as a CDN would) is refused.
    const injected = out.replace('</body>', '<script>steal()</script></body>')
    expect(cspProblem(injected)).toMatch(/1 inline script\(s\) refused, the first: steal\(\)/)
    // The layout's policy alone (`next build` without this step) allows any inline script.
    expect(cspProblem(PAGE)).toMatch(/no policy refuses/)
    // A hashed policy that a script precedes does not govern it.
    expect(cspProblem(out.replace('<head>', '<head><script>early()</script>'))).toMatch(/comes before the hashed CSP/)
    expect(cspProblem(page('', `'self' ${sha('window.__forgePrehydration={}')}`))).toMatch(/2 inline script\(s\) refused/)
  })

  it('refuses a page it cannot read with certainty, or one already hashed', () => {
    expect(() => hashPage(out)).toThrow(/found 2 \(rebuild the app first\)/)
    expect(() => hashPage(page('', "'self'"))).toThrow(/no 'unsafe-inline'/)
    expect(() => hashPage(PAGE.replace('<meta charSet="utf-8"/>', ''))).toThrow(/no <head><meta charSet/)
    expect(() => hashPage(page('<script>a("<!--<script>")</script>'))).toThrow(/<!--/)
    expect(() => hashPage(page('<button onclick="go()">x</button>'))).toThrow(/event handler/)
    expect(() => hashPage(page('<a href="javascript:go()">x</a>'))).toThrow(/javascript: URL/)
  })

  it('hashes every page of an export in place, outside _next/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-hashes-'))
    try {
      mkdirSync(join(dir, 'explore'))
      mkdirSync(join(dir, '_next/static'), { recursive: true })
      writeFileSync(join(dir, 'index.html'), PAGE)
      writeFileSync(join(dir, 'explore/index.html'), PAGE.replace('window.__forgePrehydration={}', 'window.__other=1'))
      writeFileSync(join(dir, '_next/static/x.html'), 'not a page')
      expect(cspHashes(dir)).toEqual({ pages: 2, hashes: 4 })
      expect(cspProblem(readFileSync(join(dir, 'index.html'), 'utf8'))).toBeNull()
      expect(cspProblem(readFileSync(join(dir, 'explore/index.html'), 'utf8'))).toBeNull()
      expect(readFileSync(join(dir, '_next/static/x.html'), 'utf8')).toBe('not a page')
      // A second run refuses rather than adding another policy.
      expect(() => cspHashes(dir)).toThrow(/rebuild the app first/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Every `.html` file of the export, outside `_next/`. */
function exportedPages(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    const path = rel ? `${rel}/${name}` : name
    if (statSync(join(dir, path)).isDirectory()) return path === '_next' ? [] : exportedPages(dir, path)
    return path.endsWith('.html') ? [path] : []
  })
}

// After `pnpm build` (or build:ipfs): the real pages, which this suite does not build itself.
describe.runIf(existsSync(join(WEB, 'out/index.html')))('the built export', () => {
  it("allows every page's own inline scripts and no others", () => {
    const out = join(WEB, 'out')
    const found = exportedPages(out)
    expect(found.length).toBeGreaterThan(10)
    for (const rel of found) expect(cspProblem(readFileSync(join(out, rel), 'utf8'), rel)).toBeNull()
  })
})

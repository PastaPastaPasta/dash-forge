#!/usr/bin/env node
/**
 * Turns a static export (`out/`) into the build published at forg3.dash.site (dash-sites), where
 * every stored byte costs DASH. Run it after `next build` with FORGE_DOCS_URL set (the docs hub
 * to send readers to, e.g. https://forge.dashhq.org/docs), and before build-manifest.mjs. Only
 * this script reads FORGE_DOCS_URL: the app's code and the default build are unchanged.
 *
 *  - The docs hub is left out: each `/docs/<slug>/` page becomes a one-line redirect to the same
 *    page under FORGE_DOCS_URL. The app's own docs links stay `/docs/…`; a click on one finds no
 *    route payload, so Next loads the page in full, which is the redirect.
 *  - The Platform SDK's wasm is not stored: it is byte-identical to a file of the published
 *    `@dashevo/wasm-sdk` package, so it is listed in `<map-file>` for `dash-sites publish
 *    --external`, and readers fetch it from an npm CDN and check its SHA-384. The script refuses
 *    to list a file that differs from the package's.
 *
 * Usage: node scripts/dash-site-postbuild.mjs <out-dir> <map-file>
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const WASM_PACKAGE = '@dashevo/wasm-sdk'
const WASM_FILE = 'dist/raw/wasm_sdk_bg.wasm'
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

const sha384 = (bytes) => `sha384-${createHash('sha384').update(bytes).digest('base64')}`
const escape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

export function docsBase(value) {
  if (!value) throw new Error('set FORGE_DOCS_URL (the https address of the docs hub to link to)')
  const url = new URL(value)
  if (/[?#]/.test(value) || url.protocol !== 'https:' || url.search || url.hash) throw new Error(`FORGE_DOCS_URL must be a plain https URL: ${value}`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * The origin this build is published at (NEXT_PUBLIC_SITE_URL, e.g. https://forg3.dash.site). The
 * app names it in the wallet sign-in's anti-phishing line ("Only scan codes shown on …") and in
 * its page metadata, and defaults to forge.dashhq.org, which would tell a reader on the dash.site
 * copy to trust a different address than the one in their address bar. Required, and must not be
 * forge.dashhq.org.
 */
export function siteOrigin(value) {
  if (!value) throw new Error('set NEXT_PUBLIC_SITE_URL to the address this build is published at (e.g. https://forg3.dash.site)')
  const url = new URL(value)
  if (/[?#]/.test(value) || url.protocol !== 'https:' || url.search || url.hash || url.username || url.password || url.pathname !== '/') {
    throw new Error(`NEXT_PUBLIC_SITE_URL must be a plain https origin: ${value}`)
  }
  const host = url.hostname.replace(/\.$/, '')
  if (host === 'forge.dashhq.org' || host === 'testnet-forge.dashhq.org') {
    throw new Error(`NEXT_PUBLIC_SITE_URL is ${host}: set it to the dash.site address this build is published at`)
  }
  return url.origin
}

/** Checks the export names `origin` as its own address (the sign-in line reads it from the bundle). */
export function checkSiteOrigin(out, origin) {
  const html = readFileSync(join(out, 'index.html'), 'utf8')
  if (!html.includes(`${origin}/`)) throw new Error(`${join(out, 'index.html')} does not name ${origin}: was NEXT_PUBLIC_SITE_URL set for next build?`)
}

/**
 * A page that sends the reader to `target`, keeping the address's `#anchor` (a meta refresh alone
 * would drop it), under a CSP that allows only its own one-line script: the page shares an origin
 * with the signing-key vault, like every other page of the app.
 */
export function redirectPage(target) {
  const href = escape(target)
  const js = `location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')}+location.hash)`
  const csp = `default-src 'none'; script-src 'sha256-${createHash('sha256').update(js).digest('base64')}'; base-uri 'none'; form-action 'none'`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${js}</script><meta http-equiv="refresh" content="0;url=${href}"><link rel="canonical" href="${href}"><title>Dash Forge docs</title></head><body><p>The guides are at <a href="${href}">${href}</a>.</p></body></html>\n`
}

/** Replaces `out/docs/` with redirect pages, one per page the hub had. Returns the redirected paths. */
export function redirectDocs(out, base) {
  const docs = join(out, 'docs')
  if (!existsSync(docs)) throw new Error(`${docs} not found: run next build first`)
  const pages = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry === 'index.html') pages.push(relative(docs, dir).split(sep).join('/'))
    }
  }
  walk(docs)
  rmSync(docs, { recursive: true })
  for (const page of pages) {
    const dir = join(docs, page)
    mkdirSync(dir, { recursive: true })
    const suffix = page === '' ? '/' : `/${page}/`
    writeFileSync(join(dir, 'index.html'), redirectPage(`${base}${suffix}`))
  }
  return pages.map((page) => (page === '' ? '/docs/' : `/docs/${page}/`))
}

/** The export's copy of the SDK wasm, checked against the installed package's file. */
export function externalAssets(out, packageDir) {
  const wasmDir = join(out, '_next', 'static', 'wasm')
  const found = readdirSync(wasmDir).filter((name) => /^wasm_sdk_bg\.[0-9a-f]+\.wasm$/.test(name))
  if (found.length !== 1) throw new Error(`expected one wasm_sdk_bg.<hash>.wasm in ${wasmDir}, found ${found.length}`)
  const { name, version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (name !== WASM_PACKAGE || !EXACT_VERSION.test(version)) throw new Error(`unexpected package ${name}@${version}`)
  const built = readFileSync(join(wasmDir, found[0]))
  const published = readFileSync(join(packageDir, WASM_FILE))
  if (sha384(built) !== sha384(published)) {
    throw new Error(`${found[0]} differs from ${WASM_PACKAGE}@${version}/${WASM_FILE}; it cannot be loaded from npm`)
  }
  return { [`/_next/static/wasm/${found[0]}`]: { npm: WASM_PACKAGE, version, path: WASM_FILE, integrity: sha384(built) } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out = 'out', mapFile] = process.argv.slice(2)
  const base = docsBase(process.env.FORGE_DOCS_URL)
  const origin = siteOrigin(process.env.NEXT_PUBLIC_SITE_URL)
  // `--check`: run first in build:dash-site, so a missing FORGE_DOCS_URL or NEXT_PUBLIC_SITE_URL
  // fails before the build.
  if (out !== '--check') {
    if (!mapFile) throw new Error('usage: dash-site-postbuild.mjs <out-dir> <map-file>')
    checkSiteOrigin(out, origin)
    rmSync(mapFile, { force: true })
    const here = dirname(fileURLToPath(import.meta.url))
    const assets = externalAssets(out, join(here, '..', 'node_modules', WASM_PACKAGE))
    const redirected = redirectDocs(out, base)
    writeFileSync(mapFile, `${JSON.stringify(assets, null, 2)}\n`)
    console.log(`dash-site: built for ${origin}; ${redirected.length} docs pages now redirect to ${base}; ${Object.keys(assets).length} file(s) listed in ${mapFile}`)
  }
}

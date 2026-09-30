#!/usr/bin/env node
/**
 * Turn a `FORGE_IPFS_BUILD=1` static export (`out/`) into the IPFS variant: one build that runs
 * from `/ipfs/<cid>/` on a path gateway as well as from the root of a subdomain gateway (or any
 * host). The CID is only known after the build, so the base path is found at run time:
 *
 *  - every page gets, first in its <head>, {@link BASE_SCRIPT}: it reads the base path from the
 *    URL (scripts/ipfs-base.cjs, which next.config.js reads too for the client's router base
 *    path and webpack public path) and sets a `<base href>` to it;
 *  - every `/_next/static/…` URL in the pages and in the RSC payloads (`*.txt`) becomes
 *    `_next/static/…`, relative to that <base> (the same string from any page depth, so the
 *    stylesheet links React reconciles by href still match);
 *  - every root-relative link (`<a href="/explore/">`) becomes `./explore/`, so a link opened in
 *    a new tab stays under the gateway path too.
 *
 * Deterministic (a pure text transform, files visited in sorted order), so the variant stays
 * reproducible. Fails if a page does not have the shape it expects, or if a root-relative URL
 * survives (in a page, a payload or a stylesheet), rather than publishing a build that only works
 * at a root.
 *
 * Usage: node scripts/ipfs-postbuild.mjs [out-dir]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import base from './ipfs-base.cjs'

/**
 * The first script of every page. It sets a <base> at the run-time base path, before any asset
 * URL in the page is resolved. A <base> also makes an in-page link (`href="#main"`, a README
 * heading, `#L10`) point at the base's page, so each such link is pointed at this page instead
 * the moment it can be followed: on a pointer press, keyboard focus or a context menu, which
 * come before a click, a middle click, Enter or "Copy link". The original fragment is kept in
 * `data-base-fragment`, so a later client-side navigation re-points it at the new page.
 */
export const BASE_SCRIPT =
  `(function(){var m=/${base.IPFS_BASE_PATH}/.exec(location.pathname);` +
  'var e=document.createElement("base");e.href=(m?m[0]:"")+"/";document.head.appendChild(e);' +
  'function f(v){var a=v.target&&v.target.closest?v.target.closest("a[href]"):null;if(!a)return;' +
  'var h=a.getAttribute("href"),o=a.getAttribute("data-base-fragment");' +
  'if(h.charAt(0)==="#")o=h;else if(o===null||h!==a.getAttribute("data-base-url"))return;' +
  'var u=location.pathname+location.search+o;' +
  'a.setAttribute("data-base-fragment",o);a.setAttribute("data-base-url",u);a.setAttribute("href",u)}' +
  '["pointerdown","focusin","contextmenu"].forEach(function(t){document.addEventListener(t,f,true)})})()'

const HEAD_START = '<head><meta charSet="utf-8"/>'
// `"/_next/static/` in an attribute or JSON, `\"/_next/static/` inside the inline RSC payload.
const ASSET_URL = /(\\?")\/_next\/static\//g
// A root-relative link (not protocol-relative `//host`).
const ROOT_LINK = /(<a\b[^>]*?\shref=")\/(?!\/)/g
// What must not be left: a root-relative `_next/` URL anywhere, and any other root-relative URL
// attribute (an icon, an image, a form) outside the links rewritten above.
const LEFT_ASSET = /["'(]\/_next\//
const LEFT_ATTR = /<(?!a\b)[a-z][^>]*?\s(?:src|href|srcset|action|poster)="\/(?!\/)/

/** The IPFS variant of one exported page. */
export function relativizeHtml(html, file = 'page') {
  if (html.includes(BASE_SCRIPT)) throw new Error(`${file}: already rewritten (rebuild the app first)`)
  if (!html.includes(HEAD_START)) throw new Error(`${file}: no ${HEAD_START} to put the base script after`)
  const out = html
    .replace(HEAD_START, `${HEAD_START}<script>${BASE_SCRIPT}</script>`)
    .replace(ASSET_URL, '$1_next/static/')
    .replace(ROOT_LINK, '$1./')
  refuseLeft(out, file, LEFT_ASSET, LEFT_ATTR)
  return out
}

/** The IPFS variant of one RSC payload (`index.txt`, fetched on client-side navigation). */
export function relativizePayload(text, file = 'payload') {
  const out = text.replace(ASSET_URL, '$1_next/static/')
  refuseLeft(out, file, LEFT_ASSET)
  return out
}

/** A stylesheet needs no rewrite (its `url()`s resolve against it), but none may be root-relative. */
export function checkStylesheet(css, file = 'stylesheet') {
  refuseLeft(css, file, /url\(\s*["']?\/(?!\/)/)
}

function refuseLeft(text, file, ...patterns) {
  for (const p of patterns) {
    const i = text.search(p)
    if (i >= 0) throw new Error(`${file}: a root-relative URL is left, which a path gateway cannot serve: ${text.slice(i, i + 80)}`)
  }
}

/** Every file under `dir`, sorted, as paths relative to it. */
function walk(dir, rel = '') {
  return readdirSync(join(dir, rel))
    .sort()
    .flatMap((name) => {
      const path = rel ? `${rel}/${name}` : name
      return statSync(join(dir, path)).isDirectory() ? walk(dir, path) : [path]
    })
}

/** Rewrite `dir` in place; returns how many pages and payloads were rewritten. */
export function postbuild(dir) {
  let pages = 0
  let payloads = 0
  for (const rel of walk(dir)) {
    const file = join(dir, rel)
    if (rel.endsWith('.css')) {
      checkStylesheet(readFileSync(file, 'utf8'), rel)
    } else if (rel.startsWith('_next/')) {
      continue
    } else if (rel.endsWith('.html')) {
      writeFileSync(file, relativizeHtml(readFileSync(file, 'utf8'), rel))
      pages++
    } else if (rel.endsWith('.txt')) {
      writeFileSync(file, relativizePayload(readFileSync(file, 'utf8'), rel))
      payloads++
    }
  }
  if (pages === 0) throw new Error(`${dir}: no pages (build the app first)`)
  return { pages, payloads }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'out'
  const { pages, payloads } = postbuild(dir)
  process.stdout.write(`ipfs-postbuild: ${pages} pages, ${payloads} payloads made base-relative in ${dir}\n`)
}

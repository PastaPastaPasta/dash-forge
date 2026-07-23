#!/usr/bin/env node
/**
 * Minimal static file server for the Forge Web e2e suite.
 *
 * Serves the Next.js static export (`out/`) the way GitHub Pages / a static host would:
 *  - `trailingSlash: true` routing → a request for `/repo/` resolves to `out/repo/index.html`.
 *  - Sends the COOP/COEP `credentialless` headers the evo-sdk WASM runtime requires
 *    (the app relies on these; static hosts replicate them).
 *
 * No third-party dependency (keeps the suite hermetic — the zero-backend request test must
 * not see a stray CDN/download). Usage: `node e2e/static-server.mjs [--port 4321] [--root out]`.
 */

import http from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const rootArg = args.indexOf('--root')
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.E2E_PORT ?? 4321)
const ROOT = join(
  fileURLToPath(new URL('..', import.meta.url)),
  rootArg >= 0 ? args[rootArg + 1] : 'out',
)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

async function resolve(pathname) {
  // Strip query, decode, and prevent path traversal.
  const clean = normalize(decodeURIComponent(pathname.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  const candidates = []
  if (clean.endsWith('/')) {
    candidates.push(join(ROOT, clean, 'index.html'))
  } else {
    candidates.push(join(ROOT, clean))
    // trailingSlash export: /repo → /repo/index.html; also try the .html sibling.
    candidates.push(join(ROOT, clean, 'index.html'))
    candidates.push(join(ROOT, `${clean}.html`))
  }
  for (const file of candidates) {
    try {
      const s = await stat(file)
      if (s.isFile()) return file
    } catch {
      /* try next */
    }
  }
  return null
}

const server = http.createServer(async (req, res) => {
  const commonHeaders = {
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Opener-Policy': 'same-origin',
  }
  let file = await resolve(req.url ?? '/')
  let status = 200
  if (!file) {
    // SPA-ish fallback: serve the 404 page (the app itself renders client routes).
    file = join(ROOT, '404.html')
    status = 404
    try {
      await stat(file)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', ...commonHeaders })
      res.end('Not found')
      return
    }
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream'
  res.writeHead(status, { 'content-type': type, ...commonHeaders })
  createReadStream(file).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[static-server] serving ${ROOT} at http://127.0.0.1:${PORT}`)
})

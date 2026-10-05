#!/usr/bin/env node
/**
 * Write `forge-manifest.json` into a static export: the SHA-256 of every file the build made, so
 * anyone can check a deployed copy file by file (`dg verify-app <url>`,
 * docs/guides/verify-the-app.md). The site serves it at its root.
 *
 * A manifest on the site proves nothing by itself: whoever serves the site can rewrite it. CI
 * publishes it too: the Pages deploy (pages.yml) and every release (release.yml, as
 * `forge-web-<version>.manifest.json`) record a GitHub build-provenance attestation of its
 * SHA-256, and a Forge release on chain can list it. `dg verify-app` checks the served manifest
 * against one of those, then every file against the manifest.
 *
 * Deterministic: paths sorted, no times, so the reproducible builds stay reproducible (the
 * manifest is part of the IPFS build and so of its CID).
 *
 * Usage: node scripts/build-manifest.mjs [out-dir]
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST_NAME = 'forge-manifest.json'

/** Every file under `dir`, as `/`-separated paths relative to it, sorted. */
export function listFiles(dir, root = dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...listFiles(path, root))
    else out.push(relative(root, path).split(sep).join('/'))
  }
  return out.sort()
}

/**
 * The manifest of the build in `dir`: the commit and network it was built for (from the build's
 * environment, as next.config.js reads them), whether it is the IPFS variant, and each file's
 * SHA-256 (hex), the manifest itself left out.
 *
 * @param {string} dir
 * @param {Record<string, string | undefined>} [env]
 */
export function buildManifest(dir, env = process.env) {
  const files = {}
  for (const path of listFiles(dir)) {
    if (path === MANIFEST_NAME) continue
    files[path] = createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')
  }
  const commit = /^[0-9a-f]{40}$/.test(env.FORGE_BUILD_COMMIT ?? '') ? env.FORGE_BUILD_COMMIT : null
  const network = env.NEXT_PUBLIC_NETWORK === 'devnet' && env.NEXT_PUBLIC_DEVNET_NAME ? `devnet-${env.NEXT_PUBLIC_DEVNET_NAME}` : (env.NEXT_PUBLIC_NETWORK ?? null)
  return {
    format: 1,
    commit,
    network,
    variant: env.FORGE_IPFS_BUILD === '1' ? 'ipfs' : 'host',
    files,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'out'
  const manifest = buildManifest(dir)
  writeFileSync(join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 1)}\n`)
  process.stderr.write(`${MANIFEST_NAME}: ${Object.keys(manifest.files).length} files\n`)
}

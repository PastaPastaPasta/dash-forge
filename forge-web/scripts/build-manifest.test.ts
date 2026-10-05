/** The build manifest: every file's SHA-256, deterministic, without itself. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildManifest, MANIFEST_NAME } from './build-manifest.mjs'

describe('buildManifest', () => {
  it('hashes every file, sorted, and leaves itself out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-'))
    mkdirSync(join(dir, '_next/static'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), 'hi')
    writeFileSync(join(dir, '_next/static/a.js'), '')
    writeFileSync(join(dir, MANIFEST_NAME), '{}')
    const m = buildManifest(dir, { FORGE_BUILD_COMMIT: 'a'.repeat(40), NEXT_PUBLIC_NETWORK: 'devnet', NEXT_PUBLIC_DEVNET_NAME: 'sakura', FORGE_IPFS_BUILD: '1' })
    expect(m).toEqual({
      format: 1,
      commit: 'a'.repeat(40),
      network: 'devnet-sakura',
      variant: 'ipfs',
      files: {
        '_next/static/a.js': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'index.html': '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
      },
    })
    expect(Object.keys(m.files)).toEqual([...Object.keys(m.files)].sort())
    expect(buildManifest(dir, {}).commit).toBeNull()
    expect(buildManifest(dir, { NEXT_PUBLIC_NETWORK: 'mainnet' }).variant).toBe('host')
  })
})

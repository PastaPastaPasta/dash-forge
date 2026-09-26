import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_ASSET_BYTES,
  assetFilesProblem,
  assetPlanProblem,
  plannedAsset,
  releaseIntent,
  releaseTextProblem,
  tagProblem,
} from './new-release'
import { parseReleaseAssets } from './releases'
import { releaseAssetsJson } from './writes'
import { externalTargets, policyFor, storeFile, type StorageProfile } from '../storage'
import { sha256Hex } from '../storage/sigv4'

const S3: StorageProfile = {
  name: 'r2',
  settings: { kind: 's3', provider: 'r2', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'b', pathStyle: true, publicUrl: 'https://pub.example', prefix: 'rel' },
  secrets: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
}
const PLATFORM: StorageProfile = { name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} }

describe('release input rules', () => {
  it('accepts git tag names and refuses what git check-ref-format would', () => {
    for (const t of ['v1.0.0', 'release/2026-09', 'v2', 'a.b/c']) expect(tagProblem(t), t).toBeNull()
    for (const t of ['', 'has space', 'a..b', 'x:y', 'x~1', '-v1', 'v1.', 'v1.lock', 'a.lock/b', 'a@{1}', '@', 'a//b', 'a/.b', '.a', 'x'.repeat(64)]) {
      expect(tagProblem(t), t).not.toBeNull()
    }
  })

  it('bounds the title by 120 characters AND 480 bytes, as the schema does', () => {
    expect(releaseTextProblem({ name: 'Ü'.repeat(120), notes: '' })).toBeNull()
    expect(releaseTextProblem({ name: 'Ü'.repeat(121), notes: '' })).toMatch(/120 characters/)
    expect(releaseTextProblem({ name: 'x'.repeat(121), notes: '' })).toMatch(/120 characters/)
    expect(releaseTextProblem({ name: '🔥'.repeat(120), notes: '' })).toBeNull()
    expect(releaseTextProblem({ name: '', notes: 'x'.repeat(5121) })).toMatch(/notes/)
  })

  it('refuses duplicate, path-like, disguised, empty, over-long and oversized assets', () => {
    expect(assetFilesProblem([{ name: 'a.tar.gz', size: 1 }, { name: 'b.zip', size: 2 }])).toBeNull()
    expect(assetFilesProblem([{ name: 'a', size: 1 }, { name: 'a', size: 1 }])).toMatch(/same name/)
    expect(assetFilesProblem([{ name: '../a', size: 1 }])).toMatch(/plain file name/)
    expect(assetFilesProblem([{ name: 'exe‮txt.sh', size: 1 }])).toMatch(/text-direction/)
    expect(assetFilesProblem([{ name: 'empty.bin', size: 0 }])).toMatch(/empty/)
    expect(assetFilesProblem([{ name: 'n'.repeat(256), size: 1 }])).toMatch(/255/)
    expect(assetFilesProblem([{ name: 'big.iso', size: MAX_ASSET_BYTES + 1 }])).toMatch(/dg release create/)
  })

  it('sizes the asset list before uploading, from the entries uploads will produce', () => {
    const policy = policyFor(['r2'], 'one')
    const planned = plannedAsset('app.tar.gz', 12, policy, [S3])
    expect(planned.uris).toEqual([`https://pub.example/rel/packs/${'f'.repeat(64)}.pack`, `s3://b/rel/packs/${'f'.repeat(64)}.pack`])
    expect(assetPlanProblem([{ name: 'a', size: 1 }], policy, [S3])).toBeNull()
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `asset-${i}.tar.gz`, size: 1 }))
    expect(assetPlanProblem(many, policy, [S3])).toMatch(/4096/)
    expect(assetPlanProblem([{ name: 'a', size: 1 }], policyFor(['platform'], 'one'), [PLATFORM])).toMatch(/never go to Platform/)
    expect(assetPlanProblem([], null, [])).toBeNull()
  })

  it('writes the CLI asset shape, which the reader parses back', () => {
    const asset = { name: 'app.tar.gz', sha256: 'ab'.repeat(32), sizeBytes: 12, uris: ['https://pub.example/rel/packs/x.pack', 's3://b/x'] }
    const { assets, bad } = parseReleaseAssets(releaseAssetsJson([asset]))
    expect(bad).toBe(0)
    expect(assets).toEqual([{ name: 'app.tar.gz', sha256: 'ab'.repeat(32), size: 12, uris: asset.uris }])
  })

  it('binds a publish intent to its content', async () => {
    const a = await releaseIntent('draft', { tagName: 'v1', name: 'x', notes: '' }, [])
    expect(await releaseIntent('draft', { tagName: 'v1', name: 'x', notes: '' }, [])).toBe(a)
    expect(await releaseIntent('draft', { tagName: 'v1', name: 'y', notes: '' }, [])).not.toBe(a)
    expect(a.startsWith('draft:')).toBe(true)
  })
})

describe('storeFile (release assets)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('counts only external storage known here', () => {
    expect(externalTargets(policyFor(['platform', 'r2', 'gone'], 'one'), [S3, PLATFORM])).toEqual(['r2'])
    expect(externalTargets(null, [S3])).toEqual([])
  })

  it('refuses a policy with no external storage, and empty files, before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(storeFile(new Uint8Array([1]), { policy: policyFor(['platform'], 'one'), profiles: [PLATFORM] })).rejects.toThrow(/your own storage/)
    await expect(storeFile(new Uint8Array([1]), { policy: null, profiles: [] })).rejects.toThrow(/your own storage/)
    await expect(storeFile(new Uint8Array(0), { policy: policyFor(['r2'], 'one'), profiles: [S3] })).rejects.toThrow(/empty/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stores, verifies and returns the public URL first', async () => {
    const objects = new Map<string, Uint8Array>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const key = url.host === 'pub.example' ? url.pathname.slice(1) : url.pathname.replace(/^\/b\//, '')
        if (init?.method === 'PUT') {
          objects.set(key, new Uint8Array(init.body as Uint8Array))
          return new Response(null, { status: 200 })
        }
        const obj = objects.get(key)
        if (!obj) return new Response(null, { status: 404 })
        if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(obj.length) } })
        return new Response(new Uint8Array(obj), { status: 200 })
      }),
    )
    const bytes = new TextEncoder().encode('release asset')
    const hash = await sha256Hex(bytes)
    const stored = await storeFile(bytes, { policy: policyFor(['r2', 'platform'], 'one'), profiles: [S3, PLATFORM], sha256Hex: hash })
    expect(stored).toMatchObject({ sha256: hash, sizeBytes: bytes.length, confirmed: ['r2'] })
    expect(stored.uris).toEqual([`https://pub.example/rel/packs/${hash}.pack`, `s3://b/rel/packs/${hash}.pack`])
  })
})

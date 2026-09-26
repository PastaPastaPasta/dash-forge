import { afterEach, describe, expect, it, vi } from 'vitest'

import { assetNamesProblem, assetsJson, releaseTextProblem, tagProblem } from './new-release'
import { parseReleaseAssets } from './releases'
import { policyFor, storeFile, type StorageProfile } from '../storage'
import { sha256Hex } from '../storage/sigv4'

describe('release input rules', () => {
  it('accepts git tag names and refuses what git would', () => {
    for (const t of ['v1.0.0', 'release/2026-09', 'v2']) expect(tagProblem(t), t).toBeNull()
    for (const t of ['', 'has space', 'a..b', 'x:y', 'x~1', '-v1', 'v1.', 'v1.lock', 'a@{1}', 'x'.repeat(64)]) expect(tagProblem(t), t).not.toBeNull()
  })

  it('bounds title and notes by UTF-8 bytes', () => {
    expect(releaseTextProblem({ name: 'Ü'.repeat(240), notes: '' })).toBeNull()
    expect(releaseTextProblem({ name: 'Ü'.repeat(241), notes: '' })).toMatch(/title/)
    expect(releaseTextProblem({ name: '', notes: 'x'.repeat(5121) })).toMatch(/notes/)
  })

  it('refuses duplicate or path-like asset names', () => {
    expect(assetNamesProblem(['a.tar.gz', 'b.zip'])).toBeNull()
    expect(assetNamesProblem(['a', 'a'])).toMatch(/same name/)
    expect(assetNamesProblem(['../a'])).toMatch(/plain file name/)
  })

  it('writes the CLI asset shape, which the reader parses back', () => {
    const asset = { name: 'app.tar.gz', sha256: 'ab'.repeat(32), sizeBytes: 12, uris: ['https://pub.example/web/packs/x.pack', 's3://b/x'] }
    const { assets, bad } = parseReleaseAssets(assetsJson([asset]))
    expect(bad).toBe(0)
    expect(assets).toEqual([{ name: 'app.tar.gz', sha256: 'ab'.repeat(32), size: 12, uris: asset.uris }])
    expect(() => assetsJson(Array.from({ length: 30 }, (_, i) => ({ ...asset, name: `a${i}` })))).toThrow(/4096/)
  })
})

describe('storeFile (release assets)', () => {
  const S3: StorageProfile = {
    name: 'r2',
    settings: { kind: 's3', provider: 'r2', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'b', pathStyle: true, publicUrl: 'https://pub.example', prefix: '' },
    secrets: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
  }
  const PLATFORM: StorageProfile = { name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} }
  afterEach(() => vi.unstubAllGlobals())

  it('refuses a policy with no external storage, before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(storeFile(new Uint8Array([1]), { policy: policyFor(['platform'], 'one'), profiles: [PLATFORM] })).rejects.toThrow(/your own storage/)
    await expect(storeFile(new Uint8Array([1]), { policy: null, profiles: [] })).rejects.toThrow(/your own storage/)
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
    const stored = await storeFile(bytes, { policy: policyFor(['r2', 'platform'], 'one'), profiles: [S3, PLATFORM] })
    expect(stored).toMatchObject({ sha256: hash, sizeBytes: bytes.length, confirmed: ['r2'] })
    expect(stored.uris).toEqual([`https://pub.example/packs/${hash}.pack`, `s3://b/packs/${hash}.pack`])
  })
})

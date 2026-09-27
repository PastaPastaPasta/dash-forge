/** Release reads: both asset shapes, newest per tag, and the verified download. */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { AssetHashMismatchError, downloadVerifiedAsset } from '../view/release-download'
import { newestPerTag, parseReleaseAssets, type ReleaseView } from './releases'

const H = 'ab'.repeat(32)

describe('parseReleaseAssets', () => {
  it("reads the web writer's {size, uri} and the CLI's {sizeBytes, uris} shapes", () => {
    const { assets, bad } = parseReleaseAssets(
      JSON.stringify([
        { name: 'web.tar.gz', sha256: H.toUpperCase(), size: 10, uri: 'https://a.example/w' },
        { name: 'cli.tar.gz', sha256: H, sizeBytes: 20, uris: ['https://b.example/c', 'ipfs://bafy'] },
        { name: 'old.tar.gz', sha256: H, size_bytes: 30, uris: ['https://c.example/o'], uri: 'https://c.example/o' },
      ]),
    )
    expect(bad).toBe(0)
    expect(assets).toEqual([
      { name: 'web.tar.gz', sha256: H, size: 10, uris: ['https://a.example/w'] },
      { name: 'cli.tar.gz', sha256: H, size: 20, uris: ['https://b.example/c', 'ipfs://bafy'] },
      { name: 'old.tar.gz', sha256: H, size: 30, uris: ['https://c.example/o'] },
    ])
  })

  it('counts unreadable entries instead of guessing', () => {
    expect(parseReleaseAssets('[{"name":"x","sha256":"nothex"}, 3]')).toEqual({ assets: [], bad: 2 })
    expect(parseReleaseAssets('{')).toEqual({ assets: [], bad: 1 })
    expect(parseReleaseAssets('')).toEqual({ assets: [], bad: 0 })
  })
})

describe('newestPerTag', () => {
  const rel = (tag: string, at: number, id: string): ReleaseView => ({
    id,
    tagName: tag,
    name: '',
    notes: '',
    yanked: false,
    assets: [],
    badAssets: 0,
    publisher: 'p',
    createdAt: at,
  })
  it('keeps the newest revision per tag and lists the rest as previous', () => {
    const { current, previous } = newestPerTag([rel('v1', 1, 'a'), rel('v1', 3, 'b'), rel('v2', 2, 'c'), rel('v1', 3, 'd')])
    expect(current.map((r) => r.id)).toEqual(['d', 'c'])
    expect(previous.map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('downloadVerifiedAsset', () => {
  const body = new TextEncoder().encode('release bytes\n')
  const good = bytesToHex(sha256(body))
  const serve = (routes: Record<string, Uint8Array>): typeof fetch =>
    ((input: RequestInfo | URL) => {
      const bytes = routes[String(input)]
      return bytes ? Promise.resolve(new Response(bytes.slice())) : Promise.reject(new TypeError('refused'))
    }) as typeof fetch

  it('returns the bytes only when they hash to the published sha256', async () => {
    const seen: number[] = []
    const got = await downloadVerifiedAsset(
      { name: 'a', sha256: good, size: body.length, uris: ['https://a.example/x'] },
      (p) => seen.push(p.bytes),
      { fetch: serve({ 'https://a.example/x': body }) },
    )
    expect(Array.from(got)).toEqual(Array.from(body))
    expect(seen.at(-1)).toBe(body.length)
  })

  it('refuses bytes that do not match, even when they are the only ones', async () => {
    const run = downloadVerifiedAsset(
      { name: 'a', sha256: good, size: null, uris: ['https://evil.example/x'] },
      undefined,
      { fetch: serve({ 'https://evil.example/x': new TextEncoder().encode('tampered bytes') }) },
    )
    await expect(run).rejects.toBeInstanceOf(AssetHashMismatchError)
    await expect(run).rejects.toThrow(/evil\.example/)
  })

  it('falls through to another place after a mismatch', async () => {
    const got = await downloadVerifiedAsset(
      { name: 'a', sha256: good, size: null, uris: ['https://evil.example/x', 'ipfs://bafy'] },
      undefined,
      {
        fetch: serve({ 'https://evil.example/x': new Uint8Array([1]), 'https://gw.example/ipfs/bafy': body }),
        gateways: ['https://gw.example'],
      },
    )
    expect(got.length).toBe(body.length)
  })
})

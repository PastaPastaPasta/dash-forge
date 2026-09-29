/** Release reads: both asset shapes, newest per tag, and the verified download. */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { AssetHashMismatchError, browserReadable, downloadVerifiedAsset } from '../view/release-download'
import { UNVERIFIABLE_ASSET, assetVerifiable, compareTagNames, isPrerelease, latestRelease, newestPerTag, parseReleaseAssets, releaseOrder, type ReleaseView } from './releases'

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

  it('lists an asset with an empty sha256 as unverifiable, not as unreadable (D-517)', () => {
    const { assets, bad } = parseReleaseAssets(JSON.stringify([{ name: 'fd', sha256: '', sizeBytes: 1203280, uris: ['https://github.com/sharkdp/fd/releases/download/v0.1.0/fd'] }]))
    expect(bad).toBe(0)
    expect(assets[0]?.sha256).toBe('')
    expect(assetVerifiable(assets[0]!)).toBe(false)
    expect(assetVerifiable({ sha256: H })).toBe(true)
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
    notesBody: '',
    omitted: null,
    published: null,
    publisher: 'p',
    createdAt: at,
  })
  it('keeps the newest revision per tag and lists the rest as previous', () => {
    const { current, previous } = newestPerTag([rel('v1', 1, 'a'), rel('v1', 3, 'b'), rel('v2', 2, 'c'), rel('v1', 3, 'd')])
    expect(current.map((r) => r.id)).toEqual(['c', 'd'])
    expect(previous.map((r) => r.id)).toEqual(['b', 'a'])
  })

  // L-14: an import writes the source's newest-first listing, so the OLDEST release had the
  // newest $createdAt and the rail showed it as "Latest". Same fixture as forge-core's test.
  it('orders by version and picks the latest non-prerelease', () => {
    const tags = ['v24.0.0-rc.1', 'v23.1.2', 'v23.1.10', 'v24.0.0-rc.10', 'v0.9.13.15', 'nightly', 'jq-1.7.1']
    const list = newestPerTag(tags.map((t, i) => rel(t, i + 1, t)))
    expect(list.current.map((r) => r.tagName)).toEqual(['v24.0.0-rc.10', 'v24.0.0-rc.1', 'v23.1.10', 'v23.1.2', 'jq-1.7.1', 'v0.9.13.15', 'nightly'])
    expect(latestRelease(list)?.tagName).toBe('v23.1.10')
    expect(latestRelease({ current: list.current.slice(0, 2), previous: [] })?.tagName).toBe('v24.0.0-rc.10')
    expect(latestRelease({ current: [], previous: [] })).toBeUndefined()
    expect([isPrerelease('v24.0.0-rc.1'), isPrerelease('15.2.0'), isPrerelease('v1+build')]).toEqual([true, false, false])
  })

  it('orders pre-release suffixes as forge-core does', () => {
    const tags = ['1.0.0-beta', '1.0.0-1', '1.0.0-rc.2', '1.0.0-RC1', '1.0.0-rc10', '1.0.0-alpha']
    const list = newestPerTag(tags.map((t, i) => rel(t, i, t)))
    expect(list.current.map((r) => r.tagName)).toEqual(['1.0.0-rc10', '1.0.0-rc.2', '1.0.0-RC1', '1.0.0-beta', '1.0.0-alpha', '1.0.0-1'])
  })

  it('reads a recorded size of 0 as unknown (GitLab links)', () => {
    const { assets } = parseReleaseAssets(JSON.stringify([{ name: 'a', sha256: H, sizeBytes: 0, uris: ['https://x.example/a'] }]))
    expect(assets[0]?.size).toBeNull()
  })

  it('ripgrep: 15.2.0 is latest, not 0.0.2', () => {
    const list = newestPerTag(['15.2.0', '14.1.1', '0.10.0', '0.0.2'].map((t, i) => rel(t, i + 1, t)))
    expect(latestRelease(list)?.tagName).toBe('15.2.0')
    expect(list.current.map((r) => r.tagName)).toEqual(['15.2.0', '14.1.1', '0.10.0', '0.0.2'])
  })
})

// L-13/L-53: the ref switcher and the tags/branches pages sort by this instead of localeCompare,
// so a 575-tag repo shows v23.1.10 above v23.1.8 rather than between v23.1.1 and v23.1.2.
describe('compareTagNames', () => {
  it('sorts numeric versions highest first, not lexicographically', () => {
    const names = ['v23.1.2', 'v23.1.10', 'v23.1.8', 'v23.1.9']
    expect([...names].sort(compareTagNames)).toEqual(['v23.1.10', 'v23.1.9', 'v23.1.8', 'v23.1.2'])
  })

  it('puts every versioned name ahead of every unversioned one, each internally sorted', () => {
    const names = ['nightly', 'v1.2.0', 'edge', 'v1.10.0', 'main']
    expect([...names].sort(compareTagNames)).toEqual(['v1.10.0', 'v1.2.0', 'edge', 'main', 'nightly'])
  })

  it('breaks a tie between two equal versions by natural-sorting the full name', () => {
    const names = ['zeta-v1.0.0', 'alpha-v1.0.0']
    expect([...names].sort(compareTagNames)).toEqual(['alpha-v1.0.0', 'zeta-v1.0.0'])
  })

  // Both compareTagNames (name-only, for the ref switcher and tags/branches pages) and
  // releaseOrder (ReleaseView-based, for the releases page) share the same version comparison
  // (versionDesc); they only differ in how they break a tie between two equal versions
  // (natural-sort the name vs. newestFirst by createdAt/id). This fixture has no true ties, so
  // that difference cannot show up here, and the two orders genuinely agree — proven by actually
  // running releaseOrder, not by asserting a second hand-copied expectation.
  it('agrees with releaseOrder on a mixed real-world tag set with no version ties', () => {
    const tags = ['v24.0.0-rc.1', 'v23.1.2', 'v23.1.10', 'v24.0.0-rc.10', 'v0.9.13.15', 'nightly', 'jq-1.7.1']
    const releases: ReleaseView[] = tags.map((tag, i) => ({
      id: tag,
      tagName: tag,
      name: '',
      notes: '',
      yanked: false,
      assets: [],
      badAssets: 0,
      notesBody: '',
      omitted: null,
      published: null,
      publisher: 'p',
      createdAt: i + 1,
    }))
    const byCompareTagNames = [...tags].sort(compareTagNames)
    const byReleaseOrder = [...releases].sort(releaseOrder).map((r) => r.tagName)
    expect(byCompareTagNames).toEqual(byReleaseOrder)
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

  // L-13: the source host sends no CORS header, so the page can only link to the file.
  it('knows which hosts a page can read', () => {
    const a = (uris: string[]) => ({ name: 'a', sha256: good, size: null, uris })
    expect(browserReadable(a(['https://github.com/o/r/releases/download/v1/a']))).toBe(false)
    expect(browserReadable(a(['https://gitlab.com/g/p/-/releases/v1/downloads/a']))).toBe(false)
    expect(browserReadable(a(['https://pub.example/rel/a']))).toBe(true)
    expect(browserReadable(a(['https://github.com/o/r/releases/download/v1/a', 'https://pub.example/rel/a']))).toBe(true)
    expect(browserReadable(a(['ipfs://bafy']), ['https://gw.example'])).toBe(true)
  })

  it('skips a host a page cannot read and uses a readable copy', async () => {
    const got = await downloadVerifiedAsset(
      { name: 'a', sha256: good, size: null, uris: ['https://github.com/o/r/releases/download/v1/a', 'https://pub.example/a'] },
      undefined,
      { fetch: serve({ 'https://pub.example/a': body }) },
    )
    expect(got.length).toBe(body.length)
  })

  it('never fetches an asset with no recorded hash (D-517)', async () => {
    const fetched: string[] = []
    const run = downloadVerifiedAsset({ name: 'fd', sha256: '', size: null, uris: ['https://a.example/x'] }, undefined, {
      fetch: ((input: RequestInfo | URL) => {
        fetched.push(String(input))
        return Promise.resolve(new Response(body.slice()))
      }) as typeof fetch,
    })
    await expect(run).rejects.toThrow(UNVERIFIABLE_ASSET)
    expect(fetched).toEqual([])
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

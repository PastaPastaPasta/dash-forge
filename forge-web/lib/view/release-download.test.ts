/** D-056: the fallback when a browser cannot fetch a release asset itself. */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import type { ReleaseAssetView } from '../repo'
import { browserReadable, checkDownloadedFile, directDownloadUrls, downloadVerifiedAsset } from './release-download'

const bytes = new TextEncoder().encode('ripgrep-15.0.0-x86_64-apple-darwin.tar.gz')
const asset: ReleaseAssetView = {
  name: 'rg.tar.gz',
  sha256: bytesToHex(sha256(bytes)),
  size: bytes.length,
  uris: ['https://github.com/BurntSushi/ripgrep/releases/download/15.0.0/rg.tar.gz', 'ipfs://bafyexample', 'http://insecure.example/x'],
}

describe('release asset fallback (D-056)', () => {
  it('offers the recorded https places as direct links', () => {
    expect(directDownloadUrls(asset, ['https://gw.example'])).toEqual([
      'https://github.com/BurntSushi/ripgrep/releases/download/15.0.0/rg.tar.gz',
      'https://gw.example/ipfs/bafyexample',
    ])
  })

  it('reports a CORS-blocked fetch as a download failure, not a hash mismatch', async () => {
    const blocked: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'))
    await expect(downloadVerifiedAsset(asset, undefined, { fetch: blocked, gateways: ['https://gw.example'] })).rejects.toThrow(/could not be downloaded/)
  })

  // L-13: a host known to refuse cross-origin reads is never tried in the page at all; the
  // view makes the direct download the main action instead.
  it('does not try a host that refuses cross-origin reads', async () => {
    const tried: string[] = []
    const record: typeof fetch = (input) => {
      tried.push(String(input))
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    await expect(downloadVerifiedAsset(asset, undefined, { fetch: record, gateways: [] })).rejects.toThrow(/no place a browser can download/)
    expect(tried).toEqual([])
    expect(browserReadable(asset, [])).toBe(false)
    expect(browserReadable(asset, ['https://gw.example'])).toBe(true)
  })

  // The view's three reachable states: a page-readable copy (verified in the browser), only a
  // no-CORS host (a direct link), or no browser-fetchable copy at all (a loopback bucket).
  it('tells the three kinds of copy apart', () => {
    const with_ = (uris: string[]): ReleaseAssetView => ({ ...asset, uris })
    const loopback = with_(['http://127.0.0.1:9000/forge-byo/a.pack', 's3://forge-byo/a.pack'])
    expect([browserReadable(loopback, []), directDownloadUrls(loopback, [])]).toEqual([false, []])
    const gh = with_(['https://github.com/o/r/releases/download/v1/a'])
    expect([browserReadable(gh, []), directDownloadUrls(gh, []).length]).toEqual([false, 1])
    const own = with_(['https://pub.example/a'])
    expect(browserReadable(own, [])).toBe(true)
  })

  it('checks a file downloaded by hand against the published hash and size', async () => {
    await expect(checkDownloadedFile(new Blob([bytes]), asset)).resolves.toMatchObject({ ok: true })
    const other = await checkDownloadedFile(new Blob([new Uint8Array([1, 2, 3])]), asset)
    expect(other.ok).toBe(false)
    expect(other.sizeMatches).toBe(false)
  })
})

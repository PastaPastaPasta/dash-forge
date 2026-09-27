/** D-056: the fallback when a browser cannot fetch a release asset itself. */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import type { ReleaseAssetView } from '../repo'
import { checkDownloadedFile, directDownloadUrls, downloadVerifiedAsset } from './release-download'

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
    await expect(downloadVerifiedAsset(asset, undefined, { fetch: blocked, gateways: [] })).rejects.toThrow(/could not be downloaded/)
  })

  it('checks a file downloaded by hand against the published hash and size', async () => {
    await expect(checkDownloadedFile(new Blob([bytes]), asset)).resolves.toMatchObject({ ok: true })
    const other = await checkDownloadedFile(new Blob([new Uint8Array([1, 2, 3])]), asset)
    expect(other.ok).toBe(false)
    expect(other.sizeMatches).toBe(false)
  })
})

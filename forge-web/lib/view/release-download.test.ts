/** D-056: the fallback when a browser cannot fetch a release asset itself. */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'

import { EpochKeys, GRACE_BLOCKS, openReleaseAsset, sealPack, type ReleaseAsset } from '../private'
import type { ReleaseAssetView } from '../repo'
import {
  AssetHashMismatchError,
  assetListUploadedLate,
  SealedAssetCorruptError,
  browserReadable,
  checkDownloadedFile,
  directDownloadUrls,
  displayAssetName,
  downloadSealedAsset,
  downloadVerifiedAsset,
  isSealedAsset,
} from './release-download'

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
    await expect(checkDownloadedFile(new Blob([bytes]), asset)).resolves.toEqual({ kind: 'match' })
    const same = new Uint8Array(bytes.length).fill(7)
    await expect(checkDownloadedFile(new Blob([same]), asset)).resolves.toEqual({ kind: 'wrong-hash', sha256: bytesToHex(sha256(same)) })
  })

  it('reports a wrong size without reading the file', async () => {
    let read = false
    const file = new Blob([new Uint8Array([1, 2, 3])])
    const spy = Object.assign(file, {
      stream: () => {
        read = true
        return Blob.prototype.stream.call(file)
      },
    })
    await expect(checkDownloadedFile(spy, asset)).resolves.toEqual({ kind: 'wrong-size', size: 3, want: bytes.length })
    expect(read).toBe(false)
    // With no published size, the hash decides.
    await expect(checkDownloadedFile(new Blob([bytes]), { ...asset, size: null })).resolves.toEqual({ kind: 'match' })
  })
})

describe('an asset list uploaded under an old key (private-repos.md §16.5)', () => {
  it('is late when its first copy is past stated(next epoch) plus GRACE_BLOCKS for its header epoch, or under a burned epoch', async () => {
    const k0 = await EpochKeys.import(new Uint8Array(32).fill(0x11), 0, new Uint8Array(32).fill(1))
    const sealed = await sealPack(k0, new TextEncoder().encode('{"v":1}'))
    const standing = {
      anchors: new Map([
        [0, { id: new Uint8Array(32), height: 10, statedHeight: 10 }],
        [1, { id: new Uint8Array(32).fill(1), height: 100, statedHeight: 100 }],
      ]),
    }
    const at = (...heights: number[]) => heights.map((createdAtBlockHeight) => ({ createdAtBlockHeight }))
    expect(assetListUploadedLate(sealed, at(100 + GRACE_BLOCKS), standing)).toBe(false)
    expect(assetListUploadedLate(sealed, at(101 + GRACE_BLOCKS), standing)).toBe(true)
    // a later copy (a reseed of the same bytes) does not make it late: the first upload decides
    expect(assetListUploadedLate(sealed, at(5000, 50), standing)).toBe(false)
    expect(assetListUploadedLate(sealed, at(50), { ...standing, burned: new Set([0]) })).toBe(true)
    // nothing to judge: no block height, or not a sealed header
    expect(assetListUploadedLate(sealed, [{}], standing)).toBe(false)
    expect(assetListUploadedLate(new Uint8Array(10), at(9999), standing)).toBe(false)
  })
})

describe('a sealed asset (private-repos.md §16.5)', () => {
  const file = new TextEncoder().encode('the release binary')
  const setup = async (plain: Uint8Array = file) => {
    const keys = await EpochKeys.import(new Uint8Array(32).fill(0x11), 0, new Uint8Array(32).fill(1))
    const sealed = await sealPack(keys, plain)
    const entry: ReleaseAsset = {
      name: 'app.bin',
      sha256: bytesToHex(sha256(file)),
      sizeBytes: file.length,
      uris: ['https://one.example/app', 'https://two.example/app'],
      sealedSha256: bytesToHex(sha256(sealed)),
      sealedSizeBytes: sealed.length,
    }
    return { keyring: new Map([[0, keys]]), sealed, entry }
  }
  const serving =
    (bodies: Record<string, Uint8Array>): typeof fetch =>
    (input) => {
      const body = bodies[String(input)]
      return Promise.resolve(body ? new Response(body as BodyInit) : new Response(null, { status: 404 }))
    }
  const at = (bodies: Record<string, Uint8Array>) => ({ fetch: serving(bodies), gateways: [] })

  it('checks sealedSha256, opens under the header epoch, checks the file and hands back its bytes', async () => {
    const { keyring, sealed, entry } = await setup()
    await expect(downloadSealedAsset(entry, keyring, undefined, at({ 'https://one.example/app': sealed }))).resolves.toEqual(file)
  })

  it('refuses sealed bytes of the wrong hash, and takes the next place that serves the right ones', async () => {
    const { keyring, sealed, entry } = await setup()
    const tampered = sealed.slice()
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1
    await expect(downloadSealedAsset(entry, keyring, undefined, at({ 'https://one.example/app': tampered }))).rejects.toBeInstanceOf(AssetHashMismatchError)
    await expect(downloadSealedAsset(entry, keyring, undefined, at({ 'https://one.example/app': tampered, 'https://two.example/app': sealed }))).resolves.toEqual(file)
  })

  it('refuses a file whose plaintext does not match its sha256, or is shorter than its size: nothing is handed back', async () => {
    const { keyring, sealed, entry } = await setup()
    const served = at({ 'https://one.example/app': sealed })
    await expect(downloadSealedAsset({ ...entry, sha256: 'ab'.repeat(32) }, keyring, undefined, served)).rejects.toBeInstanceOf(SealedAssetCorruptError)
    await expect(downloadSealedAsset({ ...entry, sizeBytes: file.length + 1 }, keyring, undefined, served)).rejects.toBeInstanceOf(SealedAssetCorruptError)
  })

  it('truncates a padded plaintext to sizeBytes before checking the hash', async () => {
    const padded = new Uint8Array(64 * 1024)
    padded.set(file)
    const { keyring, sealed, entry } = await setup(padded)
    await expect(downloadSealedAsset(entry, keyring, undefined, at({ 'https://one.example/app': sealed }))).resolves.toEqual(file)
    await expect(openReleaseAsset(sealed, entry, keyring)).resolves.toEqual(file)
  })

  it('a key this reader lacks is not the file’s fault: a plain error, not a corrupt file', async () => {
    const { sealed, entry } = await setup()
    const err = await downloadSealedAsset(entry, new Map(), undefined, at({ 'https://one.example/app': sealed })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(SealedAssetCorruptError)
    expect((err as Error).message).toMatch(/keys you hold/)
  })

  it('shows control and text-direction characters in a name as U+FFFD', () => {
    expect(displayAssetName('evil‮gpj.exe')).toBe('evil�gpj.exe')
    expect(displayAssetName('a\u0000b⁦c‏d')).toBe('a�b�c�d')
    expect(displayAssetName('app-1.0.tar.gz')).toBe('app-1.0.tar.gz')
  })

  it('never opens an external link as sealed', async () => {
    const { keyring, entry } = await setup()
    const link: ReleaseAsset = { name: 'x', sha256: '', sizeBytes: 0, uris: ['https://github.com/o/r/releases/download/v1/x'] }
    expect(isSealedAsset(link)).toBe(false)
    expect(isSealedAsset(entry)).toBe(true)
    await expect(downloadSealedAsset(link, keyring)).rejects.toThrow(/external link/)
  })
})

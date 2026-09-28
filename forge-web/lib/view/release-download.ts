/**
 * Verified release-asset download (`ux-dx-spec.md` §5.9): stream the asset from any of its
 * recorded places, hash it with SHA-256 as it arrives, and hand the bytes back only when the
 * hash (and the recorded size, when there is one) matches. A mismatch is an error the view
 * turns red; nothing is saved.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'

import { UNVERIFIABLE_ASSET, assetVerifiable, type ReleaseAssetView } from '../repo/releases'
import { externalFetchUrls } from './browse-source'
import { urlHost } from './format'

/** Hand bytes to the browser as a download named `filename` (browser only). */
export function saveBytes(bytes: Uint8Array, filename: string, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** The bytes one place served did not match the published hash. */
export class AssetHashMismatchError extends Error {
  constructor(
    readonly host: string,
    readonly got: string,
    readonly want: string,
  ) {
    super(`${host} served bytes whose SHA-256 is ${got.slice(0, 12)}…, not the published ${want.slice(0, 12)}…`)
    this.name = 'AssetHashMismatchError'
  }
}

export interface DownloadProgress {
  readonly bytes: number
  readonly total: number | null
}

async function readHashed(
  url: string,
  asset: ReleaseAssetView,
  onProgress: (p: DownloadProgress) => void,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const resp = await fetchImpl(url, { signal })
  if (!resp.ok) throw new Error(`${urlHost(url)}: HTTP ${resp.status}`)
  const hash = sha256.create()
  const parts: Uint8Array[] = []
  let total = 0
  const take = (chunk: Uint8Array): void => {
    total += chunk.length
    if (asset.size !== null && total > asset.size) throw new Error(`${urlHost(url)}: more bytes than the published size`)
    hash.update(chunk)
    parts.push(chunk)
    onProgress({ bytes: total, total: asset.size })
  }
  if (resp.body === null) take(new Uint8Array(await resp.arrayBuffer()))
  else {
    const reader = resp.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      take(value)
    }
  }
  const got = bytesToHex(hash.digest())
  if (got !== asset.sha256) throw new AssetHashMismatchError(urlHost(url), got, asset.sha256)
  return concatBytes(...parts)
}

/**
 * Download an asset, trying each place in turn. Resolves only with bytes that hash to
 * `asset.sha256`; rejects with {@link AssetHashMismatchError} when a place served other bytes
 * and none served the right ones.
 */
export async function downloadVerifiedAsset(
  asset: ReleaseAssetView,
  onProgress: (p: DownloadProgress) => void = () => undefined,
  opts: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal; readonly gateways?: readonly string[] } = {},
): Promise<Uint8Array> {
  // No recorded hash: nothing to verify against, so nothing is fetched (D-517).
  if (!assetVerifiable(asset)) throw new Error(UNVERIFIABLE_ASSET)
  // A host that refuses cross-origin reads always fails here; the view links to it instead.
  const urls = browserFetchUrls(asset, opts.gateways)
  if (urls.length === 0) throw new Error('no place a browser can download this asset from is recorded')
  const fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init))
  let mismatch: AssetHashMismatchError | null = null
  const reasons: string[] = []
  for (const url of urls) {
    try {
      return await readHashed(url, asset, onProgress, fetchImpl, opts.signal)
    } catch (e) {
      if (opts.signal?.aborted) throw e
      if (e instanceof AssetHashMismatchError) mismatch ??= e
      reasons.push(e instanceof Error ? e.message : String(e))
    }
  }
  if (mismatch !== null) throw mismatch
  throw new Error(`the asset could not be downloaded: ${reasons.join('; ')}`)
}

/**
 * Release-download hosts whose responses carry no `Access-Control-Allow-Origin` (checked
 * 2026-09-27: `github.com/<o>/<r>/releases/download/…` answers 302 to
 * `release-assets.githubusercontent.com` and neither sends the header; GitLab's release links
 * are the same). A page may link to their files but can never read them (L-13), so the
 * in-browser verified download would always fail with "Failed to fetch".
 */
const NO_CORS_HOSTS = ['github.com', 'gitlab.com']

/** Whether `url` is on a host a page cannot read (see {@link NO_CORS_HOSTS}). */
function noCorsHost(url: string): boolean {
  const host = urlHost(url).toLowerCase()
  return NO_CORS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * Whether this page can read `asset` itself (and so verify it as it downloads): some place it
 * is recorded at is not a host known to refuse cross-origin reads. Imported GitHub and GitLab
 * assets are not; the owner's own storage (S3, IPFS gateways) is.
 */
export function browserReadable(asset: ReleaseAssetView, gateways?: readonly string[]): boolean {
  return browserFetchUrls(asset, gateways).length > 0
}

/** The places this page can read `asset` from: public ones, minus hosts that refuse pages. */
function browserFetchUrls(asset: ReleaseAssetView, gateways?: readonly string[]): string[] {
  return externalFetchUrls(asset.uris, gateways).filter((u) => !noCorsHost(u))
}

/**
 * Places a person can download an asset from directly, when the in-browser download cannot
 * read it (D-056: GitHub asset URLs send no CORS header, so a page may link to them but not
 * fetch them). Only https URLs the release records; the browser's own download takes it.
 */
export function directDownloadUrls(asset: ReleaseAssetView, gateways?: readonly string[]): string[] {
  return externalFetchUrls(asset.uris, gateways).filter((u) => u.startsWith('https://'))
}

/**
 * Check a file the person downloaded themselves against the published SHA-256 (and size),
 * without uploading it anywhere: it is read and hashed in this tab.
 */
export async function checkDownloadedFile(
  file: Blob,
  asset: Pick<ReleaseAssetView, 'sha256' | 'size'>,
): Promise<{ readonly ok: boolean; readonly sha256: string; readonly sizeMatches: boolean }> {
  const hash = sha256.create()
  const reader = file.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
  }
  const got = bytesToHex(hash.digest())
  const sizeMatches = asset.size === null || asset.size === file.size
  return { ok: got === asset.sha256 && sizeMatches, sha256: got, sizeMatches }
}

/**
 * Verified release-asset download (`ux-dx-spec.md` §5.9): stream the asset from any of its
 * recorded places, hash it with SHA-256 as it arrives, and hand the bytes back only when the
 * hash (and the recorded size, when there is one) matches. A mismatch is an error the view
 * turns red; nothing is saved.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import type { ReleaseAssetView } from '../repo/releases'
import { externalFetchUrls } from './browse-source'

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

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

async function readHashed(
  url: string,
  asset: ReleaseAssetView,
  onProgress: (p: DownloadProgress) => void,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const resp = await fetchImpl(url, { signal })
  if (!resp.ok) throw new Error(`${hostOf(url)}: HTTP ${resp.status}`)
  const hash = sha256.create()
  const parts: Uint8Array[] = []
  let total = 0
  const take = (chunk: Uint8Array): void => {
    total += chunk.length
    if (asset.size !== null && total > asset.size) throw new Error(`${hostOf(url)}: more bytes than the published size`)
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
  if (got !== asset.sha256) throw new AssetHashMismatchError(hostOf(url), got, asset.sha256)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
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
  const urls = externalFetchUrls(asset.uris, opts.gateways)
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

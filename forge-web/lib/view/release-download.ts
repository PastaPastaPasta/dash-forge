/**
 * Verified release-asset download (`ux-dx-spec.md` §5.9): stream the asset from any of its
 * recorded places, hash it with SHA-256 as it arrives, and hand the bytes back only when the
 * hash (and the recorded size, when there is one) matches. A mismatch is an error the view
 * turns red; nothing is saved.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'

import { PACK_KIND } from '../constants'
import {
  HEADER_LEN,
  ManifestMismatchError,
  PackError,
  RELEASE_MANIFEST_MAX_BYTES,
  isLate,
  parseHeader,
  type OpenContext,
  openReleaseAsset,
  openReleaseManifest,
  type EpochKeyring,
  type ReleaseAsset,
  type ReleaseFields,
  type ReleaseManifest,
} from '../private'
import type { RepoRef } from '../repo/contract'
import { readPackCopies, type PackManifest } from '../repo/packs'
import { UNVERIFIABLE_ASSET, assetVerifiable, type ReleaseAssetView } from '../repo/releases'
import { externalFetchUrls, loadArtifactBytes } from './browse-source'
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
  asset: Pick<ReleaseAssetView, 'sha256' | 'size'>,
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

/** How a verified download fetches: the fetch to use, its abort signal, the IPFS gateways. */
interface DownloadOptions {
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
  readonly gateways?: readonly string[]
}

/**
 * Download an asset, trying each place in turn. Resolves only with bytes that hash to
 * `asset.sha256`; rejects with {@link AssetHashMismatchError} when a place served other bytes
 * and none served the right ones.
 */
export async function downloadVerifiedAsset(
  asset: ReleaseAssetView,
  onProgress: (p: DownloadProgress) => void = () => undefined,
  opts: DownloadOptions = {},
): Promise<Uint8Array> {
  // No recorded hash: nothing to verify against, so nothing is fetched (D-517).
  if (!assetVerifiable(asset)) throw new Error(UNVERIFIABLE_ASSET)
  return readFirstHashed(asset, asset, onProgress, opts)
}

/**
 * The bytes of the first of `at`'s places that hash to `object.sha256` (see
 * {@link downloadVerifiedAsset}).
 */
async function readFirstHashed(
  at: Pick<ReleaseAssetView, 'uris'>,
  object: Pick<ReleaseAssetView, 'sha256' | 'size'>,
  onProgress: (p: DownloadProgress) => void,
  opts: DownloadOptions,
): Promise<Uint8Array> {
  // A host that refuses cross-origin reads always fails here; the view links to it instead.
  const urls = browserFetchUrls(at, opts.gateways)
  if (urls.length === 0) throw new Error('no place a browser can download this asset from is recorded')
  const fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init))
  let mismatch: AssetHashMismatchError | null = null
  const reasons: string[] = []
  for (const url of urls) {
    try {
      return await readHashed(url, object, onProgress, fetchImpl, opts.signal)
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
export function browserReadable(asset: Pick<ReleaseAssetView, 'uris'>, gateways?: readonly string[]): boolean {
  return browserFetchUrls(asset, gateways).length > 0
}

/** The places this page can read `asset` from: public ones, minus hosts that refuse pages. */
function browserFetchUrls(asset: Pick<ReleaseAssetView, 'uris'>, gateways?: readonly string[]): string[] {
  return externalFetchUrls(asset.uris, gateways).filter((u) => !noCorsHost(u))
}

/**
 * Places a person can download an asset from directly, when the in-browser download cannot
 * read it (D-056: GitHub asset URLs send no CORS header, so a page may link to them but not
 * fetch them). Only https URLs the release records; the browser's own download takes it.
 */
export function directDownloadUrls(asset: Pick<ReleaseAssetView, 'uris'>, gateways?: readonly string[]): string[] {
  return externalFetchUrls(asset.uris, gateways).filter((u) => u.startsWith('https://'))
}

/** What {@link checkDownloadedFile} found. */
export type DownloadedFileCheck =
  | { readonly kind: 'match' }
  /** The published size is known and the file is another size: it was not hashed. */
  | { readonly kind: 'wrong-size'; readonly size: number; readonly want: number }
  | { readonly kind: 'wrong-hash'; readonly sha256: string }

/**
 * Check a file the person downloaded themselves against the published size and SHA-256,
 * without uploading it anywhere: it is read and hashed in this tab. A file of the wrong size
 * cannot match, so it is not read at all (it may be gigabytes).
 */
export async function checkDownloadedFile(file: Blob, asset: Pick<ReleaseAssetView, 'sha256' | 'size'>): Promise<DownloadedFileCheck> {
  if (asset.size !== null && asset.size !== file.size) return { kind: 'wrong-size', size: file.size, want: asset.size }
  const hash = sha256.create()
  const reader = file.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
  }
  const got = bytesToHex(hash.digest())
  return got === asset.sha256 ? { kind: 'match' } : { kind: 'wrong-hash', sha256: got }
}

// ---------------------------------------------------------------------------------------------
// Sealed releases (`private-repos.md` §16.5)
// ---------------------------------------------------------------------------------------------

/** A sealed release's asset list could not be opened: shown as "asset list unavailable". */
export class ReleaseManifestUnavailableError extends Error {
  constructor(
    tag: string,
    /** Why each copy failed, in the order tried. */
    readonly reasons: readonly string[],
  ) {
    super(`the asset list of release ${tag} is unavailable${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}`)
    this.name = 'ReleaseManifestUnavailableError'
  }
}

/**
 * The kind-4 asset list a sealed revision names (§16.5 reader rules; forge-core
 * `release_manifest`): every recorded copy of TLV 21's `packHash`, each refused over the 1 MiB
 * cap before anything is fetched, then its sealed bytes checked against TLV 21, opened with the
 * key of its header's epoch from `keys`, and checked for canonical JSON, the tag, the total, the
 * entries and `notes` against flag 0x10. The first copy that passes wins. §8.2's "uploaded under
 * an old key" flag does not apply: the maintainer's `enc` commits to the exact bytes.
 */
export async function loadReleaseManifest(sdk: EvoSDK, repo: RepoRef, fields: ReleaseFields, keys: EpochKeyring): Promise<ReleaseManifest> {
  return (await loadReleaseManifestStanding(sdk, repo, fields, keys)).manifest
}

/** A sealed release's opened asset list, and whether it was uploaded under an old key ({@link assetListUploadedLate}). */
export interface OpenedReleaseManifest {
  readonly manifest: ReleaseManifest
  /** Judged only with the epochs (`standing`); false without them. */
  readonly uploadedLate: boolean
}

/** What judges an asset list's upload time (§8.2): the repo's epochs, as a session resolves them. */
export type ListStanding = Pick<OpenContext, 'anchors' | 'burned'>

/**
 * Whether a sealed asset list was uploaded under an old key (§16.5, §8.2; forge-core
 * `late_asset_lists`): its first copy (`copies`: every kind-4 `packManifest` of its hash; a later
 * copy re-stores the same bytes) was recorded after `H(next(e)) + GRACE_BLOCKS` for the epoch `e`
 * its sealed header (`sealed`) names, or under a burned epoch. It stays readable (the revision's
 * `enc` commits to it), but a member removed by the rotation may read it: maintainers are warned.
 */
export function assetListUploadedLate(sealed: Uint8Array, copies: readonly { readonly createdAtBlockHeight?: number }[], standing: ListStanding): boolean {
  const heights = copies.flatMap((c) => (c.createdAtBlockHeight !== undefined && c.createdAtBlockHeight > 0 ? [c.createdAtBlockHeight] : []))
  if (heights.length === 0) return false
  let epoch: number
  try {
    epoch = parseHeader(sealed).epoch
  } catch {
    return false
  }
  return isLate(standing.anchors, NOBODY, epoch, Math.min(...heights), NO_OWNER, standing.burned)
}

/** No current member: the upload cut-off applies to every uploader ({@link assetListUploadedLate}). */
const NOBODY = { has: (): boolean => false }
const NO_OWNER = new Uint8Array(32)

/**
 * {@link loadReleaseManifest}, and whether the list was uploaded under an old key, judged with
 * `standing` when given ({@link assetListUploadedLate}).
 */
export async function loadReleaseManifestStanding(
  sdk: EvoSDK,
  repo: RepoRef,
  fields: ReleaseFields,
  keys: EpochKeyring,
  standing?: ListStanding,
): Promise<OpenedReleaseManifest> {
  const hash = fields.assetManifest
  if (hash === undefined) throw new ReleaseManifestUnavailableError(fields.tag, ['the release names no asset list'])
  const pack = await readPackCopies(sdk, repo, hash, PACK_KIND.RELEASE_ASSETS, true)
  const copies = pack?.copies ?? []
  if (copies.length === 0) throw new ReleaseManifestUnavailableError(fields.tag, [`no copy of asset list ${hash.slice(0, 12)}… is recorded`])
  // The stored (sealed) bytes: read without the session, which would open them as a pack.
  const { session: _session, ...stored } = repo
  void _session
  const reasons: string[] = []
  for (const copy of copies) {
    if (copy.sizeBytes > RELEASE_MANIFEST_MAX_BYTES) {
      reasons.push(`a copy claims ${copy.sizeBytes} bytes, over the 1 MiB cap`)
      continue
    }
    try {
      // One copy on its own: each is checked against TLV 21 here, not against the others.
      const { copies: _all, ...one } = copy
      void _all
      const sealed = await loadArtifactBytes(sdk, stored, one satisfies PackManifest)
      const manifest = await openReleaseManifest(sealed, copy.sizeBytes, hexToBytes(hash), fields.tag, fields.notesContinue === true, keys)
      return { manifest, uploadedLate: standing !== undefined && assetListUploadedLate(sealed, copies, standing) }
    } catch (e) {
      reasons.push(e instanceof ManifestMismatchError ? 'the asset list does not match the release that names it' : e instanceof Error ? e.message : String(e))
    }
  }
  throw new ReleaseManifestUnavailableError(fields.tag, reasons)
}

/** C0 and C1 controls, DEL, bidi embeddings, overrides and isolates, LRM, RLM and ALM. */
const DISGUISING_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩؜]/g

/**
 * An asset name as this page shows it and saves it: control and text-direction characters, which
 * could disguise a name (`evil‮gpj.exe`), each shown as U+FFFD. The manifest is a
 * maintainer's, and the writer refuses such names; this is defence in depth for other writers'.
 */
export function displayAssetName(name: string): string {
  return name.replace(DISGUISING_CHARS, '�')
}

/** Whether `asset` is a sealed object; else an external link, never opened and never verified. */
export function isSealedAsset(asset: ReleaseAsset): asset is ReleaseAsset & { readonly sealedSha256: string; readonly sealedSizeBytes: number } {
  return asset.sealedSha256 !== undefined && asset.sealedSizeBytes !== undefined
}

/** A sealed asset's bytes did not open to the file its entry describes: nothing is saved. */
export class SealedAssetCorruptError extends Error {
  constructor(name: string) {
    super(`${name} does not match its recorded SHA-256 after decryption`)
    this.name = 'SealedAssetCorruptError'
  }
}

/**
 * The first {@link HEADER_LEN} bytes of the sealed object `asset` names (§3.2), from the first of
 * its places that serves them (a ranged read; a host that ignores the range is read only that
 * far). A sealed release writer checks with it that an earlier attempt's files are still stored
 * before naming them again (`sealed-release.ts`). Rejects when no place answers.
 */
export async function readSealedAssetHeader(asset: ReleaseAsset, opts: DownloadOptions = {}): Promise<Uint8Array> {
  const fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init))
  const reasons: string[] = []
  for (const url of browserFetchUrls(asset, opts.gateways)) {
    try {
      const resp = await fetchImpl(url, { headers: { Range: `bytes=0-${HEADER_LEN - 1}` }, credentials: 'omit', cache: 'no-store', signal: opts.signal })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const head = await firstBytes(resp, HEADER_LEN)
      if (head.length === HEADER_LEN) return head
      reasons.push(`${urlHost(url)}: ${head.length} bytes`)
    } catch (e) {
      reasons.push(`${urlHost(url)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new Error(`${asset.name} is not stored at any place this page can read: ${reasons.join('; ') || 'none recorded'}`)
}

/** Up to the first `n` bytes of `resp`'s body; the rest is not downloaded. */
async function firstBytes(resp: Response, n: number): Promise<Uint8Array> {
  if (resp.body === null) return new Uint8Array(await resp.arrayBuffer()).slice(0, n)
  const reader = resp.body.getReader()
  const parts: Uint8Array[] = []
  let got = 0
  try {
    while (got < n) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      got += value.length
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return concatBytes(...parts).slice(0, n)
}

/**
 * Download a sealed asset verified (§16.5, as `dg release download`): the sealed object from each
 * place in turn, keeping the first whose bytes hash to `sealedSha256` (and are no longer than
 * `sealedSizeBytes`); then opened with the key of its header's epoch, truncated to `sizeBytes`
 * and checked against the plaintext `sha256`. Rejects with {@link AssetHashMismatchError} when a
 * place served other sealed bytes and none served the right ones, and with
 * {@link SealedAssetCorruptError} when the right ones do not open to the file.
 */
export async function downloadSealedAsset(
  asset: ReleaseAsset,
  keys: EpochKeyring,
  onProgress: (p: DownloadProgress) => void = () => undefined,
  opts: DownloadOptions = {},
): Promise<Uint8Array> {
  if (!isSealedAsset(asset)) throw new Error('an external link is not downloaded here: open it at its source')
  const sealed = await readFirstHashed(asset, { sha256: asset.sealedSha256, size: asset.sealedSizeBytes }, onProgress, opts)
  try {
    return await openReleaseAsset(sealed, asset, keys)
  } catch (e) {
    // These are the sealed bytes the manifest names: every copy fails their checks the same way.
    if (e instanceof PackError && (e.code === 'sealedPackCorrupt' || e.code === 'sizeMismatch')) throw new SealedAssetCorruptError(asset.name)
    // Anything else is this reader's keys (an epoch it can't read yet, say): not the file's fault,
    // and a later try, with a fresh session, may open it.
    throw new Error(`${asset.name} can't be opened with the keys you hold now${e instanceof PackError && e.code === 'noKey' ? ' (it is sealed under a key you don’t have yet)' : ''}`)
  }
}

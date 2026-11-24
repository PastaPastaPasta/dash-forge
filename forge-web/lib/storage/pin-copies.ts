/**
 * Copies of a public repository's packs on the user's own storage (`docs/design/pin-and-fork-copies.md`):
 * which packs a pin covers, which address its `packMirror` record names, and the copy a pin
 * and a fork make. Bytes are read through the verified read path and stored with the same
 * verified upload a push uses ({@link storeFile}).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { PACK_KIND } from '../constants'
import type { RepoRef } from '../repo/contract'
import { packsOfKind, readBrowseManifests, readRepoPackManifests, type PackManifest } from '../repo/packs'
import { DOC_PACK_MIRROR, mirrorsBy, mirrorUrisProblem, recordMirror, type OwnMirror } from '../repo/pack-mirrors'
import { EXISTING, previewCreate, sumPreviews, type CostPreview, type WriteAuth } from '../sdk'
import { loadArtifactBytesProgress } from '../view/browse-source'
import { gatewayUrl } from './ipfs'
import { artifactKey, profileProblem, publishProblem, type StoragePolicy, type StorageProfile } from './profiles'
import { publicObjectUrl } from './s3'
import { externalTargets, storeFile } from './upload'
import { errText } from './util'

/** The pack kinds a pin copies: a public repo's git packs and the indexes and bodies readers fetch. */
export const PIN_KINDS: readonly number[] = [
  PACK_KIND.GIT_PACK,
  PACK_KIND.OBJECT_LOCATOR,
  PACK_KIND.FLAT_INDEX,
  PACK_KIND.HISTORY_INDEX,
  PACK_KIND.HISTORY_VERSIONS,
  PACK_KIND.LONG_BODY,
]

/** The largest pack a browser copies (it is held in memory); larger ones need `dg repo pin`. */
export const COPY_MAX_BYTES = 512 * 1024 * 1024

/** One pack a pin covers. */
export interface RepoPack {
  readonly packHash: string
  readonly sizeBytes: number
  /** The pack with every copy in reader order, for the verified read. */
  readonly source: PackManifest
}

/** Profiles others can read a copy from: S3 with a public URL, or an IPFS node. Never Platform. */
export function copyableProfiles(profiles: readonly StorageProfile[]): StorageProfile[] {
  return profiles.filter((p) => p.settings.kind !== 'platform' && profileProblem(p) === null && publishProblem(p) === null)
}

/** Where a fork copies to: the default policy's first external target that others can read. */
export function forkCopyProfile(config: { readonly profiles: readonly StorageProfile[]; readonly defaultPolicy: StoragePolicy | null } | null): StorageProfile | null {
  if (config === null) return null
  const usable = copyableProfiles(config.profiles)
  const name = externalTargets(config.defaultPolicy, config.profiles).find((n) => usable.some((p) => p.name === n))
  return usable.find((p) => p.name === name) ?? null
}

/** Every pack members list (deduplicated by hash, superseded ones included), in pack-list order. */
export function repoPacks(manifests: readonly PackManifest[]): RepoPack[] {
  const seen = new Set<string>()
  const out: RepoPack[] = []
  for (const kind of PIN_KINDS) {
    for (const p of packsOfKind(manifests, kind)) {
      const hash = p.packHash.toLowerCase()
      if (seen.has(hash)) continue
      seen.add(hash)
      out.push({ packHash: hash, sizeBytes: p.sizeBytes, source: p })
    }
  }
  return out
}

/**
 * The one address a pin records from a stored copy's URIs: the public `https://` URL (an S3
 * public URL, an IPFS public gateway; kind 1), else `ipfs://<cid>` (kind 2).
 */
export function mirrorAddress(stored: readonly string[]): string[] {
  const https = stored.find((u) => u.startsWith('https://'))
  const ipfs = stored.find((u) => u.startsWith('ipfs://'))
  const uris = https !== undefined ? [https] : ipfs !== undefined ? [ipfs] : []
  const problem = mirrorUrisProblem(uris)
  if (problem !== null) throw new Error(`this copy's address cannot be recorded: ${problem}`)
  return uris
}

/** A repository's packs against the signer's records of them. */
export interface PinStatus {
  readonly packs: readonly RepoPack[]
  readonly mine: readonly OwnMirror[]
  /** Packs with no record of the signer's that a browser can copy. */
  readonly missing: readonly RepoPack[]
  /** Packs with no record that are too large for a browser. */
  readonly tooLarge: readonly RepoPack[]
}

export function pinStatus(packs: readonly RepoPack[], mine: readonly OwnMirror[]): PinStatus {
  const have = new Set(mine.map((m) => m.packHash.toLowerCase()))
  const open = packs.filter((p) => !have.has(p.packHash))
  return { packs, mine, missing: open.filter((p) => p.sizeBytes <= COPY_MAX_BYTES), tooLarge: open.filter((p) => p.sizeBytes > COPY_MAX_BYTES) }
}

/** "Pin", "Pinned", or "Update pin (N new)". */
export function pinLabel(status: PinStatus | null): string {
  if (status === null || status.mine.length === 0) return 'Pin'
  return status.missing.length === 0 ? 'Pinned' : `Update pin (${status.missing.length} new)`
}

export async function readPinStatus(sdk: EvoSDK, repo: RepoRef, me: string): Promise<PinStatus> {
  const [manifests, mine] = await Promise.all([readBrowseManifests(sdk, repo), mirrorsBy(sdk, repo, me)])
  return pinStatus(repoPacks(manifests), mine)
}

/** An address of the length `profile` records, for the price. */
function sampleAddress(profile: StorageProfile | null): string {
  const cid = `bafkrei${'a'.repeat(52)}`
  const s = profile?.settings
  if (s?.kind === 's3') return publicObjectUrl(s, artifactKey(s, 'a'.repeat(64)))
  if ((s?.kind === 'ipfs-kubo' || s?.kind === 'ipfs-pinning-service') && s.publicGateway !== '') return gatewayUrl(s.publicGateway, cid)
  return `ipfs://${cid}`
}

/** One `packMirror` per pack; the first builds the repo's subtree when the signer has none yet. */
export function pinCost(count: number, profile: StorageProfile | null, firstInRepo: boolean): CostPreview {
  const uris = [sampleAddress(profile)]
  return sumPreviews(Array.from({ length: count }, (_, i) => previewCreate(DOC_PACK_MIRROR, { uris }, i === 0 && firstInRepo ? { repo: true } : EXISTING)))
}

export type FetchBytes = (pack: RepoPack, signal?: AbortSignal) => Promise<Uint8Array>

/** Read `pack` (verified) from `repo` and store it on `profile`; the stored copy's URIs. */
export async function copyPack(sdk: EvoSDK, repo: RepoRef, pack: RepoPack, profile: StorageProfile, opts: { readonly signal?: AbortSignal; readonly fetchBytes?: FetchBytes } = {}): Promise<string[]> {
  if (pack.sizeBytes > COPY_MAX_BYTES) throw new Error(`over 512 MiB: use dg repo pin ${repo.ownerId}/${repo.name}`)
  const bytes = await (opts.fetchBytes ? opts.fetchBytes(pack, opts.signal) : loadArtifactBytesProgress(sdk, repo, pack.source, undefined, opts.signal, true))
  if (bytesToHex(sha256(bytes)) !== pack.packHash) throw new Error('the downloaded bytes do not match the pack')
  if (opts.signal?.aborted) throw new Error('Cancelled')
  const stored = await storeFile(bytes, { policy: { targets: [profile.name], replicas: 1, platformFallback: false }, profiles: [profile], sha256Hex: pack.packHash })
  return [...stored.uris]
}

export type CopyState = 'copying' | 'done' | 'skipped' | 'failed'
export interface CopyRow {
  readonly index: number
  readonly total: number
  readonly packHash: string
  readonly sizeBytes: number
  readonly state: CopyState
  readonly why?: string
}
export interface CopySummary {
  readonly recorded: number
  readonly failed: number
  readonly sizeBytes: number
}

/**
 * Copy each pack to `profile` and record it, one at a time. A pack that cannot be read or stored
 * is reported and skipped; a record Platform refuses stops the run (the next would be refused too).
 */
export async function pinPacks(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  profile: StorageProfile,
  packs: readonly RepoPack[],
  opts: { readonly signal?: AbortSignal; readonly onProgress?: (row: CopyRow) => void; readonly fetchBytes?: FetchBytes; readonly intent?: string } = {},
): Promise<CopySummary> {
  if (repo.visibility !== 'public') throw new Error('only a public repository can be pinned to your storage')
  let recorded = 0
  let failed = 0
  let sizeBytes = 0
  for (const [i, pack] of packs.entries()) {
    const report = (state: CopyState, why?: string): void =>
      opts.onProgress?.({ index: i + 1, total: packs.length, packHash: pack.packHash, sizeBytes: pack.sizeBytes, state, ...(why ? { why } : {}) })
    if (opts.signal?.aborted) break
    report('copying')
    let uris: string[]
    try {
      uris = mirrorAddress(await copyPack(sdk, repo, pack, profile, opts))
    } catch (e) {
      failed++
      report('failed', opts.signal?.aborted ? 'Cancelled; press Pin to resume.' : errText(e))
      continue
    }
    try {
      await recordMirror(sdk, auth, repo, pack.packHash, uris, opts.intent ? `${opts.intent}:${pack.packHash}` : undefined)
    } catch (e) {
      report('failed', errText(e))
      throw e
    }
    recorded++
    sizeBytes += pack.sizeBytes
    report('done')
  }
  return { recorded, failed, sizeBytes }
}

/** A fork's copy of one parent pack: its URIs on the forker's storage, or null to keep it by reference. */
export type CopyPack = (packHash: string, source?: PackManifest) => Promise<readonly string[] | null>

/**
 * The copier a fork (and a fork's sync) uses: each parent pack read from `parent` and stored on
 * `profile`. A pack it cannot copy stays by reference, as before, and is reported.
 */
export function forkCopier(sdk: EvoSDK, parent: RepoRef, profile: StorageProfile, onCopy?: (packHash: string, state: CopyState, why?: string) => void): CopyPack {
  let packs: Promise<Map<string, PackManifest>> | null = null
  return async (packHash, source) => {
    const hash = packHash.toLowerCase()
    let src = source
    if (src === undefined) {
      packs ??= readRepoPackManifests(sdk, parent).then((ms) => new Map(packsOfKind(ms, PACK_KIND.GIT_PACK).map((p) => [p.packHash.toLowerCase(), p])))
      src = (await packs).get(hash)
    }
    if (src === undefined || src.sizeBytes > COPY_MAX_BYTES) {
      onCopy?.(hash, 'skipped', src === undefined ? 'not found' : 'over 512 MiB')
      return null
    }
    onCopy?.(hash, 'copying')
    try {
      const uris = await copyPack(sdk, parent, { packHash: hash, sizeBytes: src.sizeBytes, source: src }, profile)
      onCopy?.(hash, 'done')
      return uris
    } catch (e) {
      onCopy?.(hash, 'failed', errText(e))
      return null
    }
  }
}

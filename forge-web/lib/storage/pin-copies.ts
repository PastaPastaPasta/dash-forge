/**
 * Copies of a public repository's packs on the user's own storage (`docs/design/pin-and-fork-copies.md`):
 * which packs a pin covers, which address its `packMirror` record names, and the copy a pin
 * and a fork make. Bytes are read through the verified read path and stored with the same
 * verified upload a push uses ({@link storeFile}).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { PACK_KIND } from '../constants'
import { isPublicHttpsUrl, isTemporaryHost } from '../net'
import { redactSecrets, redactValues } from '../redact'
import type { RepoRef } from '../repo/contract'
import { copyGroups, withOwnCopy, type CopyPack, type SyncManifests } from '../repo/fork'
import { invalidateMembers } from '../repo/members'
import { packsOfKind, readBrowseManifests, readRepoPackManifests, type PackManifest } from '../repo/packs'
import type { PackManifestInput } from '../repo/push'
import { DOC_PACK_MIRROR, forgetMirrorsBy, mirrorsBy, mirrorUrisProblem, recordMirror, type OwnMirror } from '../repo/pack-mirrors'
import { EXISTING, previewCreate, sumPreviews, type CostPreview, type WriteAuth } from '../sdk'
import { loadArtifactBytesProgress } from '../view/browse-source'
import { gatewayUrl } from './ipfs'
import { artifactKey, profileProblem, publishProblem, type StoragePolicy, type StorageProfile } from './profiles'
import { publicObjectUrl } from './s3'
import { sha256Hex } from './sigv4'
import { externalTargets, storeFile } from './upload'
import { errText, timedFetch } from './util'

/** The pack kinds a pin copies: a public repo's git packs and the indexes and bodies readers fetch. */
const PIN_KINDS: readonly number[] = [
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
interface RepoPack {
  readonly packHash: string
  readonly sizeBytes: number
  /** The pack with every copy in reader order, for the verified read. */
  readonly source: PackManifest
}

/** An error's text in one line, with any credential it carries (and `profile`'s secrets) scrubbed. */
function why(e: unknown, profile?: StorageProfile): string {
  const line = redactSecrets(errText(e).split(/\s+/).join(' ').trim())
  return profile === undefined ? line : redactValues(line, Object.values(profile.secrets))
}

/**
 * Whether other readers fetch `url`: a public https URL that is not on this machine, a private
 * network or a temporary tunnel. Parity: forge-core `own_copy::readable_by_others`.
 */
export function readableByOthers(url: string): boolean {
  if (!isPublicHttpsUrl(url)) return false
  try {
    return !isTemporaryHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/** The addresses of a stored copy other readers can use: public https ones and `ipfs://` CIDs. */
export function shareable(stored: readonly string[]): string[] {
  return stored.filter((u) => u.startsWith('ipfs://') || (u.startsWith('https://') && readableByOthers(u)))
}

function publishedAddress(p: StorageProfile): string {
  const s = p.settings
  return s.kind === 's3' ? s.publicUrl : s.kind === 'platform' ? '' : s.publicGateway
}

/**
 * Profiles others can read a copy from: S3 with a public URL, or an IPFS node, whose public
 * address others can fetch. Never Platform. Parity: forge-core `own_copy::pin_profile_problem`.
 */
export function copyableProfiles(profiles: readonly StorageProfile[]): StorageProfile[] {
  return profiles.filter((p) => {
    if (p.settings.kind === 'platform' || profileProblem(p) !== null || publishProblem(p) !== null) return false
    const published = publishedAddress(p)
    return published === '' || readableByOthers(published)
  })
}

/** Where a fork copies to: the default policy's first external target that others can read. */
export function forkCopyProfile(config: { readonly profiles: readonly StorageProfile[]; readonly defaultPolicy: StoragePolicy | null } | null): StorageProfile | null {
  if (config === null) return null
  const usable = copyableProfiles(config.profiles)
  const name = externalTargets(config.defaultPolicy, config.profiles).find((n) => usable.some((p) => p.name === n))
  return usable.find((p) => p.name === name) ?? null
}

/**
 * The profile whose public address (an S3 public URL, an IPFS public gateway) the first URI of
 * one of `owner`'s `manifests` is at: where a fork's earlier packs were copied, so a sync copies
 * the new ones there too. Parity: dg `repo_pin::storage_holding`.
 */
export function storageHolding(
  manifests: readonly Pick<PackManifest, 'uploader' | 'uris'>[],
  owner: string,
  config: { readonly profiles: readonly StorageProfile[] } | null,
): StorageProfile | null {
  if (config === null) return null
  const firsts = manifests.filter((m) => m.uploader === owner).flatMap((m) => m.uris.slice(0, 1))
  return (
    copyableProfiles(config.profiles).find((p) => {
      const base = publishedAddress(p)
      if (base === '') return false
      const prefix = `${base.replace(/\/+$/, '')}/`
      return firsts.some((u) => u.startsWith(prefix))
    }) ?? null
  )
}

/**
 * Every pack of a pinnable kind that a current maintainer or writer lists, deduplicated by hash
 * (superseded ones included), oldest first, its copies of those kinds in reader order. Parity:
 * forge-core `own_copy::pin_groups`.
 */
export function repoPacks(manifests: readonly PackManifest[]): RepoPack[] {
  const member = (c: PackManifest): boolean => c.ownerRole === 'maintainer' || c.ownerRole === 'writer'
  return copyGroups(manifests, (m) => PIN_KINDS.includes(m.kind))
    .filter((copies) => copies.some(member))
    .map((copies) => {
      const rep = copies[0] as PackManifest
      return { packHash: rep.packHash.toLowerCase(), sizeBytes: rep.sizeBytes, source: { ...rep, copies } }
    })
}

/**
 * The one address a pin records from a stored copy's URIs: the public `https://` URL (an S3
 * public URL, an IPFS public gateway; kind 1), else `ipfs://<cid>` (kind 2).
 */
export function mirrorAddress(stored: readonly string[]): string[] {
  const https = stored.find((u) => u.startsWith('https://') && readableByOthers(u))
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

/** "Pin", "Pinned", or "Update pin (N new)", counting every pack without a record (any size). */
export function pinLabel(status: PinStatus | null): string {
  if (status === null || status.mine.length === 0) return 'Pin'
  const open = status.missing.length + status.tooLarge.length
  return open === 0 ? 'Pinned' : `Update pin (${open} new)`
}

/**
 * The pin's status. `fresh`: read the repo's manifests, roles and the signer's records from
 * Platform rather than this session's caches (a CLI pin or unpin since, a new push).
 */
export async function readPinStatus(sdk: EvoSDK, repo: RepoRef, me: string, opts: { readonly fresh?: boolean } = {}): Promise<PinStatus> {
  if (opts.fresh) {
    invalidateMembers(repo)
    forgetMirrorsBy(me)
  }
  const [manifests, mine] = await Promise.all([opts.fresh ? readRepoPackManifests(sdk, repo) : readBrowseManifests(sdk, repo), mirrorsBy(sdk, repo, me)])
  return pinStatus(repoPacks(manifests), mine)
}

const SAMPLE_CID = `bafkrei${'a'.repeat(52)}`

/** An address of the length `profile` records, for the price. */
function sampleAddress(profile: StorageProfile): string {
  return sampleOwnUris(profile)[0] as string
}

/** Addresses of the length a copy on `profile` lists in a fork's manifest, for the price. */
export function sampleOwnUris(profile: StorageProfile): string[] {
  const s = profile.settings
  if (s.kind === 's3') return [publicObjectUrl(s, artifactKey(s, 'a'.repeat(64)))]
  if (s.kind !== 'platform' && s.publicGateway !== '') return [gatewayUrl(s.publicGateway, SAMPLE_CID), `ipfs://${SAMPLE_CID}`]
  return [`ipfs://${SAMPLE_CID}`]
}

/** The manifests a fork or sync writes when it copies to `profile` (null: by reference), for the price. */
export function pricedManifests(plan: Pick<SyncManifests, 'manifests' | 'onPlatform'>, profile: StorageProfile | null): PackManifestInput[] {
  if (profile === null) return [...plan.manifests]
  const own = sampleOwnUris(profile)
  return plan.manifests.map((m) => (plan.onPlatform.has(m.packHash) ? m : withOwnCopy(m, own)))
}

/** One `packMirror` per pack; the first builds the repo's subtree when the signer has none yet. */
export function pinCost(count: number, profile: StorageProfile, firstInRepo: boolean): CostPreview {
  const uris = [sampleAddress(profile)]
  return sumPreviews(Array.from({ length: count }, (_, i) => previewCreate(DOC_PACK_MIRROR, { uris }, i === 0 && firstInRepo ? { repo: true } : EXISTING)))
}

/** The storage refused or failed a copy: every later copy to it would fail the same way. */
export class StoreFailed extends Error {}

/** Read `pack` (verified against its hash) from `repo` and store it on `profile`; the stored copy's URIs. */
async function copyPack(sdk: EvoSDK, repo: RepoRef, pack: RepoPack, profile: StorageProfile, signal?: AbortSignal): Promise<string[]> {
  if (pack.sizeBytes > COPY_MAX_BYTES) throw new Error(`over 512 MiB: use dg repo pin ${repo.ownerId}/${repo.name}`)
  const bytes = await loadArtifactBytesProgress(sdk, repo, pack.source, undefined, signal, true)
  if (signal?.aborted) throw new Error('Cancelled')
  try {
    const stored = await storeFile(bytes, { policy: { targets: [profile.name], replicas: 1, platformFallback: false }, profiles: [profile], sha256Hex: pack.packHash, ...(signal ? { signal } : {}) })
    return [...stored.uris]
  } catch (e) {
    if (signal?.aborted) throw new Error('Cancelled')
    throw new StoreFailed(`${profile.name}: ${why(e, profile)}`)
  }
}

/**
 * Whether `url` serves the pack: a whole anonymous read, at most `sizeBytes` long (or
 * {@link COPY_MAX_BYTES} when unknown), that hashes to `packHash`.
 */
export async function servesPack(url: string, packHash: string, sizeBytes: number, signal?: AbortSignal): Promise<boolean> {
  try {
    const r = await timedFetch(url, { credentials: 'omit', cache: 'no-store' }, signal ? { signal } : {})
    if (!r.resp.ok) {
      r.discard()
      return false
    }
    return (await sha256Hex(await r.bytes(sizeBytes > 0 ? sizeBytes : COPY_MAX_BYTES))) === packHash.toLowerCase()
  } catch {
    return false
  }
}

/**
 * The address a pin records for a copy stored at `stored` ({@link mirrorAddress}), with an
 * https one read back whole first: when it does not serve the pack, the `ipfs://` CID is recorded
 * instead, and with no CID the pack fails (nothing is recorded). Parity: forge-core
 * `OwnCopy::recordable`.
 */
export async function recordableAddress(stored: readonly string[], pack: Pick<RepoPack, 'packHash' | 'sizeBytes'>, signal?: AbortSignal): Promise<string[]> {
  const pick = mirrorAddress(stored)
  const url = pick[0] as string
  if (!url.startsWith('https://')) return pick
  const serves = await servesPack(url, pack.packHash, pack.sizeBytes, signal)
  if (signal?.aborted) throw new Error('Cancelled')
  if (serves) return pick
  const cid = stored.find((u) => u.startsWith('ipfs://'))
  if (cid !== undefined) return mirrorAddress([cid])
  throw new Error(`${new URL(url).host} did not serve the copy whole to an anonymous read, so it was not recorded`)
}

/**
 * A pin's copy of `pack` on `profile` and the address its record names ({@link recordableAddress}).
 * An IPFS public gateway is not checked during the upload: a gateway still fetching the file
 * leaves the `ipfs://` CID to record.
 */
async function pinCopy(sdk: EvoSDK, repo: RepoRef, pack: RepoPack, profile: StorageProfile, signal?: AbortSignal): Promise<string[]> {
  const s = profile.settings
  if ((s.kind !== 'ipfs-kubo' && s.kind !== 'ipfs-pinning-service') || s.publicGateway === '') return recordableAddress(await copyPack(sdk, repo, pack, profile, signal), pack, signal)
  const gateway = s.publicGateway
  const stored = await copyPack(sdk, repo, pack, { ...profile, settings: { ...s, publicGateway: '' } }, signal)
  const cid = stored.find((u) => u.startsWith('ipfs://'))
  return recordableAddress(cid === undefined ? stored : [gatewayUrl(gateway, cid.slice('ipfs://'.length)), ...stored], pack, signal)
}

export type CopyState = 'copying' | 'done' | 'failed'
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
 * Copy each pack to `profile` and record it, one at a time. A pack that cannot be read is
 * reported and skipped; a storage failure or a record Platform refuses stops the run (the next
 * would fail the same way).
 */
export async function pinPacks(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  profile: StorageProfile,
  packs: readonly RepoPack[],
  opts: { readonly signal?: AbortSignal; readonly onProgress?: (row: CopyRow) => void; readonly intent?: string } = {},
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
    const cancelled = (): boolean => {
      if (!opts.signal?.aborted) return false
      report('failed', 'Cancelled; press Pin to resume.')
      return true
    }
    let uris: string[]
    try {
      uris = await pinCopy(sdk, repo, pack, profile, opts.signal)
    } catch (e) {
      if (cancelled()) break
      report('failed', why(e, profile))
      if (e instanceof StoreFailed) throw e
      failed++
      continue
    }
    if (cancelled()) break
    try {
      await recordMirror(sdk, auth, repo, pack.packHash, uris, opts.intent ? `${opts.intent}:${pack.packHash}` : undefined)
    } catch (e) {
      report('failed', why(e))
      throw e
    }
    recorded++
    sizeBytes += pack.sizeBytes
    report('done')
  }
  return { recorded, failed, sizeBytes }
}

/**
 * A fork or sync could not copy a pack to the user's storage: nothing for that pack (and, in a
 * sync, nothing at all) was written. `message` is the one line to show; `why` the detail.
 */
export class CopyFailed extends Error {
  constructor(
    message: string,
    readonly why: string,
  ) {
    super(message)
    this.name = 'CopyFailed'
  }
}

/**
 * The copier a fork (and a fork's sync) uses: each parent pack read from `parent` and stored on
 * `profile`, its addresses other readers can use returned. Any failure throws {@link CopyFailed}
 * before the pack is recorded, so the run stops and a re-run resumes it. `again`: the button that
 * resumes; `cli`: the command for a pack too large for a browser. Parity: forge-core
 * `fork::own_copy_of`.
 */
export function forkCopier(
  sdk: EvoSDK,
  parent: RepoRef,
  profile: StorageProfile,
  opts: { readonly again: string; readonly cli: string; readonly onCopy?: (packHash: string, state: CopyState, why?: string) => void },
): CopyPack {
  let packs: Promise<Map<string, PackManifest>> | null = null
  const sourceOf = async (hash: string): Promise<PackManifest | undefined> => {
    packs ??= readRepoPackManifests(sdk, parent).then((ms) => new Map(packsOfKind(ms, PACK_KIND.GIT_PACK).map((p) => [p.packHash.toLowerCase(), p])))
    try {
      return (await packs).get(hash)
    } catch (e) {
      packs = null
      throw e
    }
  }
  const resume = `A file could not be copied to ${profile.name}. Press ${opts.again} again to finish, or tick "Don't copy" under Storage.`
  return async (packHash, source) => {
    const hash = packHash.toLowerCase()
    const fail = (reason: string, message = resume): never => {
      opts.onCopy?.(hash, 'failed', reason)
      throw new CopyFailed(message, reason)
    }
    let src = source
    if (src === undefined) {
      try {
        src = await sourceOf(hash)
      } catch (e) {
        fail(why(e, profile))
      }
    }
    if (src === undefined) return fail(`not in ${parent.name}'s pack list`)
    if (src.sizeBytes > COPY_MAX_BYTES) fail('over 512 MiB', `A file is over 512 MiB, too large to copy in a browser: use ${opts.cli}, or tick "Don't copy" under Storage.`)
    opts.onCopy?.(hash, 'copying')
    let stored: string[] = []
    try {
      stored = await copyPack(sdk, parent, { packHash: hash, sizeBytes: src.sizeBytes, source: src }, profile)
    } catch (e) {
      fail(e instanceof StoreFailed ? e.message : why(e, profile))
    }
    const own = shareable(stored)
    if (own.length === 0) fail(`${profile.name} stored it at no address others can read`)
    opts.onCopy?.(hash, 'done')
    return own
  }
}

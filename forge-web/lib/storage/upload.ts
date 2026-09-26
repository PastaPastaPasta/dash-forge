/**
 * Browser uploads of pack artifacts under the user's storage policy: the web counterpart of
 * forge-core `storage/targets.rs` (`replicate`, `ExternalTarget`) and `StoredArtifact`.
 *
 * Order of events, the same guarantee the CLI gives: the bytes are stored AND verified on at
 * least `replicas` targets before this resolves, and only then may the caller write the
 * `packManifest` (and after it, refs). Nothing is written to Platform without the user first
 * agreeing to its price ({@link StoreOptions.confirmPlatform}) — asked once, before the first
 * chunk, whether Platform is a target of the policy, the fallback, or the only place.
 *
 * A copy counts as confirmed only when the URLs it records are readable by anyone, as in the
 * CLI (`ExternalTarget::store` re-reads through the first recorded URI):
 *  - S3: the signed API re-read (whole object up to 16 MiB re-hashed; larger: size plus
 *    byte-exact head and tail windows), then an anonymous ranged read of the head and tail
 *    through the public URL — the one readers use;
 *  - IPFS: kubo's CID must equal the local derivation and be pinned, then a re-read through the
 *    node's gateway when one is configured, then an anonymous read through the public gateway
 *    when one is recorded.
 * Every URL recorded must be a public https URL (`lib/net.ts`); a profile whose public address
 * is not is refused before any upload.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { WriteAuth } from '../sdk'
import { estimateChunkCredits } from '../sdk/cost'
import { isRecordableUri } from '../net'
import type { RepoRef } from '../repo/contract'
import { manifestUrisProblem, putPlatformChunks } from '../repo/push'
import { addVerified, gatewayUrl, remotePin } from './ipfs'
import { artifactKey, profileProblem, publishProblem, type StoragePolicy, type StorageProfile } from './profiles'
import { getObject, getPublic, headObject, putObject, publicObjectUrl, s3Uri, type S3Settings } from './s3'
import { sha256Hex } from './sigv4'
import { bytesEqual, errText, timedFetch } from './util'

/** Artifacts up to this size are verified by a full re-download and SHA-256. */
export const FULL_VERIFY_MAX = 16 * 1024 * 1024
const EDGE_WINDOW = 64 * 1024

/** A target that did not confirm. */
export interface TargetFailure {
  readonly target: string
  readonly reason: string
}

/** Progress of one target. */
export type UploadEvent =
  | { readonly target: string; readonly phase: 'start' }
  | { readonly target: string; readonly phase: 'progress'; readonly done: number; readonly total: number }
  | { readonly target: string; readonly phase: 'done'; readonly uris: readonly string[] }
  | { readonly target: string; readonly phase: 'failed'; readonly reason: string }

/** Where an artifact now lives: what its `packManifest` records. */
export interface StoredArtifact {
  readonly packHash: string
  readonly sizeBytes: number
  /** 0 when a Platform copy exists (chunks), else 1. */
  readonly storage: 0 | 1
  readonly chunkCount: number
  /** `platform://` first, then public https URLs, then the rest (`ipfs://`, `s3://`). */
  readonly uris: readonly string[]
  /** Targets that confirmed, in policy order. */
  readonly confirmed: readonly string[]
  readonly failures: readonly TargetFailure[]
}

/** The price of putting `bytes` on Platform, asked before paying it. */
export interface PlatformQuestion {
  readonly bytes: number
  readonly estimateCredits: number
  /** Why Platform is being used: a target of the policy, the fallback, or nothing configured. */
  readonly reason: string
}

/** Fewer than the required targets confirmed. */
export class ReplicationError extends Error {
  constructor(
    readonly required: number,
    readonly confirmed: readonly string[],
    readonly failures: readonly TargetFailure[],
    /** Whether any Platform chunks were written before the policy failed (they stay: chunks are permanent). */
    readonly platformWritten: boolean,
  ) {
    super(
      `storage policy not met: ${confirmed.length} of ${required} required target(s) confirmed` +
        failures.map((f) => `; ${f.target}: ${f.reason}`).join('') +
        (platformWritten
          ? '. Some pack chunks were written to Platform before the push stopped; they are kept, and a retry does not pay for them again. No manifest or ref was written.'
          : '. Nothing was written to Platform.'),
    )
    this.name = 'ReplicationError'
  }
}

/** The user declined to store on Platform. */
export class PlatformDeclinedError extends Error {
  constructor() {
    super('Nothing was stored: storing on Platform was declined. Configure storage in Settings → Storage and try again.')
    this.name = 'PlatformDeclinedError'
  }
}

/** The byte windows compared at both ends of an artifact (the whole of a small one). */
function edgeWindows(size: number): (readonly [number, number])[] {
  if (size <= 2 * EDGE_WINDOW) return [[0, size]]
  return [
    [0, EDGE_WINDOW],
    [size - EDGE_WINDOW, size],
  ]
}

/** Re-read an S3 copy through the signed API and check it is exactly `bytes`. */
async function verifyS3(s: S3Settings, p: StorageProfile, key: string, bytes: Uint8Array, hashHex: string): Promise<void> {
  if (bytes.length <= FULL_VERIFY_MAX) {
    const got = await getObject(s, p.secrets, key)
    if ((await sha256Hex(got)) !== hashHex) throw new Error(`re-read of ${key} returned ${got.length} bytes that do not hash to the artifact`)
    return
  }
  const size = await headObject(s, p.secrets, key)
  if (size !== bytes.length) throw new Error(`re-read of ${key}: object missing or wrong size (${size} ≠ ${bytes.length})`)
  for (const [start, end] of edgeWindows(bytes.length)) {
    const got = await getObject(s, p.secrets, key, `bytes=${start}-${end - 1}`)
    if (!bytesEqual(got, bytes.subarray(start, end))) throw new Error(`re-read of ${key} bytes ${start}..${end} differ from the artifact`)
  }
}

/** Read the head and tail of a copy anonymously, the way every reader will. */
async function verifyPublic(label: string, read: (range: string) => Promise<{ status: number; bytes: Uint8Array }>, bytes: Uint8Array): Promise<void> {
  for (const [start, end] of edgeWindows(bytes.length)) {
    let got: { status: number; bytes: Uint8Array }
    try {
      got = await read(`bytes=${start}-${end - 1}`)
    } catch (e) {
      throw new Error(`${label} is not readable by others from a browser (${errText(e)}): check public access and CORS`)
    }
    if (got.status !== 206 && got.status !== 200) throw new Error(`${label} answered HTTP ${got.status} to an anonymous read: the copy is not public`)
    const slice = got.status === 200 ? got.bytes.subarray(start, end) : got.bytes
    if (!bytesEqual(slice, bytes.subarray(start, end))) throw new Error(`${label} served bytes ${start}..${end} that differ from the artifact`)
  }
}

/** Store and verify on one external profile; the URIs its manifest entry records. */
async function storeExternal(p: StorageProfile, bytes: Uint8Array, hashHex: string): Promise<string[]> {
  const problem = profileProblem(p) ?? publishProblem(p)
  if (problem) throw new Error(`the profile is not usable: ${problem}`)
  const s = p.settings
  if (s.kind === 's3') {
    const key = artifactKey(s, hashHex)
    const existing = await headObject(s, p.secrets, key).catch(() => null)
    if (existing !== bytes.length) await putObject(s, p.secrets, key, bytes)
    try {
      await verifyS3(s, p, key, bytes, hashHex)
    } catch (first) {
      // A same-size but corrupt object at a content-addressed key would fail every push:
      // re-upload once, unconditionally, and check again.
      await putObject(s, p.secrets, key, bytes)
      try {
        await verifyS3(s, p, key, bytes, hashHex)
      } catch (second) {
        throw new Error(`${errText(second)} (also after a re-upload; first attempt: ${errText(first)})`)
      }
    }
    await verifyPublic(`the public URL (${new URL(s.publicUrl).host})`, (range) => getPublic(s, key, range), bytes)
    return [publicObjectUrl(s, key), s3Uri(s, key)]
  }
  if (s.kind === 'ipfs-kubo' || s.kind === 'ipfs-pinning-service') {
    const cid = await addVerified(s, p.secrets, bytes)
    if (s.kind === 'ipfs-pinning-service') await remotePin(s, p.secrets, cid, `dash-forge ${hashHex.slice(0, 16)}`)
    if (s.gateway !== '') {
      const r = await timedFetch(gatewayUrl(s.gateway, cid), { credentials: 'omit', cache: 'no-store' })
      const got = await r.bytes()
      if (!r.resp.ok || (await sha256Hex(got)) !== hashHex) throw new Error(`re-read of ipfs://${cid} through the gateway did not return the artifact`)
    }
    const uris = [`ipfs://${cid}`]
    if (s.publicGateway !== '') {
      const url = gatewayUrl(s.publicGateway, cid)
      await verifyPublic(`the public gateway (${new URL(url).host})`, async (range) => {
        const r = await timedFetch(url, { headers: { Range: range }, credentials: 'omit', cache: 'no-store' })
        return { status: r.resp.status, bytes: await r.bytes() }
      }, bytes)
      uris.unshift(url)
    }
    return uris
  }
  throw new Error('not an external profile')
}

/**
 * Every recorded URI, de-duplicated: the `platform://` locator first (released helpers read
 * `uris[0]` of a storage-0 manifest as the chunk locator), then public https URLs, then the
 * rest — each group in policy order (parity with forge-core `Replication::uris`).
 */
export function orderUris(groups: readonly (readonly string[])[]): string[] {
  const buckets: string[][] = [[], [], []]
  for (const uris of groups) {
    for (const u of uris) {
      const g = u.startsWith('platform://') ? 0 : /^https?:\/\//.test(u) ? 1 : 2
      const bucket = buckets[g] as string[]
      if (!bucket.includes(u)) bucket.push(u)
    }
  }
  return buckets.flat()
}

/**
 * Trim to the manifest's `uris` budget (8 × 300 bytes): private `s3://` locators go first
 * (readers without that profile cannot use them); then an error, never a silent truncation.
 * A URI no reader may fetch (plain http, this machine, a private network) is refused outright:
 * it would be published on chain for every reader's browser to request.
 */
export function fitManifestUris(uris: readonly string[]): string[] {
  const bad = uris.find((u) => !isRecordableUri(u))
  if (bad !== undefined) throw new Error(`refusing to record ${bad} on chain: only public https addresses can be read by others`)
  const fits = (list: readonly string[]): boolean => manifestUrisProblem(list) === null
  if (fits(uris)) return [...uris]
  const noS3 = uris.filter((u) => !u.startsWith('s3://'))
  if (fits(noS3)) return noS3
  throw new Error("the confirmed copies' URIs do not fit a manifest (at most 8, each up to 300 bytes); use shorter public URLs or fewer targets")
}

/** What {@link storeArtifact} needs besides the bytes. */
export interface StoreOptions {
  readonly policy: StoragePolicy | null
  readonly profiles: readonly StorageProfile[]
  /** Asked once, with the price, before anything is written to Platform. False stops it. */
  readonly confirmPlatform: (q: PlatformQuestion) => Promise<boolean>
  readonly onStep?: (e: UploadEvent) => void
}

/**
 * Store `bytes` under `policy`, verifying every copy, and return what the manifest records.
 * Before the first Platform chunk the user is asked, with the price; declining throws
 * {@link PlatformDeclinedError} (nothing configured) or {@link ReplicationError} (the policy
 * needed the Platform copy). Fewer than `replicas` confirmations throws {@link ReplicationError}.
 */
export async function storeArtifact(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  bytes: Uint8Array,
  opts: StoreOptions,
): Promise<StoredArtifact> {
  const hashHex = await sha256Hex(bytes)
  const step = opts.onStep ?? (() => undefined)
  const confirmed: { target: string; uris: string[]; platform: boolean }[] = []
  const failures: TargetFailure[] = []
  let chunkCount = 0
  let platformWritten = false
  let platformAgreed: boolean | null = null

  const fail = (target: string, e: unknown): void => {
    failures.push({ target, reason: errText(e) })
    step({ target, phase: 'failed', reason: errText(e) })
  }
  /** Ask once per push; every Platform write goes through this first. */
  const agreePlatform = async (reason: string): Promise<boolean> => {
    if (platformAgreed === null) {
      platformAgreed = await opts.confirmPlatform({ bytes: bytes.length, estimateCredits: estimateChunkCredits(bytes.length), reason })
    }
    return platformAgreed
  }

  const platformCopy = async (target: string): Promise<void> => {
    step({ target, phase: 'start' })
    try {
      const r = await putPlatformChunks(sdk, auth, repo, bytes, hashHex, (done, total, written) => {
        if (written > 0) platformWritten = true
        step({ target, phase: 'progress', done, total })
      })
      chunkCount = r.chunkCount
      confirmed.push({ target, uris: [r.locator], platform: true })
      step({ target, phase: 'done', uris: [r.locator] })
    } catch (e) {
      fail(target, e)
      throw e
    }
  }

  const policy = opts.policy
  if (policy === null || policy.targets.length === 0) {
    if (!(await agreePlatform('No storage is configured for browser pushes to this repo.'))) throw new PlatformDeclinedError()
    await platformCopy('platform')
  } else {
    const byName = new Map(opts.profiles.map((p) => [p.name, p]))
    const targets = policy.targets.map((name) => ({ name, profile: byName.get(name) }))
    const external = targets.filter((t) => t.profile?.settings.kind !== 'platform')
    const onChain = targets.filter((t) => t.profile?.settings.kind === 'platform')
    await Promise.all(
      external.map(async ({ name, profile }) => {
        step({ target: name, phase: 'start' })
        try {
          if (!profile) throw new Error('no such storage profile in this browser')
          const uris = await storeExternal(profile, bytes, hashHex)
          confirmed.push({ target: name, uris, platform: false })
          step({ target: name, phase: 'done', uris })
        } catch (e) {
          fail(name, e)
        }
      }),
    )
    const notMet = (): ReplicationError => new ReplicationError(policy.replicas, confirmed.map((c) => c.target), failures, platformWritten)
    // Platform targets only if they can still make up the policy: never pay for chunks whose
    // push is about to fail anyway — and never without the user's go-ahead on the price.
    for (const [i, { name }] of onChain.entries()) {
      if (confirmed.length + (onChain.length - i) < policy.replicas) break
      if (!(await agreePlatform(`Your storage policy for this repo includes Dash Platform (${name}).`))) {
        fail(name, new Error('storing on Platform was declined'))
        throw notMet()
      }
      await platformCopy(name).catch(() => undefined)
    }
    if (confirmed.length < policy.replicas) {
      if (!policy.platformFallback || confirmed.some((c) => c.platform)) throw notMet()
      if (!(await agreePlatform(`Your storage did not confirm (${failures.map((f) => f.target).join(', ')}).`))) throw notMet()
      try {
        await platformCopy('platform (fallback)')
      } catch {
        throw notMet()
      }
    }
  }

  // Keep policy order within each URI group.
  const order = policy?.targets ?? []
  confirmed.sort((a, b) => order.indexOf(a.target) - order.indexOf(b.target))
  const hasPlatform = confirmed.some((c) => c.platform)
  return {
    packHash: hashHex,
    sizeBytes: bytes.length,
    storage: hasPlatform ? 0 : 1,
    chunkCount: hasPlatform ? chunkCount : 0,
    uris: fitManifestUris(orderUris(confirmed.map((c) => c.uris))),
    confirmed: confirmed.map((c) => c.target),
    failures,
  }
}

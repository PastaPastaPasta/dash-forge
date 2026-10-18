/**
 * Repositories made public (`docs/security/private-repos.md` §18; DESIGN §4.10, D36; forge-core
 * `private::convert`): the facts every reader derives from the `config` timeline alone, and the
 * epoch keys an owner's make-public bundle publishes.
 *
 * A repository is **converted** when it is public now and has a `config` stamped `vis:
 * "private"`: consensus held every document's `vis` equal to its repository's visibility when it
 * was written, and a repository can only ever go from private to public. Its **seal-off epoch**
 * is the highest existing epoch stated while it was private; only epochs below it may be
 * published. Its **conversion marker** is the first config stamped `vis: "public"`: a pack
 * manifest recorded up to that block height may hold sealed bytes and is checked before it is
 * downloaded.
 */

import { constantTimeEqual, isU32 } from './bytes'
import { ENTRY_EPOCH_KEY, encodeBundle, parseBundle, type Bundle, type BundleEntry } from './bundle'
import { V1 } from './doc'
import { sortAlerts, type Anchor, type EpochAlert } from './epoch'
import { bytesEqual, compareBytes, type PrivateId } from './ids'
import { EpochKeys } from './keys'
import { sniff } from './pack'
import type { Visibility } from '../rules/v2'

/**
 * The minimum Forge version that reads a repository made public (§18): clones, fetches, forks
 * and pages of a converted repository need it.
 */
export const CONVERTED_REPO_MIN_CLIENT_VERSION = '0.2.0'

/** One `config` document as the conversion facts need it. */
export interface ConfigStamp {
  /** `$id` (orders configs of one block). */
  readonly id: PrivateId
  /** `epoch` (null on a plaintext config). */
  readonly epoch: number | null
  /** It is stamped `vis: "private"`. */
  readonly private: boolean
  /** `$createdAtBlockHeight`. */
  readonly height: number
}

/** What a reader knows about a repository made public. */
export interface Conversion {
  /** The highest existing epoch stated while the repository was private; null when none exists (nothing may be published). */
  readonly sealOffEpoch: number | null
  /** The block height of the first `vis: "public"` config; null before one lands (every manifest is then checked). */
  readonly markerHeight: number | null
}

/**
 * The conversion facts of a repository that is public now (`isPublic`), from every one of its
 * configs; `existing` says which epochs exist (§5.3). Null when it was never private.
 */
export function conversionOf(isPublic: boolean, configs: readonly ConfigStamp[], existing: (epoch: number) => boolean): Conversion | null {
  if (!isPublic || !configs.some((c) => c.private)) return null
  let sealOffEpoch: number | null = null
  let markerHeight: number | null = null
  for (const c of configs) {
    if (c.private) {
      if (c.epoch !== null && existing(c.epoch) && (sealOffEpoch === null || c.epoch > sealOffEpoch)) sealOffEpoch = c.epoch
    } else if (c.height > 0 && (markerHeight === null || c.height < markerHeight)) {
      // a config with no block height (0) cannot be placed, so it never marks the conversion
      markerHeight = c.height
    }
  }
  return { sealOffEpoch, markerHeight }
}

/**
 * Whether a pack manifest recorded at block height `height` may hold bytes sealed while the
 * repository was private: at or before the marker's height, or any before a marker exists (a
 * height of 0, unknown, counts). Such a pack's first bytes are checked before it is downloaded.
 */
export function maybeSealed(c: Conversion, height: number): boolean {
  return c.markerHeight === null || height <= c.markerHeight
}

/**
 * Why a reader skips a stored artifact (§3.2, §18.2): `noKey`, sealed under an epoch this reader
 * does not hold; `otherFormat`, a sealed header of a version this client does not open.
 */
export type SkipReason = { readonly reason: 'noKey'; readonly epoch: number } | { readonly reason: 'otherFormat'; readonly version: number }

/**
 * Whether a reader skips an artifact of a PUBLIC repository by its first bytes `head` (at least
 * 12; the whole artifact after a download), holding the epoch keys `holds` says (§18.2): a sealed
 * header under an epoch it does not hold, or of another version. A plaintext head, or one too
 * short to tell, is read as it is.
 */
export function skipReason(head: Uint8Array, holds: (epoch: number) => boolean): SkipReason | null {
  const h = sniff(head)
  if (h.kind === 'sealed' && !holds(h.epoch)) return { reason: 'noKey', epoch: h.epoch }
  if (h.kind === 'otherVersion') return { reason: 'otherFormat', version: h.version }
  return null
}

/**
 * The `vis` a document is opened under (§17, §18.1), or null when it is malformed: its own stamp,
 * which consensus held equal to its repository's visibility when it was written. A repository
 * made public (`converted`) keeps its earlier documents' `"private"`; a type without a stamp (an
 * `event`) is its repository's, except a v0x01 one (`enc0`) in a repository made public, which
 * only the private era wrote. A `"public"` document in a private repository cannot exist.
 */
export function openVis(stamp: unknown, repository: Visibility, converted: boolean, enc0: number | undefined): Visibility | null {
  if (stamp === undefined || stamp === null) return repository === 'public' && converted && enc0 === V1 ? 'private' : repository
  if (stamp === 'private') return 'private'
  if (stamp === 'public' && repository === 'public') return 'public'
  return null
}

/** One make-public bundle: its manifest's `$ownerId` and its (hash-verified) bytes. */
export interface PublishedBundle {
  readonly owner: PrivateId
  readonly bytes: Uint8Array
}

/**
 * The epoch keys a converted repository's owner published (§18.3), raw by epoch, each checked:
 * an entry of type 0x06 counts only in a bundle written by `repoOwner`, naming `repoId`, for an
 * existing epoch below the seal-off epoch, and only when its key commits to that epoch's anchor.
 * A key that does not is a `publishedKeyMismatch` alert and is ignored. Every other entry, a
 * bundle from anyone else and a bundle that does not parse are ignored.
 */
export async function publishedKeys(
  repoId: Uint8Array,
  repoOwner: PrivateId,
  conversion: Conversion,
  anchors: ReadonlyMap<number, Pick<Anchor, 'commit'>>,
  bundles: readonly PublishedBundle[],
): Promise<{ readonly keys: Map<number, Uint8Array>; readonly alerts: EpochAlert[] }> {
  const keys = new Map<number, Uint8Array>()
  const alerts: EpochAlert[] = []
  const sealOff = conversion.sealOffEpoch
  if (sealOff === null) return { keys, alerts }
  for (const b of bundles) {
    if (!bytesEqual(b.owner, repoOwner)) continue
    let parsed: Bundle
    try {
      parsed = parseBundle(b.bytes)
    } catch {
      continue
    }
    for (const e of parsed.entries) {
      if (e.kind !== ENTRY_EPOCH_KEY || !bytesEqual(e.target, repoId) || e.revision >= sealOff) continue
      const commit = anchors.get(e.revision)?.commit
      if (commit == null) continue
      const derived = await EpochKeys.import(repoId, e.revision, e.key)
      if (constantTimeEqual(derived.commit, commit)) {
        if (!keys.has(e.revision)) keys.set(e.revision, e.key)
      } else {
        alerts.push({ kind: 'publishedKeyMismatch', epoch: e.revision, author: b.owner })
      }
    }
  }
  return { keys, alerts: sortAlerts(alerts) }
}

/**
 * The most epoch-key entries one make-public bundle of epoch keys carries: what fits one Platform
 * chunk (14,700 B) beside its header and a full note, `(14,700 − 7 − 1,024) / 69`. More epochs
 * below the seal-off epoch are published in several bundles (forge-core `MAX_EPOCH_ENTRIES`).
 */
export const MAX_EPOCH_ENTRIES = 198

/** The note of every make-public bundle of epoch keys (forge-core `EPOCH_BUNDLE_NOTE`). */
export const EPOCH_BUNDLE_NOTE = 'Everything written before this repository was made public.'

/**
 * The make-public bundles (§18.3) publishing `keys`, raw epoch keys of the repository `repoId`
 * (mixed-visibility DESIGN §4.10 step 7): one 0x06 entry per epoch, in epoch order, at most
 * {@link MAX_EPOCH_ENTRIES} per bundle; none when `keys` is empty. Deterministic and
 * byte-identical to forge-core `epoch_key_bundles`, so "already published" is a manifest of the
 * same `packHash` whichever client wrote it. The caller passes only epochs below the seal-off
 * epoch (readers ignore any other) and wipes the keys and the bundles.
 */
export function epochKeyBundles(repoId: Uint8Array, keys: ReadonlyMap<number, Uint8Array>): Uint8Array[] {
  const entries: BundleEntry[] = [...keys]
    .sort(([a], [b]) => a - b)
    .map(([revision, key]) => ({ kind: ENTRY_EPOCH_KEY, target: repoId, revision, key }))
  const out: Uint8Array[] = []
  for (let i = 0; i < entries.length; i += MAX_EPOCH_ENTRIES) out.push(encodeBundle(entries.slice(i, i + MAX_EPOCH_ENTRIES), EPOCH_BUNDLE_NOTE))
  return out
}

/** The sealed tag-65 value (§18.5), integers in big-endian order. */
export interface SealOffMarker {
  readonly mode: 'codeOnly' | 'everything'
  readonly conversionId: Uint8Array
  readonly boundaryEpoch: number
  readonly startedAtMs: bigint
  readonly replacesEpoch?: number
}

/** Encode the v1 seal-off marker. The timestamp is informational and retains all 64 bits. */
export function encodeSealOffMarker(m: SealOffMarker): Uint8Array {
  if (m.conversionId.length !== 16 || !isU32(m.boundaryEpoch) || m.boundaryEpoch < 1 ||
      (m.mode !== 'codeOnly' && m.mode !== 'everything') || m.startedAtMs < 0n || m.startedAtMs > 0xffff_ffff_ffff_ffffn ||
      (m.replacesEpoch !== undefined && !isU32(m.replacesEpoch))) throw new TypeError('invalid seal-off marker')
  const out = new Uint8Array(m.replacesEpoch === undefined ? 30 : 34)
  const v = new DataView(out.buffer)
  out[0] = 1
  out[1] = m.mode === 'codeOnly' ? 1 : 2
  out.set(m.conversionId, 2)
  v.setUint32(18, m.boundaryEpoch)
  v.setBigUint64(22, m.startedAtMs)
  if (m.replacesEpoch !== undefined) v.setUint32(30, m.replacesEpoch)
  return out
}

/** Unknown lengths, versions, modes and a boundary unequal to the enclosing epoch stay unknown. */
export function parseSealOffMarker(value: Uint8Array, epoch: number): SealOffMarker | null {
  if ((value.length !== 30 && value.length !== 34) || value[0] !== 1 || (value[1] !== 1 && value[1] !== 2)) return null
  const v = new DataView(value.buffer, value.byteOffset, value.byteLength)
  if (v.getUint32(18) !== epoch || epoch < 1) return null
  return {
    mode: value[1] === 1 ? 'codeOnly' : 'everything', conversionId: value.slice(2, 18),
    boundaryEpoch: epoch, startedAtMs: v.getBigUint64(22),
    ...(value.length === 34 ? { replacesEpoch: v.getUint32(30) } : {}),
  }
}

/** Every config, classified by opening under its epoch's anchored key. */
export interface SealOffConfig extends ConfigStamp {
  readonly owner: PrivateId
  readonly opening: 'opened' | 'otherKey' | 'unreadable'
  readonly sealOff?: Uint8Array
}

export type ActiveSealOff =
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'active'; readonly epoch: number; readonly height: number; readonly marker: SealOffMarker | null; readonly highestEpoch: number; readonly replacesThrough: number | null }

/**
 * One sticky rule (§18.5): only the repo owner's private configs count. A valid later marker
 * may replace an earlier epoch; unmarked configs never do. Unknown owner configs fail closed.
 */
export function activeSealOff(configs: readonly SealOffConfig[], owner: PrivateId): ActiveSealOff {
  const candidates: { config: SealOffConfig; epoch: number; marker: SealOffMarker | null }[] = []
  let replacesThrough: number | null = null
  for (const c of configs) {
    if (!bytesEqual(c.owner, owner) || !c.private || c.epoch === null || c.epoch < 1) continue
    if (c.opening === 'unreadable') return { kind: 'unknown' }
    if (c.opening !== 'opened' || c.sealOff === undefined) continue
    const marker = parseSealOffMarker(c.sealOff, c.epoch)
    candidates.push({ config: c, epoch: c.epoch, marker })
    if (marker?.replacesEpoch !== undefined && marker.replacesEpoch < c.epoch) replacesThrough = Math.max(replacesThrough ?? 0, marker.replacesEpoch)
  }
  const remaining = candidates.filter((c) => replacesThrough === null || c.epoch > replacesThrough)
  remaining.sort((a, b) => a.epoch - b.epoch || a.config.height - b.config.height || compareBytes(a.config.id, b.config.id))
  const first = remaining[0]
  return first === undefined ? { kind: 'none' } : { kind: 'active', epoch: first.epoch, height: first.config.height, marker: first.marker, highestEpoch: remaining.at(-1)?.epoch ?? first.epoch, replacesThrough }
}

/** The lower boundary still in force; an owner replacement also sets aside stale local records. */
export function sealOffBoundary(recorded: number | null, active: ActiveSealOff): number | null {
  if (active.kind === 'unknown') throw new Error('repair keys before making this repo public')
  if (active.kind !== 'active') return recorded
  const local = recorded !== null && active.replacesThrough !== null && recorded <= active.replacesThrough ? null : recorded
  return local === null ? active.epoch : Math.min(local, active.epoch)
}

export type SealOffDecision =
  | { readonly kind: 'new' | 'unknown' }
  | { readonly kind: 'adopt' | 'lagging' | 'passed'; readonly epoch: number }
  | { readonly kind: 'public'; readonly cutoff: number | null }

/** The common boundary decision for the conversion runner and the shared vectors. */
export function sealOffDecision(recorded: number | null, active: ActiveSealOff, current: number | null, flipped: boolean, stated: number | null): SealOffDecision {
  if (active.kind === 'unknown') return { kind: 'unknown' }
  const boundary = sealOffBoundary(recorded, active)
  if (flipped) return { kind: 'public', cutoff: stated === null ? boundary : boundary === null ? stated : Math.min(stated, boundary) }
  if (boundary === null) return { kind: 'new' }
  return { kind: current === boundary ? 'adopt' : current !== null && current > boundary ? 'passed' : 'lagging', epoch: boundary }
}

/** A member notice points to the owner marker without repeating its contents (§18.5). */
export interface SealOffNotice {
  readonly conversionId: Uint8Array
  readonly boundaryEpoch: number
  readonly replacesEpoch?: number
}

/** Only a confirmed owner marker supplies the notice pointer. */
export function sealOffNoticeFor(active: ActiveSealOff, conversionId: Uint8Array): SealOffNotice | null {
  if (active.kind !== 'active' || active.marker === null || !bytesEqual(active.marker.conversionId, conversionId)) return null
  const m = active.marker
  return { conversionId: m.conversionId.slice(), boundaryEpoch: active.epoch, ...(m.replacesEpoch !== undefined ? { replacesEpoch: m.replacesEpoch } : {}) }
}

/** A received pointer is unconfirmed unless it resolves to the authoritative owner marker. */
export function confirmsSealOffNotice(active: ActiveSealOff, notice: SealOffNotice): boolean {
  const expected = sealOffNoticeFor(active, notice.conversionId)
  return expected !== null && bytesEqual(expected.conversionId, notice.conversionId) && expected.boundaryEpoch === notice.boundaryEpoch && expected.replacesEpoch === notice.replacesEpoch
}

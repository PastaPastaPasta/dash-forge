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

import { constantTimeEqual } from './bytes'
import { ENTRY_EPOCH_KEY, parseBundle, type Bundle } from './bundle'
import { V1 } from './doc'
import { sortAlerts, type Anchor, type EpochAlert } from './epoch'
import { bytesEqual, type PrivateId } from './ids'
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
    } else if (markerHeight === null || c.height < markerHeight) {
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

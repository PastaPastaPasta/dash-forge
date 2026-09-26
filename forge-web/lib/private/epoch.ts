/**
 * Epochs, anchors, the reader rule for wraps, the chain walk and the repair check
 * (`docs/security/private-repos.md` §5.3–§5.6), over flattened documents. Pure apart from
 * the key derivations and AES-GCM the chain walk needs.
 *
 * Identities are lowercase hex of the 32-byte identifier.
 */

import { RoleOracle, type Membership } from '../rules/v2'
import { compareStrings } from '../rules/oid'
import { constantTimeEqual, hexToBytes, type Bytes } from './bytes'
import { isLate, openWithKey, type AnchorRef, type OpenContext } from './doc'
import { EpochKeys, importEpochKeyAndWipe } from './keys'

export type { Membership }

/** A `config` document of the repo. */
export interface ConfigRow {
  readonly id: string
  readonly owner: string
  readonly epoch: number
  readonly createdAtBlockHeight: number
  readonly enc: Uint8Array
}

/** A `repoKey` document of the repo. */
export interface WrapRow {
  readonly id: string
  readonly owner: string
  readonly memberId: string
  readonly epoch: number
  readonly recipientKeyId: number
  /** Whether `recipientKeyId` is still an enabled key on `memberId`'s identity. */
  readonly keyEnabled: boolean
  /**
   * The epoch key, when the reader unwrapped this wrap (SDK decrypt, version and `KCV_e`
   * passed: `unwrapKey`). Absent for wraps to others or that failed.
   */
  readonly keys?: EpochKeys
}

/** An epoch's anchor (§5.3). */
export interface Anchor extends AnchorRef {
  readonly owner: string
  /** `enc[1..33]` of a well-shaped v0x02 config; null when the shape is wrong (matches nothing). */
  readonly commit: Bytes | null
  /** The anchor's config document. */
  readonly config: ConfigRow
}

export type EpochAlert =
  | { readonly kind: 'keyMismatch'; readonly epoch: number; readonly author: string }
  | { readonly kind: 'chainBroken'; readonly epoch: number; readonly author: string }
  | { readonly kind: 'rotationRequired'; readonly epoch: number; readonly members: readonly string[] }

/** The repair check's findings for the current epoch (§5.6). */
export interface Repair {
  readonly rotate: boolean
  readonly nonMembers: readonly string[]
  readonly missingWraps: readonly string[]
}

export interface EpochResolution {
  /** The highest existing epoch, or null when none exists. */
  readonly currentEpoch: number | null
  readonly anchors: ReadonlyMap<number, Anchor>
  /** The epochs the reader can read, and their keys. */
  readonly keys: ReadonlyMap<number, EpochKeys>
  /** The current epoch when readable: the only epoch a writer writes under. */
  readonly writeEpoch: number | null
  /** Epochs named by a config or wrap that have no anchor (sorted). */
  readonly unanchored: readonly number[]
  readonly alerts: readonly EpochAlert[]
  /** Null when no epoch exists. */
  readonly repair: Repair | null
  /** Current members. */
  readonly members: ReadonlySet<string>
}

const MIN_CONFIG_ENC = 61

function anchorCommit(enc: Uint8Array): Bytes | null {
  return enc.length >= MIN_CONFIG_ENC && enc[0] === 0x02 ? enc.slice(1, 33) : null
}

/** Anchor of each epoch: the first current-maintainer config by (block height, id) (§5.3). */
export function selectAnchors(configs: readonly ConfigRow[], oracle: RoleOracle): Map<number, Anchor> {
  const ordered = configs
    .filter((c) => oracle.currentRole(c.owner) === 'maintainer')
    .sort((a, b) => a.createdAtBlockHeight - b.createdAtBlockHeight || compareStrings(a.id, b.id))
  const anchors = new Map<number, Anchor>()
  for (const c of ordered) {
    if (anchors.has(c.epoch)) continue
    anchors.set(c.epoch, {
      id: c.id,
      height: c.createdAtBlockHeight,
      owner: c.owner,
      commit: anchorCommit(c.enc),
      config: c,
    })
  }
  return anchors
}

function matchesAnchor(keys: EpochKeys, anchor: Anchor): boolean {
  return anchor.commit !== null && constantTimeEqual(keys.commit, anchor.commit)
}

const KIND_ORDER = { keyMismatch: 0, chainBroken: 1, rotationRequired: 2 } as const

function sortAlerts(alerts: readonly EpochAlert[]): EpochAlert[] {
  const unique = new Map<string, EpochAlert>()
  for (const a of alerts) unique.set(JSON.stringify(a), a)
  const author = (a: EpochAlert) => ('author' in a ? a.author : '')
  return [...unique.values()].sort(
    (a, b) => a.epoch - b.epoch || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compareStrings(author(a), author(b)),
  )
}

/** One step of the chain walk: the previous epoch and its keys, or null when broken. */
async function chainStep(
  repoId: Uint8Array,
  config: ConfigRow,
  keys: EpochKeys,
  anchors: ReadonlyMap<number, Anchor>,
): Promise<{ epoch: number; keys: EpochKeys } | null> {
  const opened = await openWithKey(
    {
      type: 'config',
      ownerId: hexToBytes(config.owner),
      epoch: config.epoch,
      id: config.id,
      createdAtBlockHeight: config.createdAtBlockHeight,
      enc: config.enc,
    },
    keys,
    true,
  )
  if (opened.status !== 'readable') return null
  const { prevEpoch, prevEpochKey } = opened.fields
  if (prevEpoch === undefined || prevEpochKey === undefined) return null
  const prevAnchor = anchors.get(prevEpoch)
  if (prevEpoch >= config.epoch || prevAnchor === undefined) {
    prevEpochKey.fill(0)
    return null
  }
  const prevKeys = await importEpochKeyAndWipe(repoId, prevEpoch, prevEpochKey)
  return matchesAnchor(prevKeys, prevAnchor) ? { epoch: prevEpoch, keys: prevKeys } : null
}

/**
 * Resolve a private repo's epochs for `reader` (§5.3–§5.6): anchors, the current epoch, the
 * epochs the reader can read (accepted wraps, then the `prevEpochKey` chain from each),
 * alerts, and the repair check.
 */
export async function resolveEpochs(input: {
  readonly repoId: Uint8Array
  readonly reader: string
  readonly memberships: readonly Membership[]
  readonly configs: readonly ConfigRow[]
  readonly wraps: readonly WrapRow[]
}): Promise<EpochResolution> {
  const { repoId, reader, memberships, configs, wraps } = input
  const oracle = new RoleOracle(memberships)
  const isMaintainer = (id: string) => oracle.currentRole(id) === 'maintainer'
  const anchors = selectAnchors(configs, oracle)
  const epochs = [...anchors.keys()].sort((a, b) => a - b)
  const currentEpoch = epochs.length > 0 ? (epochs[epochs.length - 1] as number) : null
  const alerts: EpochAlert[] = []

  // §5.4: accepted wraps
  const keys = new Map<number, EpochKeys>()
  for (const w of wraps) {
    if (w.memberId !== reader || w.keys === undefined || !isMaintainer(w.owner)) continue
    const anchor = anchors.get(w.epoch)
    if (anchor === undefined || w.keys.epoch !== w.epoch) continue
    if (matchesAnchor(w.keys, anchor)) {
      if (!keys.has(w.epoch)) keys.set(w.epoch, w.keys)
    } else {
      alerts.push({ kind: 'keyMismatch', epoch: w.epoch, author: w.owner })
    }
  }

  // §5.3: the chain walk, each epoch walked once
  const pending = [...keys.keys()]
  const walked = new Set<number>()
  for (let e = pending.pop(); e !== undefined; e = pending.pop()) {
    if (walked.has(e) || e === 0) continue
    walked.add(e)
    const anchor = anchors.get(e) as Anchor
    const step = await chainStep(repoId, anchor.config, keys.get(e) as EpochKeys, anchors)
    if (step === null) {
      alerts.push({ kind: 'chainBroken', epoch: e, author: anchor.owner })
    } else if (!keys.has(step.epoch)) {
      keys.set(step.epoch, step.keys)
      pending.push(step.epoch)
    }
  }

  const unanchored = [...new Set([...configs, ...wraps].map((r) => r.epoch))]
    .filter((e) => !anchors.has(e))
    .sort((a, b) => a - b)
  const members = new Set(memberships.map((m) => m.identity))

  // §5.6: the repair check for the current epoch
  let repair: Repair | null = null
  if (currentEpoch !== null) {
    const current = wraps.filter((w) => w.epoch === currentEpoch && isMaintainer(w.owner))
    const nonMembers = [...new Set(current.map((w) => w.memberId))].filter((m) => !members.has(m)).sort(compareStrings)
    const covered = new Set(current.filter((w) => w.keyEnabled).map((w) => w.memberId))
    const missingWraps = [...members].filter((m) => !covered.has(m)).sort(compareStrings)
    repair = { rotate: nonMembers.length > 0, nonMembers, missingWraps }
    if (repair.rotate && isMaintainer(reader)) {
      alerts.push({ kind: 'rotationRequired', epoch: currentEpoch, members: nonMembers })
    }
  }

  return {
    currentEpoch,
    anchors,
    keys,
    writeEpoch: currentEpoch !== null && keys.has(currentEpoch) ? currentEpoch : null,
    unanchored,
    alerts: sortAlerts(alerts),
    repair,
    members,
  }
}

/** The {@link OpenContext} of a resolution, for `openContent` and pack reads. */
export function openContextOf(r: EpochResolution): OpenContext {
  return { keys: r.keys, anchors: r.anchors, members: r.members }
}

/** Whether content under `epoch` at `height` by `owner` is hidden as late (§8.2). */
export function contentIsLate(r: EpochResolution, epoch: number, height: number, owner: string): boolean {
  return isLate(r.anchors, r.members, epoch, height, owner)
}

/** A manifest's standing under §8.2. */
export interface ManifestStanding {
  /** Its sealed header's epoch is older than the epoch current at its block height. */
  readonly suspect: boolean
  /** Whether to read it: always for a current member's upload, else only if neither suspect nor late. */
  readonly readable: boolean
}

/** §8.2 for a `packManifest` whose sealed header names `headerEpoch`. */
export function manifestStanding(
  r: EpochResolution,
  headerEpoch: number,
  height: number,
  owner: string,
): ManifestStanding {
  let currentAt: number | null = null
  for (const [e, a] of r.anchors) if (a.height <= height && (currentAt === null || e > currentAt)) currentAt = e
  const suspect = currentAt !== null && headerEpoch < currentAt
  const late = contentIsLate(r, headerEpoch, height, owner)
  return { suspect, readable: r.members.has(owner) || (!suspect && !late) }
}

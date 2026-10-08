/**
 * Epochs, anchors, the reader rule for wraps, the chain walk and the repair check
 * (`docs/security/private-repos.md` §5.3–§5.6), over flattened documents. Pure apart from
 * the key derivations and AES-GCM the chain walk needs.
 *
 * Identities and ids are raw 32-byte values, ordered and compared as bytes (§5.3); convert at
 * the boundary with `privateId`.
 */

import { constantTimeEqual, isU32, type Bytes } from './bytes'
import { isLate, openWithKey, type AnchorRef, type OpenContext } from './doc'
import type { DocFields } from './tlv'
import { IdSet, bytesEqual, compareBytes, type PrivateId } from './ids'
import { EpochKeys, importEpochKeyAndWipe } from './keys'
import type { Role } from '../rules/v2'

/**
 * A membership role (`rules/v2`); maintainer outranks the `writer` document's roles (writer,
 * triage, reader). Every `writer` document, a reader's included, is a member and a key-wrap recipient.
 */
export type { Role }

/** One current `maintainer` or `writer` document of the repo. */
export interface PrivateMembership {
  /** `memberId`. */
  readonly identity: PrivateId
  readonly role: Role
}

/** A `config` document of the repo. */
export interface ConfigRow {
  readonly id: PrivateId
  readonly owner: PrivateId
  readonly epoch: number
  readonly createdAtBlockHeight: number
  readonly enc: Uint8Array
  /** `$createdAt` (ms), when known: the time of stated(e) ({@link AnchorRef.statedAt}). */
  readonly createdAt?: number
}

/** A `repoKey` document of the repo. */
export interface WrapRow {
  readonly id: PrivateId
  readonly owner: PrivateId
  readonly memberId: PrivateId
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
  readonly owner: PrivateId
  /** `enc[1..33]` of a well-shaped v0x02 config; null when the shape is wrong (matches nothing). */
  readonly commit: Bytes | null
  /** The anchor's config document. */
  readonly config: ConfigRow
}

export type EpochAlert =
  | { readonly kind: 'keyMismatch'; readonly epoch: number; readonly author: PrivateId }
  | { readonly kind: 'chainBroken'; readonly epoch: number; readonly author: PrivateId }
  /** A candidate anchor above the first gap in the epoch numbers: not an anchor (§5.3 contiguity). */
  | { readonly kind: 'epochGap'; readonly epoch: number; readonly author: PrivateId }
  /** The owner of a repository made public published a key for this epoch that does not commit to its anchor (§18.3): ignored. */
  | { readonly kind: 'publishedKeyMismatch'; readonly epoch: number; readonly author: PrivateId }
  | { readonly kind: 'rotationRequired'; readonly epoch: number; readonly members: readonly PrivateId[] }

/** The repair check's findings for the current epoch (§5.6); ids in byte order. */
export interface Repair {
  readonly rotate: boolean
  readonly nonMembers: readonly PrivateId[]
  readonly missingWraps: readonly PrivateId[]
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
  readonly members: IdSet
  /**
   * Readable epochs whose anchor is burned (§5.3): chain-only, never a write epoch; content
   * sealed under one is late unless its author is a current member.
   */
  readonly burned: ReadonlySet<number>
}

const MIN_CONFIG_ENC = 61

function anchorCommit(enc: Uint8Array): Bytes | null {
  return enc.length >= MIN_CONFIG_ENC && enc[0] === 0x02 ? enc.slice(1, 33) : null
}

/** Whether `a` comes strictly after `b` in anchor order: (block height, id bytes). */
function after(a: ConfigRow, b: ConfigRow): boolean {
  return a.createdAtBlockHeight > b.createdAtBlockHeight || (a.createdAtBlockHeight === b.createdAtBlockHeight && compareBytes(a.id, b.id) > 0)
}

function anchorOf(c: ConfigRow): Anchor {
  return { id: c.id, height: c.createdAtBlockHeight, statedHeight: c.createdAtBlockHeight, owner: c.owner, commit: anchorCommit(c.enc), config: c }
}

/**
 * Every config by epoch (any author), each list in anchor order (block height, id bytes). A config
 * without `enc` states no key: never an anchor, a statement or a gap (§5.3; forge-core
 * `select_anchors`).
 */
function configsByEpoch(configs: readonly ConfigRow[]): Map<number, ConfigRow[]> {
  const ordered = configs
    .filter((c) => isU32(c.epoch) && c.enc.length > 0)
    .sort((a, b) => a.createdAtBlockHeight - b.createdAtBlockHeight || compareBytes(a.id, b.id))
  const byEpoch = new Map<number, ConfigRow[]>()
  for (const c of ordered) byEpoch.set(c.epoch, [...(byEpoch.get(c.epoch) ?? []), c])
  return byEpoch
}

/**
 * Anchor of each epoch (§5.3): the first current-maintainer config by (block height, id bytes)
 * and, for `e >= 1`, strictly after stated(e - 1) in that order: the first config for `e - 1`
 * (itself after stated(e - 2)), by anyone, carrying anchor(e - 1)'s commitment, i.e. when that
 * epoch's key was first stated on chain. Config history is fixed (maintainer-gated,
 * non-deletable), so a config posted before the epoch below it had its key is never an anchor,
 * and a re-anchor after a maintainer's removal (same commitment) leaves the epochs above it
 * intact. Kept only for the contiguous run from 0; every other epoch a current maintainer named
 * is a gap ({@link gapCandidates}).
 */
export function selectAnchors(configs: readonly ConfigRow[], maintainers: IdSet): Map<number, Anchor> {
  const byEpoch = configsByEpoch(configs)
  const anchors = new Map<number, Anchor>()
  let stated: ConfigRow | null = null
  for (let e = 0; e <= 0xffff_ffff; e++) {
    const below: ConfigRow | null = stated
    const valid: ConfigRow[] = (byEpoch.get(e) ?? []).filter((x: ConfigRow) => below === null || after(x, below))
    const anchor = valid.find((x: ConfigRow) => maintainers.has(x.owner))
    if (anchor === undefined) break
    const commit = anchorCommit(anchor.enc)
    const same = (x: ConfigRow): boolean => {
      const c = anchorCommit(x.enc)
      return commit !== null && c !== null && bytesEqual(c, commit)
    }
    stated = valid.find(same) ?? anchor
    anchors.set(e, { ...anchorOf(anchor), statedHeight: stated.createdAtBlockHeight, ...statedAtOf(byEpoch.get(e) ?? [], stated) })
  }
  return anchors
}

/**
 * The `$createdAt` of stated(e) (forge-core `Keyring::stated_at`): the earliest of epoch e's
 * configs at the block height of `stated`, the config that first stated its key. Absent when no
 * such config carries a `$createdAt`.
 */
function statedAtOf(configs: readonly ConfigRow[], stated: ConfigRow): { readonly statedAt?: number } {
  const times = configs.filter((c) => c.createdAtBlockHeight === stated.createdAtBlockHeight && c.createdAt !== undefined).map((c) => c.createdAt as number)
  return times.length === 0 ? {} : { statedAt: Math.min(...times) }
}

/** The first current-maintainer config of every epoch that is not an epoch (each an `epochGap` alert), by epoch. */
export function gapCandidates(configs: readonly ConfigRow[], maintainers: IdSet): Anchor[] {
  const kept = selectAnchors(configs, maintainers)
  const out: Anchor[] = []
  for (const [e, cs] of [...configsByEpoch(configs)].sort(([a], [b]) => a - b)) {
    const first = cs.find((c) => maintainers.has(c.owner))
    if (!kept.has(e) && first !== undefined) out.push(anchorOf(first))
  }
  return out
}

function matchesAnchor(keys: EpochKeys, anchor: Anchor): boolean {
  return anchor.commit !== null && constantTimeEqual(keys.commit, anchor.commit)
}

const KIND_ORDER = { keyMismatch: 0, chainBroken: 1, epochGap: 2, rotationRequired: 3, publishedKeyMismatch: 4 } as const
const EMPTY = new Uint8Array(0)

function alertKey(a: EpochAlert): string {
  const ids = 'author' in a ? [a.author] : a.members
  return JSON.stringify([a.kind, a.epoch, ids.map((id) => [...id])])
}

/** `alerts` deduplicated and in their stable order: (epoch, kind, author). */
export function sortAlerts(alerts: readonly EpochAlert[]): EpochAlert[] {
  const unique = new Map<string, EpochAlert>()
  for (const a of alerts) unique.set(alertKey(a), a)
  const author = (a: EpochAlert) => ('author' in a ? a.author : EMPTY)
  return [...unique.values()].sort(
    (a, b) => a.epoch - b.epoch || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compareBytes(author(a), author(b)),
  )
}

/** Open `anchor` (a config) with `keys`: its fields, or null when it does not open. */
async function openAnchor(anchor: Anchor, keys: EpochKeys): Promise<DocFields | null> {
  const c = anchor.config
  const opened = await openWithKey(
    { type: 'config', ownerId: c.owner, epoch: c.epoch, id: c.id, createdAtBlockHeight: c.createdAtBlockHeight, enc: c.enc },
    keys,
    true,
  )
  return opened.status === 'readable' ? opened.fields : null
}

function wipe(f: DocFields | null): void {
  f?.prevEpochKey?.fill(0)
  f?.skipEpochKey?.fill(0)
}

/**
 * One step of the chain walk from epoch `e` (§5.3): the epochs it reaches, the one to walk on from
 * (null: stop here), and whether the chain breaks at `e`. A burned anchor carries no
 * `prevEpochKey`, so the walk stops at it; the anchor above a burned run carries `skipEpochKey`,
 * the key of the nearest epoch below the run that is not burned, and the walk steps over the run
 * (a missing or wrong skip key still yields the burned epoch below, from `prevEpochKey`).
 */
async function chainStep(
  repoId: Uint8Array,
  anchor: Anchor,
  keys: EpochKeys,
  anchors: ReadonlyMap<number, Anchor>,
): Promise<{ links: { epoch: number; keys: EpochKeys }[]; next: number | null; broken: boolean }> {
  const e = anchor.config.epoch
  const fields = await openAnchor(anchor, keys)
  try {
    const broken = { links: [], next: null, broken: true }
    if (fields === null) return broken
    if (fields.burned === true) return { links: [], next: null, broken: false }
    const { prevEpoch, prevEpochKey } = fields
    if (prevEpoch === undefined || prevEpochKey === undefined) return broken
    const prevAnchor = anchors.get(prevEpoch)
    // Contiguity (§5.3): an anchor at e chains to exactly e - 1.
    if (prevEpoch !== e - 1 || prevAnchor === undefined) return broken
    const prevKeys = await importEpochKeyAndWipe(repoId, prevEpoch, prevEpochKey.slice())
    if (!matchesAnchor(prevKeys, prevAnchor)) return broken
    const prev = { epoch: prevEpoch, keys: prevKeys }
    const prevFields = await openAnchor(prevAnchor, prevKeys)
    const prevBurned = prevFields?.burned === true
    wipe(prevFields)
    if (!prevBurned) return { links: [prev], next: prevEpoch, broken: false }
    // Step over the burned run: the nearest lower epoch the skip key commits to, not burned itself.
    const skip = fields.skipEpochKey
    if (skip !== undefined) {
      for (let s = prevEpoch - 1; s >= 0; s--) {
        const sAnchor = anchors.get(s) as Anchor
        const sKeys = await importEpochKeyAndWipe(repoId, s, skip.slice())
        if (!matchesAnchor(sKeys, sAnchor)) continue
        const sFields = await openAnchor(sAnchor, sKeys)
        const ok = sFields !== null && sFields.burned !== true
        wipe(sFields)
        if (ok) return { links: [prev, { epoch: s, keys: sKeys }], next: s, broken: false }
        break
      }
    }
    return { links: [prev], next: null, broken: true }
  } finally {
    wipe(fields)
  }
}

/**
 * Resolve a private repo's epochs for `reader` (§5.3–§5.6): anchors, the current epoch, the
 * epochs the reader can read (accepted wraps, then the `prevEpochKey` chain from each),
 * alerts, and the repair check.
 */
export async function resolveEpochs(input: {
  readonly repoId: Uint8Array
  readonly reader: PrivateId
  readonly memberships: readonly PrivateMembership[]
  readonly configs: readonly ConfigRow[]
  readonly wraps: readonly WrapRow[]
}): Promise<EpochResolution> {
  const { repoId, reader, memberships, configs, wraps } = input
  const members = new IdSet(memberships.map((m) => m.identity))
  const maintainers = new IdSet(memberships.filter((m) => m.role === 'maintainer').map((m) => m.identity))
  const anchors = selectAnchors(configs, maintainers)
  const epochs = [...anchors.keys()].sort((a, b) => a - b)
  const currentEpoch = epochs.length > 0 ? (epochs[epochs.length - 1] as number) : null
  const alerts: EpochAlert[] = gapCandidates(configs, maintainers).map((a) => ({ kind: 'epochGap', epoch: a.config.epoch, author: a.owner }))

  // §5.4: accepted wraps
  const keys = new Map<number, EpochKeys>()
  for (const w of wraps) {
    if (!bytesEqual(w.memberId, reader) || w.keys === undefined || !maintainers.has(w.owner)) continue
    const anchor = anchors.get(w.epoch)
    if (anchor === undefined || w.keys.epoch !== w.epoch || !bytesEqual(w.keys.repoId, repoId)) continue
    if (matchesAnchor(w.keys, anchor)) {
      if (!keys.has(w.epoch)) keys.set(w.epoch, w.keys)
    } else {
      alerts.push({ kind: 'keyMismatch', epoch: w.epoch, author: w.owner })
    }
  }

  await walkChains(repoId, anchors, keys, [...keys.keys()], alerts)
  const burned = await burnedEpochs(anchors, keys)

  const unanchored = [...new Set([...configs, ...wraps].map((r) => r.epoch))]
    .filter((e) => !anchors.has(e))
    .sort((a, b) => a - b)

  // §5.6: the repair check for the current epoch
  let repair: Repair | null = null
  if (currentEpoch !== null) {
    const current = wraps.filter((w) => w.epoch === currentEpoch && maintainers.has(w.owner))
    const nonMembers = new IdSet(current.map((w) => w.memberId).filter((m) => !members.has(m))).sorted()
    const covered = new IdSet(current.filter((w) => w.keyEnabled).map((w) => w.memberId))
    const missingWraps = members.sorted().filter((m) => !covered.has(m))
    // A burned current epoch needs a rotation too (§5.3: any maintainer finishes a burn).
    repair = { rotate: nonMembers.length > 0 || burned.has(currentEpoch), nonMembers, missingWraps }
    if (repair.rotate && maintainers.has(reader)) {
      alerts.push({ kind: 'rotationRequired', epoch: currentEpoch, members: nonMembers })
    }
  }

  return {
    currentEpoch,
    anchors,
    keys,
    // Nothing is written under an epoch a non-member holds (§5.6): it waits for the rotation.
    writeEpoch:
      currentEpoch !== null && keys.has(currentEpoch) && !burned.has(currentEpoch) && (repair?.nonMembers.length ?? 0) === 0
        ? currentEpoch
        : null,
    unanchored,
    alerts: sortAlerts(alerts),
    repair,
    members,
    burned,
  }
}

/**
 * §5.3: the chain walk from each of `start` (epochs `keys` holds), each epoch walked once, adding
 * every epoch it reaches to `keys` and a `chainBroken` alert where it breaks.
 */
async function walkChains(
  repoId: Uint8Array,
  anchors: ReadonlyMap<number, Anchor>,
  keys: Map<number, EpochKeys>,
  start: number[],
  alerts: EpochAlert[],
): Promise<void> {
  const pending = [...start]
  const walked = new Set<number>()
  for (let e = pending.pop(); e !== undefined; e = pending.pop()) {
    if (walked.has(e) || e === 0) continue
    walked.add(e)
    const anchor = anchors.get(e) as Anchor
    const step = await chainStep(repoId, anchor, keys.get(e) as EpochKeys, anchors)
    if (step.broken) alerts.push({ kind: 'chainBroken', epoch: e, author: anchor.owner })
    const fresh = step.next !== null && !keys.has(step.next)
    for (const l of step.links) if (!keys.has(l.epoch)) keys.set(l.epoch, l.keys)
    if (fresh && step.next !== null) pending.push(step.next)
  }
}

/** §5.3 burned epochs: the flag of each readable epoch's anchor (only the anchor's counts). */
async function burnedEpochs(anchors: ReadonlyMap<number, Anchor>, keys: ReadonlyMap<number, EpochKeys>): Promise<Set<number>> {
  const burned = new Set<number>()
  for (const [e, k] of keys) {
    const a = anchors.get(e) as Anchor
    const opened = await openWithKey(
      { type: 'config', ownerId: a.owner, epoch: e, id: a.id, createdAtBlockHeight: a.height, enc: a.config.enc },
      k,
      true,
    )
    if (opened.status === 'readable') {
      opened.fields.prevEpochKey?.fill(0)
      if (opened.fields.burned === true) burned.add(e)
    }
  }
  return burned
}

/**
 * `r` with the epoch keys a converted repository's owner published (§18.3, already checked
 * against the anchors by `./convert`'s `publishedKeys`) added to the keys the reader holds, with
 * every epoch their chains reach, and the alerts that check raised (forge-core
 * `EpochResolution::add_published`). The write epoch never changes: a published key is always
 * below the seal-off epoch.
 */
export async function addPublished(
  r: EpochResolution,
  repoId: Uint8Array,
  published: ReadonlyMap<number, Uint8Array>,
  publishedAlerts: readonly EpochAlert[],
): Promise<EpochResolution> {
  if (published.size === 0 && publishedAlerts.length === 0) return r
  const keys = new Map(r.keys)
  const alerts = [...r.alerts, ...publishedAlerts]
  for (const [e, raw] of [...published].sort(([a], [b]) => a - b)) {
    if (keys.has(e) || !r.anchors.has(e)) continue
    keys.set(e, await EpochKeys.import(repoId, e, raw))
    await walkChains(repoId, r.anchors, keys, [e], alerts)
  }
  return { ...r, keys, alerts: sortAlerts(alerts), burned: await burnedEpochs(r.anchors, keys) }
}

/** The {@link OpenContext} of a resolution, for `openContent` and pack reads. */
export function openContextOf(r: EpochResolution): OpenContext {
  return { keys: r.keys, anchors: r.anchors, members: r.members, burned: r.burned }
}

/** Whether content under `epoch` at `height` by `owner` is hidden as late (§8.2). */
export function contentIsLate(r: EpochResolution, epoch: number, height: number, owner: PrivateId): boolean {
  return isLate(r.anchors, r.members, epoch, height, owner, r.burned)
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
  owner: PrivateId,
): ManifestStanding {
  // an epoch is current from stated(e), when its key was first stated: a re-anchor does not make
  // an old-key upload look timely
  let currentAt: number | null = null
  for (const [e, a] of r.anchors) if (a.statedHeight <= height && (currentAt === null || e > currentAt)) currentAt = e
  const suspect = (currentAt !== null && headerEpoch < currentAt) || r.burned.has(headerEpoch)
  const late = contentIsLate(r, headerEpoch, height, owner)
  return { suspect, readable: r.members.has(owner) || (!suspect && !late) }
}

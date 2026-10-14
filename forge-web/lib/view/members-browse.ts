/**
 * A member's browse plane of a public repo with members-only branches (mixed-visibility DESIGN
 * §4.3; `private-repos.md` §19.5): the public context, plus the members-only git packs (kind 64)
 * their members-key session opens, so the code pages, compare and the merge box read a
 * members-only branch's commits as they read any other.
 *
 * Members-only packs are thin against the public packs (`have` = the public tips and the
 * branch's previous tip). A pack whose browse index (kind 65, `lib/browse/members-index.ts`) the
 * reader trusts is read by range: its rows join the overlay as they are. Trusted means the index
 * opens with the members-key session (its sealed bytes checked against its `packHash` first),
 * names this pack's `packHash` in its header, was uploaded by one of this pack's uploaders, and
 * has as many rows as the pack has objects. Any other pack is fetched whole (its sealed bytes
 * checked against `packHash`, its uploader's standing checked, then opened) and indexed in this
 * browser, a REF base outside the whole packs read from the public context and the ranged packs.
 * An index that fails to open, parse or pass the rule is ignored: the pack is fetched whole. Rows
 * join the public index at `packRef`s after the public pack space, so a members-only object's
 * public delta base resolves as usual. Only kind 65 has a writer: the flat and history indexes
 * are read for a repository's default branch, which is always public. Nothing decrypted is
 * stored: the context lives in the browse cache under the members-key session (`repoKey`), and
 * goes with it.
 */

import { ObjectLocator, type GitObject, type ObjectIndex, type PackSource } from '../browse'
import type { IndexedObject } from '../browse/indexer'
import { offsetKey, type LocatorEntry } from '../browse/locator'
import { parseMembersIndex, type MembersIndexPlain } from '../browse/members-index'
import { PACK_KIND } from '../constants'
import { packsOfKind, type PackManifest } from '../repo'
import type { PrivateSession } from '../repo/private-session'
import { openPrivateArtifact } from './private-packs'

/** Plaintext `[start, end)` of one members-only pack, from its `copy` when one is named. */
export type MembersRange = (start: number, end: number, copy?: number) => Promise<Uint8Array>

/** A members-only pack of an overlay: its opened bytes, or a ranged reader (its index was trusted). */
export type MembersPack = Uint8Array | MembersRange

/** What a members-only overlay adds: its index (rows at `packRef >= base`), its packs and their manifests. */
export interface MembersPacks {
  readonly locator: ObjectLocator
  /** The packs, by `packRef - base`. */
  readonly packs: readonly MembersPack[]
  readonly manifests: readonly PackManifest[]
  /** The first `packRef` of these packs: the public pack space's length. */
  readonly base: number
  /** Members-only packs this member could not open (another epoch, a narrower audience, unreadable). */
  readonly skipped: number
}

/** How {@link loadMembersPacks} reads. */
export interface MembersReads {
  /** A members-only artifact's stored (sealed) bytes, checked against its `packHash`. */
  readonly load: (m: PackManifest) => Promise<Uint8Array>
  /** A ranged reader of a members-only pack's plaintext, with the members-key session. */
  readonly ranged: (m: PackManifest) => MembersRange
  /**
   * A reader of the REF bases the whole packs do not hold: the public context, with `ranged` (the
   * packs read by range, null: none) over it. Null: not found.
   */
  readonly bases: (ranged: MembersPacks | null) => (oidHex: string) => Promise<GitObject | null>
}

/** A repo's members-only git packs (kind 64), oldest first: none of them supersedes another. */
export function membersGitPacks(manifests: readonly PackManifest[]): PackManifest[] {
  return packsOfKind(manifests, PACK_KIND.MEMBERS_GIT_PACK)
}

/** A members-only pack read by range, at its place among the repo's members-only packs. */
interface Ranged {
  readonly order: number
  readonly manifest: PackManifest
  /** Its trusted index's rows, at `packRef` 0. */
  readonly rows: ObjectLocator
  readonly read: MembersRange
}

/** A members-only pack fetched whole and opened, at its place among the repo's members-only packs. */
interface Whole {
  readonly order: number
  readonly manifest: PackManifest
  readonly bytes: Uint8Array
}

/**
 * Open and index the members-only packs of `manifests` that `lane` reads, each by range when a
 * trusted index (kind 65) covers it and fetched whole otherwise. Null when no members-only pack
 * opens.
 */
export async function loadMembersPacks(
  lane: PrivateSession,
  manifests: readonly PackManifest[],
  base: number,
  reads: MembersReads,
  budget?: number,
): Promise<MembersPacks | null> {
  const indexes = packsOfKind(manifests, PACK_KIND.MEMBERS_OBJECT_LOCATOR)
  const opened = new Map<string, Promise<MembersIndexPlain | null>>()
  const ranged: Ranged[] = []
  let whole: Whole[] = []
  let skipped = 0
  for (const [order, m] of membersGitPacks(manifests).entries()) {
    const rows = await trustedIndex(lane, m, indexes, reads.load, opened)
    if (rows !== null) {
      ranged.push({ order, manifest: m, rows, read: reads.ranged(m) })
      continue
    }
    try {
      const sealed = await reads.load(m)
      whole.push({ order, manifest: m, bytes: await openPrivateArtifact(lane, m, sealed, m.copies ?? [m]) })
    } catch {
      // not this member's to open (another epoch, a narrower branch's key) or not served: its
      // objects stay unreadable here, as a skipped pack's
      skipped++
    }
  }
  if (ranged.length === 0 && whole.length === 0) return null
  let found: IndexedObject[] = []
  if (whole.length > 0) {
    const { indexPacks, AUTO_DECODE } = await indexer()
    // a whole pack's REF base may be public, or in an earlier pack of its branch read by range
    const external = reads.bases(ranged.length === 0 ? null : await overlay(base, ranged, [], [], skipped))
    try {
      found = await indexPacks(
        whole.map((w) => w.bytes),
        undefined,
        budget ?? AUTO_DECODE,
        external,
      )
    } catch (e) {
      // Whole packs that do not index (a base nobody serves, over the budget) leave the ranged
      // ones readable; with none, there is no overlay.
      if (ranged.length === 0) throw e
      skipped += whole.length
      whole = []
    }
  }
  return overlay(base, ranged, whole, found, skipped)
}

/**
 * The overlay of `ranged` and `whole` in the order of the repo's members-only packs, at
 * `packRef`s from `base`: a ranged pack's rows moved from `packRef` 0 to its place, and `found`
 * (the rows the browser indexed over `whole`, each at its pack's position in `whole`) to theirs.
 */
async function overlay(
  base: number,
  ranged: readonly Ranged[],
  whole: readonly Whole[],
  found: readonly IndexedObject[],
  skipped: number,
): Promise<MembersPacks> {
  const sorted = [...ranged, ...whole].sort((a, b) => a.order - b.order)
  const at = new Map(sorted.map((e, i) => [e.order, base + i]))
  const place = (order: number): number => at.get(order) as number
  const parts = ranged.map((r) => r.rows.remapPacks(new Map([[0, place(r.order)]])))
  if (found.length > 0) {
    const { serializeLocator } = await import('../browse/indexer')
    parts.push(ObjectLocator.parse(serializeLocator(found.map((o) => ({ ...o, packRef: place((whole[o.packRef] as Whole).order) })))))
  }
  return {
    locator: ObjectLocator.merge(parts),
    packs: sorted.map((e) => ('read' in e ? e.read : e.bytes)),
    manifests: sorted.map((e) => e.manifest),
    base,
    skipped,
  }
}

/**
 * The rows of the trusted members-only index of `pack` among `indexes` (all at `packRef` 0), or
 * null. An index from someone who uploaded none of the pack's copies, or recording another row
 * count, is not even fetched; one that fails to open or parse, names another pack or holds
 * another number of rows is passed over. `opened` keeps each index's parse for the next pack.
 */
async function trustedIndex(
  lane: PrivateSession,
  pack: PackManifest,
  indexes: readonly PackManifest[],
  load: (m: PackManifest) => Promise<Uint8Array>,
  opened: Map<string, Promise<MembersIndexPlain | null>>,
): Promise<ObjectLocator | null> {
  const uploaders = new Set((pack.copies ?? [pack]).map((c) => c.uploader))
  const packHash = pack.packHash.toLowerCase()
  for (const idx of indexes) {
    if (idx.objectCount !== pack.objectCount || !(idx.copies ?? [idx]).some((c) => uploaders.has(c.uploader))) continue
    let plain = opened.get(idx.packHash)
    if (plain === undefined) {
      plain = load(idx)
        .then((sealed) => openPrivateArtifact(lane, idx, sealed, idx.copies ?? [idx]))
        .then(parseMembersIndex)
        .catch(() => null)
      opened.set(idx.packHash, plain)
    }
    const index = await plain
    if (index !== null && index.packHash === packHash && index.locator.count === pack.objectCount) return index.locator
  }
  return null
}

async function indexer() {
  const mod = await import('../browse/indexer')
  // a members-only push is a branch's new objects: the automatic budget a browser clone uses
  const { AUTO_INDEX_DECODE_MAX_BYTES } = await import('./browse-fallback')
  return { ...mod, AUTO_DECODE: AUTO_INDEX_DECODE_MAX_BYTES }
}

/** The lower of two entries by `packRef` (an index answers with an object's lowest-`packRef` copy). */
function lower(a: LocatorEntry | null, b: LocatorEntry | null): LocatorEntry | null {
  if (a === null) return b
  if (b === null) return a
  return b.packRef < a.packRef ? b : a
}

/** The public index with a members-only overlay's rows, which sit at `packRef >= members.base`. */
export class MembersIndex implements ObjectIndex {
  private offsets: Map<string, LocatorEntry> | null = null

  constructor(
    private readonly pub: ObjectIndex,
    private readonly members: MembersPacks,
  ) {}

  get count(): number {
    return this.pub.count + this.members.locator.count
  }

  get inMemory(): boolean {
    return this.pub.inMemory
  }

  async lookup(oid: Uint8Array): Promise<LocatorEntry | null> {
    return lower(await this.pub.lookup(oid), this.members.locator.lookup(oid))
  }

  peek(oid: Uint8Array): LocatorEntry | null | undefined {
    const p = this.pub.peek(oid)
    return p === undefined ? undefined : lower(p, this.members.locator.lookup(oid))
  }

  async findByPrefix(prefix: string, limit = 2): Promise<string[]> {
    const [p, m] = await Promise.all([this.pub.findByPrefix(prefix, limit), this.members.locator.findByPrefix(prefix, limit)])
    return [...new Set([...p, ...m])].sort().slice(0, limit)
  }

  atOffset(packRef: number, offset: number): LocatorEntry | null | undefined {
    if (packRef < this.members.base) return this.pub.atOffset(packRef, offset)
    this.offsets ??= this.members.locator.buildOffsetIndex()
    return this.offsets.get(offsetKey(packRef, offset)) ?? null
  }

  preload(): Promise<void> {
    return this.pub.preload()
  }
}

/**
 * The public pack source with the overlay's packs after it: an opened pack served from memory, a
 * ranged one read through its reader. A ranged pack's plaintext length is in its sealed header
 * only, so it reports no size: its ranges go to it as asked, never as read-ahead blocks past its end.
 */
export function membersPackSource(pub: PackSource, members: MembersPacks): PackSource {
  const own = (packRef: number): MembersPack | undefined => members.packs[packRef - members.base]
  return {
    fetchRange(packRef, start, end, copy) {
      if (packRef < members.base) return pub.fetchRange(packRef, start, end, copy)
      const pack = own(packRef)
      if (pack === undefined) throw new Error(`packRef ${packRef} out of range`)
      if (typeof pack === 'function') return pack(start, end, copy)
      if (start < 0 || end > pack.length || start > end) throw new Error(`range [${start}, ${end}) out of pack bounds`)
      return Promise.resolve(pack.subarray(start, end))
    },
    copyCount: (packRef) => {
      if (packRef < members.base) return pub.copyCount?.(packRef) ?? 1
      return typeof own(packRef) === 'function' ? (members.manifests[packRef - members.base]?.copies?.length ?? 1) : 1
    },
    sizeOf: (packRef) => {
      if (packRef < members.base) return pub.sizeOf?.(packRef)
      const pack = own(packRef)
      return pack instanceof Uint8Array ? pack.length : undefined
    },
  }
}

/**
 * A member's browse plane of a public repo with members-only branches (mixed-visibility DESIGN
 * §4.3; `private-repos.md` §19.5): the public context, plus the members-only git packs (kind 64)
 * their members-key session opens, so the code pages, compare and the merge box read a
 * members-only branch's commits as they read any other.
 *
 * Members-only packs are thin against the public packs (`have` = the public tips) and carry no
 * index of their own here: each readable one is fetched whole (its sealed bytes checked against
 * `packHash`, its uploader's standing checked, then opened), and indexed in this browser, a REF
 * base outside them read from the public context. Their rows join the public index at `packRef`s
 * after the public pack space, so a members-only object's public delta base resolves as usual.
 * The members-only browse indexes (kinds 65–69) have no writer yet and are not read (decision
 * recorded with phase 3C). Nothing decrypted is stored: the context lives in the browse cache
 * under the members-key session (`repoKey`), and goes with it.
 */

import { ObjectLocator, type GitObject, type ObjectIndex, type PackSource } from '../browse'
import { offsetKey, type LocatorEntry } from '../browse/locator'
import { PACK_KIND } from '../constants'
import { packsOfKind, type PackManifest } from '../repo'
import type { PrivateSession } from '../repo/private-session'
import { openPrivateArtifact } from './private-packs'

/** What a members-only overlay adds: its index (rows at `packRef >= base`), its packs and their manifests. */
export interface MembersPacks {
  readonly locator: ObjectLocator
  /** The opened packs, by `packRef - base`. */
  readonly packs: readonly Uint8Array[]
  readonly manifests: readonly PackManifest[]
  /** The first `packRef` of these packs: the public pack space's length. */
  readonly base: number
  /** Members-only packs this member could not open (another epoch, a narrower audience, unreadable). */
  readonly skipped: number
}

/** A repo's members-only git packs (kind 64), oldest first: none of them supersedes another. */
export function membersGitPacks(manifests: readonly PackManifest[]): PackManifest[] {
  return packsOfKind(manifests, PACK_KIND.MEMBERS_GIT_PACK)
}

/**
 * Open and index the members-only packs of `manifests` that `lane` reads. `load` fetches a pack's
 * stored (sealed) bytes, checked against its `packHash`; `publicObject` reads a REF base from the
 * public context (null: absent). Null when no members-only pack opens.
 */
export async function loadMembersPacks(
  lane: PrivateSession,
  manifests: readonly PackManifest[],
  base: number,
  load: (m: PackManifest) => Promise<Uint8Array>,
  publicObject: (oidHex: string) => Promise<GitObject | null>,
  budget?: number,
): Promise<MembersPacks | null> {
  const opened: { manifest: PackManifest; bytes: Uint8Array }[] = []
  let skipped = 0
  for (const m of membersGitPacks(manifests)) {
    try {
      const sealed = await load(m)
      opened.push({ manifest: m, bytes: await openPrivateArtifact(lane, m, sealed, m.copies ?? [m]) })
    } catch {
      // not this member's to open (another epoch, a narrower branch's key) or not served: its
      // objects stay unreadable here, as a skipped pack's
      skipped++
    }
  }
  if (opened.length === 0) return null
  const { indexPacks, serializeLocator, AUTO_DECODE } = await indexer()
  const objects = await indexPacks(
    opened.map((o) => o.bytes),
    undefined,
    budget ?? AUTO_DECODE,
    publicObject,
  )
  const locator = ObjectLocator.parse(serializeLocator(objects.map((o) => ({ ...o, packRef: o.packRef + base }))))
  return { locator, packs: opened.map((o) => o.bytes), manifests: opened.map((o) => o.manifest), base, skipped }
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

/** The public pack source with the overlay's opened packs after it. */
export function membersPackSource(pub: PackSource, members: MembersPacks): PackSource {
  const own = (packRef: number): Uint8Array | undefined => members.packs[packRef - members.base]
  return {
    fetchRange(packRef, start, end, copy) {
      if (packRef < members.base) return pub.fetchRange(packRef, start, end, copy)
      const pack = own(packRef)
      if (pack === undefined) throw new Error(`packRef ${packRef} out of range`)
      if (start < 0 || end > pack.length || start > end) throw new Error(`range [${start}, ${end}) out of pack bounds`)
      return Promise.resolve(pack.subarray(start, end))
    },
    copyCount: (packRef) => (packRef < members.base ? (pub.copyCount?.(packRef) ?? 1) : 1),
    sizeOf: (packRef) => (packRef < members.base ? pub.sizeOf?.(packRef) : own(packRef)?.length),
  }
}

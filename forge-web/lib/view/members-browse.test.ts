/**
 * The members-only overlay of the browse plane (`members-browse.ts`): a thin members-only pack
 * whose deltas name public objects is indexed in the browser with its REF bases read from the
 * public side, its rows join the public index after the public pack space, and one reader serves
 * both, the public delta base included. A pack whose browse index (kind 65) the reader trusts is
 * read by range and never fetched whole; an index it does not trust leaves the pack fetched whole.
 * A blind resolves to the commit it hides only through the reader's alias (never a guess).
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { zlibSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import { BrowseReader, FragmentedIndex, ObjectLocator, gitOidHex, type GitObject } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { encodeMembersIndex } from '../browse/members-index'
import { T_BLOB, T_REF_DELTA, concat, copyInsertDelta, hexToBytes, objHeader, packFrame } from '../browse/pack-fixtures'
import { PACK_KIND } from '../constants'
import { BranchKey, BranchKeys, BranchRing, foldBranchLetters, sealBranchPack } from '../private'
import type { PackManifest } from '../repo'
import type { PrivateSession } from '../repo/private-session'
import { aliasedReader } from './blind-reader'
import { MembersIndex, loadMembersPacks, membersPackSource, type MembersPacks, type MembersReads } from './members-browse'

// Sealing is not what the kind-65 tests are about (`private-packs.test.ts`, the private
// conformance suite): a "sealed" members-key artifact here is 0x5e then its plaintext, opened only
// when its bytes hash to the manifest's packHash, as the real opener checks first. A narrower
// branch's pack opens for real (`openBranchArtifact`).
vi.mock('./private-packs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./private-packs')>()),
  openPrivateArtifact: async (_lane: unknown, copy: { packHash: string }, sealed: Uint8Array) => {
    if (bytesToHex(sha256(sealed)) !== copy.packHash || sealed[0] !== 0x5e) throw new Error('sealedPackCorrupt')
    return sealed.slice(1)
  },
}))

const text = (s: string) => new TextEncoder().encode(s)

/** A public pack holding `base`, indexed as the published index would be (packRef 0). */
async function publicSide(base: Uint8Array) {
  const pack = packFrame(concat(objHeader(T_BLOB, base.length), zlibSync(base)))
  const locator = ObjectLocator.parse(serializeLocator(await indexPacks([pack])))
  const packs = memoryPackSource([pack])
  return { locator, packs, reader: new BrowseReader(locator, packs) }
}

describe('a thin members-only pack over the public context', () => {
  const base = text('the quick brown fox jumps over the lazy dog\n')
  const secret = text('the quick brown fox jumps over the lazy cat\n')
  const delta = copyInsertDelta(base.length, secret.length, 40, text('cat\n'))
  const thin = packFrame(concat(objHeader(T_REF_DELTA, delta.length), hexToBytes(gitOidHex('blob', base)), zlibSync(delta)))

  it('cannot be indexed alone: its base is public', async () => {
    await expect(indexPacks([thin])).rejects.toThrow(/REF_DELTA base not found/)
  })

  it('is indexed with its public base read from the public side, and read through one reader', async () => {
    const pub = await publicSide(base)
    const asked: string[] = []
    const external = async (oid: string): Promise<GitObject | null> => {
      asked.push(oid)
      return pub.reader.readObject(oid).catch(() => null)
    }
    const objects = await indexPacks([thin], undefined, undefined, external)
    // only the pack's own object gets a row (the public base is a base, not a row here)
    expect(objects.map((o) => o.oidHex)).toEqual([gitOidHex('blob', secret)])
    expect(asked).toEqual([gitOidHex('blob', base)])

    const members: MembersPacks = {
      locator: ObjectLocator.parse(serializeLocator(objects.map((o) => ({ ...o, packRef: o.packRef + 1 })))),
      packs: [thin],
      manifests: [],
      base: 1,
      skipped: 0,
    }
    const index = new MembersIndex(new FragmentedIndex([pub.locator]), members)
    expect(index.count).toBe(2)
    const reader = new BrowseReader(index, membersPackSource(pub.packs, members))
    expect(Array.from((await reader.readObject(gitOidHex('blob', secret))).bytes)).toEqual(Array.from(secret))
    expect(Array.from((await reader.readObject(gitOidHex('blob', base))).bytes)).toEqual(Array.from(base))
    expect(await index.findByPrefix(gitOidHex('blob', secret).slice(0, 6))).toEqual([gitOidHex('blob', secret)])
  })

  it('a base the public side does not hold fails the index, as a missing base does', async () => {
    await expect(indexPacks([thin], undefined, undefined, async () => null)).rejects.toThrow(/REF_DELTA base not found/)
    // and one that does not hash to the id it was asked for is not taken
    const liar = async (): Promise<GitObject> => ({ type: 'blob', bytes: text('something else\n') })
    await expect(indexPacks([thin], undefined, undefined, liar)).rejects.toThrow(/REF_DELTA base not found/)
  })
})

describe('a members-only PR\'s blinds', () => {
  it('read as the real commits this PR verified, and nothing else', async () => {
    const blob = text('members-only file\n')
    const pack = packFrame(concat(objHeader(T_BLOB, blob.length), zlibSync(blob)))
    const locator = ObjectLocator.parse(serializeLocator(await indexPacks([pack])))
    const real = gitOidHex('blob', blob)
    const blind = 'ab'.repeat(20)
    const plain = new BrowseReader(locator, memoryPackSource([pack]))
    // a plain reader never takes a blind for the commit it hides
    await expect(plain.readObject(blind)).rejects.toThrow()
    const aliased = aliasedReader(plain, new Map([[blind, real]]))
    expect(Array.from((await aliased.readObject(blind)).bytes)).toEqual(Array.from(blob))
    await expect(aliasedReader(plain, new Map()).readObject(blind)).rejects.toThrow()
  })
})

describe('a members-only pack\'s browse index (kind 65)', () => {
  const lane = {} as PrivateSession
  const ALICE = 'alice'
  const MALLORY = 'mallory'
  const seal = (plain: Uint8Array) => concat(new Uint8Array([0x5e]), plain)
  let ids = 0
  const manifest = (kind: number, sealed: Uint8Array, objectCount: number, uploader = ALICE): PackManifest => ({
    packHash: bytesToHex(sha256(sealed)),
    kind: kind as PackManifest['kind'],
    sizeBytes: sealed.length,
    objectCount,
    chunkCount: 0,
    storage: 1,
    uris: [],
    tips: [],
    supersedes: [],
    createdAt: 1000 + ids,
    documentId: `doc${ids++}`,
    createdAtBlockHeight: 10,
    uploader,
  })
  /** A members-only pack of blobs `texts`, stored "sealed", and the plaintext index of it at packRef 0. */
  const membersPack = async (texts: string[], uploader = ALICE) => {
    const plain = packFrame(...texts.map((t) => concat(objHeader(T_BLOB, t.length), zlibSync(text(t)))))
    const sealed = seal(plain)
    const m = manifest(PACK_KIND.MEMBERS_GIT_PACK, sealed, texts.length, uploader)
    const rows = ObjectLocator.parse(serializeLocator(await indexPacks([plain])))
    return { plain, sealed, m, rows }
  }
  /** A kind-65 artifact holding `plain`, uploaded by `uploader`, recording `objectCount` rows. */
  const indexArtifact = (plain: Uint8Array, objectCount: number, uploader = ALICE) => {
    const sealed = seal(plain)
    return { sealed, m: manifest(PACK_KIND.MEMBERS_OBJECT_LOCATOR, sealed, objectCount, uploader) }
  }

  /** The reads of a member's browser over `stored`, recording what was fetched whole and by range. */
  const reading = (stored: { m: PackManifest; sealed: Uint8Array }[], plains: Map<string, Uint8Array>) => {
    const whole: string[] = []
    const ranges: string[] = []
    const reads: MembersReads = {
      load: async (m) => {
        whole.push(m.documentId)
        const s = stored.find((x) => x.m.packHash === m.packHash)
        if (s === undefined) throw new Error('not served')
        return s.sealed
      },
      ranged: (m) => async (start, end) => {
        ranges.push(m.documentId)
        return (plains.get(m.packHash) as Uint8Array).subarray(start, end)
      },
      bases: () => async () => null,
    }
    return { reads, whole, ranges }
  }
  const empty = new FragmentedIndex([ObjectLocator.parse(serializeLocator([]))])
  const readerOf = (members: MembersPacks) => new BrowseReader(new MembersIndex(empty, members), membersPackSource(memoryPackSource([]), members))

  it('reads a pack with a trusted index by range, and never fetches it whole', async () => {
    const p = await membersPack(['one\n', 'two\n'])
    const idx = indexArtifact(encodeMembersIndex(hexToBytes(p.m.packHash), p.rows), 2)
    const r = reading([p, idx], new Map([[p.m.packHash, p.plain]]))
    const members = (await loadMembersPacks(lane, [p.m, idx.m], 0, r.reads)) as MembersPacks
    expect(r.whole).toEqual([idx.m.documentId])
    expect(members.locator.count).toBe(2)
    const reader = readerOf(members)
    expect(new TextDecoder().decode((await reader.readObject(gitOidHex('blob', text('two\n')))).bytes)).toBe('two\n')
    expect(r.ranges.length).toBeGreaterThan(0)
    expect(r.whole).toEqual([idx.m.documentId])
  })

  it('falls back to the whole pack for an index from another uploader, of another row count, or naming another pack', async () => {
    const p = await membersPack(['one\n', 'two\n'])
    const other = await membersPack(['three\n', 'four\n'])
    const short = ObjectLocator.parse(serializeLocator((await indexPacks([p.plain])).slice(0, 1)))
    const untrusted = [
      // someone who uploaded no copy of the pack: not even fetched
      indexArtifact(encodeMembersIndex(hexToBytes(p.m.packHash), p.rows), 2, MALLORY),
      // the pack's uploader, but one row of two
      indexArtifact(encodeMembersIndex(hexToBytes(p.m.packHash), short), 2),
      // every row of another pack
      indexArtifact(encodeMembersIndex(hexToBytes(other.m.packHash), other.rows), 2),
      // not a members-only index at all
      indexArtifact(text('not an index'), 2),
    ]
    for (const idx of untrusted) {
      const r = reading([p, idx], new Map([[p.m.packHash, p.plain]]))
      const members = (await loadMembersPacks(lane, [p.m, idx.m], 0, r.reads)) as MembersPacks
      expect(r.whole).toContain(p.m.documentId)
      expect(r.whole.includes(idx.m.documentId)).toBe(idx.m.uploader !== MALLORY)
      expect(members.packs[0]).toBeInstanceOf(Uint8Array)
      const reader = readerOf(members)
      expect(new TextDecoder().decode((await reader.readObject(gitOidHex('blob', text('one\n')))).bytes)).toBe('one\n')
      expect(r.ranges).toEqual([])
    }
  })

  it('mixes ranged and whole packs: a whole pack\'s base in an earlier ranged pack resolves', async () => {
    const first = await membersPack(['the quick brown fox jumps over the lazy dog\n'])
    const idx = indexArtifact(encodeMembersIndex(hexToBytes(first.m.packHash), first.rows), 1)
    // the branch's next push: thin against its previous tip, so its delta names an object of `first`
    const baseText = text('the quick brown fox jumps over the lazy dog\n')
    const next = text('the quick brown fox jumps over the lazy cat\n')
    const delta = copyInsertDelta(baseText.length, next.length, 40, text('cat\n'))
    const thinPlain = packFrame(concat(objHeader(T_REF_DELTA, delta.length), hexToBytes(gitOidHex('blob', baseText)), zlibSync(delta)))
    const thinSealed = seal(thinPlain)
    const thin = { sealed: thinSealed, m: manifest(PACK_KIND.MEMBERS_GIT_PACK, thinSealed, 1) }
    const r = reading([first, idx, thin], new Map([[first.m.packHash, first.plain]]))
    const reads: MembersReads = {
      ...r.reads,
      bases: (ranged) => {
        const reader = readerOf(ranged as MembersPacks)
        return (oid) => reader.readObject(oid).catch(() => null)
      },
    }
    const members = (await loadMembersPacks(lane, [first.m, idx.m, thin.m], 3, reads)) as MembersPacks
    expect(r.whole).toEqual([idx.m.documentId, thin.m.documentId])
    expect(members.manifests.map((m) => m.documentId)).toEqual([first.m.documentId, thin.m.documentId])
    expect(typeof members.packs[0]).toBe('function')
    expect(members.packs[1]).toBeInstanceOf(Uint8Array)
    expect([...members.locator.packRefsCovered()].sort()).toEqual([3, 4])
    const reader = new BrowseReader(new MembersIndex(empty, members), membersPackSource(memoryPackSource([new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)]), members))
    expect(Array.from((await reader.readObject(gitOidHex('blob', next))).bytes)).toEqual(Array.from(next))
    expect(Array.from((await reader.readObject(gitOidHex('blob', baseText))).bytes)).toEqual(Array.from(baseText))
  })
})

describe("a narrower branch's packs (DFPK 0x03)", () => {
  const REPO = new Uint8Array(32).fill(0x11)
  const NAME = 'refs/heads/sec/embargo'
  const blob = text('only for the maintainers\n')
  const pack = packFrame(concat(objHeader(T_BLOB, blob.length), zlibSync(blob)))
  const sha = async (b: Uint8Array) => bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b))))
  const manifest = async (n: number, sealed: Uint8Array): Promise<PackManifest> => ({
    packHash: await sha(sealed),
    kind: 64,
    sizeBytes: sealed.length,
    objectCount: 1,
    chunkCount: 1,
    storage: 0,
    uris: [],
    tips: [],
    supersedes: [],
    createdAt: 1000 + n,
    documentId: `m${n}`,
    uploader: 'u',
    createdAtBlockHeight: 10 + n,
  })

  it('open with a held branch key and are indexed; one whose key is not held is skipped, never an error', async () => {
    const held = BranchKey.fromBytes(new Uint8Array(32).fill(9))
    const ring = await BranchRing.create(REPO, foldBranchLetters([{ id: 'l', height: 1, sender: 'owner', letter: { name: NAME, keys: [held], audience: { group: 'maintainers', also: [] }, to: ['11111111111111111111111111111111'] } }], () => true), () => [])
    const mine = await sealBranchPack(ring.writeKeys(NAME) as BranchKeys, pack)
    const theirs = await sealBranchPack(await BranchKeys.derive(REPO, 0, BranchKey.fromBytes(new Uint8Array(32).fill(4))), pack)
    const stored = new Map([[`m1`, mine], [`m2`, theirs]])
    const manifests = [await manifest(1, mine), await manifest(2, theirs)]
    const lane = { closed: false } as unknown as PrivateSession
    let asked = 0
    const reads: MembersReads = {
      load: async (m) => stored.get(m.documentId) as Uint8Array,
      ranged: () => async () => new Uint8Array(0),
      bases: () => async () => null,
    }
    const got = await loadMembersPacks(lane, manifests, 3, reads, undefined, async () => {
      asked++
      return ring
    })
    expect(asked).toBe(1)
    expect(got?.skipped).toBe(1)
    expect(got?.manifests.map((m) => m.documentId)).toEqual(['m1'])
    expect(got?.locator.count).toBe(1)
    // with no ring, nothing opens and nothing throws
    expect(await loadMembersPacks(lane, manifests, 3, reads)).toBeNull()
  })
})

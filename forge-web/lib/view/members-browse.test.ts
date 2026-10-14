/**
 * The members-only overlay of the browse plane (`members-browse.ts`): a thin members-only pack
 * whose deltas name public objects is indexed in the browser with its REF bases read from the
 * public side, its rows join the public index after the public pack space, and one reader serves
 * both, the public delta base included. A blind resolves to the commit it hides only through the
 * reader's alias (never a guess).
 */

import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { BrowseReader, FragmentedIndex, ObjectLocator, gitOidHex, type GitObject } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { T_BLOB, T_REF_DELTA, concat, copyInsertDelta, hexToBytes, objHeader, packFrame } from '../browse/pack-fixtures'
import { BranchKey, BranchKeys, BranchRing, bytesToHex, foldBranchLetters, sealBranchPack } from '../private'
import type { PackManifest } from '../repo'
import type { PrivateSession } from '../repo/private-session'
import { aliasedReader } from './blind-reader'
import { MembersIndex, loadMembersPacks, membersPackSource, type MembersPacks } from './members-browse'

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
    const got = await loadMembersPacks(lane, manifests, 3, async (m) => stored.get(m.documentId) as Uint8Array, async () => null, undefined, async () => {
      asked++
      return ring
    })
    expect(asked).toBe(1)
    expect(got?.skipped).toBe(1)
    expect(got?.manifests.map((m) => m.documentId)).toEqual(['m1'])
    expect(got?.locator.count).toBe(1)
    // with no ring, nothing opens and nothing throws
    expect(await loadMembersPacks(lane, manifests, 3, async (m) => stored.get(m.documentId) as Uint8Array, async () => null)).toBeNull()
  })
})

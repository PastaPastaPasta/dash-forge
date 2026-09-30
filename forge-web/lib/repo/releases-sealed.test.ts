/** A private repo's release reads (`private-repos.md` §16.3): opened, folded, never named by a hash. */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { EpochKeys, IdSet, type OpenContext, type ReleaseFields } from '../private'
import { sealReleaseWithNonce } from '../private/testing'
import type { PlainDocument } from '../sdk'
import type { RepoRef } from './contract'
import { isDraft, isPrereleaseView, latestRelease, readReleases, releaseCountOf, sealedReleases } from './releases'

const repoId = new Uint8Array(32).fill(0x11)
const owner = new Uint8Array(32).fill(0x22)

async function fixture(): Promise<{ ctx: OpenContext; keys: EpochKeys }> {
  const keys = await EpochKeys.import(repoId, 0, new Uint8Array(32).fill(1))
  const ctx: OpenContext = {
    keys: new Map([[0, keys]]),
    anchors: new Map([[0, { id: new Uint8Array(32).fill(9), height: 1 }]]),
    members: new IdSet(),
  }
  return { ctx, keys }
}

function doc(id: number, createdAt: number, props: Record<string, unknown>): PlainDocument {
  return {
    $id: base58Encode(new Uint8Array(32).fill(id)),
    $ownerId: base58Encode(owner),
    $createdAt: createdAt,
    vis: 'private',
    delta: 0,
    ...props,
  } as PlainDocument
}

describe('sealedReleases', () => {
  it('opens, folds by the decrypted tag, ignores a replay and never shows a hash', async () => {
    const { ctx, keys } = await fixture()
    const seal = (f: ReleaseFields, n: number) => sealReleaseWithNonce(keys, owner, f, new Uint8Array(12).fill(n))
    const v1: ReleaseFields = { tag: 'v1.0.0', name: 'One' }
    const published = await seal(v1, 1)
    const yanked = await seal({ ...v1, yanked: true }, 2)
    const draft = await seal({ tag: 'v2.0.0', draft: true }, 3)
    const pre = await seal({ tag: 'nightly', prerelease: true }, 4)
    const sealed = (s: { tagName: string; enc: Uint8Array }) => ({ tagName: s.tagName, epoch: 0, enc: s.enc })
    const docs = [
      doc(1, 100, sealed(published)),
      doc(2, 200, sealed(yanked)),
      doc(3, 300, sealed(published)), // a replay of the first revision: cannot un-yank
      doc(4, 400, { tagName: 'v9.9.9' }), // plaintext in a private repo: malformed
      doc(5, 500, sealed(draft)),
      doc(6, 600, sealed(pre)),
      doc(7, 700, { ...sealed(yanked), name: 'leak' }), // plaintext next to enc: malformed
    ]
    const list = await sealedReleases(docs, ctx)
    expect(list.current.map((r) => r.tagName).sort()).toEqual(['nightly', 'v1.0.0', 'v2.0.0'])
    for (const r of [...list.current, ...list.previous]) expect(r.tagName).not.toBe(published.tagName)
    const v1Now = list.current.find((r) => r.tagName === 'v1.0.0')!
    expect(v1Now.id).toBe(docs[1]!['$id'])
    expect(v1Now.yanked).toBe(true)
    expect(v1Now.name).toBe('One')
    expect(list.previous.map((r) => r.id)).toEqual([docs[0]!['$id']])
    expect(isDraft(list.current.find((r) => r.tagName === 'v2.0.0')!)).toBe(true)
    expect(isPrereleaseView(list.current.find((r) => r.tagName === 'nightly')!)).toBe(true)
    // the draft is listed but not counted; the yanked release counts
    expect(releaseCountOf(list)).toBe(2)
    // neither a draft nor a yanked release is the latest; the flagged pre-release is the fallback
    expect(latestRelease(list)?.tagName).toBe('nightly')
    expect(list.hidden).toBe(2)
    expect(list.stale).toBe(false)
    // doc 7 does not open, and is newer under v1.0.0's (epoch, tagName): that tag's state is unknown
    expect(list.unknownTags).toEqual(['v1.0.0'])
  })

  it('marks a list stale when a newer revision is under a key the reader lacks', async () => {
    const { ctx, keys } = await fixture()
    const v1 = await sealReleaseWithNonce(keys, owner, { tag: 'v1' }, new Uint8Array(12))
    const withEpoch1: OpenContext = { ...ctx, anchors: new Map([...ctx.anchors, [1, { id: new Uint8Array(32).fill(8), height: 5 }]]) }
    const list = await sealedReleases(
      [doc(1, 100, { tagName: v1.tagName, epoch: 0, enc: v1.enc }), doc(2, 200, { tagName: 'A'.repeat(43), epoch: 1, enc: v1.enc })],
      withEpoch1,
    )
    expect(list.current.map((r) => r.tagName)).toEqual(['v1'])
    expect(list.stale).toBe(true)
    expect(list.hidden).toBe(1)
  })

  it('flags a revision sealed under an earlier use of its epoch number, not as tampering (§16.3)', async () => {
    const { ctx, keys } = await fixture()
    // Sealed under another key of epoch 0: the number's earlier use, before its current key was stated at 1000.
    const old = await EpochKeys.import(repoId, 0, new Uint8Array(32).fill(7))
    const sealedOld = await sealReleaseWithNonce(old, owner, { tag: 'v0.1' }, new Uint8Array(12).fill(5))
    const current = await sealReleaseWithNonce(keys, owner, { tag: 'v1' }, new Uint8Array(12).fill(6))
    const stated: OpenContext = { ...ctx, anchors: new Map([[0, { id: new Uint8Array(32).fill(9), height: 1, statedAt: 1000 }]]) }
    const at = (id: number, createdAt: number, s: { tagName: string; enc: Uint8Array }) => doc(id, createdAt, { tagName: s.tagName, epoch: 0, enc: s.enc })
    const list = await sealedReleases([at(1, 900, sealedOld), at(2, 1100, current)], stated)
    expect(list.current.map((r) => r.tagName)).toEqual(['v1'])
    expect(list.hidden).toBe(1)
    expect(list.earlierUse).toBe(1)
    // The same revision dated after stated(e) does not open under the key of that time: tampering.
    const after = await sealedReleases([at(1, 1001, sealedOld), at(2, 1100, current)], stated)
    expect(after.hidden).toBe(1)
    expect(after.earlierUse).toBeUndefined()
    // Without the time of stated(e) nothing is judged an earlier use.
    expect((await sealedReleases([at(1, 900, sealedOld)], ctx)).earlierUse).toBeUndefined()
    // An earlier use newer than v1's revision under v1's (epoch, tagName) does not put v1 in doubt;
    // the same bytes as badTag (after stated(e)) do.
    const shadow = (createdAt: number) => doc(3, createdAt, { tagName: current.tagName, epoch: 0, enc: sealedOld.enc })
    const early = await sealedReleases([at(2, 800, current), shadow(900)], stated)
    expect(early.earlierUse).toBe(1)
    expect(early.unknownTags).toEqual([])
    const tampered = await sealedReleases([at(2, 1100, current), shadow(1200)], stated)
    expect(tampered.unknownTags).toEqual(['v1'])
  })
})

describe('readReleases', () => {
  it('reads nothing for a private repo without a session: no list, no count, no hashes', async () => {
    const sdk = new Proxy({}, { get: () => { throw new Error('no read without keys') } }) as EvoSDK
    const repo = { visibility: 'private', repoId: 'r' } as unknown as RepoRef
    await expect(readReleases(sdk, repo)).resolves.toEqual({ current: [], previous: [], locked: true })
  })
})

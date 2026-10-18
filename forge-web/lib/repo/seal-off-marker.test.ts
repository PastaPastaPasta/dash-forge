/** Owner marker discovery uses every raw config and only the anchored epoch key. */
import { describe, expect, it } from 'vitest'
import { base58Encode } from '../auth/base58'
import { EpochKeys, encodeSealOffMarker, sealDoc, type SealOffMarker } from '../private'
import { sessionConfirmsSealOff, readSessionSealOff, type PrivateSession } from './private-session'
import { type PlainDocument } from '../sdk'

const owner = new Uint8Array(32).fill(0x22)
const repo = new Uint8Array(32).fill(0x11)
const marker: SealOffMarker = { mode: 'codeOnly', conversionId: new Uint8Array(16).fill(1), boundaryEpoch: 1, startedAtMs: 123n }
const config = (enc: Uint8Array, who = owner): PlainDocument => ({ $id: base58Encode(new Uint8Array(32).fill(3)), $ownerId: base58Encode(who), vis: 'private', epoch: 1n, $createdAtBlockHeight: 10n, enc })
async function fixture(): Promise<{ session: PrivateSession; keys: EpochKeys; docs: PlainDocument[] }> {
  const keys = await EpochKeys.import(repo, 1, new Uint8Array(32).fill(9))
  const enc = await sealDoc(keys, { type: 'config', ownerId: owner, epoch: 1 }, { prevEpoch: 0, prevEpochKey: new Uint8Array(32), sealOff: encodeSealOffMarker(marker) }, { anchor: true })
  const docs = [config(enc)]
  const session = { configDocuments: docs, resolution: { keys: new Map([[1, keys]]), anchors: new Map([[1, { commit: keys.commit }]]), burned: new Set<number>() } } as unknown as PrivateSession
  return { session, keys, docs }
}

describe('owner marker discovery', () => {
  it('opens and counts a marked owner config under the anchored key', async () => {
    const { session } = await fixture()
    expect(await readSessionSealOff(session, owner)).toEqual({ kind: 'active', epoch: 1, highestEpoch: 1, replacesThrough: null, height: 10, marker })
  })
  it('ignores a losing commitment, then counts a follow-up under the winning key', async () => {
    const { session, docs } = await fixture()
    const winning = docs[0]!
    const other = await EpochKeys.import(repo, 1, new Uint8Array(32).fill(8))
    docs[0] = config(await sealDoc(other, { type: 'config', ownerId: owner, epoch: 1 }, { prevEpoch: 0, prevEpochKey: new Uint8Array(32), sealOff: encodeSealOffMarker(marker) }, { anchor: true }))
    expect(await readSessionSealOff(session, owner)).toEqual({ kind: 'none' })
    docs.push({ ...winning, $id: base58Encode(new Uint8Array(32).fill(4)) })
    expect(await readSessionSealOff(session, owner)).toMatchObject({ kind: 'active', epoch: 1 })
  })
  it('fails closed on malformed or unavailable owner configs', async () => {
    const { session, docs } = await fixture()
    docs.push(config(new Uint8Array([2])))
    expect(await readSessionSealOff(session, owner)).toEqual({ kind: 'unknown' })
    docs.pop()
    ;(session.resolution.keys as Map<number, EpochKeys>).clear()
    expect(await readSessionSealOff(session, owner)).toEqual({ kind: 'unknown' })
  })
  it('ignores an unreadable non-owner config', async () => {
    const { session, docs } = await fixture()
    docs.push(config(new Uint8Array([2]), new Uint8Array(32).fill(0x33)))
    expect(await readSessionSealOff(session, owner)).toMatchObject({ kind: 'active', epoch: 1 })
  })
})

it('fails closed when a session has no complete config timeline', async () => {
  const { session } = await fixture()
  const withoutTimeline = { ...session, configDocuments: undefined }
  expect(await readSessionSealOff(withoutTimeline as PrivateSession, owner)).toEqual({ kind: 'unknown' })
})


it('confirms only private owner markers under the anchored key', async () => {
  const { session, docs } = await fixture()
  expect(await sessionConfirmsSealOff(session, owner, marker)).toBe(true)
  docs[0] = { ...docs[0], vis: 'public' }
  expect(await sessionConfirmsSealOff(session, owner, marker)).toBe(false)
})

it('skips owner configs at proven burned epochs without their keys', async () => {
  const { session } = await fixture()
  ;(session.resolution.burned as Set<number>).add(1)
  ;(session.resolution.keys as Map<number, EpochKeys>).clear()
  expect(await readSessionSealOff(session, owner)).toEqual({ kind: 'none' })
})

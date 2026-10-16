/** How far making a private repo public got, read by anyone (DESIGN §4.10, §10). */

import { beforeEach, describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { PlainDocument } from '../sdk'
import type { RepoRef } from './contract'
import { NOT_CONVERTED, STALLED_AFTER_MS, beingMadePublicText, conversionProgress, conversionProgressCached, forgetConversionProgress, isStalled, progressOf, stalledText } from './conversion-status'
import { recordConversion } from './converted'
import { mockSdk, newSeen, type Store } from './drive-mock'
import { contractOf } from './source'

const id = (b: number): string => base58Encode(new Uint8Array(32).fill(b))
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const REPO: RepoRef = { forge: FORGE, repoId: id(0x11), ownerId: id(0x21), name: 'r', visibility: 'public' }
const MIN = 60_000

let seq = 0
const row = (fields: PlainDocument): PlainDocument => ({ $id: id(0x40 + ++seq), repoId: REPO.repoId, ...fields })

/** The configs of a conversion: two private-era anchors, then (`marker`) the plaintext config of step 4. */
function configs(marker: boolean): PlainDocument[] {
  return [
    row({ $createdAt: 1 * MIN, $createdAtBlockHeight: 10, epoch: 0, enc: 'AQ==', vis: 'private' }),
    // the seal-off rotation (step 2)
    row({ $createdAt: 5 * MIN, $createdAtBlockHeight: 50, epoch: 1, enc: 'AQ==', vis: 'private' }),
    ...(marker ? [row({ $createdAt: 7 * MIN, $createdAtBlockHeight: 70, defaultBranch: 'main', vis: 'public' })] : []),
  ]
}
const repoDoc = row({ $id: REPO.repoId, $updatedAt: 6 * MIN, visibility: 'public' })
const oldRef = row({ $createdAt: 2 * MIN, vis: 'private', enc: 'AQ==', epoch: 0 })
const publicRef = row({ $createdAt: 8 * MIN, vis: 'public', refName: 'refs/heads/main' })
const membersRef = row({ $createdAt: 9 * MIN, vis: 'public', enc: 'Aw==', epoch: 1 })

describe('progressOf', () => {
  it('a repo never made public: nothing to say', () => {
    expect(progressOf(REPO, { configs: [row({ $createdAt: MIN, $createdAtBlockHeight: 1, vis: 'public' })], repoDoc, refs: [] })).toEqual(NOT_CONVERTED)
    expect(progressOf({ ...REPO, visibility: 'private' }, { configs: configs(false), repoDoc, refs: [] })).toEqual(NOT_CONVERTED)
  })

  it('flipped, no settings yet: unfinished since the flip', () => {
    const p = progressOf(REPO, { configs: configs(false), repoDoc, refs: [oldRef] })
    expect(p).toEqual({ converted: true, flippedAt: 6 * MIN, markerAt: null, hasPublicRefs: false, hasPrivateEraRefs: true, unfinished: true, lastStepAt: 6 * MIN })
  })

  it('settings written, code from before the flip not published yet: unfinished since the marker', () => {
    const p = progressOf(REPO, { configs: configs(true), repoDoc, refs: [oldRef, membersRef] })
    expect(p).toMatchObject({ markerAt: 7 * MIN, hasPublicRefs: false, hasPrivateEraRefs: true, unfinished: true, lastStepAt: 7 * MIN })
  })

  it('a plaintext ref update since: finished', () => {
    const p = progressOf(REPO, { configs: configs(true), repoDoc, refs: [oldRef, publicRef, membersRef] })
    expect(p).toMatchObject({ hasPublicRefs: true, unfinished: false, lastStepAt: 8 * MIN })
  })

  it('no code before the flip: finished with the marker', () => {
    expect(progressOf(REPO, { configs: configs(true), repoDoc, refs: [] })).toMatchObject({ hasPrivateEraRefs: false, unfinished: false })
  })
})

describe('stalled', () => {
  const p = progressOf(REPO, { configs: configs(false), repoDoc, refs: [oldRef] })
  it('only after ten minutes without a step, and only while unfinished', () => {
    expect(isStalled(p, 6 * MIN + STALLED_AFTER_MS)).toBe(false)
    expect(isStalled(p, 6 * MIN + STALLED_AFTER_MS + 1)).toBe(true)
    expect(isStalled({ ...p, unfinished: false }, 100 * MIN)).toBe(false)
    expect(isStalled(NOT_CONVERTED, 100 * MIN)).toBe(false)
  })
  it('says when, in the words readers see', () => {
    expect(stalledText(0 + 1, 3 * 24 * 60 * MIN + 1)).toBe('Making this repo public stalled 3d ago.')
    expect(beingMadePublicText).toBe("This repo is being made public. Its code appears here when that's done.")
  })
})

describe('conversionProgress', () => {
  let store: Store
  beforeEach(() => {
    store = {}
    const put = (type: string, docs: PlainDocument[]): void => {
      const c = contractOf(FORGE, type)
      store[c] = { ...(store[c] ?? {}), [type]: docs }
    }
    put('config', configs(true))
    put('repo', [repoDoc])
    put('refUpdate', [oldRef, membersRef])
    put('protectedRefUpdate', [])
    forgetConversionProgress(REPO)
  })

  it('reads the configs, the repo and both ends of both reflogs', async () => {
    const seen = newSeen()
    const p = await conversionProgress(mockSdk(store, seen), REPO)
    expect(p).toMatchObject({ converted: true, markerAt: 7 * MIN, hasPrivateEraRefs: true, hasPublicRefs: false, unfinished: true })
    expect(seen.queries.map((q) => q.documentTypeName).sort()).toEqual(['config', 'protectedRefUpdate', 'protectedRefUpdate', 'refUpdate', 'refUpdate', 'repo'])
  })

  it('costs no read for a repo the page found never made public, nor a private one', async () => {
    const seen = newSeen()
    recordConversion(REPO, [row({ $createdAt: MIN, $createdAtBlockHeight: 1, vis: 'public' })])
    expect(await conversionProgress(mockSdk(store, seen), REPO)).toEqual(NOT_CONVERTED)
    expect(await conversionProgress(mockSdk(store, seen), { ...REPO, visibility: 'private' })).toEqual(NOT_CONVERTED)
    expect(seen.queries).toHaveLength(0)
    recordConversion(REPO, configs(true))
  })

  it('a converted repo read once per page', async () => {
    const seen = newSeen()
    const sdk = mockSdk(store, seen)
    await conversionProgressCached(sdk, REPO)
    await conversionProgressCached(sdk, REPO)
    expect(seen.queries.filter((q) => q.documentTypeName === 'config')).toHaveLength(1)
    forgetConversionProgress(REPO)
    await conversionProgressCached(sdk, REPO)
    expect(seen.queries.filter((q) => q.documentTypeName === 'config')).toHaveLength(2)
  })
})

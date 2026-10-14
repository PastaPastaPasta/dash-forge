/**
 * Where making a repo public stands, from fake chain rows (the config timeline gives the conversion
 * facts as `converted.test.ts` reads them) and this browser's record: "3 of 7 steps done", the
 * stalled run's last step, the history left to the owner.
 */

import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { PlainDocument } from '../sdk'
import type { RepoRef } from './contract'
import { repoConversion } from './converted'
import type { MakePublicRecord } from './make-public'
import { statusOf, type StatusFacts } from './make-public-status'

const b58 = (b: number): string => base58Encode(new Uint8Array(32).fill(b))
const OWNER = b58(0x21)
const MAINT = b58(0x22)
const REPO: RepoRef = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: b58(0x11), ownerId: OWNER, name: 'ledger', visibility: 'public' }
let n = 0
const config = (vis: 'private' | 'public', height: number, epoch?: number): PlainDocument => ({
  $id: base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? ++n : 0x50))),
  $createdAt: height * 1000,
  $createdAtBlockHeight: height,
  vis,
  ...(epoch !== undefined ? { epoch, enc: 'AA==' } : {}),
})
const MAIN = 'refs/heads/main'
const DEV = 'refs/heads/dev'
const record = (over: Partial<MakePublicRecord> = {}): MakePublicRecord => ({ mode: 'codeOnly', refs: [[MAIN, 'a'.repeat(40)], [DEV, 'b'.repeat(40)]], sealOff: null, startedAt: 1_000, ...over })

function facts(over: Partial<StatusFacts>): StatusFacts {
  return {
    visibility: 'public',
    conversion: null,
    record: null,
    highestEpoch: null,
    sealOffAt: null,
    flipAt: null,
    markerAt: null,
    publicRefs: new Map(),
    membersOnly: new Set(),
    ownerBundles: [],
    viewer: OWNER,
    owner: OWNER,
    ...over,
  }
}

describe('the status of making a repo public', () => {
  it('while private: the confirmation and the seal-off count once the recorded epoch is the current one', () => {
    const none = statusOf(facts({ visibility: 'private', highestEpoch: 2 }))
    expect(none).toMatchObject({ phase: 'private', converted: false, doneCount: 0, totalSteps: 7, lastStepAt: null, record: null, mode: null })
    const sealed = statusOf(facts({ visibility: 'private', highestEpoch: 3, record: record({ sealOff: 3 }), sealOffAt: 9_000 }))
    expect(sealed.steps).toEqual({ sealOff: 'done', flip: 'todo', config: 'todo', code: 'todo', notify: 'todo', history: 'skipped' })
    expect(sealed.doneCount).toBe(2)
    expect(sealed.lastStepAt).toBe(9_000)
    expect(sealed.record?.refs.map((r) => r.name)).toEqual([MAIN, DEV])
    // someone rotated after it: the seal-off runs again
    expect(statusOf(facts({ visibility: 'private', highestEpoch: 4, record: record({ sealOff: 3 }) })).steps.sealOff).toBe('todo')
  })

  it('a repo never private is simply public', () => {
    const rows = [config('public', 10)]
    expect(repoConversion(REPO, rows)).toBeNull()
    expect(statusOf(facts({ conversion: null }))).toMatchObject({ phase: 'public', converted: false, doneCount: 0 })
  })

  it('made public, unfinished: "3 of 7 steps done" until the settings and the code land, then finished', () => {
    // flipped (configs stamped private, none public yet): the settings and the code are left
    const flipped = repoConversion(REPO, [config('private', 10, 0), config('private', 20, 1)])
    expect(flipped).toEqual({ sealOffEpoch: 1, markerHeight: null })
    const s = statusOf(facts({ conversion: flipped, record: record(), flipAt: 25_000, viewer: MAINT }))
    expect(s).toMatchObject({ phase: 'made', converted: true, doneCount: 3, lastStepAt: 25_000, mode: 'codeOnly' })
    expect(s.steps).toEqual({ sealOff: 'done', flip: 'done', config: 'todo', code: 'todo', notify: 'todo', history: 'skipped' })
    // the first public config, main public, dev continued by members after the flip: finished
    const marked = repoConversion(REPO, [config('private', 10, 0), config('private', 20, 1), config('public', 30)])
    const done = statusOf(
      facts({ conversion: marked, record: record(), flipAt: 25_000, markerAt: 30_000, publicRefs: new Map([[MAIN, { oid: 'a'.repeat(40), at: 31_000 }]]), membersOnly: new Set([DEV]) }),
    )
    expect(done).toMatchObject({ phase: 'public', doneCount: 7, lastStepAt: 31_000 })
    // without the members' view (an outsider), dev still looks unpublished
    expect(statusOf(facts({ conversion: marked, record: record(), publicRefs: new Map([[MAIN, { oid: 'a'.repeat(40), at: 31_000 }]]) })).steps.code).toBe('todo')
  })

  it('Everything: the history is the owner\'s step; once the owner recorded a bundle the mode is known without a record', () => {
    const marked = repoConversion(REPO, [config('private', 20, 1), config('public', 30)])
    const pending = statusOf(facts({ conversion: marked, record: record({ mode: 'everything' }), publicRefs: new Map([[MAIN, { oid: 'a', at: 1 }], [DEV, { oid: 'b', at: 2 }]]), viewer: MAINT }))
    expect(pending.steps.history).toBe('owner')
    expect(pending.phase).toBe('made')
    expect(statusOf(facts({ conversion: marked, record: record({ mode: 'everything' }), viewer: OWNER })).steps.history).toBe('todo')
    const published = statusOf(facts({ conversion: marked, publicRefs: new Map([[MAIN, { oid: 'a', at: 1 }]]), ownerBundles: [40_000] }))
    expect(published).toMatchObject({ mode: 'everything', phase: 'public', lastStepAt: 40_000 })
    expect(published.steps.history).toBe('done')
  })
})

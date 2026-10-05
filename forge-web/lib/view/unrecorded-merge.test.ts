/** "Record merge of <commit>": offered only for an open, ready PR the viewer can merge, whose base tip makes its changes. */

import { describe, expect, it } from 'vitest'

import { unrecordedMerge, unrecordedMergeCandidate, type UnrecordedMergeInputs } from './pull-actions'

const HEAD = 'a'.repeat(40)
const TIP = 'b'.repeat(40)
const PREV = 'c'.repeat(40)

function inputs(over: Partial<UnrecordedMergeInputs['pull']> = {}, canMerge = true): UnrecordedMergeInputs {
  return {
    pull: { headOid: HEAD, baseTipOid: TIP, baseTipPrev: PREV, stateComplete: true, state: { open: true, draft: false, merged: false }, ...over },
    canMerge,
  }
}

describe('unrecordedMerge', () => {
  it('offers the base tip when it contains the PR, or is a squash or rebase of it', () => {
    for (const v of ['contains', 'squash', 'rebase'] as const) expect(unrecordedMerge(inputs(), v)).toBe(TIP)
  })

  it('offers nothing when the tip does not contain the PR or could not be checked', () => {
    expect(unrecordedMerge(inputs(), 'missing')).toBeNull()
    expect(unrecordedMerge(inputs(), 'unknown')).toBeNull()
    expect(unrecordedMerge(inputs(), null)).toBeNull()
  })

  it('needs the merge right: a writer refused on a protected base never sees it', () => {
    expect(unrecordedMergeCandidate(inputs({}, false))).toBe(false)
    expect(unrecordedMerge(inputs({}, false), 'squash')).toBeNull()
  })

  it('is not checked for a closed, merged or draft PR, an unread state, or a head that is the tip', () => {
    expect(unrecordedMergeCandidate(inputs({ state: { open: false, draft: false, merged: false } }))).toBe(false)
    expect(unrecordedMergeCandidate(inputs({ state: { open: false, draft: false, merged: true } }))).toBe(false)
    expect(unrecordedMergeCandidate(inputs({ state: { open: true, draft: true, merged: false } }))).toBe(false)
    expect(unrecordedMergeCandidate(inputs({ stateComplete: false }))).toBe(false)
    // The head is the tip: "Mark as merged (done elsewhere)" records that.
    expect(unrecordedMergeCandidate(inputs({ baseTipOid: HEAD }))).toBe(false)
  })

  it('needs a base tip and a tip before it to build on', () => {
    expect(unrecordedMergeCandidate(inputs({ baseTipOid: '' }))).toBe(false)
    expect(unrecordedMergeCandidate(inputs({ baseTipPrev: '' }))).toBe(false)
    expect(unrecordedMergeCandidate(inputs())).toBe(true)
  })
})

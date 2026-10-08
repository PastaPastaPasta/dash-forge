/** "Record merge of <commit>": offered only for an open, ready PR the viewer can merge, whose base tip makes its changes. */

import { describe, expect, it } from 'vitest'

import { mergeContent, type MergeContent, type MergeVerdict } from '../rules/merge-content'
import { unrecordedMerge, unrecordedMergeCandidate, unverifiedMerge, type UnrecordedMergeInputs } from './pull-actions'

const HEAD = 'a'.repeat(40)
const TIP = 'b'.repeat(40)
const PREV = 'c'.repeat(40)

function inputs(over: Partial<UnrecordedMergeInputs['pull']> = {}, canMerge = true): UnrecordedMergeInputs {
  return {
    pull: { headOid: HEAD, baseTipOid: TIP, baseTipPrev: PREV, stateComplete: true, state: { open: true, draft: false, merged: false }, ...over },
    canMerge,
  }
}

const c = (verdict: MergeVerdict, combined: readonly string[] = []): MergeContent => ({ verdict, combined })

describe('unrecordedMerge', () => {
  it('offers the base tip when it contains the PR, or is a squash or rebase of it with nothing combined', () => {
    for (const v of ['contains', 'squash', 'rebase'] as const) {
      expect(unrecordedMerge(inputs(), c(v))).toBe(TIP)
      expect(unverifiedMerge(inputs(), c(v))).toBeNull()
    }
  })

  it('offers nothing when the tip does not contain the PR or could not be checked', () => {
    expect(unrecordedMerge(inputs(), c('missing'))).toBeNull()
    expect(unrecordedMerge(inputs(), c('unknown'))).toBeNull()
    expect(unrecordedMerge(inputs(), null)).toBeNull()
    expect(unverifiedMerge(inputs(), c('missing'))).toBeNull()
    expect(unverifiedMerge(inputs(), null)).toBeNull()
  })

  // Q5-A01: an unrelated push to a file both the PR and the base changed reads as a squash with
  // that file combined. A recorded merge is final, so the page records none and says why.
  it('offers no Record merge for a squash or rebase with files changed on both sides', () => {
    const unrelated = mergeContent({
      headOid: HEAD, mergeOid: TIP, tipBefore: PREV, mergeParents: [PREV], headInMerge: false, tipBeforeInMerge: true,
      mergeChange: { 'CHANGELOG.md': 'u' }, prChange: { 'CHANGELOG.md': 'p' }, baseChange: { 'CHANGELOG.md': 'b' },
    })
    expect(unrelated).toEqual({ verdict: 'squash', combined: ['CHANGELOG.md'] })
    expect(unrecordedMerge(inputs(), unrelated)).toBeNull()
    expect(unverifiedMerge(inputs(), unrelated)).toBe(TIP)
    expect(unrecordedMerge(inputs(), c('rebase', ['a.rs']))).toBeNull()
    expect(unverifiedMerge(inputs(), c('rebase', ['a.rs']))).toBe(TIP)
    // The same squash with the PR's own blob: offered.
    const clean = mergeContent({
      headOid: HEAD, mergeOid: TIP, tipBefore: PREV, mergeParents: [PREV], headInMerge: false, tipBeforeInMerge: true,
      mergeChange: { 'CHANGELOG.md': 'p' }, prChange: { 'CHANGELOG.md': 'p' }, baseChange: { 'README.md': 'r' },
    })
    expect(unrecordedMerge(inputs(), clean)).toBe(TIP)
  })

  it('needs the merge right: a writer refused on a protected base never sees it', () => {
    expect(unrecordedMergeCandidate(inputs({}, false))).toBe(false)
    expect(unrecordedMerge(inputs({}, false), c('squash'))).toBeNull()
    expect(unverifiedMerge(inputs({}, false), c('squash', ['a.rs']))).toBeNull()
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

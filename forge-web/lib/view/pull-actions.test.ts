/**
 * PR action gating — the merge control is offered only to members (whose `event` consensus
 * admits), and it says whether the mark counts now.
 *
 * The end-to-end case at the bottom ties the gate to `foldPrStateV2`: whenever the gate says a
 * mark "counts now", folding that same merge event really does flip the PR to merged.
 */

import { describe, expect, it } from 'vitest'

import type { PullView } from '../repo'
import { historicalTipsPredicate } from '../repo'
import type { Event, Holdings } from '../rules'
import { foldPrStateV2 } from '../rules/v2'
import { pullActions, type PullActionInputs } from './pull-actions'

const AUTHOR = 'author'
const WRITER = 'writer'
const MAINTAINER = 'maintainer'
const STRANGER = 'stranger'
const HEAD = 'cd'.repeat(20)

const NONE: Holdings = { write: false, maintain: false }
const WRITE: Holdings = { write: true, maintain: false }
const MAINTAIN: Holdings = { write: false, maintain: true }

type Pull = PullActionInputs['pull']

function pull(over: Omit<Partial<Pull>, 'state'> & { state?: Partial<PullView['state']> } = {}): Pull {
  const { state, ...rest } = over
  return {
    author: AUTHOR,
    headOid: HEAD,
    headOnBase: false,
    stateComplete: true,
    ...rest,
    state: { open: true, merged: false, draft: false, baseRef: null, labels: [], assignees: [], ...state },
  }
}

describe('pullActions — who sees "Mark as merged"', () => {
  it('offers it to writers and maintainers', () => {
    expect(pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE }).canMarkMerged).toBe(true)
    expect(pullActions({ pull: pull(), viewer: MAINTAINER, holdings: MAINTAIN }).canMarkMerged).toBe(true)
  })

  it('withholds it from a signed-in non-member, with the reason', () => {
    const a = pullActions({ pull: pull(), viewer: STRANGER, holdings: NONE })
    expect(a.canMarkMerged).toBe(false)
    expect(a.mergeHint).toMatch(/maintainers and writers/)
  })

  it('withholds it from the PR author who is not a member', () => {
    const a = pullActions({ pull: pull(), viewer: AUTHOR, holdings: NONE })
    expect(a.canMarkMerged).toBe(false)
    // …but the author may still close/reopen their own PR (an authorEvent).
    expect(a.canCloseReopen).toBe(true)
  })

  it('withholds it when logged out, with no hint', () => {
    const a = pullActions({ pull: pull(), viewer: null, holdings: null })
    expect(a.canMarkMerged).toBe(false)
    expect(a.canCloseReopen).toBe(false)
    expect(a.mergeHint).toBeNull()
  })

  it('withholds it silently while membership loads, and explains an unreadable one', () => {
    const loading = pullActions({ pull: pull(), viewer: WRITER, holdings: 'loading' })
    expect(loading.canMarkMerged).toBe(false)
    expect(loading.mergeHint).toBeNull()

    const unknown = pullActions({ pull: pull(), viewer: WRITER, holdings: null })
    expect(unknown.canMarkMerged).toBe(false)
    expect(unknown.mergeHint).toMatch(/members/)
  })

  it('withholds it on merged, closed, headless, and unverified PRs', () => {
    const holder = { viewer: WRITER, holdings: WRITE }
    expect(pullActions({ pull: pull({ state: { merged: true, open: false } }), ...holder }).canMarkMerged).toBe(false)
    expect(pullActions({ pull: pull({ state: { open: false } }), ...holder }).canMarkMerged).toBe(false)
    expect(pullActions({ pull: pull({ headOid: '' }), ...holder }).canMarkMerged).toBe(false)
    expect(pullActions({ pull: pull({ stateComplete: false }), ...holder }).canMarkMerged).toBe(false)
  })
})

describe('pullActions — close / reopen', () => {
  it('offers close on an open PR and reopen on a closed one, to members and the author', () => {
    expect(pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE }).canCloseReopen).toBe(true)
    expect(pullActions({ pull: pull({ state: { open: false } }), viewer: AUTHOR, holdings: NONE }).canCloseReopen).toBe(true)
  })

  it('withholds both from a stranger, and from everyone on a merged PR', () => {
    expect(pullActions({ pull: pull(), viewer: STRANGER, holdings: NONE }).canCloseReopen).toBe(false)
    expect(
      pullActions({ pull: pull({ state: { merged: true, open: false } }), viewer: WRITER, holdings: WRITE }).canCloseReopen,
    ).toBe(false)
  })
})

describe('pullActions agrees with the fold', () => {
  const mergeBy = (actor: string): Event => ({ id: 'e1', kind: 'merge', actor, oid: HEAD, createdAt: 10 })

  it('"counts now" iff the head has been a base tip — and the fold then merges', () => {
    for (const [baseTips, expected] of [
      [[HEAD, 'ef'.repeat(20)], true], // head was a tip, base moved on
      [['ef'.repeat(20)], false], // head never reached base
    ] as const) {
      const isAncestor = historicalTipsPredicate(baseTips)
      const baseTip = baseTips[baseTips.length - 1] as string
      const headOnBase = isAncestor(HEAD, baseTip)

      const a = pullActions({ pull: pull({ headOnBase }), viewer: WRITER, holdings: WRITE })
      expect(a.canMarkMerged).toBe(true)
      expect(a.markCountsNow).toBe(expected)
      // A member's `event` (consensus admitted it, so the fold applies it).
      expect(foldPrStateV2([mergeBy(WRITER)], [], AUTHOR, baseTip, isAncestor).merged).toBe(expected)
      // An author's merge through `authorEvent` is inert — merge is not an author action.
      expect(foldPrStateV2([], [mergeBy(AUTHOR)], AUTHOR, baseTip, isAncestor).merged).toBe(false)
    }
  })
})

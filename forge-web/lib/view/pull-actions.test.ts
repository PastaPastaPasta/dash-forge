/**
 * PR action gating — the merge control is offered only to identities whose merge event the
 * fold would accept, and it says whether the mark counts now.
 *
 * The end-to-end case at the bottom ties the gate to {@link foldPrState}: whenever the gate
 * says a mark "counts now", folding that same merge event really does flip the PR to merged —
 * and a non-holder (to whom the gate never offers the control) would have folded inert.
 */

import { describe, expect, it } from 'vitest'

import type { PullView } from '../repo'
import { historicalTipsPredicate } from '../repo'
import { AuthzResolver, foldPrState, type Event, type Holdings, type TokenRecord } from '../rules'
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
  it('offers it to WRITE and MAINTAIN holders', () => {
    expect(pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE }).canMarkMerged).toBe(true)
    expect(pullActions({ pull: pull(), viewer: MAINTAINER, holdings: MAINTAIN }).canMarkMerged).toBe(true)
  })

  it('withholds it from a signed-in non-holder, with the reason', () => {
    const a = pullActions({ pull: pull(), viewer: STRANGER, holdings: NONE })
    expect(a.canMarkMerged).toBe(false)
    expect(a.mergeHint).toMatch(/WRITE or MAINTAIN/)
  })

  it('withholds it from the PR author who holds no token', () => {
    const a = pullActions({ pull: pull(), viewer: AUTHOR, holdings: NONE })
    expect(a.canMarkMerged).toBe(false)
    // …but the author may still close/reopen their own PR (the fold honors that).
    expect(a.canCloseReopen).toBe(true)
  })

  it('withholds it when logged out, with no hint', () => {
    const a = pullActions({ pull: pull(), viewer: null, holdings: null })
    expect(a.canMarkMerged).toBe(false)
    expect(a.canCloseReopen).toBe(false)
    expect(a.mergeHint).toBeNull()
  })

  it('withholds it silently while holdings load, and explains an unreadable history', () => {
    const loading = pullActions({ pull: pull(), viewer: WRITER, holdings: 'loading' })
    expect(loading.canMarkMerged).toBe(false)
    expect(loading.mergeHint).toBeNull()

    const unknown = pullActions({ pull: pull(), viewer: WRITER, holdings: null })
    expect(unknown.canMarkMerged).toBe(false)
    expect(unknown.mergeHint).toMatch(/token history/)
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
  it('offers close on an open PR and reopen on a closed one, to holders and the author', () => {
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

describe('pullActions — forge-v2 membership', () => {
  // On forge-v2 "holdings" come from membership documents (`holdingsOfRole`), so the same gate
  // applies; only the wording says members rather than token holders.
  it('offers merge to a maintainer or writer and names members when withholding it', () => {
    expect(pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, model: 'v2' }).canMarkMerged).toBe(true)
    const stranger = pullActions({ pull: pull(), viewer: STRANGER, holdings: NONE, model: 'v2' })
    expect(stranger.canMarkMerged).toBe(false)
    expect(stranger.mergeHint).toMatch(/maintainers and writers/)
    const unknown = pullActions({ pull: pull(), viewer: WRITER, holdings: null, model: 'v2' })
    expect(unknown.mergeHint).toMatch(/members/)
    expect(unknown.mergeHint).not.toMatch(/token/)
  })

  it('lets the author close their own PR (an authorEvent) without membership', () => {
    expect(pullActions({ pull: pull(), viewer: AUTHOR, holdings: NONE, model: 'v2' }).canCloseReopen).toBe(true)
  })
})

describe('pullActions agrees with the fold', () => {
  const records: TokenRecord[] = [{ identity: WRITER, token: 'write', op: 'mint', createdAt: 0 }]
  const authz = new AuthzResolver(records)
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
      expect(foldPrState([mergeBy(WRITER)], AUTHOR, authz, baseTip, isAncestor).merged).toBe(expected)
      // A stranger's identical event is inert — which is why they are never offered it.
      expect(foldPrState([mergeBy(STRANGER)], AUTHOR, authz, baseTip, isAncestor).merged).toBe(false)
    }
  })
})

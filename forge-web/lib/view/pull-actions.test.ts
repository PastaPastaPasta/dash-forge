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
import { mergeBaseTip, mergeButton, mergeRefProblem, pullActions, type PullActionInputs } from './pull-actions'

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

describe('pullActions — protected base and branch policy (D-503)', () => {
  const MAIN = 'refs/heads/main'
  const protectedMain = { protectedPatterns: [MAIN] }

  it('refuses a writer the merge into a protected base, and says why', () => {
    const a = pullActions({ pull: pull({ baseRefName: MAIN }), viewer: WRITER, holdings: WRITE, ...protectedMain })
    expect(a.canMarkMerged).toBe(false)
    expect(a.baseProtected).toBe(true)
    expect(a.mergeHint).toMatch(/main is a protected branch: only maintainers/)
  })

  it('offers a maintainer the merge into a protected base', () => {
    const a = pullActions({ pull: pull({ baseRefName: MAIN }), viewer: MAINTAINER, holdings: MAINTAIN, ...protectedMain })
    expect(a.canMarkMerged).toBe(true)
    expect(a.policyOverride).toBe(false)
  })

  it('matches the base with the FORGE_RULES globs, not by name', () => {
    const release = pull({ baseRefName: 'refs/heads/release/1.x' })
    expect(pullActions({ pull: release, viewer: WRITER, holdings: WRITE, protectedPatterns: ['refs/heads/release/*'] }).canMarkMerged).toBe(false)
    expect(pullActions({ pull: release, viewer: WRITER, holdings: WRITE, protectedPatterns: ['refs/heads/*'] }).canMarkMerged).toBe(true)
    // A bare branch name is not a full-ref pattern and protects nothing.
    expect(pullActions({ pull: pull({ baseRefName: MAIN }), viewer: WRITER, holdings: WRITE, protectedPatterns: ['main'] }).canMarkMerged).toBe(true)
  })

  it('disables a writer on an unmet policy and offers a maintainer the override', () => {
    const unmet = { met: false, have: 0, need: 2 }
    const w = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: unmet })
    expect(w.canMarkMerged).toBe(false)
    expect(w.mergeHint).toMatch(/needs 2 approvals \(0 so far\)/)
    const m = pullActions({ pull: pull(), viewer: MAINTAINER, holdings: MAINTAIN, policy: unmet })
    expect(m.canMarkMerged).toBe(true)
    expect(m.policyOverride).toBe(true)
  })

  it('withholds a writer merge when the policy could not be read, and says so (M4: fail closed)', () => {
    const w = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: 'unknown' })
    expect(w.canMarkMerged).toBe(false)
    expect(w.mergeHint).toMatch(/couldn't read the branch policy/i)
    const m = pullActions({ pull: pull(), viewer: MAINTAINER, holdings: MAINTAIN, policy: 'unknown' })
    expect(m.canMarkMerged).toBe(true)
  })

  it('lets a writer merge once the policy is met on an unprotected base', () => {
    const a = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: { met: true, have: 2, need: 2 } })
    expect(a.canMarkMerged).toBe(true)
    expect(a.policyOverride).toBe(false)
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

describe('H2: what the browser merge will move', () => {
  const OID = 'ab'.repeat(20)
  it('accepts only an existing plain branch and a full head oid', () => {
    expect(mergeRefProblem('refs/heads/main', OID, OID)).toBeNull()
    expect(mergeRefProblem('refs/heads/feature/x-1', OID, OID)).toBeNull()
    const bad = [
      'main',
      'refs/tags/v1',
      'refs/heads/',
      'refs/heads/a..b',
      'refs/heads/.x',
      'refs/heads/x.lock',
      'refs/heads/a b',
      'refs/heads/a~1',
      'refs/heads/a^',
      'refs/heads/a:b',
      'refs/heads/a?',
      'refs/heads/a*',
      'refs/heads/a[',
      'refs/heads/a\\b',
      'refs/heads/x/',
      'refs/heads/x.',
      'refs/heads/a@{b',
      'refs/heads/a//b',
      'refs/heads/a+b',
      'refs/heads/a\nb',
      'refs/heads/a\u007fb',
    ]
    for (const r of bad) expect(mergeRefProblem(r, OID, OID), r).not.toBeNull()
    expect(mergeRefProblem('refs/heads/main', '', OID)).toMatch(/does not exist/)
    expect(mergeRefProblem('refs/heads/main', OID, 'AB'.repeat(20))).toMatch(/head/)
    expect(mergeRefProblem('refs/heads/main', OID, 'ab'.repeat(32))).toMatch(/head/)
  })

  it('the merge button refuses before checking anything', () => {
    const ok = { canMerge: true, isPublic: true, refProblem: null, baseLoaded: true, isMaintainer: true, baseProtected: false, narrow: false, check: 'fast-forward' as const, checkout: 'dg pr checkout o/r 1' }
    expect(mergeButton(ok).kind).toBe('fast-forward')
    expect(mergeButton({ ...ok, refProblem: 'nope' })).toEqual({ kind: 'unavailable', reason: 'nope' })
    expect(mergeButton({ ...ok, isPublic: false }).kind).toBe('unavailable')
    expect(mergeButton({ ...ok, baseLoaded: false })).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/Load the base repo/) })
    expect(mergeButton({ ...ok, check: 'malformed' }).kind).toBe('unavailable')
  })
})

describe('mergeBaseTip — the browser merge builds only on a base it may merge into (D-501)', () => {
  const MAIN = 'refs/heads/main'
  const OLD = 'aa'.repeat(20)
  const NOW = 'bb'.repeat(20)
  it('builds on the branch as it stands now', () => {
    expect(mergeBaseTip({ baseRefName: MAIN, baseTipOid: OLD }, MAIN, NOW)).toBe(NOW)
  })
  it('refuses a deleted base (a push would re-create it), not falling back to its old tip', () => {
    expect(mergeBaseTip({ baseRefName: MAIN, baseTipOid: OLD }, MAIN, null)).toBe('')
    expect(mergeRefProblem(MAIN, '', HEAD)).toMatch(/does not exist/)
  })
  it('refuses a base that was no branch when the PR was opened, though it exists now', () => {
    expect(mergeBaseTip({ baseRefName: MAIN, baseTipOid: '' }, MAIN, NOW)).toBe('')
  })
  it('refuses a retargeted PR: a merge into the new base would move it and never count', () => {
    expect(mergeBaseTip({ baseRefName: MAIN, baseTipOid: OLD }, 'refs/heads/next', NOW)).toBe('')
    expect(mergeBaseTip({ baseRefName: MAIN, baseTipOid: '' }, 'refs/heads/next', NOW)).toBe('')
    expect(mergeRefProblem('refs/heads/next', NOW, HEAD, MAIN)).toMatch(/retargeted.*open a new PR against the new base/)
    expect(mergeRefProblem(MAIN, NOW, HEAD, MAIN)).toBeNull()
  })
})

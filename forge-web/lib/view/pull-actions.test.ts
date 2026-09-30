/**
 * PR action gating — the merge control is offered only to members (whose `event` consensus
 * admits), and it says whether the mark counts now.
 *
 * The end-to-end case at the bottom ties the gate to `prStateV2`: whenever the gate says a
 * mark "counts now", folding that same merge event really does flip the PR to merged.
 */

import { describe, expect, it } from 'vitest'

import type { PullView } from '../repo'
import { historicalTipsPredicate } from '../repo'
import type { Holdings } from '../rules'
import { prStateV2 } from '../rules/v2'
import { deleteBranchOffer, deleteBranchProblem, mergeBaseTip, mergeBoxShown, mergeBoxSlot, mergeButton, mergeRefProblem, policyOf, pullActions, verdictSummary, type PullActionInputs } from './pull-actions'

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

  it('treats unread approvals as an unknown policy (the approvals card could not load)', () => {
    expect(policyOf(null)).toEqual({ policy: 'unknown', status: 'unknown' })
    const loaded = { policy: null, policyStatus: null }
    expect(policyOf(loaded)).toEqual({ policy: null, status: null })
    const w = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: policyOf(null).status })
    expect(w.canMarkMerged).toBe(false)
  })

  it('lets a writer merge once the policy is met on an unprotected base', () => {
    const a = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: { met: true, have: 2, need: 2 } })
    expect(a.canMarkMerged).toBe(true)
    expect(a.policyOverride).toBe(false)
  })

  it('withholds a writer merge while required checks are not passing; a maintainer overrides', () => {
    const met = { met: true, have: 1, need: 1 }
    const w = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: met, checksBlocking: true })
    expect(w.canMarkMerged).toBe(false)
    expect(w.mergeHint).toMatch(/requires passing checks/)
    const m = pullActions({ pull: pull(), viewer: MAINTAINER, holdings: MAINTAIN, policy: met, checksBlocking: true })
    expect(m.canMarkMerged).toBe(true)
    expect(m.policyOverride).toBe(true)
  })
})

describe('pullActions agrees with the merge label', () => {
  it('"on the base now" iff the head has been a base tip — and the merged PR is then not labelled', () => {
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
      // The recorded merge (state code 2, oid = the head) is merged either way, labelled when not on the base.
      const state = prStateV2(2, HEAD, [], baseTip, isAncestor)
      expect(state.merged).toBe(true)
      expect(state.mergeOnBase).toBe(expected)
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

describe('deleting the source branch after a merge (dg deletable_source, and the tip must be the merged head)', () => {
  const H = 'ab'.repeat(20)
  const base = { refName: 'refs/heads/feature', sameRepo: true, baseRefName: 'refs/heads/main', defaultBranch: 'main', headOid: H }
  it('deletes a feature branch still at the merged head, or one already gone', () => {
    expect(deleteBranchProblem(base)).toBeNull()
    expect(deleteBranchProblem({ ...base, tip: H.toUpperCase() })).toBeNull()
    expect(deleteBranchProblem({ ...base, tip: null })).toBeNull()
  })
  it('refuses the base branch and the default branch before anything is read', () => {
    expect(deleteBranchProblem({ ...base, refName: 'refs/heads/main', baseRefName: 'refs/heads/main' })).toMatch(/its base branch/)
    expect(deleteBranchProblem({ ...base, refName: 'refs/heads/main', sameRepo: false })).toMatch(/default branch/)
    expect(deleteBranchProblem({ ...base, defaultBranch: 'refs/heads/feature' })).toMatch(/default branch/)
  })
  it("fails closed when the source repo's default branch could not be read", () => {
    expect(deleteBranchProblem({ ...base, defaultBranch: null })).toMatch(/default branch could not be read/)
    expect(deleteBranchProblem({ ...base, defaultBranch: null, tip: H })).toMatch(/default branch could not be read/)
  })

  it('refuses a branch that moved past the merged head', () => {
    expect(deleteBranchProblem({ ...base, tip: 'cd'.repeat(20) })).toMatch(/moved to cdcdcdcdc after the merged head/)
  })
})

describe('"Delete the branch after merging" in the merge box', () => {
  const H = 'ab'.repeat(20)
  const fork = { visibility: 'public', sameRepo: false }
  const base = { refName: 'refs/heads/feature', source: fork, canWrite: true, baseRefName: 'refs/heads/main', defaultBranch: 'main', headOid: H }
  it('is offered to a writer of the source branch', () => {
    expect(deleteBranchOffer(base)).toEqual({ kind: 'offer' })
  })
  it("is shown disabled, with why, to a merger who can't write the contributor's fork", () => {
    expect(deleteBranchOffer({ ...base, canWrite: false })).toEqual({
      kind: 'explain',
      reason: "You can't write the contributor's fork; ask them to allow edits by maintainers, or delete it from the fork.",
    })
    expect(deleteBranchOffer({ ...base, canWrite: false, source: { visibility: 'public', sameRepo: true } })).toMatchObject({ kind: 'explain', reason: expect.stringMatching(/can't write this branch here/) })
  })
  it('is hidden when it must never be deleted, or while unknown', () => {
    expect(deleteBranchOffer({ ...base, canWrite: null })).toEqual({ kind: 'hide' })
    expect(deleteBranchOffer({ ...base, defaultBranch: null })).toEqual({ kind: 'hide' })
    expect(deleteBranchOffer({ ...base, refName: 'refs/heads/main', defaultBranch: 'main' })).toEqual({ kind: 'hide' })
    expect(deleteBranchOffer({ ...base, source: { visibility: 'private', sameRepo: false } })).toEqual({ kind: 'hide' })
    expect(deleteBranchOffer({ ...base, refName: null })).toEqual({ kind: 'hide' })
    expect(deleteBranchOffer({ ...base, source: { visibility: 'public', sameRepo: true }, refName: 'refs/heads/main' })).toEqual({ kind: 'hide' })
  })
})

describe('the merge box through its own merge', () => {
  it('stays mounted after onMerged flips the PR to merged, so it can finish (report, delete the branch)', () => {
    // A page view: the viewer can merge, merges; the refresh reads the PR as merged.
    const canMerge = [true, true, false, false]
    let shownBefore = false
    const seen = canMerge.map((can) => {
      const shown = mergeBoxShown(can, shownBefore)
      shownBefore = shownBefore || shown
      return shown
    })
    expect(seen).toEqual([true, true, true, true])
    // It never appears for a viewer who could not merge in this page view.
    expect(mergeBoxShown(false, false)).toBe(false)
  })

})

describe('where the merge box is, per tab', () => {
  const at = (o: Partial<Parameters<typeof mergeBoxSlot>[0]>) => mergeBoxSlot({ onConversation: false, draft: false, running: false, ranOnPage: false, ranOnThisTab: false, ...o })
  it('lives on the conversation of a ready PR', () => {
    expect(at({ onConversation: true })).toBe('shown')
    expect(at({ onConversation: true, draft: true })).toBe('none')
    expect(at({})).toBe('none')
  })
  it('a running merge is on screen on every tab (it may be waiting for the merger)', () => {
    expect(at({ running: true, ranOnPage: true, ranOnThisTab: true })).toBe('shown')
    expect(at({ running: true, ranOnPage: true })).toBe('shown')
  })
  it('after its merge it stays mounted: on screen where it ended, hidden on other tabs', () => {
    expect(at({ ranOnPage: true, ranOnThisTab: true })).toBe('shown')
    expect(at({ ranOnPage: true })).toBe('kept')
  })
})

describe('the merge box review line (RC1 R-16): the fold gates, the proved count is shown beside it', () => {
  const fold = (approvers: string[], changesRequested: string[] = [], policy: { requiredApprovals: number } | null = null, have = approvers.length) => ({
    approvers,
    changesRequested,
    policy,
    policyStatus: policy === null ? null : { met: have >= policy.requiredApprovals, have, need: policy.requiredApprovals },
  })
  const proved = (approvals: number, changesRequested = 0, headOid = HEAD) => ({ headOid, approvals, changesRequested })

  it('says "N approvals", proved when the chain agrees', () => {
    expect(verdictSummary(fold([MAINTAINER, WRITER]), proved(2), HEAD)).toEqual({ tone: 'approved', headline: '2 approvals', detail: null, onChain: null, proved: true })
    expect(verdictSummary(fold([]), proved(0), HEAD)).toMatchObject({ tone: 'none', headline: 'No approvals yet', proved: true })
  })

  it('says "N of M required approvals" from the fold, and names a larger proved count "on chain"', () => {
    const line = verdictSummary(fold([MAINTAINER], [], { requiredApprovals: 2 }), proved(3), HEAD)
    expect(line).toMatchObject({ tone: 'required', headline: '1 of 2 required approvals', proved: false })
    expect(line?.onChain).toMatch(/^3 member approvals on chain \(an upper bound/)
    expect(verdictSummary(fold([MAINTAINER, WRITER], [], { requiredApprovals: 2 }), proved(2), HEAD)).toMatchObject({ tone: 'approved', headline: '2 of 2 required approvals', onChain: null })
    // Maintainers only: the writer's approval is in the fold but not in the policy's count.
    expect(verdictSummary(fold([MAINTAINER, WRITER], [], { requiredApprovals: 2 }, 1), null, HEAD)).toMatchObject({ headline: '1 of 2 required approvals', detail: '2 approvals in all' })
  })

  it('leads with "Changes requested", the approvals beside it', () => {
    expect(verdictSummary(fold([MAINTAINER], [WRITER], { requiredApprovals: 1 }), proved(1, 1), HEAD)).toEqual({
      tone: 'changes',
      headline: 'Changes requested',
      detail: '1 approval · 1 of 1 required approval',
      onChain: null,
      proved: true,
    })
  })

  it('shows no "on chain" note for a proved count below the fold (a node behind)', () => {
    expect(verdictSummary(fold([MAINTAINER, WRITER]), proved(1), HEAD)).toMatchObject({ headline: '2 approvals', onChain: null, proved: false })
  })

  it('ignores a proved count for another head', () => {
    expect(verdictSummary(fold([MAINTAINER]), proved(5, 0, 'ef'.repeat(20)), HEAD)).toMatchObject({ headline: '1 approval', onChain: null, proved: false })
  })

  it('falls back to the proved count, said to be an upper bound, only when the members could not be read', () => {
    const line = verdictSummary(null, proved(2, 1), HEAD.toUpperCase())
    expect(line).toMatchObject({ tone: 'changes', headline: 'Changes requested', proved: false })
    expect(line?.onChain).toMatch(/^2 member approvals and 1 change request on chain\. The members couldn't be read/)
    expect(verdictSummary(null, null, HEAD)).toBeNull()
  })
})

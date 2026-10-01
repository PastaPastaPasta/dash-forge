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
import {
  BYPASS_VALUE_MAX,
  bypassValue,
  deleteBranchOffer,
  deleteBranchProblem,
  mergeBaseTip,
  mergeBoxShown,
  mergeBoxSlot,
  mergeButton,
  mergeGate,
  mergeRefProblem,
  policyOf,
  prLinkedIssues,
  pullActions,
  requiredChecksLine,
  unmetRules,
  verdictSummary,
  type PullActionInputs,
} from './pull-actions'

const AUTHOR = 'author'
const WRITER = 'writer'
const MAINTAINER = 'maintainer'
const STRANGER = 'stranger'
const HEAD = 'cd'.repeat(20)

const NONE: Holdings = { member: false, maintain: false, role: null }
const WRITE: Holdings = { member: true, maintain: false, role: 'writer' }
const MAINTAIN: Holdings = { member: true, maintain: true, role: 'maintainer' }
const TRIAGE: Holdings = { member: true, maintain: false, role: 'triage' }
const READER: Holdings = { member: true, maintain: false, role: 'reader' }

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

describe('pullActions — who may merge', () => {
  it('offers it to writers and maintainers', () => {
    expect(pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE }).canMerge).toBe(true)
    expect(pullActions({ pull: pull(), viewer: MAINTAINER, holdings: MAINTAIN }).canMerge).toBe(true)
  })

  it('withholds it from a triage member and a reader (RC2 roles), who may still close and reopen as triage', () => {
    const triage = pullActions({ pull: pull(), viewer: STRANGER, holdings: TRIAGE })
    expect(triage.canMerge).toBe(false)
    expect(triage.canCloseReopen).toBe(true)
    expect(triage.mergeHint).toBe("Your role here is triage: a triage member can't merge pull requests.")
    const reader = pullActions({ pull: pull(), viewer: STRANGER, holdings: READER })
    expect(reader.canMerge).toBe(false)
    expect(reader.canCloseReopen).toBe(false)
    expect(reader.mergeHint).toMatch(/reader/)
    // A reader who opened the PR closes it as its author.
    expect(pullActions({ pull: pull(), viewer: AUTHOR, holdings: READER }).canCloseReopen).toBe(true)
  })

  it('withholds it from a signed-in non-member, with the reason', () => {
    const a = pullActions({ pull: pull(), viewer: STRANGER, holdings: NONE })
    expect(a.canMerge).toBe(false)
    expect(a.mergeHint).toMatch(/maintainers and writers/)
  })

  it('withholds it from the PR author who is not a member', () => {
    const a = pullActions({ pull: pull(), viewer: AUTHOR, holdings: NONE })
    expect(a.canMerge).toBe(false)
    // …but the author may still close/reopen their own PR (an authorEvent).
    expect(a.canCloseReopen).toBe(true)
  })

  it('withholds it when logged out, with no hint', () => {
    const a = pullActions({ pull: pull(), viewer: null, holdings: null })
    expect(a.canMerge).toBe(false)
    expect(a.canCloseReopen).toBe(false)
    expect(a.mergeHint).toBeNull()
  })

  it('withholds it silently while membership loads, and explains an unreadable one', () => {
    const loading = pullActions({ pull: pull(), viewer: WRITER, holdings: 'loading' })
    expect(loading.canMerge).toBe(false)
    expect(loading.mergeHint).toBeNull()

    const unknown = pullActions({ pull: pull(), viewer: WRITER, holdings: null })
    expect(unknown.canMerge).toBe(false)
    expect(unknown.mergeHint).toMatch(/members/)
  })

  it('withholds it on merged, closed, headless, and unverified PRs', () => {
    const holder = { viewer: WRITER, holdings: WRITE }
    expect(pullActions({ pull: pull({ state: { merged: true, open: false } }), ...holder }).canMerge).toBe(false)
    expect(pullActions({ pull: pull({ state: { open: false } }), ...holder }).canMerge).toBe(false)
    expect(pullActions({ pull: pull({ headOid: '' }), ...holder }).canMerge).toBe(false)
    expect(pullActions({ pull: pull({ stateComplete: false }), ...holder }).canMerge).toBe(false)
  })
})

describe('pullActions — "Mark as merged (done elsewhere)" records a merge, it never replaces one (QW-002)', () => {
  it('is offered only once the head is on the base: there is no merge done elsewhere to record before', () => {
    const notYet = pullActions({ pull: pull({ headOnBase: false }), viewer: MAINTAINER, holdings: MAINTAIN })
    expect(notYet.canMerge).toBe(true)
    expect(notYet.canMarkMerged).toBe(false)
    const onBase = pullActions({ pull: pull({ headOnBase: true }), viewer: MAINTAINER, holdings: MAINTAIN })
    expect(onBase.canMarkMerged).toBe(true)
    expect(onBase.markCountsNow).toBe(true)
  })

  it('is never the policy override: unmet rules leave it a record, and a writer is refused it', () => {
    const unmet = { met: false, have: 0, need: 1 }
    const m = pullActions({ pull: pull({ headOnBase: true }), viewer: MAINTAINER, holdings: MAINTAIN, policy: unmet })
    expect(m.canMarkMerged).toBe(true)
    expect(m.unmetRules).toEqual(['required approvals: 0 of 1'])
    expect(m.canBypass).toBe(true)
    const w = pullActions({ pull: pull({ headOnBase: true }), viewer: WRITER, holdings: WRITE, policy: unmet })
    expect(w.canMarkMerged).toBe(false)
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
    expect(a.canMerge).toBe(false)
    expect(a.baseProtected).toBe(true)
    expect(a.mergeHint).toMatch(/main is a protected branch: only maintainers/)
  })

  it('offers a maintainer the merge into a protected base', () => {
    const a = pullActions({ pull: pull({ baseRefName: MAIN }), viewer: MAINTAINER, holdings: MAINTAIN, ...protectedMain })
    expect(a.canMerge).toBe(true)
    expect(a.canBypass).toBe(false)
    expect(a.unmetRules).toEqual([])
  })

  it('matches the base with the FORGE_RULES globs, not by name', () => {
    const release = pull({ baseRefName: 'refs/heads/release/1.x' })
    expect(pullActions({ pull: release, viewer: WRITER, holdings: WRITE, protectedPatterns: ['refs/heads/release/*'] }).canMerge).toBe(false)
    expect(pullActions({ pull: release, viewer: WRITER, holdings: WRITE, protectedPatterns: ['refs/heads/*'] }).canMerge).toBe(true)
    // A bare branch name is not a full-ref pattern and protects nothing.
    expect(pullActions({ pull: pull({ baseRefName: MAIN }), viewer: WRITER, holdings: WRITE, protectedPatterns: ['main'] }).canMerge).toBe(true)
  })

  it('disables a writer on an unmet policy and offers a maintainer the bypass, naming the rules (QW-001)', () => {
    const unmet = { met: false, have: 0, need: 2 }
    const w = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: unmet })
    expect(w.canMerge).toBe(false)
    expect(w.canBypass).toBe(false)
    expect(w.mergeHint).toMatch(/needs 2 approvals \(0 so far; the PR author's own never counts\)/)
    const m = pullActions({ pull: pull(), viewer: MAINTAINER, holdings: MAINTAIN, policy: unmet, maintainersOnly: true })
    expect(m.canMerge).toBe(true)
    expect(m.canBypass).toBe(true)
    expect(m.unmetRules).toEqual(['required approvals: 0 of 2 (maintainers only)'])
  })

  it('withholds a writer merge when the policy could not be read, and says so (M4: fail closed)', () => {
    const w = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: 'unknown' })
    expect(w.canMerge).toBe(false)
    expect(w.mergeHint).toMatch(/couldn't read the branch policy/i)
    const m = pullActions({ pull: pull(), viewer: MAINTAINER, holdings: MAINTAIN, policy: 'unknown' })
    expect(m.canMerge).toBe(true)
    // Unread is unmet: a maintainer's merge is a bypass too (fail closed).
    expect(m.canBypass).toBe(true)
    expect(m.unmetRules).toEqual(['the branch policy could not be read'])
  })

  it('treats unread approvals as an unknown policy (the approvals card could not load)', () => {
    expect(policyOf(null)).toEqual({ policy: 'unknown', status: 'unknown' })
    const loaded = { policy: null, policyStatus: null }
    expect(policyOf(loaded)).toEqual({ policy: null, status: null })
    const w = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: policyOf(null).status })
    expect(w.canMerge).toBe(false)
  })

  it('lets a writer merge once the policy is met on an unprotected base', () => {
    const a = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: { met: true, have: 2, need: 2 } })
    expect(a.canMerge).toBe(true)
    expect(a.canBypass).toBe(false)
    expect(a.unmetRules).toEqual([])
  })

  it('withholds a writer merge while required checks are not passing; a maintainer may bypass, the checks named', () => {
    const met = { met: true, have: 1, need: 1 }
    const failing = { met: false, untrusted: 0, required: [{ name: 'build', state: 'missing' as const, runId: null }, { name: 'lint', state: 'passed' as const, runId: 'x' }] }
    const w = pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: met, checks: failing })
    expect(w.canMerge).toBe(false)
    expect(w.mergeHint).toMatch(/requires passing checks/)
    const m = pullActions({ pull: pull(), viewer: MAINTAINER, holdings: MAINTAIN, policy: met, checks: failing })
    expect(m.canMerge).toBe(true)
    expect(m.canBypass).toBe(true)
    expect(m.unmetRules).toEqual(['required check `build`: missing'])
    // Unread checks are unmet (fail closed); passing ones are met.
    expect(pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: met, checks: 'unknown' }).canMerge).toBe(false)
    expect(pullActions({ pull: pull(), viewer: WRITER, holdings: WRITE, policy: met, checks: { met: true, untrusted: 0, required: [] } }).canMerge).toBe(true)
  })
})

describe('mergeGate — the merge button against the branch rules (QW-001) and a locked tab (QW-014)', () => {
  const unmet = ['required approvals: 0 of 1 (maintainers only)']

  it('is disabled while a rule is unmet, with a reason, until a maintainer ticks "bypass rules"', () => {
    const idle = mergeGate({ unmet, canBypass: true, bypassTicked: false, storageLocked: false })
    expect(idle).toEqual({ enabled: false, bypassing: false, reason: expect.stringMatching(/blocked until the branch rules are met.*bypass/) })
    expect(mergeGate({ unmet, canBypass: true, bypassTicked: true, storageLocked: false })).toEqual({ enabled: true, bypassing: true, reason: null })
  })

  it('never enables a bypass for someone who cannot bypass, ticked or not', () => {
    expect(mergeGate({ unmet, canBypass: false, bypassTicked: true, storageLocked: false }).enabled).toBe(false)
  })

  it('is a plain merge when the rules are met (the tick changes nothing)', () => {
    expect(mergeGate({ unmet: [], canBypass: false, bypassTicked: true, storageLocked: false })).toEqual({ enabled: true, bypassing: false, reason: null })
  })

  it('is disabled with a reason while the tab must unlock its storage settings (no silent click)', () => {
    const g = mergeGate({ unmet: [], canBypass: false, bypassTicked: false, storageLocked: true })
    expect(g.enabled).toBe(false)
    expect(g.reason).toMatch(/Unlock above to merge/)
  })

  it('is disabled while the source branch is past the PR head, bypass or not (QW3-013)', () => {
    const branchAhead = { branch: 'feature-ff', tip: 'b'.repeat(40), head: '9'.repeat(40) }
    for (const g of [
      mergeGate({ unmet: [], canBypass: false, bypassTicked: false, storageLocked: false, branchAhead }),
      mergeGate({ unmet, canBypass: true, bypassTicked: true, storageLocked: false, branchAhead }),
    ]) {
      expect(g.enabled).toBe(false)
      expect(g.bypassing).toBe(false)
      expect(g.reason).toBe('feature-ff is at bbbbbbb, ahead of this PR\'s head 9999999. Update the PR head first, so the merge includes those commits.')
    }
    expect(mergeGate({ unmet: [], canBypass: false, bypassTicked: false, storageLocked: false, branchAhead: null }).enabled).toBe(true)
  })
})

describe('mergeButton — a head the base already holds (QW-002)', () => {
  const base = { canMerge: true, isPublic: true, refProblem: null, baseLoaded: true, isMaintainer: true, baseProtected: false, narrow: false, check: 'up-to-date' as const, checkout: '' }

  it('points to "Mark as merged (done elsewhere)" only when that control is offered (the head was a base tip)', () => {
    expect(mergeButton({ ...base, headOnBase: true })).toEqual({ kind: 'unavailable', reason: expect.stringContaining('"Mark as merged (done elsewhere)" below') })
    const viaMergeCommit = mergeButton({ ...base, headOnBase: false })
    expect(viaMergeCommit).toEqual({ kind: 'unavailable', reason: expect.stringContaining('--event-only --merge-oid') })
    expect(JSON.stringify(viaMergeCommit)).not.toContain('Mark as merged')
  })
})

describe('unmetRules and bypassValue — the rules named, as dg names them', () => {
  it('names approvals, checks and an unreadable policy', () => {
    expect(unmetRules(null)).toEqual([])
    expect(unmetRules({ met: true, have: 1, need: 1 })).toEqual([])
    expect(unmetRules('unknown')).toEqual(['the branch policy could not be read'])
    expect(unmetRules({ met: false, have: 1, need: 2 }, { met: false, untrusted: 0, required: [] })).toEqual([
      'required approvals: 1 of 2',
      'required checks: none reported on the head',
    ])
    expect(unmetRules(null, { met: false, untrusted: 0, required: [{ name: 'ci', state: 'failing', runId: 'r' }] })).toEqual(['required check `ci`: failing'])
  })

  it('records every rule in the bypass event, as dg does', () => {
    // Word for word dg's `bypass_value` (pr/mod.rs tests).
    expect(bypassValue(['required approvals: 0 of 1', 'required check `lint`: failing'])).toBe('required approvals: 0 of 1; required check `lint`: failing')
    expect(bypassValue([])).toBe('the branch rules')
  })

  it('fits the event value: whole rules, the rest counted, one overlong rule cut', () => {
    const rules = Array.from({ length: 10 }, (_, i) => `required check \`check-number-${i}\`: missing`)
    const v = bypassValue(rules)
    expect([...v].length).toBeLessThanOrEqual(BYPASS_VALUE_MAX)
    expect(v.startsWith('required check `check-number-0`: missing; ')).toBe(true)
    expect(v.endsWith(' (+8 more)')).toBe(true)
    const cut = bypassValue(['x'.repeat(200)])
    expect([...cut].length).toBe(BYPASS_VALUE_MAX)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('requiredChecksLine — only the checks not passing are named (QW2-052)', () => {
  it('names lint alone when build passes and lint fails', () => {
    const checks = {
      met: false,
      untrusted: 0,
      required: [
        { name: 'build', state: 'passed' as const, runId: 'a' },
        { name: 'lint', state: 'failing' as const, runId: 'b' },
      ],
    }
    expect(requiredChecksLine(checks, ['build', 'lint'])).toEqual({ ok: false, text: 'Required checks not passing on the head: lint' })
  })

  it('says pending and missing, all passing, none reported and not read yet', () => {
    const one = (state: 'pending' | 'missing' | 'passed') => ({ met: state === 'passed', untrusted: 0, required: [{ name: 'e2e', state, runId: null }] })
    expect(requiredChecksLine(one('pending'), ['e2e']).text).toBe('Required checks not passing on the head: e2e (pending)')
    expect(requiredChecksLine(one('missing'), ['e2e']).text).toBe('Required checks not passing on the head: e2e (missing)')
    expect(requiredChecksLine(one('passed'), ['e2e'])).toEqual({ ok: true, text: 'Required checks pass: e2e' })
    expect(requiredChecksLine({ met: false, untrusted: 0, required: [] }, [])).toEqual({ ok: false, text: 'Required checks not passing on the head: none reported' })
    expect(requiredChecksLine('unknown', ['build'])).toEqual({ ok: false, text: 'Required checks not read yet: build' })
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
      expect(a.canMarkMerged).toBe(expected)
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

describe('prLinkedIssues — never the PR itself (QW2-054)', () => {
  it('drops the PR\'s own number from "Fixes #n"', () => {
    expect(prLinkedIssues('Adds a name. Fixes #1', 1)).toEqual([])
    expect(prLinkedIssues('Fixes #1, closes #4', 3)).toEqual([1, 4])
    expect(prLinkedIssues('Fixes #3 and resolves #2', 3)).toEqual([2])
  })
})

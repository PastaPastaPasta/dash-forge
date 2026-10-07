/**
 * The merge gate judged again at the click with the members read then: a member revoked since
 * the page loaded no longer carries the merge (as the merger, an approver or a check reporter),
 * and a maintainer made a writer no longer bypasses the branch rules.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import type { RepoRef } from '../repo/contract'
import { invalidateMembers, membersGeneration, seedMemberships } from '../repo/members'
import { checksState, type CheckRunRow } from '../rules/parity'
import { meetsPolicy, RoleOracle, type Approvals, type Membership, type Policy } from '../rules/v2'
import type { DocumentQuery } from '../sdk'
import { readRunnersCached } from '../repo/checks'
import { markMerged, MERGE_OFFLINE, MERGE_UNCONFIRMED, mergeMembersProblem, pageMergeRecheck, recheckMergeMembers, recheckPageMerge, type MergeRecheck, type PageMerge } from './merge-recheck'
import { pullActions } from './pull-actions'

const VIEWER = 'viewer'
const REVIEWER = 'reviewer'
const CI = 'ci'
const HEAD = 'cd'.repeat(20)

const writer = (identity: string): Membership => ({ identity, role: 'writer', createdAt: 1 })
const maintainer = (identity: string): Membership => ({ identity, role: 'maintainer', createdAt: 1 })

const pull = {
  author: 'author',
  headOid: HEAD,
  headOnBase: false,
  stateComplete: true,
  mergeBaseRefName: 'refs/heads/main',
  state: { open: true, merged: false, draft: false, baseRef: null, labels: [], assignees: [] },
}

/** The recheck of a merge the page judged with `atLoad`, `bypass` the rules confirmed bypassed. */
function recheck(atLoad: readonly Membership[], policy: Policy, approvals: Approvals, opts: { bypass?: readonly string[]; runs?: readonly CheckRunRow[]; runners?: readonly string[] } = {}): MergeRecheck {
  const checks = (oracle: RoleOracle, runners: ReadonlySet<string> | null) =>
    policy.requireChecks === true ? checksState(opts.runs ?? [], HEAD, oracle, runners ?? new Set(opts.runners ?? []), policy) : null
  const oracle = new RoleOracle([...atLoad])
  const status = meetsPolicy(approvals, oracle, policy)
  return { gate: { pull, viewer: VIEWER }, policy, status, approvals, checks, readsRunners: policy.requireChecks === true, bypass: opts.bypass ?? [] }
}

/** What the page offered: a merge, with these rules left to bypass. */
function offered(atLoad: readonly Membership[], r: MergeRecheck): { canMerge: boolean; unmetRules: readonly string[] } {
  const oracle = new RoleOracle([...atLoad])
  const role = oracle.currentRole(VIEWER)
  return pullActions({ ...r.gate, holdings: { member: role !== null, maintain: role === 'maintainer', role }, policy: r.status, checks: r.checks(oracle, null) })
}

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const REPO: RepoRef = { forge: FORGE, repoId: 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd', ownerId: 'owner', name: 'demo', visibility: 'public' }
/** A document query answering `writers` and `runners` (and no other rows). */
const queryWith =
  (writers: readonly string[], runners: readonly string[] = []) =>
  (q: DocumentQuery): Promise<Map<string, Record<string, unknown>>> => {
    const ids = q.documentTypeName === 'writer' ? writers : q.documentTypeName === 'runner' ? runners : []
    const rows = ids.map((id) => ({ $id: `${q.documentTypeName}:${id}`, $ownerId: 'owner', $createdAt: 1, repoId: REPO.repoId, memberId: id }))
    return Promise.resolve(new Map(rows.map((d) => [d.$id, d])))
  }
const sdkWith = (writers: readonly string[], runners: readonly string[] = []): EvoSDK => ({ documents: { query: queryWith(writers, runners) } }) as unknown as EvoSDK

const ONE_APPROVAL: Policy = { requiredApprovals: 1 }
const APPROVED: Approvals = { approvers: [REVIEWER], changesRequested: [] }

describe('mergeMembersProblem', () => {
  it('nothing changed: the merge goes ahead', () => {
    const atLoad = [writer(VIEWER), writer(REVIEWER)]
    const r = recheck(atLoad, ONE_APPROVAL, APPROVED)
    expect(offered(atLoad, r)).toMatchObject({ canMerge: true, unmetRules: [] })
    expect(mergeMembersProblem(atLoad, r)).toBeNull()
  })

  it('the only approver was revoked since the page loaded: a writer may not merge', () => {
    const atLoad = [writer(VIEWER), writer(REVIEWER)]
    const problem = mergeMembersProblem([writer(VIEWER)], recheck(atLoad, ONE_APPROVAL, APPROVED))
    expect(problem).toMatch(/^Something changed since the page loaded/)
    expect(problem).toContain('1 approval (0 so far')
  })

  it('a maintainer merging (no bypass) whose approver was revoked: the rules are no longer met', () => {
    const atLoad = [maintainer(VIEWER), writer(REVIEWER)]
    const problem = mergeMembersProblem([maintainer(VIEWER)], recheck(atLoad, ONE_APPROVAL, APPROVED))
    expect(problem).toBe('Something changed since the page loaded. The branch rules are no longer met. Review the pull request and try again.')
  })

  it('the merger was revoked: no merge', () => {
    const atLoad = [writer(VIEWER), writer(REVIEWER)]
    expect(mergeMembersProblem([writer(REVIEWER)], recheck(atLoad, ONE_APPROVAL, APPROVED))).toMatch(/^Something changed since the page loaded\. /)
  })

  it('a maintainer bypassing who was made a writer: no bypass', () => {
    const atLoad = [maintainer(VIEWER)]
    const none: Approvals = { approvers: [], changesRequested: [] }
    const r0 = recheck(atLoad, ONE_APPROVAL, none)
    const unmet = offered(atLoad, r0).unmetRules
    expect(unmet).toEqual(['required approvals: 0 of 1'])
    const r = { ...r0, bypass: unmet }
    expect(mergeMembersProblem(atLoad, r)).toBeNull()
    expect(mergeMembersProblem([writer(VIEWER)], r)).not.toBeNull()
  })

  it('a required check reported by a member revoked since: the check no longer passes', () => {
    const policy: Policy = { requiredApprovals: 0, requireChecks: true }
    const runs: CheckRunRow[] = [{ id: 'r1', headOid: HEAD, name: 'build', status: 'completed', conclusion: 'success', reporter: CI, createdAt: 5 }]
    const atLoad = [writer(VIEWER), writer(CI)]
    const r = recheck(atLoad, policy, { approvers: [], changesRequested: [] }, { runs })
    expect(offered(atLoad, r)).toMatchObject({ canMerge: true, unmetRules: [] })
    expect(mergeMembersProblem(atLoad, r)).toBeNull()
    expect(mergeMembersProblem([writer(VIEWER)], r)).toMatch(/^Something changed since the page loaded/)
  })
})

describe('recheckMergeMembers', () => {
  beforeEach(() => invalidateMembers(REPO, 'devnet'))

  it('reads the members past a warm cache that still holds the revoked approver', async () => {
    const atLoad = [writer(VIEWER), writer(REVIEWER)]
    seedMemberships(REPO, 'devnet', atLoad, membersGeneration())
    expect(await recheckMergeMembers(sdkWith([VIEWER]), REPO, 'devnet', recheck(atLoad, ONE_APPROVAL, APPROVED))).toContain('0 so far')
  })

  it('a failed read throws: the merge stops', async () => {
    const broken = { documents: { query: () => Promise.reject(new Error('DAPI down')) } } as unknown as EvoSDK
    const atLoad = [writer(VIEWER), writer(REVIEWER)]
    await expect(recheckMergeMembers(broken, REPO, 'devnet', recheck(atLoad, ONE_APPROVAL, APPROVED))).rejects.toThrow(MERGE_UNCONFIRMED)
  })

  it('a required check reported by a runner removed since: the runners are read again too', async () => {
    const policy: Policy = { requiredApprovals: 0, requireChecks: true }
    const runs: CheckRunRow[] = [{ id: 'r1', headOid: HEAD, name: 'build', status: 'completed', conclusion: 'success', reporter: CI, createdAt: 5 }]
    const r = recheck([writer(VIEWER)], policy, { approvers: [], changesRequested: [] }, { runs, runners: [CI] })
    expect(await recheckMergeMembers(sdkWith([VIEWER], [CI]), REPO, 'devnet', r)).toBeNull()
    expect(await recheckMergeMembers(sdkWith([VIEWER], []), REPO, 'devnet', r)).toMatch(/^Something changed since the page loaded/)
  })

  it('the runners read at the click replace the cached ones, so the page shows the removal', async () => {
    const repo: RepoRef = { ...REPO, repoId: 'runners-cache-repo' }
    const policy: Policy = { requiredApprovals: 0, requireChecks: true }
    const runs: CheckRunRow[] = [{ id: 'r1', headOid: HEAD, name: 'build', status: 'completed', conclusion: 'success', reporter: CI, createdAt: 5 }]
    // The page read the runner before its removal.
    expect(await readRunnersCached(sdkWith([VIEWER], [CI]), repo)).toEqual([CI])
    const r = recheck([writer(VIEWER)], policy, { approvers: [], changesRequested: [] }, { runs, runners: [CI] })
    expect(await recheckMergeMembers(sdkWith([VIEWER], []), repo, 'devnet', r)).toMatch(/^Something changed since the page loaded/)
    // The page's next read (still warm) is the click's.
    expect(await readRunnersCached(sdkWith([VIEWER], [CI]), repo)).toEqual([])
  })

  it('a failed runners read throws the neutral error, not a members one', async () => {
    const policy: Policy = { requiredApprovals: 0, requireChecks: true }
    const members = queryWith([VIEWER])
    const sdk = { documents: { query: (q: DocumentQuery) => (q.documentTypeName === 'runner' ? Promise.reject(new Error('DAPI down')) : members(q)) } } as unknown as EvoSDK
    const r = recheck([writer(VIEWER)], policy, { approvers: [], changesRequested: [] })
    await expect(recheckMergeMembers(sdk, REPO, 'devnet', r)).rejects.toThrow("Couldn't confirm the merge. Try again.")
  })
})

describe('the pull page\'s recheck (pageMergeRecheck, recheckPageMerge)', () => {
  const REQUIRE_CHECKS: Policy = { requiredApprovals: 0, requireChecks: true }
  const runs: CheckRunRow[] = [{ id: 'r1', headOid: HEAD, name: 'build', status: 'completed', conclusion: 'success', reporter: CI, createdAt: 5 }]
  const NONE: Approvals = { approvers: [], changesRequested: [] }
  const page = (over: Partial<PageMerge> = {}): PageMerge => {
    const atLoad = new RoleOracle([writer(VIEWER)])
    const policy = over.policy ?? REQUIRE_CHECKS
    const checkRuns = over.checkRuns === undefined ? { rows: runs, runners: new Set([CI]) } : over.checkRuns
    return {
      gate: { pull, viewer: VIEWER },
      policy,
      status: policy === null || policy === 'unknown' ? policy : meetsPolicy(NONE, atLoad, policy),
      approvals: NONE,
      requiredChecks: checkRuns === null || policy === null || policy === 'unknown' ? null : checksState(checkRuns.rows, HEAD, atLoad, checkRuns.runners, policy),
      checkRuns,
      ...over,
    }
  }
  const oracle = new RoleOracle([writer(VIEWER)])

  it('counted required checks are judged again, with the runners read at the click', () => {
    const r = pageMergeRecheck(page(), ['x'])
    expect(r.readsRunners).toBe(true)
    expect(r.bypass).toEqual(['x'])
    expect(r.checks(oracle, null)).toMatchObject({ met: true })
    expect(r.checks(oracle, new Set())).toMatchObject({ met: false })
  })

  it('no required checks, or none read: no runners are read and the page\'s judgement stands', () => {
    const none = pageMergeRecheck(page({ policy: ONE_APPROVAL, requiredChecks: null }), [])
    expect(none.readsRunners).toBe(false)
    expect(none.checks(oracle, new Set())).toBeNull()
    const unread = pageMergeRecheck(page({ requiredChecks: 'unknown', checkRuns: null }), [])
    expect(unread.readsRunners).toBe(false)
    expect(unread.checks(oracle, new Set())).toBe('unknown')
    const policyUnread = pageMergeRecheck(page({ policy: 'unknown', status: 'unknown', requiredChecks: 'unknown' }), [])
    expect(policyUnread.readsRunners).toBe(false)
  })

  it('no Platform connection: a refusal, and nothing is read', async () => {
    expect(await recheckPageMerge(null, REPO, 'devnet', page(), [])).toBe(MERGE_OFFLINE)
  })

  it('reads the members and runners for the page\'s gate', async () => {
    expect(await recheckPageMerge(sdkWith([VIEWER], [CI]), { ...REPO, repoId: 'page-recheck-a' }, 'devnet', page(), [])).toBeNull()
    expect(await recheckPageMerge(sdkWith([VIEWER], []), { ...REPO, repoId: 'page-recheck-b' }, 'devnet', page(), [])).toMatch(/^Something changed since the page loaded/)
  })
})

describe('markMerged', () => {
  const steps = (over: { landed?: string | null; problem?: string | null; bypass?: readonly string[]; recordFails?: boolean } = {}) => {
    const calls: string[] = []
    const landed = { current: over.landed ?? null }
    const run = (intent: string) => ({
      intent,
      bypass: over.bypass ?? [],
      landed,
      recheck: async (bypass: readonly string[]) => {
        calls.push(`recheck:${bypass.join(',')}`)
        return over.problem ?? null
      },
      merge: async () => void calls.push('merge'),
      recordBypass: async (rules: readonly string[]) => {
        calls.push(`record:${rules.join(',')}`)
        if (over.recordFails === true) throw new Error('refused')
      },
      describe: (e: unknown) => (e instanceof Error ? `${e.message}.` : String(e)),
    })
    return { run, calls, landed }
  }

  it('judges the merge again with the confirmed bypass, then records it and the bypass', async () => {
    const { run, calls, landed } = steps({ bypass: ['rule'] })
    await markMerged(run('i1'))
    expect(calls).toEqual(['recheck:rule', 'merge', 'record:rule'])
    expect(landed.current).toBe('i1')
  })

  it('no bypass: nothing but the merge is written', async () => {
    const { run, calls } = steps()
    await markMerged(run('i1'))
    expect(calls).toEqual(['recheck:', 'merge'])
  })

  it('a refusal writes nothing, and marks nothing landed', async () => {
    const { run, calls, landed } = steps({ problem: 'Something changed since the page loaded. You can no longer merge this pull request.', bypass: ['rule'] })
    await expect(markMerged(run('i1'))).rejects.toThrow('You can no longer merge this pull request.')
    expect(calls).toEqual(['recheck:rule'])
    expect(landed.current).toBeNull()
  })

  it('a retry of the intent whose merge landed writes only the bypass record, without judging it again', async () => {
    const s = steps({ bypass: ['rule'], recordFails: true })
    await expect(markMerged(s.run('i1'))).rejects.toThrow('The merge is recorded, but recording the rules bypass failed: refused. Retry to record it.')
    s.calls.length = 0
    await expect(markMerged(s.run('i1'))).rejects.toThrow('recording the rules bypass failed')
    expect(s.calls).toEqual(['record:rule'])
  })

  it('another intent is judged afresh, however an earlier one landed', async () => {
    const { run, calls } = steps({ landed: 'i1', problem: 'Something changed since the page loaded.' })
    await expect(markMerged(run('i2'))).rejects.toThrow('Something changed since the page loaded.')
    expect(calls).toEqual(['recheck:'])
  })
})

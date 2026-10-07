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
import { markMerged, MEMBERS_UNREAD, mergeMembersProblem, recheckMergeMembers, type MergeRecheck } from './merge-recheck'
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
    expect(problem).toContain('the branch rules are no longer met (required approvals: 0 of 1)')
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
  const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
  const REPO: RepoRef = { forge: FORGE, repoId: 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd', ownerId: 'owner', name: 'demo', visibility: 'public' }
  const sdkWith = (writers: readonly string[], runners: readonly string[] = []): EvoSDK =>
    ({
      documents: {
        query: (q: DocumentQuery) => {
          const ids = q.documentTypeName === 'writer' ? writers : q.documentTypeName === 'runner' ? runners : []
          const rows = ids.map((id) => ({ $id: `${q.documentTypeName}:${id}`, $ownerId: 'owner', $createdAt: 1, repoId: REPO.repoId, memberId: id }))
          return Promise.resolve(new Map(rows.map((d) => [d.$id, d])))
        },
      },
    }) as unknown as EvoSDK

  beforeEach(() => invalidateMembers(REPO, 'devnet'))

  it('reads the members past a warm cache that still holds the revoked approver', async () => {
    const atLoad = [writer(VIEWER), writer(REVIEWER)]
    seedMemberships(REPO, 'devnet', atLoad, membersGeneration())
    expect(await recheckMergeMembers(sdkWith([VIEWER]), REPO, 'devnet', recheck(atLoad, ONE_APPROVAL, APPROVED))).toContain('0 so far')
  })

  it('a failed read throws: the merge stops', async () => {
    const broken = { documents: { query: () => Promise.reject(new Error('DAPI down')) } } as unknown as EvoSDK
    const atLoad = [writer(VIEWER), writer(REVIEWER)]
    await expect(recheckMergeMembers(broken, REPO, 'devnet', recheck(atLoad, ONE_APPROVAL, APPROVED))).rejects.toThrow(MEMBERS_UNREAD)
  })

  it('a required check reported by a runner removed since: the runners are read again too', async () => {
    const policy: Policy = { requiredApprovals: 0, requireChecks: true }
    const runs: CheckRunRow[] = [{ id: 'r1', headOid: HEAD, name: 'build', status: 'completed', conclusion: 'success', reporter: CI, createdAt: 5 }]
    const r = recheck([writer(VIEWER)], policy, { approvers: [], changesRequested: [] }, { runs, runners: [CI] })
    expect(await recheckMergeMembers(sdkWith([VIEWER], [CI]), REPO, 'devnet', r)).toBeNull()
    expect(await recheckMergeMembers(sdkWith([VIEWER], []), REPO, 'devnet', r)).toMatch(/^Something changed since the page loaded/)
  })
})

describe('markMerged', () => {
  const steps = (over: { landed?: boolean; problem?: string | null; bypass?: boolean; recordFails?: boolean } = {}) => {
    const calls: string[] = []
    const run = {
      landed: over.landed ?? false,
      recheck: async () => {
        calls.push('recheck')
        return over.problem ?? null
      },
      merge: async () => void calls.push('merge'),
      recordBypass:
        over.bypass === true
          ? async () => {
              calls.push('record')
              if (over.recordFails === true) throw new Error('refused')
            }
          : null,
      describe: (e: unknown) => (e instanceof Error ? `${e.message}.` : String(e)),
    }
    return { run, calls }
  }

  it('judges the merge again, then records it and the bypass', async () => {
    const { run, calls } = steps({ bypass: true })
    await markMerged(run)
    expect(calls).toEqual(['recheck', 'merge', 'record'])
  })

  it('a refusal writes nothing', async () => {
    const { run, calls } = steps({ problem: 'Something changed since the page loaded. You can no longer merge this pull request.', bypass: true })
    await expect(markMerged(run)).rejects.toThrow('You can no longer merge this pull request.')
    expect(calls).toEqual(['recheck'])
  })

  it('a retry after the merge landed writes only the bypass record, without judging it again', async () => {
    const first = steps({ bypass: true, recordFails: true })
    await expect(markMerged(first.run)).rejects.toThrow('The merge is recorded, but recording the rules bypass failed: refused. Retry to record it.')
    const retry = steps({ landed: true, bypass: true, problem: 'Something changed since the page loaded.' })
    await markMerged(retry.run)
    expect(retry.calls).toEqual(['record'])
  })
})

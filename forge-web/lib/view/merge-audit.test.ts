/** "Branch rules at merge": the thread and the reads become the shared rule's input, and its result reads as rows. */

import { describe, expect, it, vi } from 'vitest'

const readMemberships = vi.fn()
vi.mock('../repo/members', async (orig) => ({ ...(await orig<typeof import('../repo/members')>()), readMemberships: (...a: unknown[]) => readMemberships(...a) }))
vi.mock('../repo/settings', async (orig) => ({ ...(await orig<typeof import('../repo/settings')>()), readPolicyHistory: async () => [{ id: 'p1', createdAt: 1, policy: { requiredApprovals: 1, approverRole: 0, requireChecks: false, mergeMethods: 0 } }] }))

import { auditMerge } from '../rules/merge-audit'
import type { PullThread } from './issues-view'
import { auditHeadline, auditRows, auditedMerge, mergeAuditInput, readMergeAudit } from './merge-audit'

const HEAD = 'a'.repeat(40)
const MERGE = 'b'.repeat(40)
const MERGED_AT = 10_000_000

function thread(over: { mergeOid?: string; events?: unknown[] } = {}): PullThread {
  return {
    pull: {
      author: 'auth',
      mergeBaseRefName: 'refs/heads/main',
      initialHeadOid: HEAD,
      headOid: HEAD,
      mergedAt: MERGED_AT,
      mergeOid: over.mergeOid ?? MERGE,
      state: { merged: true, open: false, draft: false },
      review: { headUpdates: [], dismissedReviews: [{ reviewId: 'r9', actor: 'maint', reason: '', createdAt: 5 }] },
    },
    timeline: [
      { kind: 'transition', at: MERGED_AT, transition: { id: 't1', targetId: 'pr', kind: 13, actor: 'maint', asAuthor: 0, createdAt: MERGED_AT, oid: MERGE } },
      ...(over.events ?? []),
    ],
    reviews: [{ id: 'r1', reviewer: 'maint2', verdict: 'approve', verdictCode: 1, commitOid: HEAD, body: '', commentCount: null, createdAt: 5_000_000 }],
    review: { headUpdates: [], dismissedReviews: [{ reviewId: 'r9', actor: 'maint', reason: '', createdAt: 5 }] },
    members: [
      { identity: 'maint', role: 'maintainer', createdAt: 1 },
      { identity: 'maint2', role: 'maintainer', createdAt: 1 },
    ],
    approvals: { approvers: [], changesRequested: [] },
  } as unknown as PullThread
}

const POLICY = { requiredApprovals: 1, approverRole: 0, requireChecks: false, mergeMethods: 0 }

describe('mergeAuditInput', () => {
  it('takes the merger, the head at the merge, reviews, dismissals and bypasses from the thread', () => {
    const bypass = { kind: 'event', at: MERGED_AT + 1, event: { id: 'e1', kind: 'policyBypass', actor: 'maint', createdAt: MERGED_AT + 1, oid: MERGE.toUpperCase(), value: 'x' } }
    const input = mergeAuditInput(thread({ events: [bypass] }), { policies: [], configs: [{ id: 'c1', createdAt: 1, protectedPatterns: ['refs/heads/main'] }], checks: null })
    expect(input).toMatchObject({
      merger: 'maint',
      mergedAt: MERGED_AT,
      mergeOid: MERGE,
      mergeHead: HEAD,
      prAuthor: 'auth',
      protection: [{ id: 'c1', createdAt: 1, protected: true }],
      reviews: [{ id: 'r1', reviewer: 'maint2', verdict: 1, commitOid: HEAD, createdAt: 5_000_000 }],
      dismissals: [{ reviewId: 'r9', createdAt: 5 }],
      runs: null,
      bypasses: [{ id: 'e1', actor: 'maint', oid: MERGE, value: 'x' }],
    })
  })

  it('is null for a merge that names no commit', () => {
    expect(auditedMerge(thread({ mergeOid: '' }))).toBeNull()
    expect(mergeAuditInput(thread({ mergeOid: '' }), { policies: [], configs: [], checks: null })).toBeNull()
  })

  it('judges a met policy and words it', () => {
    const input = mergeAuditInput(thread(), { policies: [{ id: 'p1', createdAt: 1, policy: POLICY }], configs: [], checks: null })
    const audit = auditMerge(input!)
    expect(audit.verdict).toBe('met')
    expect(auditHeadline(audit)).toBe('This merge met the branch rules in force at the time.')
    expect(auditRows(audit, 'refs/heads/main')).toEqual([
      { key: 'protected', label: 'Protected branch', text: 'main was not protected', met: null },
      { key: 'approvals', label: 'Required approvals', text: '1 of 1', met: true },
    ])
  })

  it('lists a protected base merged by a writer and each required check', () => {
    const writerThread = thread()
    const t = { ...writerThread, timeline: [{ ...writerThread.timeline[0], transition: { ...(writerThread.timeline[0] as { transition: object }).transition, actor: 'writ' } }], members: [...writerThread.members, { identity: 'writ', role: 'writer', createdAt: 1 }] } as unknown as PullThread
    const checksPolicy = { ...POLICY, requiredApprovals: 0, requiredChecks: ['build'] }
    const run = { id: 'k1', headOid: HEAD, name: 'build', status: 'completed', conclusion: 'failure', reporter: 'maint', createdAt: 9_000_000, updatedAt: 9_000_000 }
    const input = mergeAuditInput(t, { policies: [{ id: 'p1', createdAt: 1, policy: checksPolicy }], configs: [{ id: 'c1', createdAt: 1, protectedPatterns: ['refs/heads/*'] }], checks: { rows: [run], runners: new Set() } })
    const audit = auditMerge(input!)
    expect(audit.verdict).toBe('unmet')
    expect(auditRows(audit, 'refs/heads/main')).toEqual([
      { key: 'protected', label: 'Protected branch', text: 'main was protected, and no current membership record shows the merger as a maintainer then', met: false },
      { key: 'approvals', label: 'Required approvals', text: 'None', met: null },
      { key: 'check:build', label: 'Check build', text: 'failed', met: false },
    ])
  })

  it('reads the members again when the page could not, rather than counting nobody', async () => {
    const t = { ...thread(), members: [], approvals: null } as unknown as PullThread
    readMemberships.mockResolvedValue([
      { identity: 'maint', role: 'maintainer', createdAt: 1 },
      { identity: 'maint2', role: 'maintainer', createdAt: 1 },
    ])
    const audit = await readMergeAudit({} as never, {} as never, t, async () => [], null)
    expect(readMemberships).toHaveBeenCalledTimes(1)
    expect(audit?.verdict).toBe('met')
    expect(audit?.mergerRole).toBe('maintainer')
  })
})

// Q5-B04: a policy requiring code owners' approval is never shown as fully met.
describe('code owners at merge', () => {
  it('says code owners were not audited, and the merge is not met', () => {
    const audit = auditMerge({
      mergedAt: 100, merger: 'm', mergeOid: MERGE, mergeHead: HEAD, prAuthor: 'auth',
      policies: [{ id: 'p1', createdAt: 10, policy: { requiredApprovals: 0, requireCodeOwners: true } }],
    })
    expect(audit.verdict).toBe('unknown')
    expect(audit.codeOwnersUnaudited).toBe(true)
    expect(auditHeadline(audit)).toBe("Code owner approval was required, and it isn't audited here, so this merge couldn't be checked against every rule.")
    expect(auditRows(audit, 'refs/heads/main')).toContainEqual({ key: 'codeOwners', label: 'Code owners', text: 'Approval required; not audited', met: null })
  })
})

// Q5-A03 follow-up: what can't be confirmed (a merger or a bypass's recorder with no current
// membership record) is worded as unconfirmed, never as a rule not met. The verdict stays unmet.
describe('unconfirmed roles at merge', () => {
  const base = { mergedAt: 100, merger: 'gone', mergeOid: MERGE, mergeHead: HEAD, prAuthor: 'auth' }
  const protectedBase = [{ id: 'c1', createdAt: 1, protected: true }]

  it('shows a merger with no record as unconfirmed, and says the merge can\'t be confirmed', () => {
    const audit = auditMerge({ ...base, protection: protectedBase })
    expect(audit.verdict).toBe('unmet')
    expect(auditHeadline(audit)).toBe("This merge can't be confirmed against the branch rules (the merger has no current membership record), and no bypass was recorded.")
    expect(auditRows(audit, 'refs/heads/main')[0]).toEqual({
      key: 'protected',
      label: 'Protected branch',
      text: 'Unconfirmed: main was protected, and the merger has no current membership record',
      met: 'unconfirmed',
    })
  })

  it('says a bypass whose recorder has no record can\'t be confirmed, and what was unmet without it', () => {
    const bypass = { id: 'e1', actor: 'gone', createdAt: 101, oid: MERGE, value: 'required approvals: 0 of 1' }
    const policies = [{ id: 'p1', createdAt: 10, policy: { requiredApprovals: 1 } }]
    const audit = auditMerge({ ...base, protection: protectedBase, policies, bypasses: [bypass] })
    expect(audit.verdict).toBe('unmet')
    const headline = auditHeadline(audit)
    expect(headline).toBe("A bypass was recorded for this merge, but it can't be confirmed. Without it, the merge did not meet the branch rules in force at the time.")
    expect(headline).not.toContain('writer')
    // Nothing else unmet: the bypass alone can't be confirmed.
    const only = auditMerge({ ...base, protection: protectedBase, bypasses: [bypass] })
    expect(auditHeadline(only)).toBe("A bypass was recorded for this merge, but it can't be confirmed.")
  })
})

// @vitest-environment jsdom
/**
 * "Branch rules at merge" reads nothing until it is opened (the PR page's request budget), then
 * shows the audit.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const read = vi.fn()
vi.mock('@/lib/view/merge-audit', async (orig) => ({ ...(await orig<typeof import('@/lib/view/merge-audit')>()), readMergeAudit: (...a: unknown[]) => read(...a) }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))

import { RulesAtMerge } from './rules-at-merge'
import type { PullThread } from '@/lib/view'
import type { RepoRef } from '@/lib/repo'
import type { EvoSDK } from '@dashevo/evo-sdk'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  read.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const thread = {
  pull: { mergeOid: 'b'.repeat(40), mergedAt: 1000, mergeBaseRefName: 'refs/heads/main', state: { merged: true }, review: { headUpdates: [] }, initialHeadOid: 'a'.repeat(40) },
  timeline: [{ kind: 'transition', at: 1000, transition: { kind: 13, actor: 'maint', createdAt: 1000 } }],
  members: [],
  reviews: [],
  approvals: { approvers: [], changesRequested: [] },
} as unknown as PullThread

describe('RulesAtMerge', () => {
  it('reads nothing until opened, then shows the verdict and the rules', async () => {
    read.mockResolvedValue({
      verdict: 'bypassed',
      policy: { requiredApprovals: 1 },
      protected: true,
      mergerRole: 'maintainer',
      protectionUnmet: false,
      approvals: { met: false, have: 0, need: 1, blockedBy: [] },
      checks: null,
      checksUnread: false,
      bypass: { id: 'e1', actor: 'maint', createdAt: 1001, oid: 'b'.repeat(40), value: 'required approvals: 0 of 1' },
      codeOwnersUnaudited: false,
      uncountedBypass: null,
      rulesChanged: true,
    })
    await act(async () => root.render(<RulesAtMerge sdk={{} as EvoSDK} repo={{} as RepoRef} thread={thread} configHistory={async () => []} pageChecks={null} />))
    expect(read).not.toHaveBeenCalled()
    const details = host.querySelector('details') as HTMLDetailsElement
    await act(async () => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    expect(read).toHaveBeenCalledTimes(1)
    const body = host.querySelector('[data-testid="rules-at-merge-body"]')
    expect(body?.getAttribute('data-verdict')).toBe('bypassed')
    expect(body?.textContent).toContain('A maintainer bypassed the branch rules to merge this, and recorded it.')
    expect(body?.textContent).toContain('main was protected; a maintainer merged it')
    expect(body?.textContent).toContain('0 of 1')
    expect(body?.textContent).toContain('required approvals: 0 of 1')
    expect(host.querySelector('[data-testid="rules-at-merge-changed"]')).not.toBeNull()
  })

  // Q5-A03: the maintainer who merged with a bypass was removed or changed role since.
  it('shows a bypass whose writer has no current membership record, never "no bypass was recorded"', async () => {
    read.mockResolvedValue({
      verdict: 'unmet',
      policy: { requiredApprovals: 1 },
      protected: true,
      mergerRole: null,
      protectionUnmet: true,
      approvals: { met: false, have: 0, need: 1, blockedBy: [] },
      checks: null,
      checksUnread: false,
      codeOwnersUnaudited: false,
      bypass: null,
      uncountedBypass: { event: { id: 'e1', actor: 'maint', createdAt: 1001, oid: 'b'.repeat(40), value: 'required approvals: 0 of 1' }, role: null },
      rulesChanged: false,
    })
    await act(async () => root.render(<RulesAtMerge sdk={{} as EvoSDK} repo={{} as RepoRef} thread={thread} configHistory={async () => []} pageChecks={null} />))
    const details = host.querySelector('details') as HTMLDetailsElement
    await act(async () => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    const body = host.querySelector('[data-testid="rules-at-merge-body"]')
    expect(body?.getAttribute('data-verdict')).toBe('unmet')
    const text = body?.textContent ?? ''
    expect(text).not.toContain('no bypass was recorded')
    expect(text).not.toContain('no membership at the time')
    expect(text).toContain("A bypass was recorded for this merge, but it can't be confirmed. Without it, the merge did not meet the branch rules in force at the time.")
    expect(text).not.toContain("writer's role")
    expect(text).toContain('maint, no current membership record')
    expect(text).toContain('Unconfirmed: main was protected, and the merger has no current membership record')
    // The unconfirmed rule is not shown as failed (no red "Not met").
    const rows = [...host.querySelectorAll('[data-met]')].map((r) => r.getAttribute('data-met'))
    expect(rows).toEqual(['unconfirmed', 'false'])
    expect(text).not.toContain('Not met: Unconfirmed')
    const line = host.querySelector('[data-testid="rules-at-merge-uncounted-bypass"]')?.textContent ?? ''
    expect(line).toContain('maint recorded a bypass')
    expect(line).toContain('required approvals: 0 of 1.')
    expect(line).toContain("their role at the time can't be confirmed")
  })
})

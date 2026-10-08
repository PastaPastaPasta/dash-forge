// @vitest-environment jsdom
/**
 * Readers and verdicts (DESIGN §3.5, D15, §10; stream R2): only Write and Maintain approve or
 * request changes. The review drawer refuses a Read or Triage member's approve or request changes
 * before anything is signed, says why, and "Post as a comment" submits it as a comment in one
 * click. Writers, maintainers and non-members are not refused (a non-member's verdict is written
 * as one that doesn't count).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef, ReviewDraft } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import type { MembersAccess } from '@/lib/view/repo-view'
import type { Membership, Role } from '@/lib/rules/v2'
import { newReviewDraft } from '@/lib/view/pending-review'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'rae', signer: { identityId: 'rae' }, unlockScope: 'full' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => `${(e as Error).message}.`, disabledReason: null }) }))
vi.mock('@/lib/spend-toast', () => ({ spendAction: (_labels: unknown, run: (tag: (s: unknown) => unknown) => Promise<unknown>) => run((s) => s) }))
vi.mock('@/components/ui/cost-preview', () => ({ CostPreview: () => <span /> }))
vi.mock('@/lib/repo/checks', () => ({ readRunners: async () => [] }))
const submitReviewDraft = vi.fn()
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  repoContractIds: () => [],
  readMembershipsCached: async () => [],
  submitReviewDraft: (...a: unknown[]) => submitReviewDraft(...a),
  loadReviewDraft: async () => undefined,
}))

import { ReviewDrawer } from './review-drawer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'a'.repeat(40)
const m = (identity: string, role: Membership['role']): Membership => ({ identity, role, createdAt: 0 })
const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as unknown as RepoRef
const home = { repo, lane: { access: 'member' } as MembersAccess } as unknown as RepoHome

function draftOf(over: Partial<ReviewDraft> = {}): ReviewDraft {
  return { ...newReviewDraft({ draftId: 'd1', network: 'devnet', identity: 'rae', repoId: 'R', prId: 'P', headOid: HEAD, private: false, now: 1 }), ...over }
}

let host: HTMLDivElement
let root: Root
function show(draft: ReviewDraft, role: Role | null, isMember = role !== null, roleKnown = true): void {
  act(() =>
    root.render(
      <ReviewDrawer
        home={home}
        members={[m('alice', 'maintainer'), ...(role === null ? [] : [m('rae', role)])]}
        author="carol"
        repo={repo}
        pullId="P"
        headOid={HEAD}
        draft={draft}
        loaded
        update={() => undefined}
        ensure={() => draft}
        isMember={isMember}
        role={role}
        roleKnown={roleKnown}
        locked={false}
        lineExists={() => true}
        onSubmitted={() => undefined}
      />,
    ),
  )
  act(() => button('Review changes')!.click())
}
const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || (name === 'Review changes' && b.textContent?.trim().startsWith(name)))
const wait = async (ms = 50): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  submitReviewDraft.mockReset()
  submitReviewDraft.mockResolvedValue({ reviewId: 'r1', commentIds: [] })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('the review drawer refuses verdicts from Read and Triage', () => {
  it.each([
    ['reader', 'approve', 'Only people with Write access or more can approve.'],
    ['triage', 'requestChanges', 'Only people with Write access or more can request changes.'],
  ] as const)('a %s member’s %s is refused before signing', (role, verdict, copy) => {
    show(draftOf({ verdict, summary: 'Looks right to me.' }), role)
    expect(q('review-verdict-refused')?.textContent).toContain(copy)
    expect(button('Submit review')?.disabled).toBe(true)
    act(() => button('Submit review')!.click())
    expect(submitReviewDraft).not.toHaveBeenCalled()
  })

  it('"Post as a comment" submits it as a comment in one click', async () => {
    show(draftOf({ verdict: 'approve', summary: 'Looks right to me.' }), 'reader')
    act(() => button('Post as a comment')!.click())
    await wait()
    expect(submitReviewDraft).toHaveBeenCalledTimes(1)
    const [, , , submitted, post] = submitReviewDraft.mock.calls[0] as [unknown, unknown, unknown, ReviewDraft, { role: Role | null }]
    expect(submitted.verdict).toBe('comment')
    expect(submitted.summary).toBe('Looks right to me.')
    expect(post.role).toBe('reader')
  })

  it.each([['writer'], ['maintainer']] as const)('a %s approves as before', (role) => {
    show(draftOf({ verdict: 'approve', summary: 'Ship it.' }), role)
    expect(q('review-verdict-refused')).toBeNull()
    expect(button('Submit review')?.disabled).toBe(false)
  })

  it('an interrupted submit of a refused verdict points to Discard; Retry stays (it adopts a landed review, and refuses before signing)', () => {
    show(draftOf({ verdict: 'approve', summary: 'Looks right to me.', attemptedAt: 5 }), 'reader')
    expect(q('review-verdict-refused')?.textContent).toContain('Discard this review, then post it again as a comment.')
    expect(button('Post as a comment')).toBeUndefined()
    expect(button('Retry')?.disabled).toBe(false)
    expect(button('Discard the rest')).toBeDefined()
  })

  it('submits no verdict until the viewer’s role is read', () => {
    show(draftOf({ verdict: 'approve', summary: 'Ship it.' }), null, true, false)
    expect(button('Submit review')?.disabled).toBe(true)
  })

  it('submits a comment before the viewer’s role is read', () => {
    show(draftOf({ verdict: 'comment', summary: 'A note.' }), null, true, false)
    expect(button('Submit review')?.disabled).toBe(false)
  })

  it('a non-member is not refused (their verdict is written as one that does not count)', () => {
    show(draftOf({ verdict: 'approve', summary: 'Nice.' }), null, false)
    expect(q('review-verdict-refused')).toBeNull()
    expect(button('Submit review')?.disabled).toBe(false)
  })
})

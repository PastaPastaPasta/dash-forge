// @vitest-environment jsdom
/**
 * The review drawer and members-only text (stream 1D review fixes, PR #406):
 * - a members-only draft starts on Members and is never saved as public (so never to IndexedDB),
 *   not even for a moment, unless the writer picks Public;
 * - a public summary that repeats members-only text asks first (product H8);
 * - the "Add one public line?" question is not asked on a members-only PR or before the members
 *   are known, and a public line that fails after the review landed never holds the draft.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef, ReviewDraft } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import type { MembersAccess } from '@/lib/view/repo-view'
import type { Membership } from '@/lib/rules/v2'
import { newReviewDraft } from '@/lib/view/pending-review'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'bob', signer: { identityId: 'bob' }, unlockScope: 'full' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => `${(e as Error).message}.`, disabledReason: null }) }))
vi.mock('@/lib/spend-toast', () => ({ spendAction: (_labels: unknown, run: (tag: (s: unknown) => unknown) => Promise<unknown>) => run((s) => s) }))
vi.mock('@/components/ui/cost-preview', () => ({ CostPreview: () => <span /> }))
vi.mock('@/lib/repo/checks', () => ({ readRunners: async () => [] }))
const submitReviewDraft = vi.fn()
const createComment = vi.fn()
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  repoContractIds: () => [],
  readMembershipsCached: async () => [],
  submitReviewDraft: (...a: unknown[]) => submitReviewDraft(...a),
  createComment: (...a: unknown[]) => createComment(...a),
  loadReviewDraft: async () => undefined,
}))

import { ReviewDrawer } from './review-drawer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SECRET = 'The staging database password rotates on Friday at noon.'
const HEAD = 'a'.repeat(40)
const m = (identity: string, role: Membership['role']): Membership => ({ identity, role, createdAt: 0 })
const MEMBERS = [m('alice', 'maintainer'), m('bob', 'writer')]
const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as unknown as RepoRef
const home = { repo, lane: { access: 'member' } as MembersAccess } as unknown as RepoHome

function draftOf(over: Partial<ReviewDraft> = {}): ReviewDraft {
  return { ...newReviewDraft({ draftId: 'd1', network: 'devnet', identity: 'bob', repoId: 'R', prId: 'P', headOid: HEAD, private: false, now: 1 }), ...over }
}

let host: HTMLDivElement
let root: Root
const update = vi.fn()
const onSubmitted = vi.fn()
function show(draft: ReviewDraft | null, extra: { membersOnly?: boolean; members?: Membership[] | null; membersTexts?: string[] } = {}): void {
  act(() =>
    root.render(
      <ReviewDrawer
        home={home}
        members={extra.members === undefined ? MEMBERS : extra.members}
        author="carol"
        repo={repo}
        pullId="P"
        headOid={HEAD}
        draft={draft}
        loaded
        update={update}
        ensure={() => draft}
        isMember
        locked={false}
        lineExists={() => true}
        onSubmitted={onSubmitted}
        membersOnly={extra.membersOnly ?? false}
        membersTexts={extra.membersTexts ?? [SECRET]}
      />,
    ),
  )
}
const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)
const button = (name: string): HTMLButtonElement | undefined => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || (name === 'Review changes' && b.textContent?.trim().startsWith(name)))
const wait = async (ms = 300): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
/** Every draft the drawer asked to save was members-only, or held no text. */
function savedOnlyMembers(): boolean {
  return update.mock.calls.every(([d]) => d === null || d.audience === 'members' || (d.summary === '' && d.comments.length === 0))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  update.mockReset()
  onSubmitted.mockReset()
  submitReviewDraft.mockReset()
  createComment.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('a members-only review draft', () => {
  it('starts on Members and is never saved as public, from its first render on', async () => {
    const draft = draftOf({ audience: 'members', summary: SECRET })
    show(draft)
    act(() => button('Review changes')!.click())
    expect(q('review-audience-chip')?.dataset.audience).toBe('members')
    await wait()
    expect(savedOnlyMembers()).toBe(true)
    // Typing more saves it members-only still.
    act(() => type(document.getElementById('review-summary') as HTMLTextAreaElement, `${SECRET} More.`))
    await wait()
    expect(update).toHaveBeenCalled()
    expect(savedOnlyMembers()).toBe(true)
  })

  it('stays members-only when it loads after the drawer opened', async () => {
    show(null)
    act(() => button('Review changes')!.click())
    show(draftOf({ audience: 'members', summary: SECRET }))
    expect(q('review-audience-chip')?.dataset.audience).toBe('members')
    await wait()
    expect(savedOnlyMembers()).toBe(true)
  })

  it('is saved as public only when the writer picks Public', async () => {
    show(draftOf({ audience: 'members', summary: 'Fine by me.' }))
    act(() => button('Review changes')!.click())
    act(() => (q('review-audience-chip') as HTMLButtonElement).click())
    await wait(0)
    act(() => document.querySelector<HTMLInputElement>('[data-testid="audience-option-public"] input')!.click())
    await wait()
    const last = update.mock.calls.at(-1)?.[0] as ReviewDraft
    expect(last.audience).toBeUndefined()
    expect(last.summary).toBe('Fine by me.')
  })
})

describe('submitting public review text', () => {
  it('asks first when the summary repeats members-only text, and writes nothing until confirmed', async () => {
    const draft = draftOf({ summary: `> ${SECRET}\nAgreed, ship it.` })
    submitReviewDraft.mockResolvedValue({ reviewId: 'r1', commentIds: [] })
    show(draft)
    act(() => button('Review changes')!.click())
    act(() => button('Submit review')!.click())
    expect(q('quote-confirm')).not.toBeNull()
    expect(submitReviewDraft).not.toHaveBeenCalled()
    await act(async () => q('quote-confirm')!.click())
    await wait(0)
    expect(submitReviewDraft).toHaveBeenCalledTimes(1)
  })

  it('does not ask again at submit for a pending comment confirmed as it was added', async () => {
    const draft = draftOf({ summary: 'Looks good.', comments: [{ localId: 'l1', anchor: { path: 'a.ts', line: 1, side: 1 }, body: SECRET }] as ReviewDraft['comments'] })
    submitReviewDraft.mockResolvedValue({ reviewId: 'r1', commentIds: ['c1'] })
    show(draft)
    act(() => button('Review changes')!.click())
    await act(async () => button('Submit review')!.click())
    expect(q('quote-confirm')).toBeNull()
    expect(submitReviewDraft).toHaveBeenCalledTimes(1)
  })
})

describe('"Add one public line?"', () => {
  const blocking = (): ReviewDraft => draftOf({ audience: 'members', verdict: 'requestChanges', summary: 'Needs work.' })

  it('is asked for a members-only request for changes the author cannot read', () => {
    show(blocking())
    act(() => button('Review changes')!.click())
    expect(q('public-line-question')?.textContent).toContain("@carol can't read it. Add one public line?")
  })

  it('is not asked on a members-only PR, nor before the members are known', () => {
    show(blocking(), { membersOnly: true })
    act(() => button('Review changes')!.click())
    expect(q('public-line-question')).toBeNull()
    show(blocking(), { members: [] })
    expect(q('public-line-question')).toBeNull()
  })

  it('refuses a public line that repeats members-only text', () => {
    show(blocking())
    act(() => button('Review changes')!.click())
    act(() => type(document.getElementById('review-public-line') as HTMLInputElement, `> ${SECRET}`))
    expect(q('public-line-quotes')).not.toBeNull()
    expect(button('Submit review')?.disabled).toBe(true)
  })

  it('a line that fails after the review landed: the review is done, the draft cleared, the failure said', async () => {
    submitReviewDraft.mockResolvedValue({ reviewId: 'r1', commentIds: [] })
    createComment.mockRejectedValue(new Error('Platform is busy'))
    show(blocking())
    act(() => button('Review changes')!.click())
    act(() => type(document.getElementById('review-public-line') as HTMLInputElement, 'Changes requested: see the review.'))
    await act(async () => button('Submit review')!.click())
    await wait(0)
    expect(update).toHaveBeenLastCalledWith(null)
    expect(onSubmitted).toHaveBeenCalledWith({ reviewId: 'r1', commentIds: [] })
    expect(q('review-line-error')?.textContent).toContain("Your review is submitted, but its public line wasn't posted: Platform is busy.")
    expect(q('review-error')).toBeNull()
  })
})

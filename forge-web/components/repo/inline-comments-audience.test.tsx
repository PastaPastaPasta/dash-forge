// @vitest-environment jsdom
/**
 * Diff comments and members-only text (stream 1D review fixes, PR #406, product H8): a public
 * line comment, reply, review comment or pending-comment edit that repeats members-only text the
 * page shows asks first, and nothing is posted or added until the writer confirms. A
 * members-only one does not ask.
 */

import { act, useContext, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DraftComment, RepoRef } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { lineKey } from '@/lib/view/inline-threads'
import { InlineCommentsContext } from '@/components/repo/diff-view'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'me' }, identity: 'me' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-first-write', () => ({ useFirstWrite: () => ({}) }))
vi.mock('@/hooks/use-mirror-trust', () => ({ useMirrorTrust: () => null }))
vi.mock('@/components/repo/byline', () => ({ Byline: () => <span /> }))
const postComment = vi.fn()
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  repoContractIds: () => [],
  readMembershipsCached: async () => [],
  postComment: (...a: unknown[]) => postComment(...a),
}))

import { InlineCommentsProvider, type InlineAudience, type PendingReview } from './inline-comments'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SECRET = 'The staging database password rotates on Friday at noon.'
const HEAD = 'a'.repeat(40)
const FILE = 'src/app.ts'
const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'O', name: 'repo', visibility: 'public' } as unknown as RepoRef
const home = { repo } as unknown as RepoHome
const audience = (pr: 'public' | 'members' = 'public'): InlineAudience => ({ home, members: [], maintainer: false, pr, author: 'carol', membersTexts: [SECRET] })

function FakeDiff(): JSX.Element {
  const inline = useContext(InlineCommentsContext)!
  useEffect(() => inline.report(FILE, new Set([lineKey(FILE, 1, 2)])), [inline])
  return (
    <div>
      <button type="button" data-testid="line-2" onClick={() => inline.start(FILE, 1, 2)}>
        2
      </button>
      {inline.render(FILE, 1, 2)}
    </div>
  )
}

let host: HTMLDivElement
let root: Root
function show(opts: { pending?: PendingReview; pr?: 'public' | 'members' } = {}): void {
  act(() =>
    root.render(
      <InlineCommentsProvider repo={repo} audience={audience(opts.pr)} pullId="P" headOid={HEAD} comments={[]} changedPaths={new Set([FILE])} onPosted={() => undefined} {...(opts.pending ? { pending: opts.pending } : {})}>
        <FakeDiff />
      </InlineCommentsProvider>,
    ),
  )
}
const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)
const button = (name: string): HTMLButtonElement | undefined => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
function type(el: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function pendingWith(over: Partial<PendingReview> = {}): PendingReview {
  return { comments: [], elsewhere: [], count: 0, membersTexts: [], frozen: false, onAdd: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn(), ...over }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  postComment.mockReset()
  postComment.mockResolvedValue({ documentId: 'c9' })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('a public diff comment that repeats members-only text', () => {
  it('asks before "Add comment", and posts only on confirm', async () => {
    show()
    act(() => q('line-2')!.click())
    act(() => type(host.querySelector('textarea')!, `> ${SECRET}\nThis line leaks it.`))
    act(() => button('Add comment')!.click())
    expect(q('quote-confirm')).not.toBeNull()
    expect(postComment).not.toHaveBeenCalled()
    await act(async () => q('quote-confirm')!.click())
    expect(postComment).toHaveBeenCalledTimes(1)
  })

  it('asks before "Start a review", and adds nothing on "Keep editing"', () => {
    const pending = pendingWith()
    show({ pending })
    act(() => q('line-2')!.click())
    act(() => type(host.querySelector('textarea')!, SECRET))
    act(() => button('Start a review')!.click())
    expect(q('quote-confirm')).not.toBeNull()
    act(() => q('quote-cancel')!.click())
    expect(pending.onAdd).not.toHaveBeenCalled()
    act(() => button('Start a review')!.click())
    act(() => q('quote-confirm')!.click())
    expect(pending.onAdd).toHaveBeenCalledTimes(1)
  })

  it("asks before adding a public review comment that repeats the review's own unposted members-only comment", () => {
    const own = 'Ship the vendor patch only after the embargo lifts on the ninth.'
    const pending = pendingWith({ count: 1, membersTexts: [own] })
    show({ pending })
    act(() => q('line-2')!.click())
    act(() => type(host.querySelector('textarea')!, `Note: ${own}`))
    act(() => button('Add review comment')!.click())
    expect(q('quote-confirm')).not.toBeNull()
    expect(pending.onAdd).not.toHaveBeenCalled()
    act(() => q('quote-confirm')!.click())
    expect(pending.onAdd).toHaveBeenCalledTimes(1)
  })

  it("asks before saving a public pending comment's edit", () => {
    const draft: DraftComment = { localId: 'd1', anchor: { path: FILE, line: 2, side: 1 }, body: 'Rename this.' }
    const pending = pendingWith({ comments: [draft], count: 1 })
    show({ pending })
    act(() => (document.querySelector('[aria-label="Edit pending comment"]') as HTMLButtonElement).click())
    act(() => type(document.querySelector('textarea[aria-label="Edit pending comment"]') as HTMLTextAreaElement, `As they said:\n${SECRET}`))
    act(() => button('Save')!.click())
    expect(q('quote-confirm')).not.toBeNull()
    expect(pending.onEdit).not.toHaveBeenCalled()
    act(() => q('quote-confirm')!.click())
    expect(pending.onEdit).toHaveBeenCalledWith('d1', `As they said:\n${SECRET}`)
  })
})

describe('members-only diff text', () => {
  it('posts without asking on a members-only PR', async () => {
    show({ pr: 'members' })
    act(() => q('line-2')!.click())
    act(() => type(host.querySelector('textarea')!, SECRET))
    await act(async () => button('Add comment')!.click())
    expect(q('quote-confirm')).toBeNull()
    expect(postComment).toHaveBeenCalledTimes(1)
  })
})

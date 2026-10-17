// @vitest-environment jsdom
/**
 * Suggestions on the PR diff:
 * - QW-065: with no commit name and email set, Apply and "Add to batch" still show (Apply
 *   disabled), and the name and email are set right there, not by a trip to Settings that would
 *   lose the batch;
 * - QW4-026: in Conversation, a review comment's suggestion offers the same Apply and "Add to
 *   batch", not only "View in Files changed";
 * - QW-067: the line composer offers "Insert a suggestion" (pre-filled with the lines) and a
 *   Preview that shows it as the diff it will be, and a pending comment's suggestion shows the
 *   lines it replaces, not only the + lines.
 */

import { act, useContext, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DraftComment, RepoRef } from '@/lib/repo'
import type { CommentView } from '@/lib/view'
import { lineKey } from '@/lib/view/inline-threads'
import { PREFS_KEY } from '@/lib/view/prefs'
import { linesAt, type SuggestionAnchor } from '@/lib/view/suggest-block'
import { InlineCommentsContext } from '@/components/repo/diff-view'
import { InlineCommentsProvider, SuggestedBody, type PendingReview, type SuggestionActions } from './inline-comments'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'me' }, identity: 'me' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-first-write', () => ({ useFirstWrite: () => ({}) }))
vi.mock('@/hooks/use-mirror-trust', () => ({ useMirrorTrust: () => null }))
vi.mock('@/components/repo/byline', () => ({ Byline: () => <span /> }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEAD = 'a'.repeat(40)
const FILE = 'src/greet.sh'
const TEXT = '#!/bin/sh\necho "HELLO, $name"\necho "Bye"\n'
const repo = { repoId: 'R', name: 'repo', visibility: 'public' } as unknown as RepoRef
const anchor = { path: FILE, line: 2, startLine: null, side: 1 as const, commitOid: HEAD }
const suggestion: CommentView = {
  id: 'c1',
  author: 'reviewer',
  body: 'Add an exclamation mark.\n\n```suggestion\necho "HELLO, $name!"\n```',
  createdAt: 1,
  replyTo: null,
  anchor,
  reviewId: null,
  imported: false,
}

const postComment = vi.fn()
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  postComment: (...a: unknown[]) => postComment(...a),
}))

const want = vi.fn()
function actions(patch: Partial<SuggestionActions> = {}): SuggestionActions {
  return {
    canApply: true,
    why: null,
    needsIdentity: false,
    ready: true,
    original: (a: SuggestionAnchor) => linesAt(TEXT, a, HEAD),
    want,
    unapplicable: () => null,
    applied: new Map(),
    batch: new Set(),
    onToggleBatch: () => undefined,
    onApply: () => undefined,
    ...patch,
  }
}

/** The diff's stand-in: lines 2 and 3 of a side (the new one by default), shown, with their clicks (Shift extends). */
function FakeDiff({ side = 1 }: { side?: 0 | 1 }): JSX.Element {
  const inline = useContext(InlineCommentsContext)!
  useEffect(() => inline.report(FILE, new Set([lineKey(FILE, side, 2), lineKey(FILE, side, 3)])), [inline, side])
  return (
    <div>
      {[2, 3].map((n) => (
        <div key={n}>
          <button type="button" data-testid={`line-${n}`} onClick={(e) => inline.start(FILE, side, n, e.shiftKey)}>
            {n}
          </button>
          {inline.render(FILE, side, n)}
        </div>
      ))}
    </div>
  )
}

let host: HTMLDivElement
let root: Root
function show(opts: { comments?: CommentView[]; suggestions: SuggestionActions; pending?: PendingReview; side?: 0 | 1; layout?: string; pullId?: string }): void {
  act(() =>
    root.render(
      <InlineCommentsProvider
        repo={repo}
        pullId={opts.pullId ?? 'P'}
        headOid={HEAD}
        comments={opts.comments ?? []}
        changedPaths={new Set([FILE])}
        onPosted={() => undefined}
        suggestions={opts.suggestions}
        {...(opts.pending ? { pending: opts.pending } : {})}
      >
        <FakeDiff key={opts.layout ?? 'unified'} side={opts.side ?? 1} />
      </InlineCommentsProvider>,
    ),
  )
}
const button = (name: string): HTMLButtonElement | undefined => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  window.localStorage.clear()
  want.mockClear()
  postComment.mockReset()
  postComment.mockResolvedValue({ documentId: 'c9' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('applying a suggestion with no commit name and email set (QW-065)', () => {
  it('shows Apply (disabled) and Add to batch, and sets the name and email in place', () => {
    show({ comments: [suggestion], suggestions: actions({ needsIdentity: true, ready: false }) })
    const bar = host.querySelector('[data-testid="suggestion-actions"]')!
    expect(button('Apply suggestion')?.disabled).toBe(true)
    expect(button('Add to batch')?.disabled).toBe(false)
    expect(bar.textContent).toContain('set them to apply suggestions')
    act(() => button('Set name and email')!.click())
    const form = host.querySelector<HTMLFormElement>('[data-testid="commit-identity-form"]')!
    const [name, email] = [...form.querySelectorAll('input')]
    act(() => type(name!, 'Alice Example'))
    act(() => type(email!, 'alice@example.com'))
    act(() => form.requestSubmit())
    const saved = JSON.parse(window.localStorage.getItem(PREFS_KEY)!)
    expect(saved.mergeName).toBe('Alice Example')
    expect(saved.mergeEmail).toBe('alice@example.com')
    expect(host.querySelector('[data-testid="commit-identity-form"]')).toBeNull()
  })

  it('still says why when the viewer can never apply', () => {
    show({ comments: [suggestion], suggestions: actions({ canApply: false, why: 'Only the PR author (or writers of repo) can apply this. Copy the suggestion instead.' }) })
    expect(button('Apply suggestion')).toBeUndefined()
    expect(host.textContent).toContain('Only the PR author')
  })
})

describe('writing a suggestion (QW-067)', () => {
  it('inserts a block pre-filled with the line, and previews it as a diff', async () => {
    show({ suggestions: actions() })
    act(() => (host.querySelector('[data-testid="line-2"]') as HTMLButtonElement).click())
    expect(want).toHaveBeenCalledWith(FILE)
    const insert = button('Insert a suggestion')
    expect(insert).toBeDefined()
    await act(async () => insert!.click())
    const field = host.querySelector<HTMLTextAreaElement>('textarea')!
    expect(field.value).toBe('```suggestion\necho "HELLO, $name"\n```\n')
    act(() => type(field, field.value.replace('$name"', '$name!"')))
    act(() => button('Preview')!.click())
    const preview = host.querySelector('[data-testid="markdown-preview"]')!
    expect(preview.querySelector('[data-kind="removed"]')?.textContent).toContain('echo "HELLO, $name"')
    expect(preview.querySelector('[data-kind="added"]')?.textContent).toContain('echo "HELLO, $name!"')
  })

  it('offers no suggestion on the old side', () => {
    show({ suggestions: actions(), side: 0 })
    act(() => (host.querySelector('[data-testid="line-2"]') as HTMLButtonElement).click())
    expect(host.querySelector('textarea')).not.toBeNull()
    expect(button('Insert a suggestion')).toBeUndefined()
  })

  it("shows a pending comment's suggestion with the lines it replaces", () => {
    // A draft's anchor on the draft's own head omits the head (`addDraftComment`).
    const draft: DraftComment = { localId: 'd1', anchor: { path: FILE, line: 2, side: 1 }, body: suggestion.body }
    const pending: PendingReview = { comments: [draft], elsewhere: [], count: 1, membersTexts: [], frozen: false, onAdd: () => undefined, onEdit: () => undefined, onRemove: () => undefined }
    show({ suggestions: actions(), pending })
    const shown = host.querySelector('[data-testid="pending-comment"]')!
    expect(shown.querySelector('[data-kind="removed"]')?.textContent).toContain('echo "HELLO, $name"')
    expect(shown.querySelector('[data-kind="added"]')?.textContent).toContain('echo "HELLO, $name!"')
  })
})

const click = (id: string, init: MouseEventInit = {}): void => act(() => void (host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, ...init })))
const field = (): HTMLTextAreaElement | null => host.querySelector<HTMLTextAreaElement>('textarea')
const typed = (text: string): void => act(() => type(field()!, text))

describe('an unsent line comment across a layout change (#560)', () => {
  const open = (layout: string, more: Partial<Parameters<typeof show>[0]> = {}): void => show({ suggestions: actions(), layout, ...more })

  it('keeps the typed text and the Preview tab when the diff is rebuilt (Split/Unified, phone width)', () => {
    open('split')
    click('line-2')
    typed('Please rename this')
    act(() => button('Preview')!.click())
    open('unified')
    expect(host.querySelector('[data-testid="markdown-preview"]')?.textContent).toContain('Please rename this')
    expect(button('Add comment')!.disabled).toBe(false)
    act(() => button('Write')!.click())
    expect(field()!.value).toBe('Please rename this')
  })

  it('is gone after Cancel', () => {
    open('split')
    click('line-2')
    typed('draft')
    act(() => button('Cancel')!.click())
    click('line-2')
    expect(field()!.value).toBe('')
    expect(button('Add comment')!.disabled).toBe(true)
  })

  it('does not follow the viewer to another line and back', () => {
    open('split')
    click('line-2')
    typed('for line 2')
    click('line-3')
    expect(field()!.value).toBe('')
    click('line-2')
    expect(field()!.value).toBe('')
  })

  it('is gone after a successful Add comment', async () => {
    open('split')
    click('line-2')
    typed('ship it')
    await act(async () => button('Add comment')!.click())
    expect(postComment).toHaveBeenCalledTimes(1)
    expect(field()).toBeNull()
    click('line-2')
    expect(field()!.value).toBe('')
  })

  it('is gone after Start a review', () => {
    const onAdd = vi.fn()
    const pending: PendingReview = { comments: [], elsewhere: [], count: 0, membersTexts: [], frozen: false, onAdd, onEdit: () => undefined, onRemove: () => undefined }
    open('split', { pending })
    click('line-2')
    typed('for the review')
    act(() => button('Start a review')!.click())
    expect(onAdd).toHaveBeenCalledTimes(1)
    click('line-2')
    expect(field()!.value).toBe('')
  })

  it('is not restored for another pull request', () => {
    open('split')
    click('line-2')
    typed('for P')
    open('split', { pullId: 'Q' })
    expect(field()!.value).toBe('')
  })

  it('keeps the text when a shift-click extends the selection, also across a rebuild', () => {
    open('split')
    click('line-2')
    typed('for lines 2-3')
    click('line-3', { shiftKey: true })
    expect(host.textContent).toContain('lines 2–3')
    expect(field()!.value).toBe('for lines 2-3')
    open('unified')
    expect(field()!.value).toBe('for lines 2-3')
    // Extending upward (the composer stays on its row) keeps it too.
    click('line-2', { shiftKey: true })
    expect(field()!.value).toBe('for lines 2-3')
  })

  it('cannot post twice when the diff is rebuilt mid-post, and ends with the composer closed', async () => {
    let finish!: (v: { documentId: string }) => void
    postComment.mockReturnValue(new Promise((r) => (finish = r)))
    open('split')
    click('line-2')
    typed('post me once')
    await act(async () => button('Add comment')!.click())
    expect(postComment).toHaveBeenCalledTimes(1)
    open('unified')
    // The rebuilt composer is the same post in flight: it cannot be sent again.
    expect(button('Add comment')!.disabled || field()!.value === '').toBe(true)
    await act(async () => button('Add comment')!.click())
    expect(postComment).toHaveBeenCalledTimes(1)
    await act(async () => finish({ documentId: 'c9' }))
    expect(field()).toBeNull()
    click('line-2')
    expect(field()!.value).toBe('')
  })

  it('shows a failed post to the rebuilt composer, with the text kept', async () => {
    let fail!: (e: Error) => void
    postComment.mockReturnValue(new Promise((_, r) => (fail = r)))
    open('split')
    click('line-2')
    typed('try again')
    await act(async () => button('Add comment')!.click())
    open('unified')
    await act(async () => fail(new Error('network down')))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('network down')
    expect(field()!.value).toBe('try again')
    expect(button('Add comment')!.disabled).toBe(false)
  })
})

describe('an unsent reply across a layout change (#560)', () => {
  const open = (layout: string): void => show({ comments: [suggestion], suggestions: actions(), layout })

  it('keeps an unsent reply across a layout change', () => {
    open('split')
    act(() => button('Reply')!.click())
    typed('Good catch, fixing')
    act(() => button('Preview')!.click())
    open('unified')
    expect(host.querySelector('[data-testid="markdown-preview"]')?.textContent).toContain('Good catch, fixing')
    act(() => button('Write')!.click())
    expect(field()!.value).toBe('Good catch, fixing')
  })

  it('keeps an open but empty reply open, and drops it on Cancel', () => {
    open('split')
    act(() => button('Reply')!.click())
    open('unified')
    expect(field()).not.toBeNull()
    typed('draft')
    act(() => button('Cancel')!.click())
    expect(field()).toBeNull()
    open('split')
    expect(field()).toBeNull()
    act(() => button('Reply')!.click())
    expect(field()!.value).toBe('')
  })

  it('closes the reply, empty, when the diff is rebuilt mid-post and the post then lands', async () => {
    let finish!: (v: { documentId: string }) => void
    postComment.mockReturnValue(new Promise((r) => (finish = r)))
    open('split')
    act(() => button('Reply')!.click())
    typed('only once')
    await act(async () => button('Reply')!.click())
    expect(postComment).toHaveBeenCalledTimes(1)
    open('unified')
    expect(field()?.value === '' || [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Reply').every((b) => b.disabled)).toBe(true)
    await act(async () => finish({ documentId: 'c9' }))
    expect(field()).toBeNull()
    act(() => button('Reply')!.click())
    expect(field()!.value).toBe('')
  })

  it('leaves another thread\'s reply alone', () => {
    const other: CommentView = { ...suggestion, id: 'c2', anchor: { ...anchor, line: 3 } }
    show({ comments: [suggestion, other], suggestions: actions() })
    const replies = (): HTMLButtonElement[] => [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Reply')
    act(() => replies()[0]!.click())
    typed('first')
    act(() => replies().at(-1)!.click())
    const boxes = [...host.querySelectorAll('textarea')]
    expect(boxes.map((b) => b.value)).toEqual(['first', ''])
    act(() => type(boxes[1]!, 'second'))
    act(() => [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Cancel')[1]!.click())
    show({ comments: [suggestion, other], suggestions: actions(), layout: 'unified' })
    expect([...host.querySelectorAll('textarea')].map((b) => b.value)).toEqual(['first'])
  })
})

describe('a suggestion in Conversation (QW4-026)', () => {
  it('offers Apply and Add to batch, and applies and batches', () => {
    const onApply = vi.fn()
    const onToggleBatch = vi.fn()
    // The text the page shows (a mirrored comment's, its banner stripped) still carries the suggestion.
    act(() => root.render(<SuggestedBody comment={suggestion} suggestions={actions({ onApply, onToggleBatch })} source={`Mirrored.\n\n${suggestion.body}`} />))
    expect(host.textContent).toContain('Mirrored.')
    // The suggestion renders as the diff of the line it replaces.
    expect(host.textContent).toContain('echo "HELLO, $name"')
    expect(host.textContent).toContain('echo "HELLO, $name!"')
    act(() => button('Apply suggestion')!.click())
    expect(onApply).toHaveBeenCalledWith(suggestion)
    act(() => button('Add to batch')!.click())
    expect(onToggleBatch).toHaveBeenCalledWith(suggestion)
  })

  it('is plain Markdown without suggestion actions, and says "Applied in" once applied', () => {
    act(() => root.render(<SuggestedBody comment={{ ...suggestion, body: 'No suggestion here.' }} suggestions={actions()} />))
    expect(host.querySelector('[data-testid="suggestion-actions"]')).toBeNull()
    act(() => root.render(<SuggestedBody comment={suggestion} suggestions={actions({ applied: new Map([['c1', 'b'.repeat(40)]]) })} />))
    expect(host.querySelector('[data-testid="suggestion-applied"]')?.textContent).toContain('Applied in')
    expect(button('Apply suggestion')).toBeUndefined()
  })
})

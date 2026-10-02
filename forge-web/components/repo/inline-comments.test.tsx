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

/** The diff's stand-in: line 2 of a side (the new one by default), shown, with its click. */
function FakeDiff({ side = 1 }: { side?: 0 | 1 }): JSX.Element {
  const inline = useContext(InlineCommentsContext)!
  useEffect(() => inline.report(FILE, new Set([lineKey(FILE, side, 2)])), [inline, side])
  return (
    <div>
      <button type="button" data-testid="line-2" onClick={() => inline.start(FILE, side, 2)}>
        2
      </button>
      {inline.render(FILE, side, 2)}
    </div>
  )
}

let host: HTMLDivElement
let root: Root
function show(opts: { comments?: CommentView[]; suggestions: SuggestionActions; pending?: PendingReview; side?: 0 | 1 }): void {
  act(() =>
    root.render(
      <InlineCommentsProvider
        repo={repo}
        pullId="P"
        headOid={HEAD}
        comments={opts.comments ?? []}
        changedPaths={new Set([FILE])}
        onPosted={() => undefined}
        suggestions={opts.suggestions}
        {...(opts.pending ? { pending: opts.pending } : {})}
      >
        <FakeDiff side={opts.side ?? 1} />
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
    const pending: PendingReview = { comments: [draft], elsewhere: [], count: 1, frozen: false, onAdd: () => undefined, onEdit: () => undefined, onRemove: () => undefined }
    show({ suggestions: actions(), pending })
    const shown = host.querySelector('[data-testid="pending-comment"]')!
    expect(shown.querySelector('[data-kind="removed"]')?.textContent).toContain('echo "HELLO, $name"')
    expect(shown.querySelector('[data-kind="added"]')?.textContent).toContain('echo "HELLO, $name!"')
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

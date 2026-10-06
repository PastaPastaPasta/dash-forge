// @vitest-environment jsdom
/**
 * Comment drafts kept in this browser: written as typed, cleared when emptied, dropped after two
 * weeks, per issue or PR, and never stored for a private repository (a `null` key). The
 * composer's Cmd/Ctrl+Enter runs its main action.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MarkdownEditor } from '@/components/repo/issue-bits'
import { DRAFT_TTL_MS, MAX_DRAFTS, clearDrafts, commentDraftKey, commentEditDraftKey, editDraftKey, newIssueDraftKey, readDraft, useDraftState, useDraftText, useEditDraft, writeDraft } from './draft-text'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  localStorage.clear()
})

describe('readDraft / writeDraft', () => {
  it('keeps text, clears an empty one, and drops an old one', () => {
    writeDraft('r:t:comment', 'half a thought', 1_000)
    expect(readDraft('r:t:comment', 2_000)).toBe('half a thought')
    writeDraft('r:t:comment', '   ')
    expect(readDraft('r:t:comment')).toBe('')
    writeDraft('r:t:comment', 'stale', 1_000)
    expect(readDraft('r:t:comment', 1_000 + DRAFT_TTL_MS + 1)).toBe('')
    expect(localStorage.length).toBe(0)
  })
  it('keeps the newest drafts only, and drops expired ones as it writes', () => {
    writeDraft('old', 'x', 1)
    for (let i = 0; i < MAX_DRAFTS; i++) writeDraft(`k${i}`, 'x', DRAFT_TTL_MS + 10 + i)
    expect(localStorage.getItem('forge:draft:v1:old')).toBeNull()
    expect(localStorage.length).toBe(MAX_DRAFTS)
    writeDraft('newest', 'x', DRAFT_TTL_MS + 10 + MAX_DRAFTS)
    expect(localStorage.length).toBe(MAX_DRAFTS)
    expect(localStorage.getItem('forge:draft:v1:k0')).toBeNull()
  })
  it('is kept per identity, for public repos only, and forgotten with the identity', () => {
    expect(commentDraftKey({ repoId: 'R', visibility: 'public' }, 'T', 'A')).toBe('A:R:T:comment')
    expect(commentDraftKey({ repoId: 'R', visibility: 'private' }, 'T', 'A')).toBeNull()
    expect(commentDraftKey({ repoId: 'R' }, 'T', 'A')).toBeNull()
    expect(commentDraftKey({ repoId: 'R', visibility: 'public' }, 'T', null)).toBeNull()
    writeDraft('A:R:T:comment', 'mine')
    writeDraft('B:R:T:comment', 'theirs')
    clearDrafts('A')
    expect(readDraft('A:R:T:comment')).toBe('')
    expect(readDraft('B:R:T:comment')).toBe('theirs')
  })
  it('reads a damaged entry as no draft', () => {
    localStorage.setItem('forge:draft:v1:x', '{not json')
    expect(readDraft('x')).toBe('')
  })
})

let holdDraft: (held: boolean, text: string) => void = () => {}
function Composer({ draftKey, onSubmit }: { draftKey: string | null; onSubmit?: () => void }) {
  const [text, setText, hold] = useDraftText(draftKey)
  holdDraft = hold
  return <MarkdownEditor id="c" label="Comment" value={text} onChange={setText} onSubmit={onSubmit} />
}

const field = (): HTMLTextAreaElement => host.querySelector('textarea')!
function type(text: string): void {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    set.call(field(), text)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('useDraftText', () => {
  it('restores the draft after a remount, per target', () => {
    act(() => root.render(<Composer draftKey="r:a:comment" />))
    type('draft on A')
    act(() => root.render(<Composer draftKey="r:b:comment" />))
    expect(field().value).toBe('')
    act(() => root.render(<Composer draftKey="r:a:comment" />))
    expect(field().value).toBe('draft on A')
    act(() => root.unmount())
    root = createRoot(host)
    act(() => root.render(<Composer draftKey="r:a:comment" />))
    expect(field().value).toBe('draft on A')
  })
  it('stores nothing while a post is in flight, and keeps the text again when nothing was sent', () => {
    act(() => root.render(<Composer draftKey="r:a:comment" />))
    type('posting this')
    act(() => holdDraft(true, 'posting this'))
    expect(readDraft('r:a:comment')).toBe('')
    type('posting this, edited')
    expect(readDraft('r:a:comment')).toBe('')
    act(() => holdDraft(false, 'posting this, edited'))
    expect(readDraft('r:a:comment')).toBe('posting this, edited')
  })
  it('stores nothing without a key (a private repository)', () => {
    act(() => root.render(<Composer draftKey={null} />))
    type('secret plan')
    expect(field().value).toBe('secret plan')
    expect(localStorage.length).toBe(0)
  })
})

describe('useDraftState (edits and new issues)', () => {
  type Edit = { title: string; body: string; rev: number }
  let api: { value: Edit | null; set: (v: Edit | null) => void; hold: (on: boolean, v: Edit | null) => void } | null = null
  function Editor({ k, rev }: { k: string | null; rev: number }): JSX.Element {
    const [value, set, hold] = useDraftState<Edit>(k, (d) => d.rev === rev)
    api = { value, set, hold }
    return <span>{value?.body ?? ''}</span>
  }

  it('keys edits and new issues per identity, public repos only', () => {
    const pub = { repoId: 'R', visibility: 'public' }
    expect(editDraftKey(pub, 'T', 'A')).toBe('A:R:T:edit')
    expect(commentEditDraftKey(pub, 'T', 'A')).toBe('A:R:T:comment-edit')
    expect(newIssueDraftKey(pub, 'A')).toBe('A:R:new:issue')
    expect(editDraftKey({ repoId: 'R', visibility: 'private' }, 'T', 'A')).toBeNull()
    expect(newIssueDraftKey(pub, null)).toBeNull()
  })

  it('restores an edit after a remount while the document is unchanged', () => {
    act(() => root.render(<Editor k="A:R:T:edit" rev={3} />))
    act(() => api!.set({ title: 'New title', body: 'half an edit', rev: 3 }))
    act(() => root.unmount())
    root = createRoot(host)
    act(() => root.render(<Editor k="A:R:T:edit" rev={3} />))
    expect(api!.value).toEqual({ title: 'New title', body: 'half an edit', rev: 3 })
  })

  it('drops an edit once the document changed since it started, never restoring it over the newer version', () => {
    writeDraft('A:R:T:edit', JSON.stringify({ title: 't', body: 'old edit', rev: 3 }))
    act(() => root.render(<Editor k="A:R:T:edit" rev={4} />))
    expect(api!.value).toBeNull()
    expect(readDraft('A:R:T:edit')).toBe('')
  })

  it('stores nothing while held, and clears on null', () => {
    act(() => root.render(<Editor k="A:R:T:edit" rev={1} />))
    act(() => api!.hold(true, null))
    act(() => api!.set({ title: 't', body: 'b', rev: 1 }))
    expect(readDraft('A:R:T:edit')).toBe('')
    act(() => api!.hold(false, { title: 't', body: 'b', rev: 1 }))
    expect(JSON.parse(readDraft('A:R:T:edit'))).toEqual({ title: 't', body: 'b', rev: 1 })
    act(() => api!.set(null))
    expect(readDraft('A:R:T:edit')).toBe('')
  })
})

describe('useEditDraft', () => {
  type Edit = { title: string; body: string; rev: number }
  let api: ReturnType<typeof useEditDraft<Edit>> | null = null
  function Editor({ rev }: { rev: number }): JSX.Element {
    api = useEditDraft<Edit>('A:R:T:edit', (d) => d.rev === rev, (d) => d.title !== 'Saved' || d.body !== 'saved body')
    return <span />
  }

  it('stores an edit only while it differs from the saved document', () => {
    act(() => root.render(<Editor rev={1} />))
    act(() => api!.set({ title: 'Saved', body: 'saved body', rev: 1 }))
    expect(api!.value).toEqual({ title: 'Saved', body: 'saved body', rev: 1 })
    expect(readDraft('A:R:T:edit')).toBe('')
    act(() => api!.set({ title: 'Saved', body: 'changed', rev: 1 }))
    expect(JSON.parse(readDraft('A:R:T:edit'))).toMatchObject({ body: 'changed' })
    act(() => api!.set(null))
    expect(api!.value).toBeNull()
    expect(readDraft('A:R:T:edit')).toBe('')
  })

  it('says when a stored edit was discarded because the document changed', () => {
    writeDraft('A:R:T:edit', JSON.stringify({ title: 't', body: 'old', rev: 1 }))
    act(() => root.render(<Editor rev={2} />))
    expect(api!.value).toBeNull()
    expect(api!.dropped).toBe(true)
  })
})

describe('MarkdownEditor shortcut', () => {
  it('runs the main action on Cmd+Enter and Ctrl+Enter, not on Enter', () => {
    const onSubmit = vi.fn()
    act(() => root.render(<Composer draftKey={null} onSubmit={onSubmit} />))
    const key = (init: KeyboardEventInit) => act(() => void field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })))
    key({})
    expect(onSubmit).not.toHaveBeenCalled()
    key({ metaKey: true })
    key({ ctrlKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(field().getAttribute('aria-keyshortcuts')).toBe('Meta+Enter Control+Enter')
  })
})

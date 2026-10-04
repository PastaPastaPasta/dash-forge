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
import { DRAFT_TTL_MS, readDraft, useDraftText, writeDraft } from './draft-text'

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
  it('reads a damaged entry as no draft', () => {
    localStorage.setItem('forge:draft:v1:x', '{not json')
    expect(readDraft('x')).toBe('')
  })
})

function Composer({ draftKey, onSubmit }: { draftKey: string | null; onSubmit?: () => void }) {
  const [text, setText] = useDraftText(draftKey)
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
  it('stores nothing without a key (a private repository)', () => {
    act(() => root.render(<Composer draftKey={null} />))
    type('secret plan')
    expect(field().value).toBe('secret plan')
    expect(localStorage.length).toBe(0)
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

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
import { DRAFT_TTL_MS, MAX_DRAFTS, clearDrafts, commentDraftKey, readDraft, useDraftText, useQuotedUntilEmptied, writeDraft, type DraftPersist } from './draft-text'
import { quotesMembersText } from './audience'

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

describe('useDraftText with a rule decided per text (members-only text quoted)', () => {
  const SECRET = 'The staging database password rotates on Friday at noon.'
  const MEMBERS = [SECRET]
  const KEY = 'A:R:T:comment'
  /** Every value this browser's storage held, read during each render. */
  let seenAtRender: string[]
  let setText: (t: string) => void = () => undefined
  function Quoting({ rule }: { rule: DraftPersist }): JSX.Element {
    const [text, set] = useDraftText(KEY, rule)
    setText = set
    seenAtRender.push(Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? '').join('\n'))
    return <span data-testid="text">{text}</span>
  }
  beforeEach(() => {
    seenAtRender = []
  })

  it('never stores pasted members-only text, at any render, and drops the stored public copy at once', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const rule = (t: string): boolean => !quotesMembersText(t, MEMBERS)
    act(() => root.render(<Quoting rule={rule} />))
    act(() => setText('A public thought'))
    expect(readDraft(KEY)).toBe('A public thought')
    // The paste: the stored public copy goes in the same call, before React renders again.
    act(() => {
      setText(`A public thought\n${SECRET}`)
      expect(localStorage.length).toBe(0)
    })
    act(() => setText(`A public thought\n> ${SECRET}\nmore`))
    expect(localStorage.length).toBe(0)
    expect(host.querySelector('[data-testid="text"]')?.textContent).toContain(SECRET)
    expect(seenAtRender.some((v) => v.includes('staging database'))).toBe(false)
    expect(setItem.mock.calls.some(([, v]) => String(v).includes('staging database'))).toBe(false)
    // The quote taken out: still in memory only, until the text is emptied (posted or deleted).
    act(() => setText('A public thought, edited'))
    expect(localStorage.length).toBe(0)
    act(() => setText(''))
    act(() => setText('A new thought'))
    expect(readDraft(KEY)).toBe('A new thought')
    setItem.mockRestore()
  })

  it('keeps a quoting draft off disk when the members-only text is forgotten (the tab locked)', () => {
    act(() => root.render(<Quoting rule={(t) => !quotesMembersText(t, MEMBERS)} />))
    act(() => setText(`> ${SECRET}`))
    expect(localStorage.length).toBe(0)
    // Locked: the store is cleared, so the same rule now finds nothing to compare against.
    act(() => root.render(<Quoting rule={(t) => !quotesMembersText(t, [])} />))
    expect(localStorage.length).toBe(0)
    act(() => setText(`> ${SECRET}\nand more`))
    expect(localStorage.length).toBe(0)
  })

  it('drops a stored copy that turns out to quote members-only text the page read later', () => {
    act(() => root.render(<Quoting rule={() => true} />))
    act(() => setText(SECRET))
    expect(readDraft(KEY)).toBe(SECRET)
    // The members-only comment loaded: the same text is now a quote of it.
    act(() => root.render(<Quoting rule={(t) => !quotesMembersText(t, MEMBERS)} />))
    expect(localStorage.length).toBe(0)
  })
})

describe('useQuotedUntilEmptied (the new-PR form)', () => {
  let seen: boolean[] = []
  function Form({ quotes, empty }: { quotes: boolean; empty: boolean }): null {
    seen.push(useQuotedUntilEmptied(quotes, empty))
    return null
  }
  it('stays true from the first quote until the form is emptied, whatever the check says later', () => {
    seen = []
    act(() => root.render(<Form quotes={false} empty={false} />))
    expect(seen.at(-1)).toBe(false)
    act(() => root.render(<Form quotes empty={false} />))
    expect(seen.at(-1)).toBe(true)
    // The tab locked: the check finds nothing now, the text is the same.
    act(() => root.render(<Form quotes={false} empty={false} />))
    expect(seen.at(-1)).toBe(true)
    act(() => root.render(<Form quotes={false} empty />))
    expect(seen.at(-1)).toBe(false)
    act(() => root.render(<Form quotes={false} empty={false} />))
    expect(seen.at(-1)).toBe(false)
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

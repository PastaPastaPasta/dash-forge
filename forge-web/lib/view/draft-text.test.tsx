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
import { DRAFT_TTL_MS, MAX_DRAFTS, clearDrafts, commentDraftKey, commentEditDraftKey, discardedEdits, editDraftKey, newIssueDraftKey, readDraft, useDraftState, useDraftText, useEditDraft, useQuotedUntilEmptied, writeDraft, type DraftPersist } from './draft-text'
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
    expect(commentDraftKey({ repoId: 'R', visibility: 'public' }, 'T', 'A', 'public')).toBe('A:R:T:comment')
    expect(commentDraftKey({ repoId: 'R', visibility: 'private' }, 'T', 'A', 'public')).toBeNull()
    expect(commentDraftKey({ repoId: 'R' }, 'T', 'A', 'public')).toBeNull()
    expect(commentDraftKey({ repoId: 'R', visibility: 'public' }, 'T', null, 'public')).toBeNull()
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

  it('says when a stored edit was discarded because the document changed, until the next edit', () => {
    writeDraft('A:R:T:edit', JSON.stringify({ title: 't', body: 'old', rev: 1 }))
    act(() => root.render(<Editor rev={2} />))
    expect(api!.value).toBeNull()
    expect(api!.dropped).toBe(true)
    // What was discarded, so the page can say where (Q5-A11).
    expect(api!.droppedValue).toEqual({ title: 't', body: 'old', rev: 1 })
    act(() => api!.set({ title: 'Saved', body: 'new', rev: 2 }))
    expect(api!.dropped).toBe(false)
    expect(api!.droppedValue).toBeNull()
  })

  it('holds the stored edit while it saves, keeps it again only when nothing was sent', async () => {
    const { UnconfirmedWriteError } = await import('../sdk')
    act(() => root.render(<Editor rev={1} />))
    act(() => api!.set({ title: 'Saved', body: 'edited', rev: 1 }))
    expect(readDraft('A:R:T:edit')).not.toBe('')
    await act(async () => {
      await expect(api!.saving(async () => { throw new UnconfirmedWriteError('d') })).rejects.toThrow()
    })
    // Sent but not shown yet: held away, so a reload neither saves it twice nor calls it discarded.
    expect(readDraft('A:R:T:edit')).toBe('')
    await act(async () => {
      await expect(api!.saving(async () => { throw new Error('refused') })).rejects.toThrow()
    })
    expect(JSON.parse(readDraft('A:R:T:edit'))).toMatchObject({ body: 'edited' })
    await act(async () => {
      await api!.saving(async () => 'ok')
    })
    expect(readDraft('A:R:T:edit')).toBe('')
  })
})

describe('edit and new-issue drafts keep no members-only text at rest (DESIGN §4.1)', () => {
  const SECRET = 'The staging database password rotates on Friday at noon.'
  const MEMBERS = [SECRET]
  type Issue = { title: string; body: string }
  type Edit = { title: string; body: string; rev: number }
  /** Whether any value this browser's storage held (at a render, or in any write) names the secret. */
  let seenAtRender: string[]
  const leaked = (setItem: { mock: { calls: unknown[][] } }): boolean =>
    seenAtRender.some((v) => v.includes('staging database')) || setItem.mock.calls.some(([, v]) => String(v).includes('staging database'))
  const snapshot = (): void => {
    seenAtRender.push(Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? '').join('\n'))
  }
  beforeEach(() => {
    seenAtRender = []
  })

  let issue: { value: Issue | null; set: (v: Issue | null) => void; hold: (on: boolean, v: Issue | null) => void } | null = null
  function NewIssue({ members, audience }: { members: string[]; audience: 'public' | 'members' }): JSX.Element {
    const [value, set, hold] = useDraftState<Issue>('A:R:new:issue', () => true, (d) => audience === 'public' && !quotesMembersText(`${d.title}\n${d.body}`, members))
    issue = { value, set, hold }
    snapshot()
    return <span data-testid="issue">{value?.body ?? ''}</span>
  }

  it('a new issue quoting members-only text stays in memory, from the call that sets it, until emptied', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    act(() => root.render(<NewIssue members={MEMBERS} audience="public" />))
    act(() => issue!.set({ title: 'Ship it', body: 'public notes' }))
    expect(JSON.parse(readDraft('A:R:new:issue'))).toEqual({ title: 'Ship it', body: 'public notes' })
    act(() => {
      issue!.set({ title: 'Ship it', body: `public notes\n> ${SECRET}` })
      // Removed in the same call, before React renders again.
      expect(localStorage.length).toBe(0)
    })
    expect(host.querySelector('[data-testid="issue"]')?.textContent).toContain(SECRET)
    // The tab locks (the members-only text is forgotten): the quoting draft still stays off disk.
    act(() => root.render(<NewIssue members={[]} audience="public" />))
    act(() => issue!.set({ title: 'Ship it', body: `public notes\n> ${SECRET}\nmore` }))
    expect(localStorage.length).toBe(0)
    // A failed submit that sent nothing keeps the draft again: still not on disk.
    act(() => issue!.hold(true, null))
    act(() => issue!.hold(false, { title: 'Ship it', body: `> ${SECRET}` }))
    expect(localStorage.length).toBe(0)
    expect(leaked(setItem)).toBe(false)
    // Emptied (posted or deleted): a new public draft is kept again.
    act(() => issue!.set(null))
    act(() => issue!.set({ title: 'Next', body: 'public' }))
    expect(JSON.parse(readDraft('A:R:new:issue'))).toEqual({ title: 'Next', body: 'public' })
    setItem.mockRestore()
  })

  it('a members-only new issue is never stored, and switching to Members drops the stored public copy', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    act(() => root.render(<NewIssue members={MEMBERS} audience="public" />))
    act(() => issue!.set({ title: 'Plan', body: 'draft' }))
    expect(readDraft('A:R:new:issue')).not.toBe('')
    act(() => root.render(<NewIssue members={MEMBERS} audience="members" />))
    expect(localStorage.length).toBe(0)
    act(() => issue!.set({ title: 'Plan', body: `draft ${SECRET}` }))
    expect(localStorage.length).toBe(0)
    expect(leaked(setItem)).toBe(false)
    setItem.mockRestore()
  })

  let edit: ReturnType<typeof useEditDraft<Edit>> | null = null
  function EditBox({ members, persist }: { members: string[]; persist?: boolean }): JSX.Element {
    edit = useEditDraft<Edit>(
      'A:R:T:edit',
      (d) => d.rev === 1,
      (d) => d.title !== 'Saved' || d.body !== 'saved body',
      persist ?? ((d) => !quotesMembersText(`${d.title}\n${d.body}`, members)),
    )
    snapshot()
    return <span data-testid="edit">{edit.value?.body ?? ''}</span>
  }

  it('an edit of a members-only issue, PR or comment is never stored', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    act(() => root.render(<EditBox members={MEMBERS} persist={false} />))
    act(() => edit!.set({ title: 'Saved', body: `edited: ${SECRET}`, rev: 1 }))
    expect(edit!.value?.body).toContain(SECRET)
    expect(localStorage.length).toBe(0)
    // A save known not to have been sent keeps the edit in memory only.
    await act(async () => {
      await expect(edit!.saving(async () => { throw new Error('refused') })).rejects.toThrow()
    })
    expect(localStorage.length).toBe(0)
    expect(leaked(setItem)).toBe(false)
    setItem.mockRestore()
  })

  it('a public edit that quotes members-only text is removed before it is stored, and stays off disk once the tab locks', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    act(() => root.render(<EditBox members={MEMBERS} />))
    act(() => edit!.set({ title: 'Saved', body: 'a public fix', rev: 1 }))
    expect(JSON.parse(readDraft('A:R:T:edit'))).toMatchObject({ body: 'a public fix' })
    act(() => {
      edit!.set({ title: 'Saved', body: `a public fix\n${SECRET}`, rev: 1 })
      expect(localStorage.length).toBe(0)
    })
    act(() => root.render(<EditBox members={[]} />))
    expect(localStorage.length).toBe(0)
    act(() => edit!.set({ title: 'Saved', body: `a public fix\n${SECRET}!`, rev: 1 }))
    expect(localStorage.length).toBe(0)
    await act(async () => {
      await expect(edit!.saving(async () => { throw new Error('refused') })).rejects.toThrow()
    })
    expect(localStorage.length).toBe(0)
    expect(edit!.value?.body).toContain(SECRET)
    expect(leaked(setItem)).toBe(false)
    setItem.mockRestore()
  })

  it('drops a stored edit that turns out to quote members-only text the page read later', () => {
    act(() => root.render(<EditBox members={[]} />))
    act(() => edit!.set({ title: 'Saved', body: SECRET, rev: 1 }))
    expect(readDraft('A:R:T:edit')).not.toBe('')
    act(() => root.render(<EditBox members={MEMBERS} />))
    expect(localStorage.length).toBe(0)
    expect(edit!.value?.body).toBe(SECRET)
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

describe('discardedEdits (Q5-A11)', () => {
  it('marks a discarded comment edit at its comment, and names it in the box, never as the description', () => {
    const d = discardedEdits(false, { id: 'c2' }, ['c1', 'c2'])
    expect(d.atComment).toBe('c2')
    expect(d.boxNote).toMatch(/^Your unsaved edit of a comment was discarded/)
    expect(d.boxNote).not.toMatch(/description/)
  })
  it('names what was discarded', () => {
    expect(discardedEdits(false, { id: 'gone' }, ['c1'])).toEqual({ atComment: null, boxNote: expect.stringMatching(/^Your unsaved edit of a comment/) })
    expect(discardedEdits(true, null, []).boxNote).toMatch(/^Your unsaved edit of the description was discarded/)
    expect(discardedEdits(true, { id: 'c1' }, ['c1'])).toEqual({ atComment: 'c1', boxNote: expect.stringMatching(/^Your unsaved edits of the description and of a comment/) })
    expect(discardedEdits(false, null, ['c1'])).toEqual({ atComment: null, boxNote: null })
  })
})

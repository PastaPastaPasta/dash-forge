// @vitest-environment jsdom
/**
 * Review round 2 of the members-only UX (stream 1D, PR #406): every public composer of a repo
 * checks against all the members-only text this tab opened in it (not only its own page), until
 * the tab locks; a pending review that quotes it carries its memory-only mark into every save;
 * and Escape goes to the right layer (a dialog ignores one already taken, and a popover under a
 * dialog never takes the dialog's).
 */

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReviewDraft } from '@/lib/repo'
import { AUDIENCE_FIELD } from '@/lib/repo/private-content'
import { clearMembersTexts, noteMembersText, noteOpenedDoc, openedMembersTexts, subscribeMembersTexts } from '@/lib/repo/members-texts'
import { closePrivateSessions } from '@/lib/repo/private-session'
import { newReviewDraft } from '@/lib/view/pending-review'

vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'bob', signer: { identityId: 'bob' }, unlockScope: 'full' }) }))
const saved: ReviewDraft[] = []
let stored: ReviewDraft | undefined
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  loadReviewDraft: async () => stored,
  saveReviewDraft: async (d: ReviewDraft) => void saved.push(d),
  discardReviewDraft: async () => undefined,
}))

import { closeWithComment, useMembersTexts, useQuoteGate } from './audience'
import { useReviewDraft } from './review-drawer'
import { Dialog, useEscapeLayer } from '@/components/ui/dialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SECRET = 'The staging database password rotates on Friday at noon.'
const REPO = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R1', ownerId: 'alice', name: 'demo', visibility: 'public' as const }
const HEAD = 'a'.repeat(40)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  clearMembersTexts()
  saved.length = 0
  stored = undefined
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe("the tab's opened members-only text", () => {
  it('keeps what a session opened, per repo, members-only documents of public repos only', async () => {
    noteOpenedDoc(REPO, { $id: 'd1', body: SECRET, [AUDIENCE_FIELD]: 'members' })
    noteOpenedDoc(REPO, { $id: 'd2', body: 'a public comment' })
    noteOpenedDoc({ repoId: 'P', visibility: 'private' }, { $id: 'd3', body: 'private repo text', [AUDIENCE_FIELD]: 'members' })
    noteOpenedDoc(REPO, { $id: 'd4', title: 'Members-only issue title', body: '', [AUDIENCE_FIELD]: 'members' })
    expect(openedMembersTexts('R1')).toEqual([SECRET, 'Members-only issue title'])
    expect(openedMembersTexts('P')).toEqual([])
    // A stable snapshot until something is added.
    expect(openedMembersTexts('R1')).toBe(openedMembersTexts('R1'))
  })

  it('tells its listeners once per batch, and is emptied when every session closes (lock, sign-out)', async () => {
    const heard = vi.fn()
    const stop = subscribeMembersTexts(heard)
    noteMembersText('R1', 'a', ['one'])
    noteMembersText('R1', 'b', ['two'])
    await flush()
    expect(heard).toHaveBeenCalledTimes(1)
    closePrivateSessions()
    expect(openedMembersTexts('R1')).toEqual([])
    await flush()
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe('a public composer checks all the members-only text the tab opened in its repo', () => {
  const go = vi.fn()
  function Composer({ repoId, text }: { repoId: string; text: string }): JSX.Element {
    // A composer whose own page shows no members-only text (a new issue, a new PR).
    const membersTexts = useMembersTexts(repoId)
    const gate = useQuoteGate()
    return (
      <>
        <button type="button" data-testid="submit" onClick={() => gate.check(text, membersTexts, go)}>
          Submit
        </button>
        {gate.dialog}
      </>
    )
  }
  beforeEach(() => go.mockReset())

  it('asks for text opened elsewhere in the repo, read after the paste too, and stops once the tab locks', async () => {
    const draft = `FYI: ${SECRET.toLowerCase()}`
    act(() => root.render(<Composer repoId="R1" text={draft} />))
    // Pasted while the members session was still loading: nothing to compare yet.
    act(() => q('submit')!.click())
    expect(go).toHaveBeenCalledTimes(1)
    // Another thread's members-only comment (past the first page, or another issue) opens.
    noteMembersText('R1', 'c9', [SECRET])
    await flush()
    act(() => q('submit')!.click())
    expect(go).toHaveBeenCalledTimes(1)
    expect(q('quote-confirm')).not.toBeNull()
    act(() => q('quote-cancel')!.click())
    // Locked: the text is gone from this tab.
    act(() => closePrivateSessions())
    await flush()
    act(() => q('submit')!.click())
    expect(go).toHaveBeenCalledTimes(2)
  })

  it("never checks against another repo's text (a stated limit)", async () => {
    noteMembersText('R2', 'c1', [SECRET])
    act(() => root.render(<Composer repoId="R1" text={SECRET} />))
    await flush()
    act(() => q('submit')!.click())
    expect(go).toHaveBeenCalledTimes(1)
  })
})

describe('"Close with comment" whose comment quotes members-only text', () => {
  const confirm = vi.fn()
  function CloseButton({ comment, audience = 'public' }: { comment?: string; audience?: 'public' | 'members' }): JSX.Element {
    const gate = useQuoteGate()
    return (
      <>
        <button type="button" data-testid="close" onClick={() => closeWithComment(gate, audience, [SECRET], { kind: 'state' as const, ...(comment !== undefined ? { comment } : {}) }, confirm)}>
          Close with comment
        </button>
        {gate.dialog}
      </>
    )
  }
  beforeEach(() => confirm.mockReset())

  it('asks: confirmed, the close goes with the comment; cancelled, nothing happens', () => {
    act(() => root.render(<CloseButton comment={`> ${SECRET}`} />))
    act(() => q('close')!.click())
    expect(confirm).not.toHaveBeenCalled()
    act(() => q('quote-cancel')!.click())
    expect(confirm).not.toHaveBeenCalled()
    act(() => q('close')!.click())
    act(() => q('quote-confirm')!.click())
    expect(confirm).toHaveBeenCalledWith({ kind: 'state', comment: `> ${SECRET}` })
  })

  it('closes at once without a comment, with one that quotes nothing, or with a members-only one', () => {
    act(() => root.render(<CloseButton />))
    act(() => q('close')!.click())
    act(() => root.render(<CloseButton comment="Done in #4." />))
    act(() => q('close')!.click())
    act(() => root.render(<CloseButton comment={SECRET} audience="members" />))
    act(() => q('close')!.click())
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(q('quote-confirm')).toBeNull()
  })
})

describe('a pending review that quotes members-only text', () => {
  let hook: ReturnType<typeof useReviewDraft> | null = null
  function Host({ texts }: { texts: readonly string[] }): null {
    hook = useReviewDraft(REPO, 'P', HEAD, false, texts)
    return null
  }

  it('is marked memory-only on the draft itself, from the moment it quotes or the text is read', async () => {
    act(() => root.render(<Host texts={[SECRET]} />))
    await flush()
    act(() => hook!.pending!.onAdd({ path: 'a.ts', line: 1, side: 1 }, `> ${SECRET}`))
    expect(saved.at(-1)?.memoryOnly).toBe(true)
    // The page's draft carries the mark too, so the submit's saves keep it.
    expect(hook!.draft?.memoryOnly).toBe(true)
    // The quote taken out, or the tab locked (the texts forgotten): the mark stays until the
    // draft is discarded or submitted, so the quoting draft never lands on disk.
    act(() => hook!.pending!.onEdit(hook!.draft!.comments[0]!.localId, 'Fine by me.'))
    expect(saved.at(-1)?.memoryOnly).toBe(true)
    act(() => root.render(<Host texts={[]} />))
    act(() => hook!.pending!.onEdit(hook!.draft!.comments[0]!.localId, `> ${SECRET}`))
    expect(saved.at(-1)?.memoryOnly).toBe(true)
  })

  it('takes the mark when the members-only text it quotes is read after it was stored', async () => {
    stored = { ...newReviewDraft({ draftId: 'd1', network: 'devnet', identity: 'bob', repoId: 'R1', prId: 'P', headOid: HEAD, private: false, now: 1 }), summary: `> ${SECRET}` }
    act(() => root.render(<Host texts={[]} />))
    await flush()
    expect(saved).toHaveLength(0)
    act(() => root.render(<Host texts={[SECRET]} />))
    await flush()
    expect(saved.at(-1)?.memoryOnly).toBe(true)
    expect(hook!.draft?.memoryOnly).toBe(true)
  })
})

describe('Escape and popovers', () => {
  const escape = (target: EventTarget = document): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => void target.dispatchEvent(e))
    return e
  }
  function Popover({ onEscape }: { onEscape: () => void }): JSX.Element {
    const [open, setOpen] = useState(true)
    const ref = useRef<HTMLDivElement>(null)
    useEscapeLayer(open, () => {
      setOpen(false)
      onEscape()
    }, ref)
    return <div ref={ref} data-testid="popover" data-open={open ? 'yes' : 'no'} />
  }

  it('a dialog ignores an Escape something inside it already took', () => {
    const onClose = vi.fn()
    act(() =>
      root.render(
        <Dialog open onClose={onClose} title="Open an issue">
          <input data-testid="field" onKeyDown={(e) => e.key === 'Escape' && e.preventDefault()} />
        </Dialog>,
      ),
    )
    escape(q('field')!)
    expect(onClose).not.toHaveBeenCalled()
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a popover left open on the page under a dialog never takes, or blocks, the dialog’s Escape', () => {
    const onClose = vi.fn()
    const popoverEscape = vi.fn()
    act(() =>
      root.render(
        <>
          <Popover onEscape={popoverEscape} />
          <Dialog open onClose={onClose} title="Post members-only text publicly?">
            <p>body</p>
          </Dialog>
        </>,
      ),
    )
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(popoverEscape).not.toHaveBeenCalled()
    expect(q('popover')?.dataset.open).toBe('yes')
  })

  it('a popover with no dialog open takes Escape', () => {
    const popoverEscape = vi.fn()
    act(() => root.render(<Popover onEscape={popoverEscape} />))
    escape()
    expect(popoverEscape).toHaveBeenCalledTimes(1)
  })
})

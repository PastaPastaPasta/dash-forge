// @vitest-environment jsdom
/**
 * RC2 MOD: a comment or review a maintainer hid shows collapsed ("hidden by"), anyone can expand
 * it, a hidden review's verdict says it still counts, a maintainer gets Hide / Unhide, and the
 * timeline names what a hide hid.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HiddenItems } from '@/lib/rules/moderation'
import type { TimelineItem } from '@/lib/view'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => undefined }))

const { Timeline, moderationNamed } = await import('./timeline')
const { HideMenu } = await import('./moderation')

const BOB = 'BbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbbBbbb'
const CAROL = 'CcccCcccCcccCcccCcccCcccCcccCcccCcccCcccCccc'
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const comment: TimelineItem = {
  kind: 'comment',
  at: 1,
  comment: { id: 'c1', author: BOB, body: 'buy cheap pills', createdAt: 1, replyTo: null, anchor: null, reviewId: null, imported: false } as never,
}
const review: TimelineItem = {
  kind: 'review',
  at: 2,
  review: { id: 'r1', reviewer: BOB, verdict: 'approve', verdictCode: 1, commitOid: '', body: 'lgtm', commentCount: null, createdAt: 2 } as never,
  comments: [],
  expected: 0,
}
const hidden = (by: string, eventId: string, reason: 'spam' | null = 'spam') => ({ by, reason, at: 5, eventId, via: 'item' as const })
const moderation: HiddenItems = { thread: null, items: { c1: hidden(CAROL, 'e1'), r1: hidden(CAROL, 'e2', null) }, counted: ['e1', 'e2'] }

describe('Timeline with hidden items', () => {
  it('collapses a hidden comment and review, and expands them on Show', () => {
    act(() => root.render(<Timeline items={[comment, review]} moderation={moderation} />))
    const rows = host.querySelectorAll('[data-testid="hidden-item"]')
    expect(rows).toHaveLength(2)
    expect(host.textContent).not.toContain('buy cheap pills')
    expect(rows[0]?.textContent).toContain('as spam')
    expect(host.querySelector('[data-testid="hidden-verdict"]')?.textContent).toContain('still counts unless dismissed')
    act(() => (rows[0]?.querySelector('[data-testid="show-hidden"]') as HTMLButtonElement).click())
    expect(host.textContent).toContain('buy cheap pills')
    expect(host.querySelector('[data-testid="revealed-hidden"]')).not.toBeNull()
  })

  it("renders a maintainer's actions on a collapsed row and a shown one", () => {
    const moderate = vi.fn(({ id }: { kind: 'comment' | 'review'; id: string }) => <span data-testid={`mod-${id}`} />)
    act(() => root.render(<Timeline items={[comment, review]} moderation={{ thread: null, items: { c1: hidden(CAROL, 'e1') }, counted: ['e1'] }} moderate={moderate} />))
    expect(host.querySelector('[data-testid="mod-c1"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="mod-r1"]')).not.toBeNull()
  })

  it('leaves out a hide the reader rule did not count', () => {
    const ev = (id: string, actor: string): TimelineItem => ({ kind: 'event', at: 3, event: { id, kind: 'hide', actor, refId: 'c1', value: 'spam', createdAt: 3 } as never })
    act(() => root.render(<Timeline items={[comment, ev('e1', CAROL), ev('e9', BOB)]} moderation={{ thread: null, items: { c1: hidden(CAROL, 'e1') }, counted: ['e1'] }} />))
    const rows = [...host.querySelectorAll('[data-testid="timeline-event"]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('hid a comment by')
  })

  it('names what a hide hid', () => {
    const refs = new Map([['c1', { kind: 'comment' as const, author: BOB }]])
    expect(moderationNamed({ kind: 'hide', actor: CAROL, refId: 'c1', value: 'spam', createdAt: 5 }, refs)).toEqual({ text: 'hid a comment by', who: BOB, after: ' as spam' })
    expect(moderationNamed({ kind: 'unhide', actor: CAROL, refId: 'c1', value: null, createdAt: 6 }, refs)).toEqual({ text: 'unhid a comment by', who: BOB, after: '' })
    expect(moderationNamed({ kind: 'hide', actor: CAROL, createdAt: 5 }, refs)).toBeNull()
    expect(moderationNamed({ kind: 'pin', actor: CAROL, refId: 'c1', createdAt: 5 }, refs)).toBeNull()
  })
})

describe('HideMenu', () => {
  it("says why instead of offering a write that would change nothing", () => {
    act(() => root.render(<HideMenu hidden={false} onHide={vi.fn()} onUnhide={vi.fn()} disabled={false} blocked="ownersContent" />))
    expect(host.querySelector('[data-testid="hide-item"]')).toBeNull()
    expect(host.querySelector('[data-testid="hide-blocked"]')?.getAttribute('data-why')).toBe('ownersContent')
    act(() => root.render(<HideMenu hidden onHide={vi.fn()} onUnhide={vi.fn()} disabled={false} blocked="withItsReview" />))
    expect(host.querySelector('[data-testid="unhide-item"]')).toBeNull()
    expect(host.textContent).toContain('Hidden with its review')
  })

  it('offers the reasons, and Unhide when hidden', () => {
    const onHide = vi.fn()
    const onUnhide = vi.fn()
    act(() => root.render(<HideMenu hidden={false} onHide={onHide} onUnhide={onUnhide} disabled={false} />))
    act(() => (host.querySelector('[data-testid="hide-item"]') as HTMLButtonElement).click())
    act(() => (host.querySelector('[data-reason="off-topic"]') as HTMLButtonElement).click())
    expect(onHide).toHaveBeenCalledWith('off-topic')
    act(() => root.render(<HideMenu hidden onHide={onHide} onUnhide={onUnhide} disabled={false} />))
    act(() => (host.querySelector('[data-testid="unhide-item"]') as HTMLButtonElement).click())
    expect(onUnhide).toHaveBeenCalled()
  })
})

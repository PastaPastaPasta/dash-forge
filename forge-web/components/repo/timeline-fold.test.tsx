// @vitest-environment jsdom
/**
 * QW2-010: a long timeline hides its middle behind "Load more", and a mirrored review with
 * nothing of its own is one line, not a card.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TimelineItem } from '@/lib/view'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => undefined }))

const { Timeline, timelineWindow, TIMELINE_EDGE, TIMELINE_FOLD_AT, TIMELINE_PAGE } = await import('./timeline')

const A = 'AaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaaAaaa'
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

const event = (i: number): TimelineItem => ({ kind: 'event', at: i, event: { id: `e${i}`, kind: 'labelAdd', value: `l${i}`, actor: A, createdAt: i } as never })

describe('timelineWindow', () => {
  it('shows everything up to the fold, then both ends and pages of the middle', () => {
    expect(timelineWindow(TIMELINE_FOLD_AT, 0)).toEqual({ head: TIMELINE_FOLD_AT, tail: 0, hidden: 0 })
    expect(timelineWindow(283, 0)).toEqual({ head: TIMELINE_EDGE, tail: TIMELINE_EDGE, hidden: 283 - 2 * TIMELINE_EDGE })
    expect(timelineWindow(283, TIMELINE_PAGE).hidden).toBe(283 - 2 * TIMELINE_EDGE - TIMELINE_PAGE)
    expect(timelineWindow(283, 10_000)).toEqual({ head: 283 - TIMELINE_EDGE, tail: TIMELINE_EDGE, hidden: 0 })
  })
})

describe('Timeline', () => {
  it('hides the middle of a long timeline behind Load more', () => {
    const items = Array.from({ length: 120 }, (_, i) => event(i))
    act(() => root.render(<Timeline items={items} />))
    const rows = (): number => host.querySelectorAll('[data-testid="timeline-event"]').length
    expect(rows()).toBe(2 * TIMELINE_EDGE)
    expect(host.querySelector('[data-testid="timeline-fold"]')?.textContent).toContain(`${120 - 2 * TIMELINE_EDGE} hidden items`)
    const more = (): void => act(() => (host.querySelector('[data-testid="timeline-fold"] button') as HTMLButtonElement).click())
    more()
    expect(rows()).toBe(2 * TIMELINE_EDGE + TIMELINE_PAGE)
    more()
    expect(rows()).toBe(120)
    expect(host.querySelector('[data-testid="timeline-fold"]')).toBeNull()
  })

  it('keeps items that arrive later on the shown end', () => {
    const items = Array.from({ length: 120 }, (_, i) => event(i))
    act(() => root.render(<Timeline items={items} />))
    act(() => root.render(<Timeline items={[...items, event(120)]} />))
    const shownIds = [...host.querySelectorAll('[data-testid="timeline-event"]')].map((e) => e.textContent ?? '')
    expect(shownIds).toHaveLength(2 * TIMELINE_EDGE + 1)
    expect(shownIds.at(-1)).toContain('l120')
    expect(shownIds.at(-TIMELINE_EDGE - 1)).toContain(`l${120 - TIMELINE_EDGE}`)
  })

  it('shows an empty mirrored review as one line', () => {
    const review: TimelineItem = {
      kind: 'review',
      at: 5,
      review: {
        id: 'r1',
        reviewer: A,
        verdict: 'comment',
        verdictCode: 3,
        commitOid: 'a'.repeat(40),
        body: '> Mirrored from github.com/o/r#1 by @hush (review, commented, 2024-12-17)\n\n',
        commentCount: null,
        createdAt: 5,
        origin: { author: 'hush', createdAt: 1_700_000_000_000, url: 'https://github.com/o/r/pull/1#r', host: 'github.com' },
      },
      comments: [],
      expected: 0,
    }
    act(() => root.render(<Timeline items={[review]} trust={new Set([A])} />))
    const row = host.querySelector('[data-kind="mirrored-review"]')
    expect(row?.textContent).toContain('reviewed')
    expect(host.textContent).not.toContain('Mirrored from')
    // With its comments folded under it, the card shows them, and no provenance quote of its own.
    const comment = {
      id: 'c1', author: A, createdAt: 4, replyTo: null, anchor: null, reviewId: null, imported: true,
      body: '> Mirrored from github.com/o/r#1 by @hush (review comment, 2024-12-17)\n\n`dip.md`\n\nPlease rename this.',
      origin: { author: 'hush', createdAt: 1_699_999_999_000, url: 'https://github.com/o/r/pull/1#c', host: 'github.com' },
    }
    act(() => root.render(<Timeline items={[{ ...review, comments: [comment] } as TimelineItem]} trust={new Set([A])} />))
    expect(host.querySelector('[data-testid="review-comment"]')?.textContent).toContain('dip.md')
    expect(host.querySelector('[data-testid="review-comment"]')?.textContent).toContain('Please rename this.')
    expect(host.textContent).not.toContain('Mirrored from')
  })
})

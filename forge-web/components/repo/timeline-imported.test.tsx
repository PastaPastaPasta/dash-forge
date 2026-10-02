// @vitest-environment jsdom
/**
 * QW4-006: a state change the thread's own mirror recorded is the source's. The import records the
 * state, not who changed it there or when, so the timeline credits the source forge ("Closed as
 * completed on github.com") rather than the mirror identity at the import time.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TimelineItem } from '@/lib/view'
import type { CloseWhy } from '@/lib/view/close-reason'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/hooks/use-dpns-name', () => ({ useDpnsName: () => 'mirror' }))

const { Timeline, sourcePhrase } = await import('./timeline')

const MIRROR = 'MmmmMmmmMmmmMmmmMmmmMmmmMmmmMmmmMmmmMmmmMmmm'
const MAINT = 'NnnnNnnnNnnnNnnnNnnnNnnnNnnnNnnnNnnnNnnnNnnn'
const ORIGIN = { author: 'thephez', createdAt: 1_600_000_000_000, url: 'https://github.com/dashpay/dips/issues/155', host: 'github.com' }
const OID = 'a4d46dd2d'.padEnd(40, '0')

/** When the import wrote the thread: a minute before it recorded the state. */
const IMPORTED_AT = Date.now() - 5 * 3600_000 - 60_000
const transition = (id: string, kind: number, actor: string, extra: Record<string, unknown> = {}): TimelineItem =>
  ({ kind: 'transition', at: 10, transition: { id, kind, actor, targetId: 't', asAuthor: 0, createdAt: Date.now() - 5 * 3600_000, ...extra } }) as never

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

const rows = (): Element[] => [...host.querySelectorAll('[data-testid="timeline-event"]')]

describe('imported state changes (QW4-006)', () => {
  it('credits the source forge, not the mirror identity, for the mirror\'s own close of an imported issue', () => {
    const completed: CloseWhy = { phrase: 'closed this as completed', duplicate: null, skipped: false }
    act(() => root.render(<Timeline items={[transition('t1', 1, MIRROR, { reason: 1 })]} imported={{ origin: ORIGIN, signer: MIRROR, createdAt: IMPORTED_AT }} closeWhy={() => completed} closedIn={() => ({ number: 3, title: 'x', href: '/p/3' })} />))
    const [row] = rows()
    expect(row?.getAttribute('data-imported')).toBe('true')
    expect(row?.textContent).toMatch(/^Closed as completed on github\.com mirrored 5 ?h(ours)? ago/)
    expect(row?.textContent).not.toContain('mirror closed')
    // No "closed as completed in #3": the import's timing names no cause.
    expect(row?.textContent).not.toContain('#3')
    expect(row?.querySelector('a[href="https://github.com/dashpay/dips/issues/155"]')?.textContent).toBe('github.com')
  })

  it('says a merge happened at its commit on the source', () => {
    act(() => root.render(<Timeline items={[transition('t2', 13, MIRROR, { oid: OID })]} imported={{ origin: ORIGIN, signer: MIRROR, createdAt: IMPORTED_AT }} />))
    expect(rows()[0]?.textContent).toMatch(/^Merged at a4d46dd2d.* on github\.com/)
  })

  it('names a duplicate\'s canonical, and keeps the grey icon', () => {
    const dup: CloseWhy = { phrase: 'closed this as a duplicate of #1', duplicate: { number: 1, title: 'First', href: '/i/1' }, skipped: true }
    act(() => root.render(<Timeline items={[transition('t3', 1, MIRROR, { reason: 3, dupNumber: 1 })]} imported={{ origin: ORIGIN, signer: MIRROR, createdAt: IMPORTED_AT }} closeWhy={() => dup} />))
    expect(rows()[0]?.textContent).toMatch(/^Closed as a duplicate of #1 First on github\.com/)
    expect(rows()[0]?.querySelector('[data-icon="closed-skipped"]')).not.toBeNull()
  })

  it('keeps a member\'s own state change on an imported thread credited to them', () => {
    act(() => root.render(<Timeline items={[transition('t4', 2, MAINT)]} imported={{ origin: ORIGIN, signer: MIRROR, createdAt: IMPORTED_AT }} />))
    expect(rows()[0]?.getAttribute('data-imported')).toBeNull()
    expect(rows()[0]?.textContent).toContain('reopened this')
  })

  it('credits the signer for a change away from any import: the owner acting here, hours later', () => {
    act(() => root.render(<Timeline items={[transition('t5', 1, MIRROR, { createdAt: Date.now() - 60_000 })]} imported={{ origin: ORIGIN, signer: MIRROR, createdAt: IMPORTED_AT }} closedIn={() => ({ number: 3, title: 'x', href: '/p/3' })} />))
    expect(rows()[0]?.getAttribute('data-imported')).toBeNull()
    expect(rows()[0]?.textContent).toMatch(/closed this as completed in #3/)
    // A duplicate close done here (not by an import) names its actor too.
    act(() => root.render(<Timeline items={[]} imported={{ origin: ORIGIN, signer: MIRROR, createdAt: IMPORTED_AT }} duplicateRefs={[{ id: 'd2', actor: MIRROR, at: 20, imported: false, number: 7, title: 'Again', href: '/i/7' }]} />))
    expect(host.querySelector('[data-kind="marked-duplicate"]')?.textContent).toMatch(/marked #7 Again as a duplicate of this issue · /)
  })

  it('places a duplicate\'s back-reference and branch events among the items by time (QW4-024, QW4-025)', () => {
    const comment = (id: string, at: number): TimelineItem => ({ kind: 'comment', at, comment: { id, author: MAINT, body: id, createdAt: at, replyTo: null, anchor: null, reviewId: null, imported: false } }) as never
    act(() =>
      root.render(
        <Timeline
          items={[comment('first', 10), comment('last', 40)]}
          duplicateRefs={[{ id: 'd1', actor: MAINT, at: 20, number: 2, title: 'Same bug', href: '/i/2' }]}
          branchEvents={[{ id: 'b1', actor: MAINT, at: 30, kind: 'deleted', branch: 'feature-ff' }]}
        />,
      ),
    )
    const order = [...host.querySelectorAll('[data-testid="timeline-comment"], [data-testid="timeline-event"]')].map((e) => e.getAttribute('data-kind') ?? 'comment')
    expect(order).toEqual(['comment', 'marked-duplicate', 'branch-deleted', 'comment'])
    expect(host.querySelector('[data-kind="marked-duplicate"]')?.textContent).toMatch(/marked #2 Same bug as a duplicate of this issue · /)
    expect(host.querySelector('[data-kind="branch-deleted"]')?.textContent).toMatch(/deleted the feature-ff branch · /)
  })

  it('words a mirror\'s duplicate close of an imported issue as the source\'s', () => {
    act(() => root.render(<Timeline items={[]} imported={{ origin: ORIGIN, signer: MIRROR, createdAt: IMPORTED_AT }} duplicateRefs={[{ id: 'd1', actor: MIRROR, at: 20, imported: true, number: 2, title: 'Same bug', href: '/i/2' }]} />))
    expect(host.querySelector('[data-kind="marked-duplicate"]')?.textContent).toBe('Marked #2 Same bug as a duplicate of this issue on github.com')
  })

  it('words a phrase with no actor', () => {
    expect(sourcePhrase('closed this as not planned')).toBe('Closed as not planned')
    expect(sourcePhrase('merged this')).toBe('Merged')
    expect(sourcePhrase('reopened this')).toBe('Reopened')
    expect(sourcePhrase('locked the conversation')).toBe('Locked the conversation')
    expect(sourcePhrase('marked this ready for review')).toBe('Marked ready for review')
  })
})

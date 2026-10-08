// @vitest-environment jsdom
/**
 * Members-only content in issue and PR lists (stream 1D review fixes, PR #406): labelled comment
 * counts, a specific-people row named neutrally, the state tabs' cut-off affordance at phone
 * width, and which writes count as public text for the quote check.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { titleOf as rowTitleOf } from '@/lib/repo/issues'
import { titleOf as mineTitleOf } from '@/lib/view/mine'
import { publicTextOf } from '@/lib/view/audience'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: () => undefined }), useSearchParams: () => new URLSearchParams() }))

import { CommentCount, RowLink, StateTab, StateTabs } from './list-controls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})
const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`)
const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes))

describe('a row comment count', () => {
  it('says how many are members-only: "5 comments (5 members-only)"', () => {
    act(() => root.render(<CommentCount n={5} membersOnly={5} />))
    expect(q('comment-count')?.querySelector('.sr-only')?.textContent).toBe('5 comments (5 members-only)')
    expect(q('comment-count-members-only')?.textContent).toBe('(5 members-only)')
    act(() => root.render(<CommentCount n={5} />))
    expect(q('comment-count')?.querySelector('.sr-only')?.textContent).toBe('5 comments')
    expect(q('comment-count-members-only')).toBeNull()
  })

  it('labels the share on a public thread too: "3 comments (2 members-only)" (Q5-D03)', () => {
    act(() => root.render(<CommentCount n={3} membersOnly={2} />))
    expect(q('comment-count')?.querySelector('.sr-only')?.textContent).toBe('3 comments (2 members-only)')
    expect(q('comment-count')?.getAttribute('title')).toBe('3 comments (2 members-only)')
    expect(q('comment-count-members-only')?.textContent).toBe('(2 members-only)')
    // never more members-only than comments
    act(() => root.render(<CommentCount n={1} membersOnly={4} />))
    expect(q('comment-count')?.querySelector('.sr-only')?.textContent).toBe('1 comment (1 members-only)')
  })
})

describe('a specific-people issue or PR (enc v0x04)', () => {
  it('is named "Encrypted for specific people", never members-only, in rows and lists', () => {
    const letter = { $id: 'x', title: '', enc: b64([0x04, 1, 2, 3]), vis: 'public' }
    const members = { ...letter, enc: b64([0x03, 1, 2, 3]) }
    expect(rowTitleOf(letter as never)).toBe('Encrypted for specific people')
    expect(rowTitleOf(members as never, 'patch')).toBe('Members-only pull request')
    expect(mineTitleOf(letter as never, 'pull')).toBe('Encrypted for specific people')
    expect(mineTitleOf(members as never, 'issue')).toBe('Members-only issue')
    // The row shows its title (the neutral name), not a members-only one.
    act(() => root.render(<RowLink href="/x" title="Encrypted for specific people" membersOnly />))
    expect(q('members-only-title')?.textContent?.trim()).toBe('Encrypted for specific people')
  })
})

describe('the state tabs at phone width', () => {
  it('show an arrow while tabs are cut off on the right, and none when they fit', () => {
    const size = (scrollWidth: number) => {
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth)
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
    }
    size(420)
    const tabs = (
      <StateTabs label="Issue state">
        <StateTab active onClick={() => undefined}>3 Open (1 members-only)</StateTab>
        <StateTab active={false} onClick={() => undefined}>2 Closed</StateTab>
        <StateTab active={false} onClick={() => undefined}>All</StateTab>
      </StateTabs>
    )
    act(() => root.render(tabs))
    expect(q('state-tabs-more')).not.toBeNull()
    const scroller = host.querySelector<HTMLElement>('[role="tablist"]')!
    scroller.scrollBy = vi.fn()
    act(() => q('state-tabs-more')!.click())
    expect(scroller.scrollBy).toHaveBeenCalled()
    vi.restoreAllMocks()
    size(300)
    act(() => scroller.dispatchEvent(new Event('scroll')))
    expect(q('state-tabs-more')).toBeNull()
  })
})

describe('what counts as public text for the quote check', () => {
  it('is the text of a public write in a public thread, and nothing members-only', () => {
    expect(publicTextOf('hi', 'public')).toBe('hi')
    expect(publicTextOf('hi', undefined, 'public')).toBe('hi')
    expect(publicTextOf('hi', 'members')).toBeNull()
    expect(publicTextOf('hi', 'public', 'members')).toBeNull()
    expect(publicTextOf('hi', undefined, 'specificPeople')).toBeNull()
  })
})

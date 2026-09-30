// @vitest-environment jsdom
/**
 * Blame's commit column is one tab stop, not one per hunk: axe flagged adjacent 20 px hunk links
 * (target-size, WCAG 2.5.8) at 768 and 1280 px, and a keyboard user had to Tab through every
 * hunk. The arrow keys move between the hunks' commit links.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BlameResult } from '@/lib/view/blame'
import { BlameTable } from './blame-content'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/repo/blame/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined, push: () => undefined }) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const oid = (c: string): string => c.repeat(40)
const entry = (subject: string) => ({ subject, author: { name: 'a', email: 'a@x', when: 1_700_000_000_000 }, committer: { name: 'a', email: 'a@x', when: 1_700_000_000_000 } })
const RESULT = {
  lines: ['one', 'two', 'three', 'four'],
  hunks: [
    { start: 1, count: 1, oid: oid('a') },
    { start: 2, count: 2, oid: oid('b') },
    { start: 4, count: 1, oid: oid('c') },
  ],
  commits: new Map([
    [oid('a'), entry('first')],
    [oid('b'), entry('second')],
    [oid('c'), entry('third')],
  ]),
  partial: false,
  boundary: null,
  cursor: null,
  approximate: false,
  versions: 3,
  renames: [],
} as unknown as BlameResult

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  act(() => root.render(<BlameTable result={RESULT} addr={{ owner: 'o', name: 'n' }} permalink={null} />))
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const links = (): HTMLAnchorElement[] => [...el.querySelectorAll<HTMLAnchorElement>('a[data-testid="blame-commit"]')]
const press = (t: Element, key: string, extra: KeyboardEventInit = {}): void => {
  act(() => {
    t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }))
  })
}

describe('blame commit column', () => {
  it('has one tab stop, the first hunk', () => {
    expect(links().map((a) => a.textContent)).toEqual(['first', 'second', 'third'])
    expect(links().map((a) => a.tabIndex)).toEqual([0, -1, -1])
  })

  it('moves between hunks with the arrows, and leaves modified keys alone', () => {
    const [first, second, third] = links()
    act(() => first!.focus())
    press(first!, 'ArrowDown')
    expect(document.activeElement).toBe(second)
    press(second!, 'End')
    expect(document.activeElement).toBe(third)
    press(third!, 'ArrowUp', { metaKey: true })
    expect(document.activeElement).toBe(third)
  })
})

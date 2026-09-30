// @vitest-environment jsdom
/**
 * A PR diff's line-number buttons (each starts an inline comment) are one tab stop per file, not
 * one per code line (a roving tabindex): axe flagged 375 packed 20 px tab stops on one PR's Files
 * tab (target-size, WCAG 2.5.8), and a keyboard user had to Tab through every line to get past a
 * diff. The arrow keys move between the lines; clicking still starts a comment.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TextDiffLine } from '@/lib/view/text-diff'
import { gutterKeys, gutterTabStop, nextRovingIndex } from '@/lib/view/gutter-rove'
import { InlineCommentsContext, PatchLines, type InlineComments } from './diff-view'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('next/navigation', () => ({ usePathname: () => '/repo/pull/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined, push: () => undefined }) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LINES: TextDiffLine[] = [
  { kind: 'context', oldLine: 1, newLine: 1, text: 'a' },
  { kind: 'deleted', oldLine: 2, newLine: null, text: 'b' },
  { kind: 'added', oldLine: null, newLine: 2, text: 'B' },
  { kind: 'context', oldLine: 3, newLine: 3, text: 'c' },
]

describe('gutter-rove', () => {
  it('lists the shown line numbers side by side, and skips gaps', () => {
    expect(gutterKeys([...LINES, { kind: 'gap', hidden: 4, from: 4 }])).toEqual(['0:1', '1:1', '0:2', '1:2', '0:3', '1:3'])
  })
  it('keeps the last focused line as the tab stop while it is shown, else the first', () => {
    const keys = gutterKeys(LINES)
    expect(gutterTabStop(keys, null)).toBe('0:1')
    expect(gutterTabStop(keys, '1:2')).toBe('1:2')
    expect(gutterTabStop(keys, '1:99')).toBe('0:1')
    expect(gutterTabStop([], null)).toBeNull()
  })
  it('moves by one with Up/Down, to the ends with Home/End, and ignores other keys', () => {
    expect(nextRovingIndex(3, 0, 'ArrowDown')).toBe(1)
    expect(nextRovingIndex(3, 2, 'ArrowDown')).toBe(2)
    expect(nextRovingIndex(3, 0, 'ArrowUp')).toBe(0)
    expect(nextRovingIndex(3, 1, 'End')).toBe(2)
    expect(nextRovingIndex(3, 2, 'Home')).toBe(0)
    expect(nextRovingIndex(3, 1, 'Enter')).toBeNull()
    expect(nextRovingIndex(3, -1, 'ArrowDown')).toBeNull()
  })
})

describe('PatchLines gutter', () => {
  let root: Root
  let el: HTMLDivElement
  const start = vi.fn()
  const inline: InlineComments = { render: () => null, canComment: true, start, report: () => undefined }

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
    act(() =>
      root.render(
        <InlineCommentsContext.Provider value={inline}>
          <PatchLines path="f.txt" full={LINES} />
        </InlineCommentsContext.Provider>,
      ),
    )
  })
  afterEach(() => {
    act(() => root.unmount())
    el.remove()
    start.mockReset()
  })

  const gutter = (): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('button[data-gutter-side]')]
  const tabbable = (): string[] => gutter().filter((b) => b.tabIndex === 0).map((b) => b.getAttribute('aria-label') ?? '')
  const key = (target: HTMLElement, k: string): void => {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    })
  }

  it('puts one gutter button in the tab order, the first line', () => {
    expect(gutter()).toHaveLength(6)
    expect(tabbable()).toEqual(['Comment on old line 1 of f.txt'])
  })

  it('moves along a side with the arrows, and the tab stop follows focus', () => {
    const first = gutter()[0]!
    act(() => first.focus())
    key(first, 'ArrowDown')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Comment on old line 2 of f.txt')
    expect(tabbable()).toEqual(['Comment on old line 2 of f.txt'])
    key(document.activeElement as HTMLElement, 'End')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Comment on old line 3 of f.txt')
  })

  it('ignores modified arrows (browser shortcuts), and Left on the old side', () => {
    const first = gutter()[0]!
    act(() => first.focus())
    act(() => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    })
    expect(document.activeElement).toBe(first)
    key(first, 'ArrowLeft')
    expect(document.activeElement).toBe(first)
  })

  it('crosses to the other side with Right and back with Left: this row, else the next one below', () => {
    const first = gutter()[0]!
    act(() => first.focus())
    key(first, 'ArrowRight')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Comment on new line 1 of f.txt')
    key(document.activeElement as HTMLElement, 'ArrowLeft')
    expect(document.activeElement).toBe(first)
    // The deleted line has no new-side number: Right goes to the next new line below it.
    const deleted = gutter().find((b) => b.getAttribute('aria-label') === 'Comment on old line 2 of f.txt')!
    act(() => deleted.focus())
    key(deleted, 'ArrowRight')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Comment on new line 2 of f.txt')
  })

  it('still starts a comment on click', () => {
    act(() => gutter()[3]!.click())
    expect(start).toHaveBeenCalledWith('f.txt', 1, 2, false)
  })
})

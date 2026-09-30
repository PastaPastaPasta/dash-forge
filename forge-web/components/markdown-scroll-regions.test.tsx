// @vitest-environment jsdom
/**
 * QW-031: a wide block in a comment scrolls sideways, so a keyboard user must be able to focus it
 * to scroll it (WCAG 2.1.1; axe `scrollable-region-focusable`, serious). Code blocks already did;
 * a review comment's ```suggestion block (a diff in a <pre>) did not: 29-36 of them on one PR.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MarkdownView } from './markdown-view'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
/** jsdom lays nothing out: make every <pre> as wide as this, in a 300 px box. */
let preWidth = 0

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return this.tagName === 'PRE' ? preWidth : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.tagName === 'PRE' ? 300 : 0 } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
})

const SOURCE = 'Try this:\n\n```suggestion\nconst aVeryLongLine = somethingThatDoesNotFitOnAPhone(withArguments, andMore, andEvenMore)\n```\n'

describe('suggestion blocks', () => {
  it('are a focusable, labelled region when they overflow', () => {
    preWidth = 900
    act(() => root.render(<MarkdownView source={SOURCE} suggestion={{ original: ['const old = 1'] }} />))
    const pre = host.querySelector('[data-testid="suggestion"] pre')
    expect(pre).not.toBeNull()
    expect(pre?.getAttribute('tabindex')).toBe('0')
    expect(pre?.getAttribute('role')).toBe('region')
    expect(pre?.getAttribute('aria-label')).toBe('Suggested change')
  })

  it('are no tab stop when they fit', () => {
    preWidth = 200
    act(() => root.render(<MarkdownView source={SOURCE} suggestion={{ original: ['const old = 1'] }} />))
    const pre = host.querySelector('[data-testid="suggestion"] pre')
    expect(pre?.hasAttribute('tabindex')).toBe(false)
  })
})

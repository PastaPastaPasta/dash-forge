// @vitest-environment jsdom
/**
 * QW3-020: a review comment's code in Conversation scrolls sideways on a long line, so a keyboard
 * user must be able to focus it (axe `scrollable-region-focusable`, serious, ×18 on dips #161),
 * and its line numbers must meet contrast in dark mode (anvil-500 was 3.3:1 on the page).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Anchor } from '@/lib/rules/v2'
import { AnchorContext } from './anchor-snippet'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
/** jsdom lays nothing out: the snippet's content is this wide, in a 288 px box (a phone). */
let contentWidth = 0
const isSnippet = (el: HTMLElement): boolean => el.getAttribute('data-testid') === 'conversation-snippet'

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return isSnippet(this) ? contentWidth : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return isSnippet(this) ? 288 : 0 } })
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

const ANCHOR: Anchor = { path: 'dip-0003.md', line: 3, startLine: null, side: 1, commitOid: '' }
const TEXT = 'one\ntwo\n' + 'a very long line '.repeat(30) + '\n'

const render = (): HTMLElement => {
  act(() => root.render(<AnchorContext anchor={ANCHOR} text={TEXT} outdated={false} applied={null} />))
  return host.querySelector('[data-testid="conversation-snippet"]') as HTMLElement
}

describe('a review comment code snippet in Conversation (QW3-020)', () => {
  it('is a focusable, labelled region when a line overflows', () => {
    contentWidth = 4056
    const snippet = render()
    expect(snippet.getAttribute('tabindex')).toBe('0')
    expect(snippet.getAttribute('role')).toBe('region')
    expect(snippet.getAttribute('aria-label')).toBe('Code at dip-0003.md line 3 (new)')
  })

  it('adds no tab stop when it fits', () => {
    contentWidth = 200
    expect(render().hasAttribute('tabindex')).toBe(false)
  })

  it('numbers its lines in the diff gutter colours, not anvil-500 on the dark page', () => {
    contentWidth = 200
    const gutter = render().querySelector('td')!
    expect(gutter.className).toContain('dark:text-anvil-400')
    expect(gutter.className).not.toContain('dark:text-anvil-500')
  })
})

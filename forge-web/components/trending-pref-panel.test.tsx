// @vitest-environment jsdom
/**
 * Settings → Stars: the "Count my stars toward Trending" toggle on a beat-shaped contract (and
 * while the shape is read), and a plain statement with no toggle on a fused-star one (RC2 C1).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StarShape } from '@/lib/repo/star-shape'

let shape: StarShape | null = null
vi.mock('@/hooks/use-star-shape', () => ({ useStarShape: () => shape }))

const { TrendingPrefPanel } = await import('./trending-pref-panel')

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

function render(s: StarShape | null): HTMLElement {
  shape = s
  act(() => root.render(<TrendingPrefPanel />))
  return el.querySelector('[data-testid="trending-pref"]')!
}

describe('TrendingPrefPanel', () => {
  it.each([['beat' as const], [null]])('offers the toggle on a %s-shaped star', (s) => {
    const panel = render(s)
    expect(panel.querySelector('[data-testid="trending-pref-toggle"]')).not.toBeNull()
    expect(panel.textContent).toContain('Count my stars toward Trending')
  })

  it('on a fused star says stars count, with nothing to turn off, and what Trending leaves out', () => {
    const panel = render('fused')
    expect(panel.querySelector('[data-testid="trending-pref-toggle"]')).toBeNull()
    expect(panel.textContent).toContain('Your stars count toward Trending')
    expect(panel.textContent).toContain('nothing to turn off')
    expect(panel.textContent).toContain('leaves out private repos, and your star on a repo of your own while the repo is newer than the window (under a week old for This week)')
  })
})

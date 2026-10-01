// @vitest-environment jsdom
/**
 * QW3-001: while a browse index is read whole, the code page shows the bytes read so far, and
 * says the network is slow once it has waited a while, rather than a bare spinner.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { endIndexProgress, indexProgress, noteIndexProgress } from '@/lib/view/index-progress'
import { BrowseLoading, SLOW_AFTER_MS } from './browse-loading'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.useRealTimers()
  endIndexProgress('repo', 'a')
  endIndexProgress('repo', 'b')
})

const render = (): void => act(() => root.render(<BrowseLoading repoKey="repo" label="Loading browse index" />))

describe('BrowseLoading', () => {
  it('shows the bytes of the index read so far, summed over its fragments', () => {
    render()
    expect(el.textContent).toContain('Loading browse index')
    expect(el.querySelector('[role=progressbar]')).toBeNull()
    act(() => {
      noteIndexProgress('repo', 'a', 3_000_000, 9_650_896)
      noteIndexProgress('repo', 'b', 10_000, 26_620)
    })
    const bar = el.querySelector('[role=progressbar]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('31')
    expect(el.textContent).toContain('Reading the browse index')
    expect(el.textContent).toMatch(/2\.9 MB of 9\.2 MB · 31%/)
    // A fragment read in full leaves the sum; the last one leaves no progress at all.
    act(() => noteIndexProgress('repo', 'b', 26_620, 26_620))
    expect(indexProgress('repo')).toEqual({ fetched: 3_000_000, total: 9_650_896 })
    act(() => endIndexProgress('repo', 'a'))
    expect(indexProgress('repo')).toBeUndefined()
    expect(el.querySelector('[role=progressbar]')).toBeNull()
  })

  it('says the network is slow after a while, and nothing before', () => {
    render()
    act(() => vi.advanceTimersByTime(SLOW_AFTER_MS - 1))
    expect(el.querySelector('[data-testid=browse-loading-slow]')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(el.querySelector('[data-testid=browse-loading-slow]')?.textContent).toContain('the network is slow')
  })
})

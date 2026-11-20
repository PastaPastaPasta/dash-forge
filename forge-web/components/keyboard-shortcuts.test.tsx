// @vitest-environment jsdom
/** `?` lists the shortcuts; on a repo page `g` then a letter follows the header's tab link. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHORD_MS, KeyboardShortcuts } from './keyboard-shortcuts'

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
  document.querySelectorAll('a[data-repo-tab]').forEach((a) => a.remove())
  vi.useRealTimers()
})

const press = (k: string, target: EventTarget = document.body): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

function tab(key: string): { link: HTMLAnchorElement; clicked: () => number } {
  const link = document.createElement('a')
  link.dataset.repoTab = key
  link.href = '#'
  let n = 0
  link.addEventListener('click', (e) => {
    e.preventDefault()
    n++
  })
  document.body.append(link)
  return { link, clicked: () => n }
}

describe('KeyboardShortcuts', () => {
  it('opens the list on ?', () => {
    act(() => root.render(<KeyboardShortcuts />))
    expect(document.querySelector('[data-testid=keyboard-shortcuts]')).toBeNull()
    press('?')
    expect(document.querySelector('[data-testid=keyboard-shortcuts]')?.textContent).toContain('Switch between Write and Preview')
  })

  it('ignores ? typed into a field', () => {
    act(() => root.render(<KeyboardShortcuts />))
    const input = document.createElement('input')
    document.body.append(input)
    press('?', input)
    expect(document.querySelector('[data-testid=keyboard-shortcuts]')).toBeNull()
    input.remove()
  })

  it('follows g i to the Issues tab, within the chord window only', () => {
    const issues = tab('issues')
    act(() => root.render(<KeyboardShortcuts />))
    press('g')
    press('i')
    expect(issues.clicked()).toBe(1)
    press('g')
    act(() => vi.advanceTimersByTime(CHORD_MS + 1))
    press('i')
    expect(issues.clicked()).toBe(1)
  })
})

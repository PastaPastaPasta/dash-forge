// @vitest-environment jsdom
/**
 * The language bar never looks complete when its walk was cut short (a file or tree bound): the
 * partial note shows with languages counted, and also when none were.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LanguageBar } from './repo-facts-card'

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

const RUST = { name: 'Rust', color: '#dea584', bytes: 10, percent: 100 }

describe('LanguageBar', () => {
  it('says a cut-short walk is partial', () => {
    act(() => root.render(<LanguageBar stats={{ languages: [RUST], files: 5000, truncated: true }} />))
    expect(el.querySelector('[data-testid="language-note"]')?.textContent).toContain('based on the first 5,000 files')
  })

  it('says so when a cut-short walk counted no language at all', () => {
    act(() => root.render(<LanguageBar stats={{ languages: [], files: 0, truncated: true }} />))
    expect(el.querySelector('[data-testid="language-note"]')?.textContent).toContain('the walk stopped at its limit')
  })

  it('shows nothing for a complete walk with no language', () => {
    act(() => root.render(<LanguageBar stats={{ languages: [], files: 3, truncated: false }} />))
    expect(el.innerHTML).toBe('')
  })
})

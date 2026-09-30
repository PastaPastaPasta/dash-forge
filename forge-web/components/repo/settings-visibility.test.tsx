// @vitest-environment jsdom
/** QW2-063: repo Settings shows the repo's visibility, read-only (it is set at creation). */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: null, ready: false }) }))

import { VisibilityRow } from './repo-settings-sections'

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

describe('VisibilityRow', () => {
  it('names a public repo’s visibility as permanent', () => {
    act(() => root.render(<VisibilityRow visibility="public" />))
    const row = el.querySelector('[data-testid="settings-visibility"]') as HTMLElement
    expect(row.dataset['visibility']).toBe('public')
    expect(row.textContent).toMatch(/Public\s*· set when the repo was created, and permanent/)
    expect(row.querySelector('input, select, button')).toBeNull()
  })

  it('says what a private repo keeps public, its issue and PR counts included', () => {
    act(() => root.render(<VisibilityRow visibility="private" />))
    const row = el.querySelector('[data-testid="settings-visibility"]') as HTMLElement
    expect(row.textContent).toMatch(/Private/)
    expect(row.textContent).toMatch(/how many issues and pull requests it has are public/)
  })
})

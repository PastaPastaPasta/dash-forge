// @vitest-environment jsdom
/** EmptyState's heading level (QW4-044): an h3 inside a page, the page's h1 when it is the page (a sign-in gate). */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EmptyState } from './states'

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
})

describe('EmptyState heading', () => {
  it('is an h3 by default', () => {
    act(() => root.render(<EmptyState title="No repos yet" />))
    expect(host.querySelector('h3')?.textContent).toBe('No repos yet')
    expect(host.querySelector('h1')).toBeNull()
  })

  it('is the h1 a gate asks for', () => {
    act(() => root.render(<EmptyState heading="h1" title="Sign in to forge a repo" />))
    expect(host.querySelector('h1')?.textContent).toBe('Sign in to forge a repo')
    expect(host.querySelector('h3')).toBeNull()
  })
})

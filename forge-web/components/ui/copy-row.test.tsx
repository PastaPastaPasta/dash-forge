// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CopyRow } from './copy-row'

// The copy button's accessible name never carries the copied text: a caller that copies a
// secret (and forgets a label) must not put it in an attribute.
const TEXT = 'fake-copied-secret-not-real'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('CopyRow', () => {
  it('falls back to a generic label, never the copied text', () => {
    act(() => root.render(<CopyRow text={TEXT} display="••••" />))
    const label = host.querySelector('button')!.getAttribute('aria-label')
    expect(label).toBe('Copy to clipboard')
    expect(host.innerHTML).not.toContain(TEXT)
  })

  it('uses the label it is given', () => {
    act(() => root.render(<CopyRow text="git clone x" label="Copy the clone command" />))
    expect(host.querySelector('button')!.getAttribute('aria-label')).toBe('Copy the clone command')
  })
})

// @vitest-environment jsdom
/** A long commit body starts collapsed, and what is collapsed is not in the page at all. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommitBody, longCommitBody } from './commit-content'
import { repoLinks } from './target-href'

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

const links = repoLinks({ owner: 'o', name: 'r' }, null)
const LONG = ['one', 'two', 'three', 'four', 'see https://example.com/hidden', 'six'].join('\n')

describe('CommitBody', () => {
  it('shows the first 3 lines of a long body, with no link from the rest to tab to, until expanded', () => {
    expect(longCommitBody(LONG)).toBe(true)
    act(() => root.render(<CommitBody body={LONG} links={links} />))
    const body = host.querySelector('[data-testid="commit-body"]') as HTMLElement
    const toggle = host.querySelector('[data-testid="commit-body-toggle"]') as HTMLButtonElement
    expect(body.textContent).toBe('one\ntwo\nthree')
    expect(body.querySelector('a')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    act(() => toggle.click())
    expect(body.textContent).toContain('six')
    expect(body.querySelector('a')?.getAttribute('href')).toBe('https://example.com/hidden')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('Show less')
  })

  it('shows a short body whole, with no toggle', () => {
    act(() => root.render(<CommitBody body={'one\ntwo'} links={links} />))
    expect(host.querySelector('[data-testid="commit-body"]')?.textContent).toBe('one\ntwo')
    expect(host.querySelector('[data-testid="commit-body-toggle"]')).toBeNull()
  })
})

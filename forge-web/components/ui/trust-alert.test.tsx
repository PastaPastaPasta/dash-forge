// @vitest-environment jsdom
/**
 * A failed verification leads the page (QW-004): a quorum-key mismatch heads every page with a
 * banner and withholds the content until the reader asks for it, then frames it as unverified.
 * The page stays mounted throughout (no remount when the result lands), and a check that did
 * not fail changes nothing.
 */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { QuorumCrossCheck } from '@/lib/view'

let quorum: QuorumCrossCheck | undefined
let connection: 'trusted' | 'offline' | 'connecting' = 'trusted'
vi.mock('@/hooks/use-sdk', () => ({ useConnectionTrust: () => ({ network: 'testnet', connection }) }))
vi.mock('@/hooks/use-quorum-check', () => ({ useQuorumCheck: () => quorum }))
let view = '/repo/blob/?path=dip-0001.md'
vi.mock('@/hooks/use-trust-view', () => ({ useTrustView: () => view }))

const { TrustAnchorGate } = await import('./trust-alert')

const MISMATCH: QuorumCrossCheck = {
  state: 'mismatch',
  primary: 'quorums.testnet.networks.dash.org',
  secondary: '68.67.122.228:1443',
  quorums: ['5e5397c17bb1'.padEnd(64, '0')],
}
const AGREED: QuorumCrossCheck = { state: 'agreed', primary: 'q', secondary: 'd', overlap: 4 }

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  quorum = AGREED
  connection = 'trusted'
  view = '/repo/blob/?path=dip-0001.md'
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

/** A page body with state of its own, to catch a remount. */
function Page(): JSX.Element {
  const [typed, setTyped] = useState('')
  return (
    <div data-testid="page">
      <p>dip-0001.md</p>
      <input data-testid="draft" value={typed} onChange={(e) => setTyped(e.target.value)} />
    </div>
  )
}

function render(): void {
  act(() =>
    root.render(
      <TrustAnchorGate>
        <Page />
      </TrustAnchorGate>,
    ),
  )
}

const banner = (): HTMLElement | null => el.querySelector('[data-testid="trust-anchor-failed"]')
const page = (): HTMLElement => el.querySelector('[data-testid="page"]')!
/** Hidden by the gate: the page's wrapper, or any ancestor, carries `hidden`. */
const pageHidden = (): boolean => page().closest('[hidden]') !== null
const button = (): HTMLButtonElement => banner()!.querySelector('button')!

describe('TrustAnchorGate', () => {
  it('passes the page through untouched when the keys agree', () => {
    render()
    expect(banner()).toBeNull()
    expect(pageHidden()).toBe(false)
    expect(el.textContent).not.toMatch(/Unverified|Verification failed/)
  })

  it('on a key mismatch: a banner first, in the card words, and the page withheld', () => {
    quorum = MISMATCH
    render()
    const b = banner()!
    expect(b).not.toBeNull()
    // First in the document, before the page: at the top of the viewport on any width.
    expect(el.firstElementChild).toBe(b)
    expect(b.querySelector('[role="alert"]')!.textContent).toMatch(/^Verification failed/)
    expect(b.textContent).toContain('Chain data: Failed.')
    expect(b.textContent).toContain('Do not rely on this page.')
    expect(b.textContent).toContain('68.67.122.228:1443')
    expect(pageHidden()).toBe(true)
    expect(button().textContent).toBe('Show it anyway, unverified')
    expect(button().getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the page only on request, framed as unverified, and can hide it again', () => {
    quorum = MISMATCH
    render()
    act(() => button().click())
    expect(pageHidden()).toBe(false)
    const frame = el.querySelector('[data-testid="trust-withheld"]')!
    expect(frame.contains(page())).toBe(true)
    expect(frame.textContent?.trim()).toMatch(/^Unverified/)
    expect(banner()!.textContent).toMatch(/Shown on your request, unverified/)
    expect(button().textContent).toBe('Hide the page')
    act(() => button().click())
    expect(pageHidden()).toBe(true)
  })

  it('withholds the next view again: a page shown on request does not carry over', () => {
    quorum = MISMATCH
    render()
    act(() => button().click())
    expect(pageHidden()).toBe(false)
    // Another file on the same route: the shell stays mounted, the query changes.
    view = '/repo/blob/?path=dip-0002.md'
    render()
    expect(pageHidden()).toBe(true)
    expect(button().textContent).toBe('Show it anyway, unverified')
  })

  it('stays failed while Platform is unreachable', () => {
    quorum = MISMATCH
    connection = 'offline'
    render()
    expect(banner()).not.toBeNull()
    expect(pageHidden()).toBe(true)
  })

  it('does not remount the page when the mismatch lands after it rendered', () => {
    render()
    const input = el.querySelector<HTMLInputElement>('[data-testid="draft"]')!
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'half a comment')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    quorum = MISMATCH
    render()
    expect(banner()).not.toBeNull()
    // The same element, with its state: kept mounted while hidden.
    expect(el.querySelector('[data-testid="draft"]')).toBe(input)
    expect(input.value).toBe('half a comment')
  })
})

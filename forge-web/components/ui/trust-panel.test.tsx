// @vitest-environment jsdom
/**
 * The Verification card's disclosure row (FEAT-08): a private or members-only repo says what is
 * encrypted and what an outsider still sees; an open repo has no such row.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deriveTrust, NO_CONTENT_CHECKS, type TrustInputs } from '@/lib/view'

vi.mock('@/components/author', () => ({ Author: () => null }))

const { TrustPanel } = await import('./trust-panel')

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

function show(over: Partial<TrustInputs>): void {
  const report = deriveTrust({ network: 'testnet', connection: 'trusted', tip: 'missing', checks: NO_CONTENT_CHECKS, configuredBackend: 'platform', deployed: true, ...over })
  act(() => root.render(<TrustPanel report={report} />))
  act(() => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
}

describe('TrustPanel privacy row', () => {
  it('is absent for a repo that seals nothing', () => {
    show({})
    expect(host.querySelector('[data-testid="trust-privacy"]')).toBeNull()
  })

  it('names what a private repo encrypts and what stays visible', () => {
    show({ sealed: 'private' })
    const row = host.querySelector('[data-testid="trust-privacy"]')!
    expect(row.getAttribute('data-kind')).toBe('private')
    expect(row.textContent).toContain('Private content')
    expect(row.textContent).toContain('encrypted for its members')
    expect(row.textContent).toContain('Sizes and timing are visible')
  })

  it('names the members-only content of a public repo', () => {
    show({ sealed: 'members-only' })
    expect(host.querySelector('[data-testid="trust-privacy"]')!.textContent).toContain('Members-only content')
  })

  it('shows the not-deployed state', () => {
    show({ deployed: false })
    expect(host.querySelector('[data-testid="trust-privacy"]')!.textContent).toContain('Not deployed')
  })
})

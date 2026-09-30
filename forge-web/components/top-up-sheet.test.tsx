// @vitest-environment jsdom
/**
 * The top-up sheet (QA wave bonsia):
 * - QW-047: opened ahead of any write (the banner, the pill, Settings) it describes the funds as
 *   they stand; only a write that did not fit says "does not cover this write";
 * - QW-012: the balance fix is a top-up from this browser (a deposit address), not only an
 *   identity id to copy;
 * - QW-048: the pill always opens it, with this key's budget and expiry spelled out.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '@/hooks/use-ui-store'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const EXPIRES = Date.UTC(2026, 11, 29)

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: ID,
    storage: 'vault',
    balance: String(19_312_430_240),
    keyLimits: { remaining: 4_000_000_000n, total: 5_000_000_000n, expiresAt: EXPIRES },
    // fundsState's: the balance (0.19 DASH) is above the key's 0.04 left, so the key caps it.
    funds: { level: 'comfortable', reason: null, spendable: 4_000_000_000n },
    refreshBalance: async () => undefined,
  }),
}))
// The flow itself is covered in lib/auth/identity-top-up.test.ts.
vi.mock('@/components/identity-top-up-flow', () => ({
  IdentityTopUpFlow: ({ faucet }: { faucet: string | null }) => <div data-testid="identity-top-up" data-faucet={faucet ?? ''} />,
}))

const { TopUpSheet } = await import('./top-up-sheet')
const { FundsPill } = await import('./funds-pill')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const q = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel)

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<><FundsPill /><TopUpSheet /></>))
})
afterEach(() => {
  act(() => useUiStore.getState().closeTopUp())
  act(() => root.unmount())
  host.remove()
})

describe('the top-up sheet', () => {
  it('opened ahead of a write: the balance as it stands, never "does not cover this write" (QW-047)', () => {
    act(() => useUiStore.getState().openTopUp())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/Your identity's balance is 0\.193124 DASH/)
    expect(text).not.toMatch(/does not cover this write/)
    expect(q('[data-testid="identity-top-up"]')).not.toBeNull()
  })

  it('after a write that did not fit: says so, with the shortfall', () => {
    act(() => useUiStore.getState().openTopUp({ blocker: 'balance', shortfall: 100_000_000n }))
    expect(document.body.textContent).toMatch(/does not cover this write \(short by 0\.001 DASH\)/)
  })

  it('an expiring (not yet expired) key is described as expiring', () => {
    act(() => useUiStore.getState().openTopUp({ blocker: 'key-expiry', proactive: true }))
    expect(document.body.textContent).toMatch(/expires on/)
    expect(document.body.textContent).not.toMatch(/has expired/)
  })

  it('the pill opens it even when funds are comfortable, with the key spelled out (QW-048)', () => {
    act(() => q('[data-testid="funds-pill"]')!.click())
    expect(useUiStore.getState().topUp).toEqual({ blocker: 'balance', proactive: true })
    expect(q('[data-testid="key-funds-line"]')!.textContent).toMatch(/0\.04 of 0\.05 DASH budget left, expires/)
    // The balance does not cap a key with less left than it (QW2-035).
    expect(q('[data-testid="key-funds-line"]')!.textContent).not.toMatch(/capped/)
    expect(q('[data-testid="top-up-coverage"]')!.textContent).toMatch(/covers about \d+\.$/)
  })
})

// @vitest-environment jsdom
/**
 * On mainnet no normal flow asks for the recovery phrase: the top-up sheet leads with DashPay (a
 * balance) or the wallet (a key), and every master-key action sits behind one closed disclosure.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '@/hooks/use-ui-store'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const session = vi.hoisted(() => ({ origin: null as 'app-connect' | null, refreshed: 0 }))

vi.mock('@/lib/constants', async (orig) => {
  const real = await orig<typeof import('@/lib/constants')>()
  return { ...real, ACTIVE_NETWORK: { ...real.ACTIVE_NETWORK, network: 'mainnet' } }
})
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: ID,
    storage: 'vault',
    origin: session.origin,
    balance: String(19_312_430_240),
    keyLimits: { remaining: 4_000_000_000n, total: 5_000_000_000n, expiresAt: Date.UTC(2027, 0, 1) },
    funds: { level: 'comfortable', reason: null, spendable: 4_000_000_000n },
    refreshBalance: async () => {
      session.refreshed++
    },
  }),
}))
vi.mock('@/components/identity-top-up-flow', () => ({ IdentityTopUpFlow: () => <div data-testid="identity-top-up" /> }))

const { TopUpSheet } = await import('./top-up-sheet')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const q = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel)
const closedDisclosure = (testId: string): boolean => (q(`[data-testid="${testId}"]`) as HTMLDetailsElement | null)?.open === false

beforeEach(() => {
  session.origin = null
  session.refreshed = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<TopUpSheet />))
})
afterEach(() => {
  act(() => useUiStore.getState().closeTopUp())
  act(() => root.unmount())
  host.remove()
})

describe('the top-up sheet on mainnet', () => {
  it('a low balance: buy credits in DashPay and check again; the phrase top-up is collapsed', async () => {
    act(() => useUiStore.getState().openTopUp())
    expect(q('[data-testid="top-up-in-dashpay"]')!.textContent).toMatch(/DashPay/)
    await act(async () => q('[data-testid="top-up-check-again"]')!.click())
    expect(session.refreshed).toBe(1)
    expect(closedDisclosure('top-up-other-ways')).toBe(true)
    expect(q('[data-testid="top-up-phrase"] [data-testid="identity-top-up"]')).not.toBeNull()
  })

  it("a wallet's key: Renew in your wallet leads; top-up and the identity file are collapsed", () => {
    session.origin = 'app-connect'
    act(() => root.render(<TopUpSheet />))
    act(() => useUiStore.getState().openTopUp({ blocker: 'key-budget' }))
    expect(q('[data-testid="renew-in-wallet"]')).not.toBeNull()
    expect(closedDisclosure('top-up-master-actions')).toBe(true)
  })

  it('any other key: signing in again with the wallet leads, never the phrase', () => {
    act(() => useUiStore.getState().openTopUp({ blocker: 'key-expiry' }))
    act(() => q('[data-testid="sign-in-with-wallet"]')!.click())
    expect(useUiStore.getState().loginView).toBe('wallet')
    expect(useUiStore.getState().topUp).toBeNull()
  })
})

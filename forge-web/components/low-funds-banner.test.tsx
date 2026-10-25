// @vitest-environment jsdom
/**
 * The low-funds banner sends a key a wallet granted (App Connect) to be renewed in that wallet;
 * every other key keeps "Renew key" (the identity file).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '@/hooks/use-ui-store'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const session = vi.hoisted(() => ({ origin: null as 'app-connect' | null, reason: 'key-expiry' as 'key-expiry' | 'key-budget' | 'balance', level: 'low' as 'low' | 'empty' }))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: ID,
    origin: session.origin,
    funds: { level: session.level, reason: session.reason, spendable: 1_000_000_000n },
  }),
}))

const { LowFundsBanner } = await import('./low-funds-banner')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const main = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('[data-testid="low-funds-banner"] button')!

async function show(): Promise<void> {
  act(() => root.render(<LowFundsBanner />))
  await act(async () => Promise.resolve())
}

beforeEach(() => {
  session.origin = null
  session.reason = 'key-expiry'
  session.level = 'low'
  sessionStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => useUiStore.getState().closeLogin())
  act(() => root.unmount())
  host.remove()
})

describe('the low-funds banner', () => {
  it("renews a wallet-granted key in the wallet", async () => {
    session.origin = 'app-connect'
    await show()
    expect(main().textContent).toBe('Renew in your wallet')
    act(() => main().click())
    expect(useUiStore.getState().loginView).toBe('wallet-renew')
  })

  it('also for an empty budget', async () => {
    session.origin = 'app-connect'
    session.reason = 'key-budget'
    session.level = 'empty'
    await show()
    expect(main().textContent).toBe('Renew in your wallet')
  })

  it('keeps "Renew key" and the identity file for a key this browser registered', async () => {
    await show()
    expect(main().textContent).toBe('Renew key')
    act(() => main().click())
    expect(useUiStore.getState().loginView).toBe('import')
  })

  it('a low balance is still a top-up, whatever the key came from', async () => {
    session.origin = 'app-connect'
    session.reason = 'balance'
    await show()
    expect(main().textContent).toBe('Top up')
  })
})

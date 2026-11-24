// @vitest-environment jsdom
/** On mainnet the low-funds banner never sends a key to the recovery phrase: the wallet replaces it. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useUiStore } from '@/hooks/use-ui-store'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const session = vi.hoisted(() => ({ origin: null as 'passkey' | null }))

vi.mock('@/lib/constants', async (orig) => {
  const real = await orig<typeof import('@/lib/constants')>()
  return { ...real, ACTIVE_NETWORK: { ...real.ACTIVE_NETWORK, network: 'mainnet' } }
})
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ identity: ID, origin: session.origin, funds: { level: 'low', reason: 'key-expiry', spendable: 1_000_000_000n } }),
}))

const { LowFundsBanner } = await import('./low-funds-banner')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  session.origin = null
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

async function show(): Promise<HTMLButtonElement[]> {
  act(() => root.render(<LowFundsBanner />))
  await act(async () => Promise.resolve())
  return [...host.querySelectorAll<HTMLButtonElement>('[data-testid="low-funds-banner"] button')].filter((b) => b.getAttribute('aria-label') === null)
}

it('a key Forge registered is replaced by signing in again with the wallet', async () => {
  const [main, ...rest] = await show()
  expect(main!.textContent).toBe('Sign in again with your wallet')
  expect(rest).toHaveLength(0)
  act(() => main!.click())
  expect(useUiStore.getState().loginView).toBe('wallet')
})

it('a key a passkey restored renews in the wallet, with no identity-file button', async () => {
  session.origin = 'passkey'
  const buttons = await show()
  expect(buttons.map((b) => b.textContent)).toEqual(['Renew in your wallet'])
})

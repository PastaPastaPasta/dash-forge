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
import { FIAT_RATES_KEY, FIAT_SETTINGS_KEY } from '@/lib/fiat/store'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const EXPIRES = Date.UTC(2026, 11, 29)

/** Where the signed-in key came from: `app-connect` for a wallet's grant. */
const session = vi.hoisted(() => ({ origin: null as 'app-connect' | 'passkey' | null }))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: ID,
    storage: 'vault',
    origin: session.origin,
    balance: String(19_312_430_240),
    keyLimits: { remaining: 4_000_000_000n, total: 5_000_000_000n, expiresAt: EXPIRES },
    // fundsState's: the balance (0.19 DASH) is above the key's 0.04 left, so the key caps it.
    funds: { level: 'comfortable', reason: null, spendable: 4_000_000_000n },
    refreshBalance: async () => undefined,
  }),
}))
// The flow itself is covered in lib/auth/identity-top-up.test.ts.
vi.mock('@/components/identity-top-up-flow', () => ({
  IdentityTopUpFlow: ({ faucets }: { faucets: readonly string[] }) => <div data-testid="identity-top-up" data-faucet={faucets.join(' ')} />,
}))

const { TopUpSheet, faucetUrl } = await import('./top-up-sheet')
const { FaucetLinks } = await import('./faucet-links')
const { FundsPill } = await import('./funds-pill')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const q = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel)

beforeEach(() => {
  session.origin = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<><FundsPill /><TopUpSheet /></>))
})
afterEach(() => {
  act(() => useUiStore.getState().closeTopUp())
  act(() => root.unmount())
  host.remove()
  localStorage.removeItem(FIAT_RATES_KEY)
  localStorage.removeItem(FIAT_SETTINGS_KEY)
  window.dispatchEvent(new StorageEvent('storage', { key: FIAT_RATES_KEY }))
  window.dispatchEvent(new StorageEvent('storage', { key: FIAT_SETTINGS_KEY }))
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
    expect(q('[data-testid="key-funds-line"]')!.textContent).toMatch(/0\.04 DASH of 0\.05 DASH budget left, expires/)
    // The balance does not cap a key with less left than it (QW2-035).
    expect(q('[data-testid="key-funds-line"]')!.textContent).not.toMatch(/capped/)
    expect(q('[data-testid="top-up-coverage"]')!.textContent).toMatch(/covers about \d+\.$/)
  })

  it('puts fiat beside the issue price before describing how many issues the funds cover', () => {
    localStorage.setItem(FIAT_RATES_KEY, JSON.stringify({ v: 1, source: 'ctx', fetchedAt: Date.now(), rates: { USD: 40 } }))
    localStorage.setItem(FIAT_SETTINGS_KEY, JSON.stringify({ v: 1, enabled: true, currency: 'USD' }))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: FIAT_RATES_KEY }))
      window.dispatchEvent(new StorageEvent('storage', { key: FIAT_SETTINGS_KEY }))
      useUiStore.getState().openTopUp()
    })
    const text = q('[data-testid="top-up-coverage"]')!.textContent
    expect(text).toMatch(/^About [\d.]+ DASH \(≈ \$0\.05(?: on mainnet)?\) covers an issue; what you can spend now covers about \d+\.$/)
    const budget = q('[data-testid="key-funds-line"]')!
    expect(budget.querySelectorAll('[data-testid="fiat-note"]')).toHaveLength(1)
    expect(budget.textContent).toContain('0.04 DASH (≈ $1.60')
  })

  // The test build reads the default network, testnet: its faucets show without NEXT_PUBLIC_FORGE_DEV (WEB-05).
  it('a testnet build offers both testnet faucets, the official one first (WEB-05, OD-12)', () => {
    expect(faucetUrl()).toBe('https://faucet.testnet.networks.dash.org')
    act(() => useUiStore.getState().openTopUp())
    expect(q('[data-testid="identity-top-up"]')!.dataset['faucet']).toBe(
      'https://faucet.testnet.networks.dash.org https://faucet.thepasta.org',
    )
  })
})

describe('FaucetLinks', () => {
  it('links the first faucet as the main link and the others as "or <host>"', () => {
    act(() => root.render(<FaucetLinks urls={['https://faucet.testnet.networks.dash.org', 'https://faucet.thepasta.org']} suffix=" (paste the address above)" />))
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="faucet-links"] a')]
    expect(links.map((a) => a.href)).toEqual(['https://faucet.testnet.networks.dash.org/', 'https://faucet.thepasta.org/'])
    expect(links[0]!.textContent).toBe('Get test DASH from the testnet faucet')
    expect(q('[data-testid="faucet-links"]')!.textContent).toBe(
      'Get test DASH from the testnet faucet (paste the address above) or faucet.thepasta.org',
    )
  })

  it('renders nothing when the network has no faucet (mainnet)', () => {
    act(() => root.render(<FaucetLinks urls={[]} />))
    expect(q('[data-testid="faucet-links"]')).toBeNull()
  })
})

describe('the top-up sheet for a key a wallet granted (App Connect)', () => {
  const byText = (text: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text) ?? null
  const open = (blocker: 'key-expiry' | 'key-budget'): void => {
    session.origin = 'app-connect'
    act(() => root.render(<><FundsPill /><TopUpSheet /></>))
    act(() => useUiStore.getState().openTopUp({ blocker }))
  }

  it('renews in the wallet first, and keeps the identity file as the other way', () => {
    open('key-expiry')
    expect(byText('Renew in your wallet')).not.toBeNull()
    expect(byText('Renew with identity file')).not.toBeNull()
    expect(byText('Renew key')).toBeNull()
    act(() => byText('Renew in your wallet')!.click())
    expect(useUiStore.getState().loginView).toBe('wallet-renew')
    expect(useUiStore.getState().topUp).toBeNull()
  })

  it('the identity file still opens the import renewal', () => {
    open('key-expiry')
    act(() => byText('Renew with identity file')!.click())
    expect(useUiStore.getState().loginView).toBe('import')
  })

  it('a spent budget offers the wallet, the master-key top-up and the identity file', () => {
    open('key-budget')
    expect(byText('Renew in your wallet')).not.toBeNull()
    expect(byText('Top up key')).not.toBeNull()
    expect(byText('Renew with identity file')).not.toBeNull()
  })

  it('a key this browser registered itself is renewed as before', () => {
    act(() => useUiStore.getState().openTopUp({ blocker: 'key-expiry' }))
    expect(byText('Renew key')).not.toBeNull()
    expect(byText('Renew in your wallet')).toBeNull()
  })
})

describe('the top-up sheet for a key a passkey restored (unknown origin)', () => {
  const byText = (text: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text) ?? null

  it('offers the wallet and the identity file side by side, and says why', () => {
    session.origin = 'passkey'
    act(() => root.render(<><FundsPill /><TopUpSheet /></>))
    act(() => useUiStore.getState().openTopUp({ blocker: 'key-expiry' }))
    expect(document.querySelector('[data-testid="top-up-sheet"]')!.textContent).toMatch(/passkey brought this key here, so Forge can't tell who made it/)
    expect(byText('Renew in your wallet')).not.toBeNull()
    expect(byText('Renew with identity file')).not.toBeNull()
    expect(byText('Renew key')).toBeNull()
    act(() => byText('Renew in your wallet')!.click())
    expect(useUiStore.getState().loginView).toBe('wallet-renew')
  })
})

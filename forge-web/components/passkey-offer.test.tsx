// @vitest-environment jsdom
/**
 * The one-time passkey offer under the header: shown once after an interactive sign-in or unlock,
 * only where a passkey could hold this key, never again after "Not now" or once a passkey exists
 * here, and not at all for a reloaded tab.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ACTIVE_NETWORK } from '@/lib/constants'
import { putMarker } from '@/lib/auth/passkey-vault/markers'
import { resetMemoryStores } from '@/lib/idb'
import { MAX_OFFERS } from '@/lib/auth/passkey-vault/offer'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const session = vi.hoisted(() => ({
  problem: null as string | null,
  scope: 'full' as 'full' | 'signing' | null,
  storage: 'vault' as 'vault' | 'session' | null,
  unlimited: false,
  keyLimits: { remaining: 4n, total: 5n, expiresAt: Date.now() + 86_400_000 } as { remaining: bigint; total: bigint; expiresAt: number | null } | null,
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: ID,
    storage: session.storage,
    unlockScope: session.scope,
    platformPasskeyProblem: session.problem,
    unlimitedKey: session.unlimited,
    unboundedKey: false,
    keyLimits: session.keyLimits,
  }),
}))

const { PasskeyOffer } = await import('./passkey-offer')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const offer = (): HTMLElement | null => host.querySelector('[data-testid="passkey-offer"]')
async function mount(): Promise<void> {
  await act(async () => root.render(<PasskeyOffer />))
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}
/** A new page load: the component mounts again (its once-per-load memory is gone). */
async function reload(): Promise<void> {
  act(() => root.unmount())
  root = createRoot(host)
  await mount()
}

beforeEach(() => {
  resetMemoryStores()
  localStorage.clear()
  session.problem = null
  session.scope = 'full'
  session.storage = 'vault'
  session.unlimited = false
  session.keyLimits = { remaining: 4n, total: 5n, expiresAt: Date.now() + 86_400_000 }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('the passkey offer', () => {
  it('shows after an interactive sign-in, and says what a passkey is not', async () => {
    await mount()
    expect(offer()!.textContent).toMatch(/Sign in on your other devices with a passkey/)
    expect(offer()!.textContent).toMatch(/It doesn't recover an account/)
    expect(host.querySelector('[data-testid="passkey-offer-setup"]')!.getAttribute('href')).toMatch(/^\/settings\/keys\/?#passkeys$/)
  })

  it.each([
    ['passkeys are hidden here', () => (session.problem = 'Checking whether passkeys work on this page.')],
    ['the tab was reloaded (it holds only the signing key)', () => (session.scope = 'signing')],
    ['the key is a pasted one', () => (session.storage = 'session')],
    ['the key has no limits', () => (session.unlimited = true)],
    ['the key has no budget', () => (session.keyLimits = null)],
    ['the key never expires', () => (session.keyLimits = { remaining: 4n, total: 5n, expiresAt: null })],
  ])('does not show when %s', async (_why, change) => {
    change()
    await mount()
    expect(offer()).toBeNull()
  })

  it('"Not now" ends it for good', async () => {
    await mount()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="passkey-offer-dismiss"]')!.click())
    expect(offer()).toBeNull()
    await reload()
    expect(offer()).toBeNull()
  })

  it('"Set up a passkey" ends it too: Settings has the rest', async () => {
    await mount()
    // No page loads in jsdom: the click is handled by the app, the navigation is not carried out.
    const stop = (e: Event): void => e.preventDefault()
    document.addEventListener('click', stop)
    await act(async () => host.querySelector<HTMLAnchorElement>('[data-testid="passkey-offer-setup"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    document.removeEventListener('click', stop)
    await reload()
    expect(offer()).toBeNull()
  })

  it('is made at most twice when ignored, once per page load', async () => {
    for (let i = 0; i < MAX_OFFERS; i++) {
      await reload()
      expect(offer()).not.toBeNull()
    }
    await reload()
    expect(offer()).toBeNull()
  })

  it('is not made where a passkey already exists on this device', async () => {
    await putMarker(ACTIVE_NETWORK.network, ID, { credentialId: new Uint8Array(16).fill(1), recipientKey: new Uint8Array(32).fill(2), keyIds: [5], addedAt: 1 })
    await mount()
    expect(offer()).toBeNull()
    session.scope = 'full'
    await reload()
    expect(offer()).toBeNull()
  })
})

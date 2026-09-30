// @vitest-environment jsdom
/**
 * Wallet sign-in over an unfinished renewal whose key is locked: the renewal's passphrase input is
 * uncontrolled, so the typed passphrase never lands in the DOM's `value` attribute.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingRenewalChoiceError, PendingRenewalLockedError } from '@/lib/auth/controller'

const { ID, FORGE } = vi.hoisted(() => ({
  ID: '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD',
  FORGE: { core: 'CoreContract111', collab: 'CollabContract111', community: 'CommunityContract111', group: 'Group111' },
}))
const FAKE_VAULT_PASSPHRASE = 'fake-vault-passphrase-000'
const FAKE_RENEWAL_PASSPHRASE = 'fake-renewal-passphrase-789'
const adoptWalletKeys = vi.fn()

vi.mock('@/lib/constants', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/constants')>()
  return { ...m, ACTIVE_NETWORK: { ...m.ACTIVE_NETWORK, v2: FORGE } }
})
vi.mock('@/lib/auth/connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/connect')>()),
  connectPlatform: async () => ({}),
  withPlatformRead: <T,>(p: Promise<T>) => p,
}))
vi.mock('@/lib/auth/app-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/app-connect')>()),
  responseSources: async () => [{}],
  newLoginRequest: () => ({ uri: 'dash-key:fake', expiresAt: Date.now() + 60_000 }),
  awaitWalletAnswer: async () => ({ kind: 'keys', identityId: ID, keys: [{ scope: {}, limits: {} }] }),
}))
vi.mock('@/lib/auth/key-registration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/key-registration')>()),
  isUnlimited: () => false,
}))
vi.mock('@/lib/auth/responder-profile', () => ({
  responderProfile: async () => ({ identityId: ID, name: null, namedAt: null, warnings: [] }),
}))
vi.mock('@/components/ui/qr', () => ({ Qr: () => null }))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ adoptWalletKeys, addWalletGrant: vi.fn(), identity: null, isLoading: false, vaults: [], unlockScope: null }),
}))

const { WalletConnectFlow } = await import('./wallet-connect-flow')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function type(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function byText(text: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!
}
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => Promise.resolve())
}

beforeEach(() => {
  adoptWalletKeys.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('WalletConnectFlow: a locked unfinished renewal', () => {
  it('keeps the renewal passphrase out of the DOM and passes it on', async () => {
    adoptWalletKeys
      .mockRejectedValueOnce(new PendingRenewalChoiceError(7))
      .mockRejectedValueOnce(new PendingRenewalLockedError(7, ['passphrase'], false))
      .mockResolvedValueOnce(undefined)
    const onDone = vi.fn()
    act(() => root.render(<WalletConnectFlow onDone={onDone} />))
    await flush()
    expect(host.querySelector('[data-testid="wallet-confirm"]')).not.toBeNull()
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    act(() => type(host.querySelector<HTMLInputElement>('#vault-passphrase')!, FAKE_VAULT_PASSPHRASE))
    act(() => type(host.querySelector<HTMLInputElement>('#vault-passphrase-2')!, FAKE_VAULT_PASSPHRASE))
    await act(async () => byText('Finish signing in').click())
    await act(async () => byText('Continue with the wallet').click())

    const input = host.querySelector<HTMLInputElement>('#renewal-passphrase')!
    expect(byText('Keep its key and continue').disabled).toBe(true)
    act(() => type(input, FAKE_RENEWAL_PASSPHRASE))
    expect(input.getAttribute('value') ?? '').not.toContain(FAKE_RENEWAL_PASSPHRASE)
    expect(document.body.innerHTML).not.toContain(FAKE_RENEWAL_PASSPHRASE)
    expect(byText('Keep its key and continue').disabled).toBe(false)
    await act(async () => byText('Keep its key and continue').click())
    expect(adoptWalletKeys).toHaveBeenLastCalledWith(ID, expect.anything(), expect.anything(), {
      discardPendingRenewal: true,
      renewalUnlock: { passphrase: FAKE_RENEWAL_PASSPHRASE },
    })
    expect(onDone).toHaveBeenCalled()
  })
})

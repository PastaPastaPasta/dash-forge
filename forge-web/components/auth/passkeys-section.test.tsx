// @vitest-environment jsdom
/**
 * Settings → Devices & keys → Passkeys: hidden unless passkeys are offered here and the key is
 * kept in this browser; lists the identity's passkeys (this device or another, the key each holds
 * and its state); adds one (the encryption key off by default, with the warning that it cannot be
 * taken back); updates, removes (confirm first), finishes ("Check again") and discards one; says
 * which keys stay on this device only; and asks a resumed tab to unlock before carrying on.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UnlockNeededError } from '@/lib/auth/controller'
import { PlatformPasskeyError, type PlatformPasskeyRow } from '@/lib/auth/passkey-vault/service'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'

const row = (id: string, o: Partial<PlatformPasskeyRow> = {}): PlatformPasskeyRow => ({
  id,
  addedAt: Date.UTC(2026, 9, 1),
  updatedAt: Date.UTC(2026, 9, 1),
  thisDevice: false,
  keyId: 5,
  keyState: 'live',
  current: true,
  needsUpdate: false,
  encryptionKey: false,
  ...o,
})

const auth = {
  problem: null as string | null,
  storage: 'vault' as 'vault' | 'session',
  holdsEncryption: false,
  rows: [] as PlatformPasskeyRow[],
  pending: null as { id: string } | null,
  leftOut: 0,
  listPlatformPasskeys: async (): Promise<PlatformPasskeyRow[]> => auth.rows,
  pendingPlatformPasskey: async () => auth.pending,
  platformPasskeyLeftOut: async () => auth.leftOut,
  addPlatformPasskey: vi.fn(async (_o?: unknown): Promise<void> => undefined),
  finishPlatformPasskey: vi.fn(async (): Promise<void> => undefined),
  abandonPlatformPasskey: vi.fn(async (): Promise<void> => undefined),
  removePlatformPasskey: vi.fn(async (_id: string): Promise<void> => undefined),
  resealPlatformPasskeys: vi.fn(async (_o?: unknown) => ({ resealed: 1, needUpdate: 0 })),
  unlockMore: vi.fn(async (_m: unknown): Promise<void> => undefined),
}

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: ID,
    storage: auth.storage,
    platformPasskeyProblem: auth.problem,
    isLoading: false,
    unlockScope: 'full',
    locked: false,
    vaults: [{ identityId: ID, keyId: 5, createdAt: 0, methods: ['passphrase'], ...(auth.holdsEncryption ? { encryptionKey: true } : {}) }],
    listPlatformPasskeys: auth.listPlatformPasskeys,
    pendingPlatformPasskey: auth.pendingPlatformPasskey,
    platformPasskeyLeftOut: auth.platformPasskeyLeftOut,
    addPlatformPasskey: auth.addPlatformPasskey,
    finishPlatformPasskey: auth.finishPlatformPasskey,
    abandonPlatformPasskey: auth.abandonPlatformPasskey,
    removePlatformPasskey: auth.removePlatformPasskey,
    resealPlatformPasskeys: auth.resealPlatformPasskeys,
    controller: { unlockMore: auth.unlockMore },
  }),
}))

const { PasskeysSection } = await import('./passkeys-section')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel)
const buttonIn = (scope: ParentNode, text: RegExp): HTMLButtonElement => [...scope.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}
async function render(): Promise<void> {
  await act(async () => root.render(<PasskeysSection />))
  await settle()
}
async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull()
  await act(async () => (el as HTMLElement).click())
  await settle()
}

beforeEach(() => {
  auth.problem = null
  auth.storage = 'vault'
  auth.holdsEncryption = false
  auth.rows = []
  auth.pending = null
  auth.leftOut = 0
  for (const f of [auth.addPlatformPasskey, auth.finishPlatformPasskey, auth.abandonPlatformPasskey, auth.removePlatformPasskey, auth.resealPlatformPasskeys, auth.unlockMore]) f.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('the passkeys section', () => {
  it('is hidden while passkeys are not offered, and for a key that is not kept in this browser', async () => {
    auth.problem = "Passkeys that work on your other devices aren't available on this network yet."
    await render()
    expect(q('[data-testid="passkeys-section"]')).toBeNull()
    auth.problem = null
    auth.storage = 'session'
    await render()
    expect(q('[data-testid="passkeys-section"]')).toBeNull()
  })

  it('says what a passkey is and is not, and that every device shares one key and budget', async () => {
    await render()
    expect(q('[data-testid="passkeys-explain"]')!.textContent).toMatch(/moves this sign-in to another device\. It doesn't recover an account/)
    expect(q('[data-testid="passkeys-shared"]')!.textContent).toMatch(/Every device shares the same key and budget, so disabling the key signs them all out/)
    expect(q('[data-testid="passkeys-empty"]')).not.toBeNull()
  })

  it('lists each passkey: this device or another, when, and the key it holds', async () => {
    auth.rows = [
      row('mine', { thisDevice: true, encryptionKey: true }),
      row('old', { keyId: 3, keyState: 'disabled', current: false, needsUpdate: true }),
      row('gone', { keyId: 2, keyState: 'missing', current: false, needsUpdate: true }),
    ]
    await render()
    const rows = [...document.querySelectorAll('[data-testid="passkey-row"]')]
    expect(rows.map((r) => r.getAttribute('data-passkey-id'))).toEqual(['mine', 'old', 'gone'])
    expect(rows[0]!.textContent).toMatch(/This device/)
    expect(rows[0]!.textContent).toMatch(/Holds your encryption key/)
    expect(rows[0]!.textContent).toMatch(/Holds this browser's key, #5/)
    expect(rows[0]!.textContent).not.toMatch(/Needs update/)
    expect(rows[1]!.textContent).toMatch(/Another device/)
    expect(rows[1]!.textContent).toMatch(/Needs update/)
    expect(rows[1]!.textContent).toMatch(/key #3, which was disabled/)
    expect(rows[2]!.textContent).toMatch(/key #2, which your identity no longer shows/)
  })

  it('says which keys stay on this device only', async () => {
    auth.leftOut = 2
    await render()
    expect(q('[data-testid="passkeys-left-out"]')!.textContent).toMatch(/Keys without a spending limit stay on this device only\. 2 keys here have no limit or no expiry/)
    // Read again on a fresh mount.
    auth.leftOut = 0
    act(() => root.unmount())
    root = createRoot(host)
    await render()
    expect(q('[data-testid="passkeys-left-out"]')).toBeNull()
  })
})

describe('adding a passkey', () => {
  const open = async (): Promise<void> => {
    await render()
    await click(q('[data-testid="passkey-add"]'))
  }

  it('adds one without the encryption key by default', async () => {
    await open()
    expect(q('[data-testid="passkey-add-dialog"]')!.textContent).toMatch(/You approve twice/)
    expect(q('[data-testid="cost-preview"]')).not.toBeNull()
    expect(q('[data-testid="passkey-encryption-warning"]')).toBeNull()
    await click(q('[data-testid="passkey-add-confirm"]'))
    expect(auth.addPlatformPasskey).toHaveBeenCalledWith({ includeEncryptionKey: false })
    // Done: the dialog is gone and the list was read again.
    expect(q('[data-testid="passkey-add-dialog"]')).toBeNull()
  })

  it('cannot add the encryption key a browser does not hold, and says where to get it', async () => {
    await open()
    expect(q<HTMLInputElement>('[data-testid="passkey-include-encryption"]')!.disabled).toBe(true)
    expect(q('[data-testid="passkey-add-dialog"]')!.textContent).toMatch(/doesn't hold your encryption key/)
  })

  it('warns that the encryption key cannot be taken back, and sends the choice', async () => {
    auth.holdsEncryption = true
    await open()
    await click(q('[data-testid="passkey-include-encryption"]'))
    expect(q('[data-testid="passkey-encryption-warning"]')!.textContent).toMatch(/Removing the passkey later can't take the encryption key back/)
    await click(q('[data-testid="passkey-add-confirm"]'))
    expect(auth.addPlatformPasskey).toHaveBeenCalledWith({ includeEncryptionKey: true })
  })

  it('explains when some keys are left out', async () => {
    auth.leftOut = 1
    await open()
    expect(q('[data-testid="passkey-add-left-out"]')!.textContent).toBe('Keys without a spending limit stay on this device only.')
  })

  it('shows a refusal in the dialog (a key a passkey may not hold)', async () => {
    auth.addPlatformPasskey.mockRejectedValueOnce(new PlatformPasskeyError("This sign-in's key has no spending limit or expiry, so it can't be kept with a passkey.", 'ineligible'))
    await open()
    await click(q('[data-testid="passkey-add-confirm"]'))
    expect(q('[data-testid="passkey-add-dialog"] [role="alert"]')!.textContent).toMatch(/no spending limit or expiry/)
    expect(q('[data-testid="passkey-add-dialog"]')).not.toBeNull()
  })

  it('a passkey made but not yet seen on Platform closes the dialog and offers "Check again"', async () => {
    auth.addPlatformPasskey.mockImplementationOnce(async () => {
      auth.pending = { id: 'new' }
      throw new PlatformPasskeyError("The passkey was added, but Platform doesn't show it yet. Check again in a minute.", 'pending')
    })
    await open()
    await click(q('[data-testid="passkey-add-confirm"]'))
    expect(q('[data-testid="passkey-add-dialog"]')).toBeNull()
    expect(q('[data-testid="passkey-pending"]')!.textContent).toMatch(/isn't on Platform yet/)
    // One unfinished passkey at a time.
    expect(q<HTMLButtonElement>('[data-testid="passkey-add"]')!.disabled).toBe(true)
  })

  it('a resumed tab unlocks first, then adds', async () => {
    auth.addPlatformPasskey.mockRejectedValueOnce(new UnlockNeededError('unlock first'))
    await open()
    await click(q('[data-testid="passkey-add-confirm"]'))
    expect(q('[data-testid="passkey-add-unlock"]')).not.toBeNull()
    // The unlock is no form inside the add's form (its button would submit the add instead).
    expect(document.querySelector('form form')).toBeNull()
    expect(q<HTMLButtonElement>('[data-testid="passkey-add-confirm"]')!.disabled).toBe(true)
    const pass = q<HTMLInputElement>('#passkey-add-unlock-passphrase')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(pass, 'fake-passphrase-not-real-123')
    act(() => pass.dispatchEvent(new Event('input', { bubbles: true })))
    await click(buttonIn(q('[data-testid="passkey-add-unlock"]')!, /^Unlock$/))
    expect(auth.unlockMore).toHaveBeenCalledWith({ passphrase: 'fake-passphrase-not-real-123' })
    expect(auth.addPlatformPasskey).toHaveBeenCalledTimes(2)
  })
})

describe('managing passkeys', () => {
  it('"Needs update" asks that passkey once and re-saves the current keys into it', async () => {
    auth.rows = [row('old', { keyId: 3, current: false, needsUpdate: true }), row('fine')]
    await render()
    expect(document.querySelectorAll('[data-testid="passkey-update"]')).toHaveLength(1)
    await click(q('[data-testid="passkey-update"]'))
    expect(auth.resealPlatformPasskeys).toHaveBeenCalledWith({ id: 'old' })
  })

  it('removes a passkey only after a confirm that says the key keeps working', async () => {
    auth.rows = [row('mine', { thisDevice: true })]
    await render()
    await click(q('[data-testid="passkey-remove"]'))
    expect(auth.removePlatformPasskey).not.toHaveBeenCalled()
    expect(q('[role="dialog"]')!.textContent).toMatch(/The key it held keeps working/)
    await click(q('[data-testid="confirm-action"]'))
    expect(auth.removePlatformPasskey).toHaveBeenCalledWith('mine')
  })

  it('keeps it when the confirm is cancelled', async () => {
    auth.rows = [row('mine', { thisDevice: true })]
    await render()
    await click(q('[data-testid="passkey-remove"]'))
    await click(buttonIn(document, /^Cancel$/))
    expect(auth.removePlatformPasskey).not.toHaveBeenCalled()
  })

  it('"Check again" finishes an unfinished passkey; "Discard" gives it up after a confirm', async () => {
    auth.pending = { id: 'new' }
    await render()
    await click(q('[data-testid="passkey-check-again"]'))
    expect(auth.finishPlatformPasskey).toHaveBeenCalledTimes(1)
    await click(q('[data-testid="passkey-discard"]'))
    expect(auth.abandonPlatformPasskey).not.toHaveBeenCalled()
    expect(q('[role="dialog"]')!.textContent).toMatch(/entry is deleted first/)
    await click(q('[data-testid="confirm-action"]'))
    expect(auth.abandonPlatformPasskey).toHaveBeenCalledTimes(1)
  })

  it('shows what went wrong, in the controller’s words', async () => {
    auth.rows = [row('old', { needsUpdate: true, current: false })]
    auth.resealPlatformPasskeys.mockRejectedValueOnce(new PlatformPasskeyError("This passkey doesn't open its entry on Platform. Sign in another way (your identity file, recovery phrase or wallet), then add the passkey again.", 'refused'))
    await render()
    await click(q('[data-testid="passkey-update"]'))
    expect(q('[role="alert"]')!.textContent).toMatch(/doesn't open its entry on Platform/)
  })

  it('a resumed tab unlocks, then runs the update again', async () => {
    auth.rows = [row('old', { needsUpdate: true, current: false })]
    auth.resealPlatformPasskeys.mockRejectedValueOnce(new UnlockNeededError('unlock first'))
    await render()
    await click(q('[data-testid="passkey-update"]'))
    expect(q('[data-testid="passkeys-unlock"]')).not.toBeNull()
    const pass = q<HTMLInputElement>('#passkeys-unlock-passphrase')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(pass, 'fake-passphrase-not-real-123')
    act(() => pass.dispatchEvent(new Event('input', { bubbles: true })))
    await click(buttonIn(q('[data-testid="passkeys-unlock"]')!, /^Unlock$/))
    expect(auth.resealPlatformPasskeys).toHaveBeenCalledTimes(2)
    expect(q('[data-testid="passkeys-unlock"]')).toBeNull()
  })
})


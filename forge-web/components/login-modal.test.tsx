// @vitest-environment jsdom
/**
 * The sign-in sheet's recovery routes (QA wave bonsia):
 *
 * - QW-010: the words alone find an identity this browser already holds a key for. The sheet
 *   stays on Import with that identity filled in and offers Unlock or Replace (the way back from
 *   a forgotten passphrase), instead of switching to an Unlock that needs the old passphrase.
 *   The Unlock view links to that route too.
 * - QW-052: replacing a stored key that has an encryption key beside it ticks "Enable private
 *   repos" by default, and says what unticking it drops.
 * - QW-011: an import error shows above the button and is scrolled into view.
 * - QW-051: "Forget this key" asks in an in-app dialog, not `window.confirm`.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AlreadyStoredError } from '@/lib/auth/controller'
import type { VaultInfo } from '@/lib/auth/vault'
import { useUiStore } from '@/hooks/use-ui-store'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'

const auth = {
  vaults: [] as VaultInfo[],
  importIdentity: vi.fn(),
  forget: vi.fn(async () => undefined),
  unlock: vi.fn(),
}

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    vaults: auth.vaults,
    vaultsLoaded: true,
    vaultsError: null,
    reloadVaults: () => undefined,
    limitedKeys: true,
    importIdentity: auth.importIdentity,
    unlock: auth.unlock,
    forget: auth.forget,
    isLoading: false,
    step: null,
    identity: null,
    unlockScope: null,
    storage: null,
    controller: { supportsLimitedKeys: () => false, checkGroup: async () => ({ notice: null }) },
  }),
}))

const { LoginModal } = await import('./login-modal')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host.ownerDocument.querySelector<T>(sel)
}
function byText(text: string | RegExp, sel = 'button'): HTMLElement | null {
  return [...host.ownerDocument.querySelectorAll<HTMLElement>(sel)].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''))) ?? null
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
async function click(el: HTMLElement | null): Promise<void> {
  expect(el).not.toBeNull()
  await act(async () => {
    el!.click()
  })
  await flush()
}

async function openImportWithWords(): Promise<void> {
  act(() => useUiStore.getState().openLogin('import'))
  await flush()
  await click(byText('Recovery phrase'))
  act(() => type(q<HTMLTextAreaElement>('#import-mnemonic')!, Array(12).fill('abandon').join(' ')))
  act(() => type(q<HTMLInputElement>('#vault-passphrase')!, 'a new passphrase'))
  await flush()
  act(() => type(q<HTMLInputElement>('#vault-passphrase-2')!, 'a new passphrase'))
  await flush()
}

beforeEach(() => {
  auth.vaults = [{ identityId: ID, keyId: 6, createdAt: 1_700_000_000_000, methods: ['passphrase'] }]
  auth.importIdentity.mockReset()
  auth.forget.mockClear()
  Element.prototype.scrollIntoView = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<LoginModal />))
})
afterEach(() => {
  act(() => useUiStore.getState().closeLogin())
  act(() => root.unmount())
  host.remove()
})

describe('QW-010: the words find a key this browser already holds', () => {
  it('stays on Import, fills in the identity and offers Replace; the second click replaces', async () => {
    auth.importIdentity.mockRejectedValueOnce(new AlreadyStoredError(ID)).mockResolvedValueOnce({})
    await openImportWithWords()
    await click(byText("Create this browser's key"))
    expect(auth.importIdentity).toHaveBeenCalledTimes(1)
    expect(auth.importIdentity.mock.calls[0]![0]).toMatchObject({ identityId: '' })
    // Not switched to Unlock: the words, the filled-in ID and the replace offer are all here.
    expect(q('#unlock-passphrase')).toBeNull()
    expect(q<HTMLInputElement>('#import-id')!.value).toBe(ID)
    expect(q('[data-testid="import-already-stored"]')!.textContent).toMatch(/These words belong to an identity this browser already holds/)
    expect(q('[data-testid="import-already-stored"]')!.textContent).toMatch(/forgot its passphrase/)
    await click(byText("Replace this browser's key"))
    expect(auth.importIdentity).toHaveBeenCalledTimes(2)
    // With the ID: the controller replaces the stored key rather than refusing again.
    expect(auth.importIdentity.mock.calls[1]![0]).toMatchObject({ identityId: ID })
  })

  it('other words clear the identity the last ones found (it no longer applies)', async () => {
    auth.importIdentity.mockRejectedValueOnce(new AlreadyStoredError(ID))
    await openImportWithWords()
    await click(byText("Create this browser's key"))
    expect(q<HTMLInputElement>('#import-id')!.value).toBe(ID)
    act(() => type(q<HTMLTextAreaElement>('#import-mnemonic')!, Array(12).fill('zoo').join(' ')))
    await flush()
    expect(q<HTMLInputElement>('#import-id')!.value).toBe('')
    expect(q('[data-testid="import-already-stored"]')).toBeNull()
  })

  it('"Unlock it instead" still switches to Unlock', async () => {
    auth.importIdentity.mockRejectedValueOnce(new AlreadyStoredError(ID))
    await openImportWithWords()
    await click(byText("Create this browser's key"))
    await click(byText('Unlock it instead'))
    expect(q('#unlock-passphrase')).not.toBeNull()
  })

  it('the Unlock view links to the recovery route', async () => {
    act(() => useUiStore.getState().openLogin())
    await flush()
    expect(q('[data-testid="unlock-forgot"]')!.textContent).toMatch(/Forgot the passphrase\?/)
    await click(byText(/Replace this key with your recovery phrase/))
    expect(q('#import-mnemonic, [role="tablist"]')).not.toBeNull()
    expect(q('#unlock-passphrase')).toBeNull()
  })
})

describe('QW-011: an import error is shown where the user is looking', () => {
  it('sits above the button and is scrolled into view', async () => {
    auth.importIdentity.mockRejectedValueOnce(new Error('These 12 words aren\'t a valid recovery phrase'))
    auth.vaults = []
    await openImportWithWords()
    await click(byText("Create this browser's key"))
    const alert = q('[role="alert"]')!
    expect(alert.textContent).toMatch(/aren't a valid recovery phrase/)
    const button = byText("Create this browser's key")!
    expect(alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
})

describe('QW-052: replacing a key that has an encryption key beside it', () => {
  it('ticks "Enable private repos" and says what unticking drops', async () => {
    auth.vaults = [{ ...auth.vaults[0]!, encryptionKey: true }]
    act(() => useUiStore.getState().openLogin('import'))
    await flush()
    await click(byText('Recovery phrase'))
    act(() => type(q<HTMLInputElement>('#import-id')!, ID))
    await flush()
    const box = q<HTMLInputElement>('[data-testid="enable-private-repos"]')!
    expect(box.checked).toBe(true)
    expect(q('[data-testid="import-keeps-encryption"]')!.textContent).toMatch(/brings it over again/)
    await click(box)
    expect(box.checked).toBe(false)
    expect(q('[data-testid="import-keeps-encryption"]')!.textContent).toMatch(/is removed with the old key/)
  })

  it('another identity does not inherit the tick', async () => {
    auth.vaults = [{ ...auth.vaults[0]!, encryptionKey: true }]
    act(() => useUiStore.getState().openLogin('import'))
    await flush()
    await click(byText('Recovery phrase'))
    act(() => type(q<HTMLInputElement>('#import-id')!, ID))
    await flush()
    expect(q<HTMLInputElement>('[data-testid="enable-private-repos"]')!.checked).toBe(true)
    act(() => type(q<HTMLInputElement>('#import-id')!, 'BTJPjCLCnRaJQkqakpcdLYFsaHgFf5XSEBNxFCyYBteH'))
    await flush()
    expect(q<HTMLInputElement>('[data-testid="enable-private-repos"]')!.checked).toBe(false)
  })

  it('leaves the box unticked for a key without one', async () => {
    act(() => useUiStore.getState().openLogin('import'))
    await flush()
    await click(byText('Recovery phrase'))
    act(() => type(q<HTMLInputElement>('#import-id')!, ID))
    await flush()
    expect(q<HTMLInputElement>('[data-testid="enable-private-repos"]')!.checked).toBe(false)
    expect(q('[data-testid="import-keeps-encryption"]')).toBeNull()
  })
})

describe('QW-051: forgetting a key asks in the app', () => {
  it('Cancel keeps the key; "Forget key" forgets it; window.confirm is never used', async () => {
    const native = vi.spyOn(window, 'confirm')
    act(() => useUiStore.getState().openLogin())
    await flush()
    await click(byText('Forget this key'))
    expect(host.ownerDocument.body.textContent).toMatch(/Forget this browser's key\?/)
    await click(byText('Cancel'))
    expect(auth.forget).not.toHaveBeenCalled()
    await click(byText('Forget this key'))
    await click(q('[data-testid="confirm-action"]'))
    expect(auth.forget).toHaveBeenCalledWith(ID)
    expect(native).not.toHaveBeenCalled()
  })
})

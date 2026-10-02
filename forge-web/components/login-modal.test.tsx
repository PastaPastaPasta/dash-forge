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
 * - QA wave 2: Unlock preselects the identity used last (QW2-025); forgetting the last key moves
 *   to the tile list (QW2-027); an unfinished identity creation is offered first (QW2-030);
 *   signing in to read a private repo ticks "Enable private repos" (QW2-016); an identity file
 *   for another network is refused as it is picked (QW2-031).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AlreadyStoredError } from '@/lib/auth/controller'
import type { VaultInfo } from '@/lib/auth/vault'
import { useUiStore } from '@/hooks/use-ui-store'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'

const OTHER = 'BTJPjCLCnRaJQkqakpcdLYFsaHgFf5XSEBNxFCyYBteH'

const auth = {
  /** The signed-in session (a renewal from Settings), or null. */
  identity: null as string | null,
  keyId: null as number | null,
  unlockScope: null as 'full' | 'signing' | null,
  storage: null as 'vault' | 'session' | null,
  vaults: [] as VaultInfo[],
  lastIdentity: null as string | null,
  importIdentity: vi.fn(),
  forget: vi.fn(async () => undefined),
  unlock: vi.fn(),
}

/** The unfinished identity creation this browser holds, if any. */
let journal: { depositAddress: string } | undefined

vi.mock('@/lib/auth/connect', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/connect')>()),
  connectPlatform: () => Promise.reject(new Error('offline in tests')),
}))
/** Whether Dash Wallet can answer here (testnet); false mutes its tile, as on a devnet. */
let walletSupported: boolean | null = null
vi.mock('@/lib/auth/app-connect', async (orig) => {
  const real = await orig<typeof import('@/lib/auth/app-connect')>()
  return { ...real, walletSignInSupported: (n: Parameters<typeof real.walletSignInSupported>[0]) => walletSupported ?? real.walletSignInSupported(n) }
})
vi.mock('@/lib/auth/create-identity', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/create-identity')>()),
  readCreationJournal: async () => journal,
}))
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  masterMaterialFromFile: (text: string) => ({ identityId: ID, networkKey: text, masterWif: null, mnemonic: null }),
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    vaults: auth.vaults,
    lastIdentity: auth.lastIdentity,
    vaultsLoaded: true,
    vaultsError: null,
    reloadVaults: () => undefined,
    limitedKeys: true,
    importIdentity: auth.importIdentity,
    unlock: auth.unlock,
    forget: auth.forget,
    isLoading: false,
    step: null,
    identity: auth.identity,
    keyId: auth.keyId,
    unlockScope: auth.unlockScope,
    storage: auth.storage,
    controller: {
      supportsLimitedKeys: () => false,
      checkGroup: async () => ({ notice: null }),
      checkFileNetwork: (key: string | null) => {
        if (key !== null && key !== 'devnet-sakura') throw new Error(`This identity file is for ${key}, but this site is on devnet-sakura.`)
      },
    },
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
  auth.lastIdentity = null
  auth.identity = null
  auth.keyId = null
  auth.unlockScope = null
  auth.storage = null
  journal = undefined
  walletSupported = null
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

describe('the sheet on a phone (QA wave 4)', () => {
  it('QW4-041: the muted wallet tile is dashed, not faded, so its helper text keeps its contrast', async () => {
    auth.vaults = []
    walletSupported = false
    act(() => useUiStore.getState().openLogin())
    // The wallet tile shows once Platform could not be asked (offline in tests): muted on a devnet.
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    expect(q('[data-testid="tile-wallet"]')!.dataset.muted).toBe('true')
    const tiles = [...host.ownerDocument.querySelectorAll<HTMLElement>('[data-testid^="tile-"]')]
    expect(tiles.length).toBeGreaterThan(1)
    // Only a disabled tile (writes paused) fades; an enabled one, muted or not, never does.
    for (const tile of tiles) expect(tile.className).not.toMatch(/(^|\s)opacity-/)
    for (const tile of tiles.filter((t) => t.dataset.muted === 'true')) expect(tile.className).toMatch(/border-dashed/)
  })

  it('QW4-042: "All options" has a 44 px hit area on touch screens', async () => {
    auth.vaults = []
    act(() => useUiStore.getState().openLogin('import'))
    await flush()
    expect(byText('All options')!.className).toMatch(/\bhit-area\b/)
  })
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

describe('QA wave 2 (bonsia): sign-in intent and polish', () => {
  it('QW2-025: Unlock preselects the identity signed in last', async () => {
    auth.vaults = [...auth.vaults, { identityId: OTHER, keyId: 3, createdAt: 1_700_000_000_000, methods: ['passphrase'] }]
    auth.lastIdentity = OTHER
    act(() => useUiStore.getState().openLogin())
    await flush()
    expect(q<HTMLSelectElement>('select[aria-label="Identity"]')!.value).toBe('1')
  })

  it('QW2-027: forgetting the last stored key moves to the sign-in options', async () => {
    auth.forget.mockImplementationOnce(async () => {
      auth.vaults = []
    })
    act(() => useUiStore.getState().openLogin())
    await flush()
    await click(byText('Forget this key'))
    await click(q('[data-testid="confirm-action"]'))
    act(() => root.render(<LoginModal />))
    await flush()
    expect(q('[data-testid="tile-import"]')).not.toBeNull()
    expect(host.ownerDocument.body.textContent).not.toMatch(/Unlock the key this browser already holds/)
  })

  it('QW2-030: an unfinished identity creation is offered first in the chooser', async () => {
    auth.vaults = []
    journal = { depositAddress: 'yZWGfAbCdEfGhIjKlMnOpQrStUvWxYz12' }
    act(() => useUiStore.getState().openLogin())
    await flush()
    await flush()
    const tile = q('[data-testid="tile-create-resume"]')
    expect(tile?.textContent).toMatch(/Finish creating your identity/)
    expect(tile?.textContent).toMatch(/yZWGfAbCdE/)
  })

  it('QW2-016: signing in to read a private repo says so and ticks "Enable private repos"', async () => {
    auth.vaults = []
    act(() => useUiStore.getState().openLogin(undefined, undefined, { action: 'read this private repo', privateRepo: true }))
    await flush()
    expect(host.ownerDocument.body.textContent).toMatch(/Sign in to read this private repo/)
    expect(q('[data-testid="signin-intent"]')!.textContent).toMatch(/Enable private repos/)
    await click(q('[data-testid="tile-import"]'))
    expect(q<HTMLInputElement>('[data-testid="enable-private-repos"]')!.checked).toBe(true)
  })

  it('QW2-031: an identity file for another network is refused when it is picked', async () => {
    auth.vaults = []
    act(() => useUiStore.getState().openLogin('import'))
    await flush()
    const input = q<HTMLInputElement>('input[type="file"][aria-label="Identity file"]')!
    const file = { name: 'DEMO.identity.json', text: async () => 'devnet-moutai' }
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(q('[role="alert"]')!.textContent).toMatch(/for devnet-moutai, but this site is on devnet-sakura/)
    expect(byText(/Create this browser's key/)!.hasAttribute('disabled')).toBe(true)
  })
})

describe('QA wave 3 (bonsia): the import form', () => {
  it('QW3-027: Enter in the passphrase fields signs in, as the Unlock sheet does', async () => {
    auth.vaults = []
    auth.importIdentity.mockResolvedValueOnce({})
    await openImportWithWords()
    await act(async () => {
      q<HTMLInputElement>('#vault-passphrase-2')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()
    expect(auth.importIdentity).toHaveBeenCalledTimes(1)
  })

  it('QW3-031: Renew key opens a renewal of the signed-in identity, not the generic sign-in', async () => {
    auth.identity = ID
    auth.keyId = 6
    auth.storage = 'vault'
    auth.unlockScope = 'full'
    auth.vaults = [{ identityId: ID, keyId: 6, createdAt: 1, methods: ['passphrase'], encryptionKey: true }]
    act(() => useUiStore.getState().openLogin('renew'))
    await flush()
    const body = host.ownerDocument.body.textContent ?? ''
    expect(body).toMatch(/Renew this browser's key/)
    expect(body).not.toMatch(/Sign in to Dash Forge/)
    expect(byText(/All options/)).toBeNull()
    expect(body).toMatch(/Disables key #6 and registers/)
    // The encryption key this tab holds moves with the renewal: no unticked box saying otherwise.
    expect(q('[data-testid="enable-private-repos"]')).toBeNull()
    expect(q('[data-testid="import-carries-encryption"]')!.textContent).toMatch(/Private repos stay enabled/)
    await click(byText('Recovery phrase'))
    expect(q<HTMLInputElement>('#import-id')!.value).toBe(ID)
    expect(q<HTMLInputElement>('#import-id')!.readOnly).toBe(true)
    expect(byText("Renew this browser's key")).not.toBeNull()
  })

  it("QW3-007: a key that only got staged is no key to replace: no false renewal copy", async () => {
    auth.vaults = [{ identityId: ID, keyId: 11, createdAt: 1, methods: ['passphrase'], staged: true }]
    await openImportWithWords()
    act(() => type(q<HTMLInputElement>('#import-id')!, ID))
    await flush()
    expect(q('[data-testid="import-already-stored"]')).toBeNull()
    expect(q('[data-testid="import-unfinished"]')!.textContent).toMatch(/did not finish/)
    expect(host.ownerDocument.body.textContent).not.toMatch(/old key is disabled in the same update/)
    expect(byText("Create this browser's key")).not.toBeNull()
  })
})

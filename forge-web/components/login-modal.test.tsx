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
 *   signing in to read a private repo ticks "Read and write members-only and private content" (QW2-016); an identity file
 *   for another network is refused as it is picked (QW2-031).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AlreadyStoredError } from '@/lib/auth/controller'
import { PlatformPasskeyError } from '@/lib/auth/passkey-vault/service'
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
  /** Why passkeys for other devices are hidden; null shows the tile (the default is hidden). */
  passkeyProblem: 'Checking whether passkeys work on this page.' as string | null,
  signInWithPasskey: vi.fn(),
  isLoading: false,
  step: null as string | null,
}

/** The unfinished identity creation this browser holds, if any. */
let journal: { depositAddress: string } | undefined

/** The network the sheet renders for; null keeps the build's (testnet). */
const network = vi.hoisted(() => ({ override: null as 'mainnet' | null }))
vi.mock('@/lib/constants', async (orig) => {
  const real = await orig<typeof import('@/lib/constants')>()
  const active = new Proxy(real.ACTIVE_NETWORK, {
    get: (target, prop, receiver) => (network.override !== null && (prop === 'network' || prop === 'key') ? network.override : Reflect.get(target, prop, receiver)),
  })
  return { ...real, ACTIVE_NETWORK: active }
})

/** Whether Platform answers (a fake connection); off, the wallet tile still shows, as offline. */
let platformUp = false
/** Whether the chain supports App Connect v2. */
let v2Available: boolean | null = false
/** Whether a released wallet reads the chain's protocol. */
let releasedWallet = true
/** The operator's pause (writesPausedReason), or null. */
let paused: string | null = null
vi.mock('@/lib/devnet-notice', async (orig) => ({
  ...(await orig<typeof import('@/lib/devnet-notice')>()),
  writesPausedReason: () => paused,
}))
vi.mock('@/lib/auth/connect', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/connect')>()),
  connectPlatform: () => (platformUp ? Promise.resolve({}) : Promise.reject(new Error('offline in tests'))),
}))
vi.mock('@/lib/auth/app-connect-v2', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/app-connect-v2')>()),
  appConnectSupport: async () => (v2Available === null ? null : { v2: v2Available, releasedWallet }),
}))
/** What the finished creation's deposit address still holds (duffs), or an Error when unreadable. */
let leftover: number | Error | Promise<number> = 0
const WELCOME_DEPOSIT = { depositAddress: 'yDepositAddressForTheWelcomeView1', startedAt: 1 }
let createdDeposit: unknown = WELCOME_DEPOSIT
const balanceCalls: unknown[][] = []
const created = vi.hoisted(() => ({ identityId: 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec' }))
vi.mock('@/components/auth/create-identity-flow', () => ({
  CreateIdentityFlow: ({ onDone }: { onDone: (c: unknown) => void }) => (
    <button type="button" data-testid="fake-create-done" onClick={() => onDone({ identityId: created.identityId, deposit: createdDeposit })}>
      finish
    </button>
  ),
}))
vi.mock('@/lib/auth/create-identity', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/create-identity')>()),
  readCreationJournal: async () => journal,
  depositBalance: async (...args: unknown[]) => {
    balanceCalls.push(args)
    if (leftover instanceof Error) throw leftover
    return await leftover
  },
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
    isLoading: auth.isLoading,
    step: auth.step,
    platformPasskeyProblem: auth.passkeyProblem,
    signInWithPasskey: auth.signInWithPasskey,
    identity: auth.identity,
    keyId: auth.keyId,
    unlockScope: auth.unlockScope,
    storage: auth.storage,
    controller: {
      supportsLimitedKeys: () => false,
      checkGroup: async () => ({ notice: null }),
      walletSignInBlocker: async () => null,
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
  leftover = 0
  createdDeposit = WELCOME_DEPOSIT
  balanceCalls.length = 0
  platformUp = false
  v2Available = false
  releasedWallet = true
  paused = null
  network.override = null
  auth.importIdentity.mockReset()
  auth.forget.mockClear()
  auth.passkeyProblem = 'Checking whether passkeys work on this page.'
  auth.signInWithPasskey.mockReset()
  auth.isLoading = false
  auth.step = null
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
    act(() => useUiStore.getState().openLogin())
    // The wallet tile shows once Platform could not be asked (offline in tests): muted.
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
  it('ticks the encryption-key box and says what unticking drops', async () => {
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

describe('a key the wallet disconnected', () => {
  it('a flagged key says to sign in again and offers forgetting it, not a renewal', async () => {
    auth.vaults = [{ ...auth.vaults[0]!, disconnected: true, fromAppConnect: true }]
    act(() => useUiStore.getState().openLogin())
    await flush()
    const box = q('[data-testid="unlock-disconnected"]')!
    expect(box.textContent).toMatch(/This key was disconnected in your wallet, so sign in again/)
    expect(byText("Renew this browser's key")).toBeNull()
    await click(byText('Forget this key and sign in again'))
    expect(host.ownerDocument.body.textContent).toMatch(/Forget this disabled key\?/)
    expect(host.ownerDocument.body.textContent).toMatch(/disabled on Platform and can't sign/)
    expect(host.ownerDocument.body.textContent).not.toMatch(/stays valid until it expires/)
    await click(q('[data-testid="confirm-action"]'))
    expect(auth.forget).toHaveBeenCalledWith(ID)
  })

  it("picking another key clears the first key's disconnected message (Forget can't hit the wrong key)", async () => {
    auth.vaults = [...auth.vaults, { identityId: OTHER, keyId: 3, createdAt: 1_700_000_000_000, methods: ['passphrase'] }]
    auth.unlock.mockRejectedValueOnce(new Error('this key was disconnected in your wallet, so sign in again'))
    act(() => useUiStore.getState().openLogin())
    await flush()
    act(() => type(q<HTMLInputElement>('#unlock-passphrase')!, 'pw'))
    await flush()
    await click(byText('Unlock'))
    expect(q('[data-testid="unlock-disconnected"]')).not.toBeNull()
    const select = q<HTMLSelectElement>('select[aria-label="Identity"]')!
    const other = select.value === '0' ? '1' : '0'
    act(() => {
      select.value = other
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(q('[data-testid="unlock-disconnected"]')).toBeNull()
  })

  it("forgetting the disconnected key leaves no disconnected message on the next key", async () => {
    auth.vaults = [...auth.vaults, { identityId: OTHER, keyId: 3, createdAt: 1_700_000_000_000, methods: ['passphrase'] }]
    auth.unlock.mockRejectedValueOnce(new Error('this key was disconnected in your wallet, so sign in again'))
    auth.forget.mockImplementationOnce(async () => {
      auth.vaults = auth.vaults.filter((x) => x.identityId !== ID)
    })
    act(() => useUiStore.getState().openLogin())
    await flush()
    act(() => type(q<HTMLInputElement>('#unlock-passphrase')!, 'pw'))
    await flush()
    await click(byText('Unlock'))
    expect(q('[data-testid="unlock-disconnected"]')).not.toBeNull()
    await click(byText('Forget this key'))
    await click(q('[data-testid="confirm-action"]'))
    expect(auth.forget).toHaveBeenCalledWith(ID)
    act(() => root.render(<LoginModal />))
    await flush()
    expect(q('[data-testid="unlock-disconnected"]')).toBeNull()
    await click(byText('Forget this key'))
    expect(host.ownerDocument.body.textContent).not.toMatch(/Forget this disabled key\?/)
  })

  it('a flagged key still shows other failures, such as a wrong passphrase', async () => {
    auth.vaults = [{ ...auth.vaults[0]!, disconnected: true }]
    auth.unlock.mockRejectedValueOnce(new Error('wrong passphrase'))
    act(() => useUiStore.getState().openLogin())
    await flush()
    act(() => type(q<HTMLInputElement>('#unlock-passphrase')!, 'pw'))
    await flush()
    await click(byText('Unlock'))
    expect(q('[data-testid="unlock-disconnected"]')).not.toBeNull()
    expect(host.ownerDocument.body.textContent).toMatch(/wrong passphrase/)
  })

  it('an unlock that finds it disconnected shows the same, in place of the raw error', async () => {
    auth.unlock.mockRejectedValueOnce(new Error('this key was disconnected in your wallet, so sign in again'))
    act(() => useUiStore.getState().openLogin())
    await flush()
    act(() => type(q<HTMLInputElement>('#unlock-passphrase')!, 'pw'))
    await flush()
    await click(byText('Unlock'))
    expect(q('[data-testid="unlock-disconnected"]')).not.toBeNull()
    expect(byText("Renew this browser's key")).toBeNull()
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

  it('QW2-016: signing in to read a private repo says so and ticks the encryption-key box', async () => {
    auth.vaults = []
    act(() => useUiStore.getState().openLogin(undefined, { action: 'read this private repo', privateRepo: true }))
    await flush()
    expect(host.ownerDocument.body.textContent).toMatch(/Sign in to read this private repo/)
    expect(q('[data-testid="signin-intent"]')!.textContent).toMatch(/Read and write members-only and private content/)
    await click(q('[data-testid="tile-import"]'))
    expect(q<HTMLInputElement>('[data-testid="enable-private-repos"]')!.checked).toBe(true)
    // D25: the box also opens members-only content in public repos, so it does not say "private" alone.
    const label = q('[data-testid="enable-private-repos"]')!.closest('label')!.textContent!
    expect(label).toMatch(/^Read and write members-only and private content/)
    expect(label).toMatch(/members-only content in public repos/)
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
    expect(q('[data-testid="import-carries-encryption"]')!.textContent).toMatch(/Members-only and private content stays readable/)
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

describe('QW4-022: creating an identity is titled as sign-up', () => {
  it('names the create sheet "Create your identity", not "Sign in to Dash Forge"', async () => {
    auth.vaults = []
    act(() => useUiStore.getState().openLogin('create'))
    await flush()
    expect(q('[role="dialog"] h2')?.textContent).toBe('Create your identity')
    // Import is a sign-in, and keeps its title.
    await click(byText('All options'))
    await click(q('[data-testid="tile-import"]'))
    expect(q('[role="dialog"] h2')?.textContent).toBe('Sign in to Dash Forge')
  })
})

describe('Q5-C04: the key lifetime is worded for each path', () => {
  it('the tile list notes the key lasts 90 days by default and up to a year', async () => {
    auth.vaults = []
    act(() => useUiStore.getState().openLogin())
    await flush()
    const text = host.ownerDocument.body.textContent ?? ''
    expect(q('[data-testid="signin-key-limits"]')!.textContent).toContain('It lasts 90 days by default, and up to a year.')
    expect(text).not.toContain('you can renew it for up to a year later')
    // Create fixes the lifetime; Import offers the picker.
    await click(q('[data-testid="tile-create"]'))
    expect(host.ownerDocument.body.textContent).toContain('for 90 days; you can renew it for up to a year later')
    await click(byText('All options'))
    await click(q('[data-testid="tile-import"]'))
    expect(host.ownerDocument.body.textContent).toContain('for 90 days by default (up to a year)')
  })
})

describe('App Connect v2 in the sheet', () => {
  const tileOrder = (): (string | undefined)[] => [...host.ownerDocument.querySelectorAll<HTMLElement>('button[data-testid^="tile-"]')].map((t) => t.dataset['testid'])
  const shownTiles = (): (string | undefined)[] =>
    [...host.ownerDocument.querySelectorAll<HTMLElement>('button[data-testid^="tile-"]')].filter((t) => t.closest('[hidden]') === null).map((t) => t.dataset['testid'])

  it('puts the wallet tile first where a released wallet answers v2, and says one approval covers Forge', async () => {
    auth.vaults = []
    platformUp = true
    v2Available = true
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    expect(shownTiles()).toEqual(['tile-wallet'])
    expect(tileOrder()).toEqual(['tile-wallet', 'tile-import', 'tile-dg', 'tile-create'])
    expect(q('[data-testid="tile-wallet"]')!.dataset['muted']).toBeUndefined()
    expect(q('[data-testid="tile-wallet"]')!.textContent).toMatch(/approve once for all of Forge/)
    expect(q('[data-testid="tile-wallet-badge"]')!.textContent).toBe('Recommended')
    expect(q('[data-testid="tile-create-badge"]')).toBeNull()
  })

  it('keeps every other way in under one collapsed Other ways to sign in', async () => {
    auth.vaults = []
    platformUp = true
    v2Available = true
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    const more = q<HTMLButtonElement>('[data-testid="signin-more"]')!
    expect(more.tagName).toBe('BUTTON')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    const panel = host.ownerDocument.getElementById(more.getAttribute('aria-controls')!)!
    expect(panel.hidden).toBe(true)
    expect(panel.contains(q('[data-testid="signin-help"]'))).toBe(true)
    expect(panel.contains(q('[data-testid="signin-key-limits"]'))).toBe(true)
    expect(panel.contains(q('[data-testid="tile-create-cost"]'))).toBe(true)
    expect(panel.contains(byText('Advanced'))).toBe(true)
    await click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(panel.hidden).toBe(false)
    expect(shownTiles()).toEqual(['tile-wallet', 'tile-import', 'tile-dg', 'tile-create'])
  })

  it('on testnet with v2 on offer, the wallet leads and names its testnet build; creating stays recommended for newcomers', async () => {
    auth.vaults = []
    platformUp = true
    v2Available = true
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    expect(shownTiles()).toEqual(['tile-wallet'])
    expect(q('[data-testid="tile-wallet"]')!.dataset['muted']).toBeUndefined()
    expect(q('[data-testid="tile-wallet"]')!.textContent).toMatch(/its testnet build/)
    expect(q('[data-testid="tile-wallet"]')!.textContent).not.toMatch(/#591/)
    expect(q('[data-testid="tile-create-cost"]')!.textContent).toMatch(/Testnet · free test credits/)
    expect(q('[data-testid="tile-get-dashpay"]')).toBeNull()
  })

  it('on mainnet with v2 on offer, newcomers get DashPay and sign in with it; recovery-phrase paths are under Advanced', async () => {
    network.override = 'mainnet'
    auth.vaults = []
    platformUp = true
    v2Available = true
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    expect(shownTiles()).toEqual(['tile-wallet', 'tile-get-dashpay'])
    expect(tileOrder()).toEqual(['tile-wallet', 'tile-get-dashpay', 'tile-dg'])
    expect(q('[data-testid="tile-wallet-badge"]')!.textContent).toBe('Recommended')
    expect(q('[data-testid="tile-create-badge"]')).toBeNull()
    expect(q('[data-testid="tile-get-dashpay"]')!.textContent).toBe('No DashPay yet? Get it first')
    expect(q('[data-testid="signin-more"]')!.textContent).toBe('Other ways to sign in')
    await click(q('[data-testid="tile-get-dashpay"]'))
    // The install step comes before any code: store links, then the username, then the code.
    expect(q('[data-testid="wallet-request"]')).toBeNull()
    expect(q<HTMLAnchorElement>('[data-testid="get-dashpay-android"]')!.href).toBe('https://play.google.com/store/apps/details?id=hashengineering.darkcoin.wallet')
    expect(q<HTMLAnchorElement>('[data-testid="get-dashpay-ios"]')!.href).toBe('https://apps.apple.com/app/id1206647026')
    expect(q('[data-testid="get-dashpay"]')!.textContent).toMatch(/Create your username in DashPay/)
    await click(q('[data-testid="get-dashpay-continue"]'))
    expect(q('[data-testid="get-dashpay"]')).toBeNull()
    expect(q('[data-testid="wallet-request"]')).not.toBeNull()
  })

  it('on mainnet with writes paused, the Get DashPay link is not offered (its last step would open the wallet code)', async () => {
    network.override = 'mainnet'
    paused = 'Writes are paused for maintenance.'
    auth.vaults = []
    platformUp = true
    v2Available = true
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    expect(q('[data-testid="tile-wallet"]')).not.toBeNull()
    expect(q('[data-testid="tile-get-dashpay"]')).toBeNull()
  })

  it('at a protocol no released wallet reads (testnet at 15), creating leads and the wallet tile says why, under Other ways', async () => {
    auth.vaults = []
    platformUp = true
    v2Available = true
    releasedWallet = false
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    expect(tileOrder()).toEqual(['tile-create', 'tile-import', 'tile-dg', 'tile-wallet'])
    expect(q('[data-testid="tile-create-badge"]')!.textContent).toBe('Recommended')
    expect(q('[data-testid="tile-wallet"]')!.dataset['muted']).toBe('true')
    expect(q('[data-testid="tile-wallet"]')!.textContent).toMatch(/Released DashPay builds can't sign in on testnet since its latest Platform upgrade/)
    expect(q('[data-testid="tile-get-dashpay"]')).toBeNull()
  })

  it('on mainnet without v2, creating stays first: there is no wallet to finish in yet', async () => {
    network.override = 'mainnet'
    auth.vaults = []
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    expect(tileOrder()).toEqual(['tile-create', 'tile-dg', 'tile-wallet'])
    expect(q('[data-testid="tile-get-dashpay"]')).toBeNull()
    expect(byText('Other ways to sign in', 'h3')).toBeNull()
  })

  it('keeps the wallet tile last, muted, when Platform could not be asked', async () => {
    auth.vaults = []
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    expect(tileOrder()).toEqual(['tile-create', 'tile-import', 'tile-dg', 'tile-wallet'])
    expect(q('[data-testid="tile-wallet"]')!.dataset['muted']).toBe('true')
    expect(q('[data-testid="tile-wallet"]')!.textContent).not.toMatch(/DashConnect|testnet only/)
  })

  it('keeps the wallet tile when Platform answered but its protocol could not be read', async () => {
    auth.vaults = []
    platformUp = true
    v2Available = null
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    expect(tileOrder()).toEqual(['tile-create', 'tile-import', 'tile-dg', 'tile-wallet'])
  })

  it('shows no wallet tile where the chain answered without App Connect v2 (no older code to offer)', async () => {
    auth.vaults = []
    platformUp = true
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 20; i++) await flush()
    expect(q('[data-testid="tile-wallet"]')).toBeNull()
    // The other ways in all stay: create, recovery phrase or identity file, dg, and raw key paste under Advanced.
    expect(tileOrder()).toEqual(['tile-create', 'tile-import', 'tile-dg'])
    await click(byText('Advanced'))
    expect(tileOrder()).toEqual(['tile-create', 'tile-import', 'tile-dg', 'tile-advanced'])
  })

  it('replaces a key from the older wallet code on its own view, wallet first, with the identity file as the other way', async () => {
    auth.identity = ID
    auth.keyId = 6
    auth.storage = 'vault'
    auth.unlockScope = 'full'
    act(() => useUiStore.getState().openLogin('wallet-replace'))
    await flush()
    const body = host.ownerDocument.body.textContent ?? ''
    expect(body).toMatch(/Replace this browser's key/)
    expect(body).toMatch(/One approval gives a limited key for all of Forge/)
    expect(byText(/All options/)).toBeNull()
    expect(q('[data-testid="wallet-request"]')).not.toBeNull()
    await click(q('[data-testid="renew-with-file-instead"]'))
    expect(q('[data-testid="wallet-request"]')).toBeNull()
    expect(host.ownerDocument.body.textContent).toMatch(/Disables key #6 and registers/)
  })

  it('opens the renewal in the wallet on its own view, with the identity file as the other way', async () => {
    auth.identity = ID
    auth.keyId = 6
    auth.storage = 'vault'
    auth.unlockScope = 'full'
    act(() => useUiStore.getState().openLogin('wallet-renew'))
    await flush()
    const body = host.ownerDocument.body.textContent ?? ''
    expect(body).toMatch(/Renew this browser's key in your wallet/)
    expect(body).not.toMatch(/Sign in to Dash Forge/)
    expect(byText(/All options/)).toBeNull()
    expect(q('[data-testid="wallet-renew-prepare"]')).not.toBeNull()
    await click(q('[data-testid="renew-with-file-instead"]'))
    expect(q('[data-testid="wallet-renew-prepare"]')).toBeNull()
    expect(host.ownerDocument.body.textContent).toMatch(/Disables key #6 and registers/)
  })
})

describe('Sign in with a passkey (passkeys that hold a key on Platform)', () => {
  const openChooser = async (): Promise<void> => {
    auth.vaults = []
    act(() => useUiStore.getState().openLogin())
    await flush()
  }

  it('is hidden while passkeys are not offered here (not checked, another host, no vault deployed yet)', async () => {
    await openChooser()
    expect(q('[data-testid="tile-passkey"]')).toBeNull()
    // The rest of the list is there.
    expect(q('[data-testid="tile-create"]')).not.toBeNull()
  })

  it('shows once passkeys are offered, first for an existing identity, and says what it does not do', async () => {
    auth.passkeyProblem = null
    await openChooser()
    for (let i = 0; i < 20 && q('[data-testid="tile-wallet"]') === null; i++) await flush()
    const order = [...host.ownerDocument.querySelectorAll<HTMLElement>('button[data-testid^="tile-"]')].map((b) => b.dataset.testid)
    expect(order.slice(0, 3)).toEqual(['tile-create', 'tile-passkey', 'tile-import'])
    expect(q('[data-testid="tile-passkey"]')!.textContent).toMatch(/Sign in with a passkey/)
    expect(q('[data-testid="tile-passkey"]')!.textContent).toMatch(/It doesn't recover an account/)
  })

  it('signs in with one prompt and closes the sheet', async () => {
    auth.passkeyProblem = null
    auth.signInWithPasskey.mockResolvedValueOnce(undefined)
    await openChooser()
    await click(q('[data-testid="tile-passkey"]'))
    expect(auth.signInWithPasskey).toHaveBeenCalledTimes(1)
    expect(useUiStore.getState().loginOpen).toBe(false)
  })

  it('shows the step while it works', async () => {
    auth.passkeyProblem = null
    auth.isLoading = true
    auth.step = 'Waiting for your passkey'
    await openChooser()
    expect(q('[data-testid="passkey-sign-in-step"]')!.textContent).toBe('Waiting for your passkey…')
  })

  it('says a browser-only passkey only unlocks the browser that made it', async () => {
    auth.passkeyProblem = null
    auth.signInWithPasskey.mockRejectedValueOnce(new PlatformPasskeyError('This passkey only unlocks the browser that made it. Use it there, or sign in another way.', 'not-vault'))
    await openChooser()
    await click(q('[data-testid="tile-passkey"]'))
    expect(q('[role="alert"]')!.textContent).toMatch(/only unlocks the browser that made it/)
    expect(q('[data-testid="passkey-unlock-instead"]')).toBeNull()
    expect(useUiStore.getState().loginOpen).toBe(true)
  })

  it('offers "Unlock instead" when this browser already keeps a key', async () => {
    auth.passkeyProblem = null
    auth.signInWithPasskey.mockRejectedValueOnce(new PlatformPasskeyError('This browser already keeps this key. Unlock it instead.', 'held'))
    await openChooser()
    auth.vaults = [{ identityId: ID, keyId: 6, createdAt: 1_700_000_000_000, methods: ['passphrase'] }]
    await click(q('[data-testid="tile-passkey"]'))
    expect(q('[role="alert"]')!.textContent).toMatch(/already keeps this key/)
    await click(q('[data-testid="passkey-unlock-instead"]'))
    // The Unlock view, for the key this browser holds.
    expect(q('#unlock-passphrase')).not.toBeNull()
  })
})

describe('after a new identity registers (F13, F14)', () => {
  const finish = async (): Promise<void> => {
    auth.vaults = []
    act(() => useUiStore.getState().openLogin('create'))
    await flush()
    await click(q('[data-testid="fake-create-done"]'))
    for (let i = 0; i < 5; i++) await flush()
  }

  it("lands on \"You're in\" with next steps, not a closed sheet", async () => {
    await finish()
    expect(useUiStore.getState().loginOpen).toBe(true)
    expect(host.ownerDocument.body.textContent).toMatch(/You're in/)
    expect(q('[data-testid="welcome-new-repo"]')!.getAttribute('href')).toMatch(/^\/new\/?$/)
    expect(q('[data-testid="welcome-mirror"]')!.getAttribute('href')).toMatch(/^\/mirror\/?$/)
    expect(q('[data-testid="welcome-explore"]')!.getAttribute('href')).toMatch(/^\/explore\/?$/)
    expect(byText(/All options/)).toBeNull()
    expect(q('[data-testid="welcome-leftover"]')).toBeNull()
    // The identity registered, so its lock was broadcast: it counts as a spend.
    expect(balanceCalls).toEqual([[expect.any(String), WELCOME_DEPOSIT, { countLock: true }]])
    await click(q('[data-testid="welcome-done"]'))
    expect(useUiStore.getState().loginOpen).toBe(false)
  })

  it('closing on the welcome view and reopening lands on the chooser, not the welcome view', async () => {
    await finish()
    await click(q('[data-testid="welcome-done"]'))
    act(() => useUiStore.getState().openLogin())
    for (let i = 0; i < 5; i++) await flush()
    expect(q('[data-testid="signup-welcome"]')).toBeNull()
    expect(q('[data-testid="tile-create"]')).not.toBeNull()
  })

  it('says it is checking the deposit address while the check runs', async () => {
    leftover = new Promise<number>(() => undefined)
    await finish()
    expect(q('[data-testid="welcome-deposit-checking"]')).not.toBeNull()
  })

  it('warns when a second payment is still on the deposit address', async () => {
    leftover = 100_000_000
    await finish()
    const warning = q('[data-testid="welcome-leftover"]')!
    expect(warning.getAttribute('role')).toBe('alert')
    expect(warning.textContent).toMatch(/1 DASH/)
    expect(warning.textContent).toMatch(/yDepositAddressForTheWelcomeView1/)
    expect(warning.textContent).toMatch(/Only your 12 words can recover it/)
  })

  it('says so when the deposit address could not be checked', async () => {
    leftover = new Error('no node answered')
    await finish()
    expect(q('[data-testid="welcome-deposit-unknown"]')).not.toBeNull()
  })

  it('an unreadable creation record shows the "could not check" line, not silence', async () => {
    createdDeposit = 'unreadable'
    await finish()
    expect(q('[data-testid="welcome-deposit-unknown"]')).not.toBeNull()
    expect(q('[data-testid="welcome-deposit-checking"]')).toBeNull()
    expect(balanceCalls).toEqual([])
  })
})

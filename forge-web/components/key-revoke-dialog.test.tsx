// @vitest-environment jsdom
/**
 * "Revoke on chain" after a reload (QA wave 3, bonsia):
 * - QW3-006: the tab holds only its signing key, so the revoke unlocks first. The unlock form
 *   used to sit inside the revoke form; its Unlock button then submitted the page (a reload to
 *   `/settings/?`) and nothing was revoked. It is outside now, offered before the master key, and
 *   a revoke that finds the tab locked carries on after the unlock with the words still given.
 * - QW3-028: words that are another identity's stay in the field, with the error, to correct.
 * - QW3-030: the dialog prices the update before it is signed.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UnlockNeededError } from '@/lib/auth/controller'
import { idbPut, resetMemoryStores } from '@/lib/idb'
import { ACTIVE_NETWORK } from '@/lib/constants'
import { WrongMasterKeyError } from '@/lib/auth/limited-key'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const WORDS = Array(12).fill('abandon').join(' ')
const PASS = 'fake-passphrase-not-real-123'

const auth = {
  scope: 'signing' as 'signing' | 'full',
  revokeStored: vi.fn(async (_id: string, _input: unknown): Promise<void> => undefined),
  unlockMore: vi.fn(async (_m: unknown): Promise<void> => {
    auth.scope = 'full'
  }),
}

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: ID,
    keyId: 6,
    isLoading: false,
    unlockScope: auth.scope,
    revokeStored: auth.revokeStored,
    vaults: [{ identityId: ID, keyId: 6, createdAt: 0, methods: ['passphrase'] }],
    controller: { unlockMore: auth.unlockMore },
  }),
}))

const { KeyRevokeDialog } = await import('./key-revoke-dialog')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const button = (text: RegExp): HTMLButtonElement => [...host.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement
const render = (): void => act(() => root.render(<KeyRevokeDialog unlimited={false} onClose={onClose} />))
async function unlock(): Promise<void> {
  act(() => type(host.querySelector<HTMLInputElement>('#revoke-unlock-passphrase')!, PASS))
  await act(async () => button(/^Unlock$/).click())
  render()
}
async function giveWords(): Promise<void> {
  act(() => button(/^Recovery phrase$/).click())
  act(() => type(host.querySelector('textarea')!, WORDS))
}

beforeEach(() => {
  auth.scope = 'signing'
  auth.revokeStored.mockReset()
  auth.unlockMore.mockClear()
  onClose.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('KeyRevokeDialog', () => {
  it('QW3-006: a reloaded tab unlocks first, outside the revoke form, then revokes', async () => {
    const submits: boolean[] = []
    document.addEventListener('submit', (e) => submits.push(e.defaultPrevented))
    render()
    // The unlock is no form inside a form (that submitted the page), and comes first.
    expect(host.querySelector('form form')).toBeNull()
    expect(host.querySelector('[data-testid="revoke-unlock"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="key-revoke-dialog"] [data-testid="revoke-unlock"]')).toBeNull()
    await giveWords()
    expect(button(/Sign once & revoke/).disabled).toBe(true)
    await unlock()
    expect(auth.unlockMore).toHaveBeenCalledWith({ passphrase: PASS })
    // Every submit the page saw was handled by the app: none reloads the page.
    expect(submits.every((prevented) => prevented)).toBe(true)
    expect(host.querySelector('[data-testid="revoke-unlock"]')).toBeNull()
    await act(async () => button(/Sign once & revoke/).click())
    expect(auth.revokeStored).toHaveBeenCalledWith(ID, { mnemonic: WORDS })
    expect(onClose).toHaveBeenCalled()
  })

  it('a revoke that finds the tab locked carries on after the unlock, with the words given', async () => {
    auth.scope = 'full'
    auth.revokeStored.mockRejectedValueOnce(new UnlockNeededError('unlock first')).mockResolvedValueOnce(undefined)
    render()
    await giveWords()
    await act(async () => button(/Sign once & revoke/).click())
    render()
    expect(host.querySelector('[data-testid="revoke-unlock"]')).not.toBeNull()
    await unlock()
    expect(auth.revokeStored).toHaveBeenCalledTimes(2)
    expect(auth.revokeStored.mock.calls[1]).toEqual([ID, { mnemonic: WORDS }])
    expect(onClose).toHaveBeenCalled()
  })

  it("QW3-028: another identity's words stay in the field beside a plain error", async () => {
    auth.scope = 'full'
    auth.revokeStored.mockRejectedValueOnce(new WrongMasterKeyError(ID, 'This recovery phrase belongs to identity 9CVMSjk…, not 9r27eDs… (the identity signed in here).'))
    render()
    await giveWords()
    await act(async () => button(/Sign once & revoke/).click())
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/belongs to identity 9CVMSjk…, not 9r27eDs…/)
    expect(host.querySelector('textarea')!.value).toBe(WORDS)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('any other failure does not keep the master key on the page', async () => {
    auth.scope = 'full'
    auth.revokeStored.mockRejectedValueOnce(new Error('Failed to broadcast update: timeout'))
    render()
    await giveWords()
    await act(async () => button(/Sign once & revoke/).click())
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/timeout/)
    expect(host.querySelector('textarea')!.value).toBe('')
  })

  it('QW3-034: says what stays when the identity was topped up in this browser', async () => {
    auth.scope = 'full'
    await idbPut('journal', `top-up-next:${ACTIVE_NETWORK.network}:${ID}`, { index: 2 })
    render()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(host.querySelector('[data-testid="revoke-top-up-stays"]')!.textContent).toMatch(/where your next top-up starts/)
    resetMemoryStores()
  })

  it('QW4-021: says the forget after it deletes the spend history and notifications here', () => {
    auth.scope = 'full'
    render()
    const note = host.querySelector('[data-testid="revoke-forget-deletes"]')!.textContent ?? ''
    expect(note).toMatch(/spend history \(Settings → Spend\)/)
    expect(note).toMatch(/notifications/)
  })

  it('QW3-030: prices the update before it is signed', () => {
    auth.scope = 'full'
    render()
    expect(host.querySelector('[data-testid="cost-preview"]')!.textContent).toMatch(/~0\.000023 DASH/)
  })
})

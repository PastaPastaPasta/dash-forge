// @vitest-environment jsdom
/**
 * Devices & keys, "Disable all other keys": the button offers exactly the keys that can be
 * disabled one by one (never this browser's key, the master, encryption or another app's), the
 * dialog names them, and one master-key signature sends them to the controller.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMemoryStores } from '@/lib/idb'
import type { KeyRow } from '@/lib/auth/devices'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const WORDS = Array(12).fill('abandon').join(' ')

const row = (keyId: number, role: KeyRow['role'], o: Partial<KeyRow> = {}): KeyRow => ({
  keyId,
  role,
  kind: role === 'signing' || role === 'forge-contract' ? 'wallet' : role === 'forge' ? 'forge-limited' : 'other',
  bounds: role === 'signing' ? 'any contract' : 'Forge contract group',
  current: false,
  purpose: role === 'encryption' ? 1 : 0,
  level: role === 'master' ? 0 : 2,
  disabledAt: null,
  budgetTotal: null,
  budgetLeft: null,
  expiresAt: null,
  thisBrowser: false,
  ...o,
})

const rows: KeyRow[] = [
  row(0, 'master', { level: 0 }),
  row(1, 'signing'), // a wallet sign-in
  row(4, 'encryption'),
  row(9, 'forge', { thisBrowser: true, current: true }),
  row(10, 'forge'),
  row(11, 'forge-contract'), // the iOS wallet's key
  row(12, 'forge', { disabledAt: 5 }),
  row(14, 'other', { kind: 'other', bounds: 'contract group X' }),
]

const auth = {
  identityKeys: vi.fn(async (): Promise<KeyRow[]> => rows),
  disableOtherKeys: vi.fn(async (_input: unknown, onProgress?: (done: number, total: number) => void): Promise<number[]> => {
    onProgress?.(4, 4)
    return [1, 10, 11, 14]
  }),
}

// One object for every render: the page reloads its keys whenever the controller changes.
const session = {
  identity: ID,
  isLoading: false,
  newKeys: [],
  controller: { identityKeys: auth.identityKeys, disableOtherKeys: auth.disableOtherKeys },
}
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => session }))

const { DevicesKeys } = await import('./devices-keys')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function type(el: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const button = (text: RegExp): HTMLButtonElement => [...host.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement
const render = async (): Promise<void> => {
  await act(async () => root.render(<DevicesKeys />))
}

beforeEach(() => {
  resetMemoryStores()
  localStorage.clear()
  auth.identityKeys.mockClear()
  auth.disableOtherKeys.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('Disable all other keys', () => {
  it('counts the keys it would disable and lists them in a confirm dialog', async () => {
    await render()
    expect(host.querySelector('[data-testid="disable-others"]')!.textContent).toMatch(/Disables the 4 signing keys other than this browser's, wallet sign-ins/)
    expect(document.querySelector('[data-testid="disable-others-dialog"]')).toBeNull()
    await act(async () => button(/Disable all other keys/).click())
    const listed = [...document.querySelectorAll('[data-testid="disable-others-list"] li')].map((li) => li.getAttribute('data-key-id'))
    // Wallet sign-ins and another app's key are listed too; this browser's key, the master and
    // the encryption key are not.
    expect(listed).toEqual(['1', '10', '11', '14'])
    const kinds = [...document.querySelectorAll('[data-testid="disable-others-list"] li')].map((li) => li.getAttribute('data-kind'))
    expect(kinds).toEqual(['wallet', 'forge-limited', 'wallet', 'other'])
    expect(document.querySelector('[data-testid="disable-others-list"]')!.textContent).toMatch(/wallet sign-in: any contract/)
    expect(document.querySelector('[data-testid="disable-others-warning"]')!.textContent).toMatch(/wallet sign-in, for one\) will need to sign in again/)
    expect(document.querySelector('[data-testid="disable-others-encryption-note"] a')!.getAttribute('href')).toMatch(/#replacing-it-after-a-lost-device$/)
    expect(auth.disableOtherKeys).not.toHaveBeenCalled()
  })

  it('signs once with the master key and reloads the list', async () => {
    await render()
    await act(async () => button(/Disable all other keys/).click())
    act(() => button(/^Recovery phrase$/).click())
    act(() => type(document.querySelector('[data-testid="disable-others-dialog"] textarea')!, WORDS))
    await act(async () => button(/Sign & disable 4 keys/).click())
    expect(auth.disableOtherKeys).toHaveBeenCalledTimes(1)
    expect(auth.disableOtherKeys.mock.calls[0]![0]).toEqual({ mnemonic: WORDS })
    // The dialog closed and the page read the keys again.
    expect(document.querySelector('[data-testid="disable-others-dialog"]')).toBeNull()
    expect(auth.identityKeys).toHaveBeenCalledTimes(2)
  })

  it('a failure stays in the dialog and keeps nothing of the master key', async () => {
    auth.disableOtherKeys.mockRejectedValueOnce(new Error('Disabled 10 of 12 keys, then it stopped: timeout. Run it again to disable the rest.'))
    await render()
    await act(async () => button(/Disable all other keys/).click())
    act(() => button(/^Recovery phrase$/).click())
    act(() => type(document.querySelector('[data-testid="disable-others-dialog"] textarea')!, WORDS))
    await act(async () => button(/Sign & disable 4 keys/).click())
    expect(document.querySelector('[role="alert"]')!.textContent).toMatch(/Disabled 10 of 12 keys/)
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="disable-others-dialog"] textarea')!.value).toBe('')
  })

  it('offers nothing when no other key can be disabled', async () => {
    auth.identityKeys.mockResolvedValueOnce(rows.filter((r) => [0, 4, 9, 12].includes(r.keyId)))
    await render()
    expect(host.querySelector('[data-testid="disable-others"]')).toBeNull()
  })
})

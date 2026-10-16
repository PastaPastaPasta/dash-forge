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
  row(1, 'signing'),
  row(4, 'encryption'),
  row(9, 'forge', { thisBrowser: true }),
  row(10, 'forge'),
  row(11, 'forge-contract'),
  row(12, 'forge', { disabledAt: 5 }),
  row(14, 'other'),
]

const auth = {
  identityKeys: vi.fn(async (): Promise<KeyRow[]> => rows),
  disableOtherKeys: vi.fn(async (_input: unknown, onProgress?: (done: number, total: number) => void): Promise<number[]> => {
    onProgress?.(2, 2)
    return [10, 11]
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
    expect(host.querySelector('[data-testid="disable-others"]')!.textContent).toMatch(/Disables the 2 Forge keys other than this browser/)
    expect(document.querySelector('[data-testid="disable-others-dialog"]')).toBeNull()
    await act(async () => button(/Disable all other keys/).click())
    const listed = [...document.querySelectorAll('[data-testid="disable-others-list"] li')].map((li) => li.getAttribute('data-key-id'))
    expect(listed).toEqual(['10', '11'])
    expect(auth.disableOtherKeys).not.toHaveBeenCalled()
  })

  it('signs once with the master key and reloads the list', async () => {
    await render()
    await act(async () => button(/Disable all other keys/).click())
    act(() => button(/^Recovery phrase$/).click())
    act(() => type(document.querySelector('[data-testid="disable-others-dialog"] textarea')!, WORDS))
    await act(async () => button(/Sign & disable 2 keys/).click())
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
    await act(async () => button(/Sign & disable 2 keys/).click())
    expect(document.querySelector('[role="alert"]')!.textContent).toMatch(/Disabled 10 of 12 keys/)
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="disable-others-dialog"] textarea')!.value).toBe('')
  })

  it('offers nothing when no other key can be disabled', async () => {
    auth.identityKeys.mockResolvedValueOnce(rows.filter((r) => r.keyId < 10))
    await render()
    expect(host.querySelector('[data-testid="disable-others"]')).toBeNull()
  })
})

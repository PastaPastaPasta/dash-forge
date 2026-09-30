// @vitest-environment jsdom
/**
 * Discarding an unfinished renewal with its passphrase: the passphrase input is uncontrolled, so
 * the typed passphrase never lands in the DOM's `value` attribute.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const FAKE_PASSPHRASE = 'fake-renewal-passphrase-456'
const abandonPendingRenewal = vi.fn(async (_id: string, _with?: unknown) => undefined)

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    controller: {
      pendingRenewal: async () => ({ keyId: 7, createdAt: 1_700_000_000_000, methods: ['passphrase'] }),
      abandonPendingRenewal,
    },
    logout: () => undefined,
  }),
}))

const { PendingRenewal } = await import('./pending-renewal')

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

beforeEach(() => {
  abandonPendingRenewal.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('PendingRenewal', () => {
  it('keeps the renewal passphrase out of the DOM and discards with it', async () => {
    await act(async () => root.render(<PendingRenewal identityId={ID} />))
    await act(async () => byText('Discard').click())
    const input = host.querySelector<HTMLInputElement>('#discard-renewal-passphrase')!
    expect(byText('Keep its key and discard').disabled).toBe(true)
    act(() => type(input, FAKE_PASSPHRASE))
    expect(input.getAttribute('value') ?? '').not.toContain(FAKE_PASSPHRASE)
    expect(document.body.innerHTML).not.toContain(FAKE_PASSPHRASE)
    expect(byText('Keep its key and discard').disabled).toBe(false)
    await act(async () => byText('Keep its key and discard').click())
    expect(abandonPendingRenewal).toHaveBeenCalledWith(ID, { passphrase: FAKE_PASSPHRASE })
  })
})

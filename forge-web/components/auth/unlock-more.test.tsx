// @vitest-environment jsdom
/**
 * The "Unlock to …" passphrase is an uncontrolled input: React mirrors a controlled input's value
 * into the `value` attribute, which put the passphrase in the DOM.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const FAKE_PASSPHRASE = 'fake-passphrase-not-real-123'
const unlockMore = vi.fn(async (_method: unknown) => undefined)

const session = vi.hoisted(() => ({ whole: false }))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: session.whole ? null : ID,
    locked: session.whole,
    vaults: [{ identityId: ID, keyId: 6, createdAt: 0, methods: ['passphrase'] }],
    controller: { unlockMore },
    isLoading: false,
  }),
}))

const { UnlockMore } = await import('./unlock-more')
const { useUiStore } = await import('@/hooks/use-ui-store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function type(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  unlockMore.mockClear()
  session.whole = false
  useUiStore.getState().closeLogin()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('UnlockMore', () => {
  it('keeps the typed passphrase out of the DOM and still unlocks with it', async () => {
    act(() => root.render(<UnlockMore title="Unlock" />))
    const input = host.querySelector<HTMLInputElement>('#unlock-more-passphrase')!
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true)
    act(() => type(input, FAKE_PASSPHRASE))
    expect(input.getAttribute('value') ?? '').not.toContain(FAKE_PASSPHRASE)
    expect(document.body.innerHTML).not.toContain(FAKE_PASSPHRASE)
    expect(submit.disabled).toBe(false)
    await act(async () => submit.click())
    expect(unlockMore).toHaveBeenCalledWith({ passphrase: FAKE_PASSPHRASE })
    expect(input.value).toBe('')
  })

  it('over a fully locked session offers the header\'s Unlock, not a passphrase field (R8)', () => {
    session.whole = true
    act(() => root.render(<UnlockMore title="Unlock to read members-only content" />))
    expect(host.querySelector('input')).toBeNull()
    expect(useUiStore.getState().loginOpen).toBe(false)
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="unlock-more-open"]')!.click())
    expect(useUiStore.getState().loginOpen).toBe(true)
  })
})

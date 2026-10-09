// @vitest-environment jsdom
/**
 * #452 "Choose a username": the name is checked as typed, then read once per pause; a contested
 * name is explained and swapped for one that is not; a free name is priced and signed once with
 * the identity's own key; a name registered with `dg` is picked up by "check again".
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ID = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const OTHER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const WORDS = Array(11).fill('abandon').concat('about').join(' ')

const h = vi.hoisted(() => ({
  holders: new Map<string, string>(),
  failRead: false,
  reads: [] as string[],
  register: vi.fn(async (_input: unknown, label: string) => `${label}.dash`),
  ownName: null as string | null,
  balance: '500000000' as string | null,
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ identity: ID, balance: h.balance, isLoading: false, registerUsername: h.register }),
}))
// One connection object, as the real hook keeps: a new one per render would re-run the read.
const SDK = {}
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: SDK, ready: true, network: 'devnet' }) }))
vi.mock('@/lib/view/dpns', async (orig) => ({
  ...(await orig<typeof import('@/lib/view/dpns')>()),
  dpnsLabelHolder: async (_sdk: unknown, label: string) => {
    h.reads.push(label)
    if (h.failRead) throw new Error('quorum not found')
    return h.holders.get(label.toLowerCase()) ?? null
  },
  lookupDpnsName: async () => h.ownName,
}))

const { UsernameDialog, AVAILABILITY_DEBOUNCE_MS } = await import('./username-dialog')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const q = (testId: string): HTMLElement | null => host.querySelector(`[data-testid="${testId}"]`)
const button = (text: RegExp): HTMLButtonElement => [...host.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement
async function typeName(name: string): Promise<void> {
  act(() => type(host.querySelector<HTMLInputElement>('#username-input')!, name))
  await act(async () => {
    vi.advanceTimersByTime(AVAILABILITY_DEBOUNCE_MS + 1)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  h.holders = new Map([['qa-taken-7', OTHER]])
  h.failRead = false
  h.reads = []
  h.register.mockClear()
  h.ownName = null
  h.balance = '500000000'
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<UsernameDialog onClose={() => undefined} />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('UsernameDialog', () => {
  it('says why an invalid name cannot be one, without a read', async () => {
    await typeName('a_b')
    expect(q('username-status')?.textContent).toMatch(/only letters/i)
    expect(h.reads).toEqual([])
  })

  it('explains a contested name and offers variants that are not', async () => {
    await typeName('alice')
    expect(q('username-contested')?.textContent).toMatch(/masternode vote/)
    expect(q('username-contested')?.textContent).toMatch(/0\.1 DASH/)
    expect(h.reads).toEqual([])
    act(() => button(/^alice2$/).click())
    await act(async () => {
      vi.advanceTimersByTime(AVAILABILITY_DEBOUNCE_MS + 1)
    })
    expect(host.querySelector<HTMLInputElement>('#username-input')!.value).toBe('alice2')
    expect(q('username-free')).not.toBeNull()
  })

  it('reads once per pause and says a taken name is taken', async () => {
    act(() => type(host.querySelector<HTMLInputElement>('#username-input')!, 'qa-ta'))
    act(() => type(host.querySelector<HTMLInputElement>('#username-input')!, 'qa-taken-7'))
    await act(async () => {
      vi.advanceTimersByTime(AVAILABILITY_DEBOUNCE_MS + 1)
    })
    expect(h.reads).toEqual(['qa-taken-7'])
    expect(q('username-taken')?.textContent).toMatch(/is taken/)
    expect(q('username-register')).toBeNull()
  })

  it('never reads a failed check as free', async () => {
    h.failRead = true
    await typeName('fresh-name-7')
    expect(q('username-check-failed')?.textContent).toMatch(/Couldn.t check/)
    expect(q('username-register')).toBeNull()
    h.failRead = false
    act(() => button(/check again/i).click())
    await act(async () => {
      vi.advanceTimersByTime(AVAILABILITY_DEBOUNCE_MS + 1)
    })
    expect(q('username-free')).not.toBeNull()
  })

  it('prices a free name and signs it once with the identity’s key', async () => {
    await typeName('Fresh-Name-7')
    expect(q('cost-preview')?.textContent).toMatch(/0\.00071–0\.001 DASH/)
    const register = q('username-register') as HTMLButtonElement
    expect(register.disabled).toBe(true)
    act(() => button(/Recovery phrase/).click())
    act(() => type(host.querySelector<HTMLTextAreaElement>('#username-mnemonic')!, WORDS))
    expect(register.disabled).toBe(false)
    await act(async () => {
      register.click()
    })
    expect(h.register).toHaveBeenCalledWith({ mnemonic: WORDS }, 'Fresh-Name-7')
    expect(q('username-done')?.textContent).toMatch(/Fresh-Name-7\.dash is your username/)
    expect(q('username-done')?.textContent).toMatch(/not stored/)
  })

  it('does not offer to sign below the registration’s cost', async () => {
    h.balance = '1000000'
    await typeName('fresh-name-7')
    expect(q('username-low-balance')).not.toBeNull()
    expect((q('username-register') as HTMLButtonElement).disabled).toBe(true)
  })

  it('hands over the dg command and picks up a name registered with it', async () => {
    await typeName('fresh-name-7')
    expect(q('username-command')?.textContent).toMatch(/^dg auth name register fresh-name-7 --master <identity file> --network /)
    await act(async () => {
      q('username-check-again')!.click()
    })
    expect(host.textContent).toMatch(/No username for this identity yet/)
    h.ownName = 'fresh-name-7.dash'
    await act(async () => {
      q('username-check-again')!.click()
    })
    expect(q('username-done')?.textContent).toMatch(/fresh-name-7\.dash is your username/)
    expect(q('username-done')?.textContent).not.toMatch(/not stored/)
  })
})

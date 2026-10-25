// @vitest-environment jsdom
/**
 * `platformPasskeyProblem`, the one flag every passkey control hides behind. It starts hidden, and
 * stays hidden on a page or network that cannot have passkeys. Where it can, it is lifted only
 * once the forge-meta Platform serves is read and has the vault's entry type: that read waits for
 * someone who could use passkeys (signed in, or the sign-in sheet open), so a page that never
 * connects to Platform does not start to for this.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '@/hooks/use-ui-store'

const NOT_YET = 'Checking whether passkeys work on this page.'
const NO_VAULT = "Passkeys that work on your other devices aren't available on this network yet."

const fake = vi.hoisted(() => ({
  sync: null as string | null,
  checked: null as string | null,
  check: undefined as unknown as ReturnType<typeof vi.fn>,
  session: null as { identityId: string; balance: string } | null,
}))

vi.mock('../lib/auth', () => {
  class AuthController {
    constructor() {
      // Every controller action the provider binds that this test does not care about.
      return new Proxy(this, { get: (target, key, receiver) => (key in target ? Reflect.get(target, key, receiver) : () => undefined) })
    }
    getState() {
      return { session: fake.session, isLoading: false, error: null, resuming: false }
    }
    subscribe() {
      return () => undefined
    }
    attach() {
      return () => undefined
    }
    async resume() {}
    async storedVaults() {
      return []
    }
    setSpendListener() {}
    supportsLimitedKeys() {
      return true
    }
    platformPasskeyProblem() {
      return fake.sync
    }
    checkPlatformPasskeys() {
      return fake.check()
    }
    get writeAuth() {
      return null
    }
  }
  return { AuthController }
})

const { AuthProvider, useAuth } = await import('./auth-context')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let seen: string | null | undefined

function Probe(): null {
  seen = useAuth().platformPasskeyProblem
  return null
}
async function mount(): Promise<void> {
  await act(async () => root.render(<AuthProvider network="devnet"><Probe /></AuthProvider>))
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  fake.sync = null
  fake.session = null
  fake.check = vi.fn(async () => fake.checked)
  fake.checked = null
  seen = undefined
  useUiStore.getState().closeLogin()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => useUiStore.getState().closeLogin())
  act(() => root.unmount())
  host.remove()
})

describe('platformPasskeyProblem in the auth context', () => {
  it('stays hidden, and reads nothing, while nobody could use passkeys', async () => {
    await mount()
    expect(seen).toBe(NOT_YET)
    expect(fake.check).not.toHaveBeenCalled()
  })

  it('a page or network that cannot have passkeys says why, without reading anything', async () => {
    fake.sync = 'This browser can’t use passkeys on this page.'
    act(() => useUiStore.getState().openLogin())
    await mount()
    expect(seen).toBe(fake.sync)
    expect(fake.check).not.toHaveBeenCalled()
  })

  it('opening the sign-in sheet reads forge-meta; a vault that is not deployed keeps the controls hidden', async () => {
    fake.checked = NO_VAULT
    await mount()
    await act(async () => useUiStore.getState().openLogin())
    expect(fake.check).toHaveBeenCalledTimes(1)
    expect(seen).toBe(NO_VAULT)
  })

  it('a deployed vault lifts the flag', async () => {
    fake.checked = null
    await mount()
    await act(async () => useUiStore.getState().openLogin())
    expect(seen).toBeNull()
  })

  it('a signed-in page reads it too', async () => {
    fake.session = { identityId: '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD', balance: '1' }
    fake.checked = NO_VAULT
    await mount()
    expect(fake.check).toHaveBeenCalledTimes(1)
    expect(seen).toBe(NO_VAULT)
  })
})

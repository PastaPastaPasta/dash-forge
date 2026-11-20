// @vitest-environment jsdom
/**
 * F21: while this browser's storage is too slow to say whether a key is kept here, the header
 * shows that it is still checking, never a plain "Sign in" that reads as a sign-out.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let auth: Record<string, unknown> = {}
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => auth }))

import { SignInButton } from './sign-in-button'

const base = { locked: false, resuming: false, vaultsLoaded: false, vaultsError: null, vaultsSlow: false, vaults: [] }

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

describe('SignInButton', () => {
  it('says the session is still being checked while storage is slow', () => {
    auth = { ...base, vaultsError: 'slow', vaultsSlow: true }
    act(() => root.render(<SignInButton label="long" />))
    expect(el.querySelector('[data-testid=session-storage-slow]')).not.toBeNull()
    expect(el.textContent).not.toContain('Sign in')
  })

  it('offers Sign in for any other read failure', () => {
    auth = { ...base, vaultsError: 'broken' }
    act(() => root.render(<SignInButton />))
    expect(el.querySelector('[data-testid=session-storage-slow]')).toBeNull()
    expect(el.textContent).toContain('Sign in')
  })

  it('offers Unlock when a list read earlier names a kept key', () => {
    auth = { ...base, vaultsLoaded: true, vaultsSlow: true, locked: true, vaults: [{ identityId: 'a' }] }
    act(() => root.render(<SignInButton />))
    expect(el.querySelector('[data-testid=session-unlock]')).not.toBeNull()
  })
})

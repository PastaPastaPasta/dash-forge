// @vitest-environment jsdom
/**
 * A signed-out visitor gets a sign-in card instead of the comment box; a locked session (a key to
 * unlock) and a session still being picked up keep the box.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let auth: Record<string, unknown> = {}
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => auth }))

import { SignedOutComposer, useSignedOut } from './signed-out-composer'

const base = { identity: null, locked: false, resuming: false, vaultsLoaded: true, vaultsError: null, vaultsSlow: false, vaults: [] }
const COST = { credits: 982_000_000, dash: 0.00982 } as Parameters<typeof SignedOutComposer>[0]['cost']

function Probe(): JSX.Element {
  return <>{useSignedOut() ? <SignedOutComposer cost={COST} /> : <textarea />}</>
}

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

describe('SignedOutComposer', () => {
  it('replaces the box for a signed-out visitor with Sign in and hides cost math', () => {
    auth = base
    act(() => root.render(<Probe />))
    expect(el.querySelector('[data-testid=signed-out-composer]')).not.toBeNull()
    expect(el.querySelector('textarea')).toBeNull()
    expect(el.textContent).toContain('Sign in to join the conversation')
    expect(el.querySelector('button')?.textContent).toBe('Sign in')
    expect(el.querySelector('[data-testid=cost-preview]')).toBeNull()
  })

  it.each([
    ['signed in', { identity: 'abc' }],
    ['locked', { locked: true }],
    ['resuming a kept session', { resuming: true }],
    ['still reading the stored keys', { vaultsLoaded: false }],
  ])('keeps the box when %s', (_name, patch) => {
    auth = { ...base, ...patch }
    act(() => root.render(<Probe />))
    expect(el.querySelector('[data-testid=signed-out-composer]')).toBeNull()
    expect(el.querySelector('textarea')).not.toBeNull()
  })
})

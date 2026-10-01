// @vitest-environment jsdom
/**
 * While the devnet is moving (`NEXT_PUBLIC_DEVNET_NOTICE=moving`) the write guard refuses every
 * write with the reason, even for a signed-in identity with funds; otherwise it is unchanged.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ paused: null as string | null }))
const toast = vi.hoisted(() => vi.fn())
const openLogin = vi.hoisted(() => vi.fn())

vi.mock('@/lib/devnet-notice', () => ({ writesPausedReason: () => state.paused }))
vi.mock('@/hooks/use-toasts', () => ({ toast }))
vi.mock('@/hooks/use-ui-store', () => ({
  useUiStore: (select: (s: unknown) => unknown) => select({ openLogin, openTopUp: vi.fn() }),
}))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: 'id1',
    signer: {},
    balance: '1000000000',
    funds: null,
    keyLimits: null,
    grants: null,
    refreshBalance: vi.fn(),
    resuming: false,
    unlockScope: null,
  }),
}))
vi.mock('@/lib/view/funds', () => ({ affordability: () => ({ ok: true }) }))

import { useWriteGuard, type WriteGuard } from './use-write-guard'

let root: Root
let el: HTMLDivElement
let guard: WriteGuard
function Probe(): null {
  guard = useWriteGuard()
  return null
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  state.paused = null
  toast.mockClear()
  openLogin.mockClear()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  act(() => root.render(<Probe />))
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

describe('useWriteGuard while the devnet is moving', () => {
  it('lets a funded, signed-in write through when no move is under way', () => {
    expect(guard.check(1000)).toBe(true)
    expect(guard.disabledReason).toBeNull()
  })

  it('refuses the write with a toast naming the reason, and shows it on every disabled button', () => {
    state.paused = 'Writing is paused: this devnet was retired and Dash Forge moved to devnet sakura.'
    act(() => root.render(<Probe />))
    expect(guard.check(1000)).toBe(false)
    expect(toast).toHaveBeenCalledWith({ title: 'Writing is paused', detail: state.paused })
    expect(openLogin).not.toHaveBeenCalled()
    expect(guard.disabledReason).toBe(state.paused)
  })
})

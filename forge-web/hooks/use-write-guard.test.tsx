// @vitest-environment jsdom
/**
 * While the devnet is moving (`NEXT_PUBLIC_DEVNET_NOTICE=moving`) the write guard refuses every
 * write with the reason, even for a signed-in identity with funds; otherwise it is unchanged.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ paused: null as string | null, origin: null as 'app-connect' | null }))
const toast = vi.hoisted(() => vi.fn())
const openLogin = vi.hoisted(() => vi.fn())
const openTopUp = vi.hoisted(() => vi.fn())
const recheckSession = vi.hoisted(() => vi.fn())

vi.mock('@/lib/devnet-notice', () => ({ writesPausedReason: () => state.paused }))
vi.mock('@/hooks/use-toasts', () => ({ toast }))
vi.mock('@/hooks/use-ui-store', () => ({
  useUiStore: (select: (s: unknown) => unknown) => select({ openLogin, openTopUp }),
}))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: 'id1',
    signer: {},
    balance: '1000000000',
    funds: null,
    keyLimits: null,
    grants: null,
    refreshBalance: vi.fn(async () => undefined),
    recheckSession,
    origin: state.origin,
    resuming: false,
    unlockScope: null,
  }),
}))
vi.mock('@/lib/view/funds', () => ({ affordability: () => ({ ok: true }) }))

import { ConsensusRefusal } from '@/lib/sdk/write'
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
  state.origin = null
  openTopUp.mockClear()
  recheckSession.mockReset().mockResolvedValue(undefined)
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

describe('useWriteGuard after a write fails on a wallet-granted key', () => {
  const refusal = (code: number) => new ConsensusRefusal(code, `refused ${code}`, {}, false)

  it("reads the refusal as App Connect does: a revoked key opens the renew sheet with the wallet's words", () => {
    state.origin = 'app-connect'
    act(() => root.render(<Probe />))
    expect(guard.failed(refusal(20006))).toMatch(/^Your wallet revoked this browser's access/)
    expect(openTopUp).toHaveBeenCalledWith({ blocker: 'key-disabled' })
    expect(recheckSession).not.toHaveBeenCalled()
  })

  it('checks the session again after a write outside the key\'s bounds (20014), and survives a failed read', async () => {
    state.origin = 'app-connect'
    recheckSession.mockRejectedValue(new Error('offline'))
    act(() => root.render(<Probe />))
    guard.failed(refusal(20014))
    await Promise.resolve()
    expect(recheckSession).toHaveBeenCalledTimes(1)
  })

  it('leaves any other key as it was', () => {
    guard.failed(refusal(20014))
    expect(guard.failed(refusal(20006))).not.toMatch(/wallet revoked/)
    expect(recheckSession).not.toHaveBeenCalled()
  })
})

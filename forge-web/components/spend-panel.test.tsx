// @vitest-environment jsdom
/**
 * Settings → Spend right after a reload: the session shows the kept balance (from when it was
 * kept), which predates the ledger's later rows. The unexplained line waits for a balance read
 * after the last row (asking for one once) instead of calling the gap "top-ups".
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpendRow } from '@/lib/spend'

const auth = { balance: '1000' as string, balanceReadAt: null as number | null }
const refreshBalance = vi.fn(async () => undefined)
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ identity: 'I', balance: auth.balance, balanceReadAt: auth.balanceReadAt, refreshBalance }),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: null, ready: false }) }))

const row = (at: number, credits: number): SpendRow => ({
  at,
  identityId: 'I',
  network: 'devnet',
  kind: 'create:comment',
  repo: 'R',
  documentId: String(at),
  estimateCredits: credits,
  actualCredits: credits,
})
// The baseline was 1000 before the first write; two writes of 100 and 50 since.
const ledger = { rows: [row(100, 100), row(200, 50)], baseline: { at: 100, credits: 1000n } }
vi.mock('@/lib/spend', async (orig) => ({
  ...(await orig<typeof import('@/lib/spend')>()),
  readLedger: async () => ledger.rows,
  readBaseline: async () => ledger.baseline,
}))

import { SpendPanel } from './spend-panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  refreshBalance.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<SpendPanel />)
  })
}
const q = (id: string): Element | null => host.querySelector(`[data-testid="${id}"]`)

describe('the spend reconciliation after a reload', () => {
  it('hides the gap while the balance is the kept session’s, and reads it once', async () => {
    // The kept balance is from before both writes: reconciling it would say −150 "top-ups".
    auth.balance = '1000'
    auth.balanceReadAt = null
    await render()
    expect(q('spend-reconcile')).toBeNull()
    expect(host.textContent).not.toMatch(/top-ups/)
    expect(q('spend-reconcile-pending')).not.toBeNull()
    expect(refreshBalance).toHaveBeenCalledTimes(1)
  })

  it('hides it for a balance read before the last row, too', async () => {
    auth.balance = '900'
    auth.balanceReadAt = 150
    await render()
    expect(q('spend-reconcile')).toBeNull()
    expect(refreshBalance).toHaveBeenCalledTimes(1)
  })

  it('shows the line once the balance is read after the last row', async () => {
    auth.balance = '850'
    auth.balanceReadAt = 250
    await render()
    expect(q('spend-reconcile')?.textContent).toMatch(/unexplained \(other apps or keys\)/)
    expect(q('spend-reconcile-pending')).toBeNull()
    expect(refreshBalance).not.toHaveBeenCalled()
  })
})

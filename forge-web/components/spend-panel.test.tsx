// @vitest-environment jsdom
/**
 * Settings → Spend right after a reload: the session shows the kept balance (from when it was
 * kept), which predates the ledger's later rows. The unexplained line waits for a balance with
 * every recorded write in it (reading it again, a bounded number of times) instead of calling
 * the gap "top-ups".
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpendRow } from '@/lib/spend'

const auth = { balance: '1000' as string, balanceReadAt: null as number | null }
/** What the next balance reads answer, in order (then nothing changes). */
let refreshes: { balance: string; readAt: number }[] = []
const refreshBalance = vi.fn(async () => {
  const next = refreshes.shift()
  if (next === undefined) return
  auth.balance = next.balance
  auth.balanceReadAt = next.readAt
  rerender()
})
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ identity: 'I', balance: auth.balance, balanceReadAt: auth.balanceReadAt, refreshBalance }),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: null, ready: false }) }))
const measuring = { now: false }
vi.mock('@/lib/sdk/write', async (orig) => ({ ...(await orig<typeof import('@/lib/sdk/write')>()), measurementPending: () => measuring.now }))

const row = (at: number, credits: number, balanceBefore: string): SpendRow => ({
  at,
  identityId: 'I',
  network: 'devnet',
  kind: 'create:comment',
  repo: 'R',
  documentId: String(at),
  estimateCredits: credits,
  actualCredits: credits,
  balanceBefore,
})
// The baseline was 1000 before the first write; two writes of 100 and 50 since (balance 850).
const ledger = { rows: [row(100, 100, '1000'), row(200, 50, '900')], baseline: { at: 100, credits: 1000n } }
vi.mock('@/lib/spend', async (orig) => ({
  ...(await orig<typeof import('@/lib/spend')>()),
  readLedger: async () => ledger.rows,
  readBaseline: async () => ledger.baseline,
}))

import { SpendPanel } from './spend-panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let rerender: () => void = () => undefined
beforeEach(() => {
  vi.useFakeTimers()
  refreshBalance.mockClear()
  refreshes = []
  measuring.now = false
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  rerender = () => root.render(<SpendPanel key="panel" />)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

/** Advance the clock a second at a time, so each re-render and its effects run as they would. */
const flush = async (ms = 0): Promise<void> => {
  for (let left = ms; ; left -= 1000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(1000, Math.max(0, left)))
    })
    if (left <= 1000) return
  }
}
/** Mount the panel and let the ledger read land (no timer runs yet). */
const render = async (): Promise<void> => {
  await act(async () => rerender())
  await act(async () => undefined)
}
const q = (id: string): Element | null => host.querySelector(`[data-testid="${id}"]`)

describe('the spend reconciliation after a reload', () => {
  it('waits on the kept balance, reads it again, then shows the line (never "top-ups")', async () => {
    // The kept balance is from before both writes: reconciling it would say −150 "top-ups".
    auth.balance = '1000'
    auth.balanceReadAt = null
    refreshes = [{ balance: '850', readAt: 250 }]
    await render()
    expect(q('spend-reconcile')).toBeNull()
    expect(host.textContent).not.toMatch(/top-ups/)
    expect(q('spend-reconcile-pending')).not.toBeNull()
    await flush()
    expect(refreshBalance).toHaveBeenCalledTimes(1)
    expect(q('spend-reconcile')?.textContent).toMatch(/0\.?0* DASH unexplained \(other apps or keys\)/)
    expect(q('spend-reconcile-pending')).toBeNull()
    // Settled: no further reads.
    await flush(60_000)
    expect(refreshBalance).toHaveBeenCalledTimes(1)
  })

  it('reads again while a node answers a balance from before the last write, then stops trying', async () => {
    // Read after the last row, but 900 is what the last write started from: a node behind it.
    auth.balance = '900'
    auth.balanceReadAt = 250
    refreshes = [
      { balance: '900', readAt: 260 },
      { balance: '900', readAt: 270 },
      { balance: '900', readAt: 280 },
      { balance: '900', readAt: 290 },
      { balance: '900', readAt: 300 },
    ]
    await render()
    expect(q('spend-reconcile')).toBeNull()
    await flush(60_000)
    // A few reads at most per last row, and the page stays honest meanwhile.
    expect(refreshBalance).toHaveBeenCalledTimes(4)
    expect(q('spend-reconcile')).toBeNull()
    expect(host.textContent).not.toMatch(/top-ups/)
  })

  it('a read that changes nothing is not repeated in a loop', async () => {
    auth.balance = '900'
    auth.balanceReadAt = 150 // before the last row
    refreshes = [] // every read fails (nothing changes)
    await render()
    await flush(60_000)
    expect(refreshBalance).toHaveBeenCalledTimes(1)
    expect(q('spend-reconcile-pending')).not.toBeNull()
  })

  it('waits while a write is still measuring its charge', async () => {
    auth.balance = '850'
    auth.balanceReadAt = 250
    measuring.now = true
    await render()
    expect(q('spend-reconcile')).toBeNull()
    measuring.now = false
    await act(async () => rerender())
    expect(q('spend-reconcile')).not.toBeNull()
  })

  it('a write while the panel is open never reconciles the new balance against the old rows', async () => {
    auth.balance = '850'
    auth.balanceReadAt = 250
    await render()
    const unexplained = (): string | null | undefined => q('spend-reconcile')?.getAttribute('data-unexplained')
    expect(unexplained()).toBe('0')
    // A 30-credit write: its row lands, then the balance is read (onSpend's order). The ledger
    // read for the new balance is slow: until it lands, the line shown before stays (never +30
    // "other apps or keys" from the new balance against the old rows).
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const rowsBefore = ledger.rows
    const spend = await import('@/lib/spend')
    const slow = vi.spyOn(spend, 'readLedger')
    try {
      ledger.rows = [...rowsBefore, row(300, 30, '850')]
      slow.mockImplementationOnce(async () => {
        await gate
        return ledger.rows
      })
      auth.balance = '820'
      auth.balanceReadAt = 310
      await act(async () => rerender())
      expect(unexplained()).toBe('0')
      await act(async () => release())
      await flush()
      expect(unexplained()).toBe('0')
      expect(q('spend-reconcile')?.textContent).toMatch(/Ledger/)
    } finally {
      ledger.rows = rowsBefore
      slow.mockRestore()
    }
  })

  it('shows the line at once for a balance read after the last row', async () => {
    auth.balance = '850'
    auth.balanceReadAt = 250
    await render()
    expect(q('spend-reconcile')?.textContent).toMatch(/unexplained \(other apps or keys\)/)
    await flush(60_000)
    expect(refreshBalance).not.toHaveBeenCalled()
  })
})

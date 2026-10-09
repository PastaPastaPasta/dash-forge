// @vitest-environment jsdom
/**
 * When the PR page probes for new pushes (#453): never on load, once a minute while the tab is
 * visible, never while it is hidden, at once when it is shown or focused (at most once per
 * throttle), and not again once something was found until the page re-reads.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvoSDK } from '@dashevo/evo-sdk'
import type { NewPush, ProbeBase, ProbeOutcome } from '@/lib/repo/head-probe'

const probe = vi.hoisted(() => ({ probeHead: vi.fn() }))
vi.mock('@/lib/repo/head-probe', () => probe)

import { FOCUS_THROTTLE_MS, PROBE_MS, useHeadProbe } from './use-head-probe'

const sdk = {} as EvoSDK
const base = { events: { at: 1, ids: [] } } as unknown as ProbeBase
const PUSH: NewPush = { tip: 'b'.repeat(40), headMoved: true, refUpdateId: 'r1' }
const nothing: ProbeOutcome = { found: null, events: { at: 1, ids: [] } }

let visibility: DocumentVisibilityState = 'visible'
let root: Root
let el: HTMLDivElement
let state: ReturnType<typeof useHeadProbe>

function Probe({ enabled = true, k = 'k1' }: { enabled?: boolean; k?: string }): null {
  state = useHeadProbe(sdk, enabled, base, k)
  return null
}

async function render(props: { enabled?: boolean; k?: string } = {}): Promise<void> {
  await act(async () => root.render(<Probe {...props} />))
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function show(v: DocumentVisibilityState): Promise<void> {
  visibility = v
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  probe.probeHead.mockReset()
  probe.probeHead.mockResolvedValue(nothing)
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})

afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.useRealTimers()
})

describe('useHeadProbe', () => {
  it('does not probe on load; then exactly once a minute while visible', async () => {
    await render()
    expect(probe.probeHead).not.toHaveBeenCalled()
    await advance(PROBE_MS - 1)
    expect(probe.probeHead).toHaveBeenCalledTimes(0)
    await advance(1)
    expect(probe.probeHead).toHaveBeenCalledTimes(1)
    await advance(PROBE_MS * 4)
    expect(probe.probeHead).toHaveBeenCalledTimes(5)
  })

  it('a hidden tab reads nothing; showing it probes at once, then the minute runs from there', async () => {
    await render()
    await show('hidden')
    await advance(PROBE_MS * 10)
    expect(probe.probeHead).toHaveBeenCalledTimes(0)
    await show('visible')
    expect(probe.probeHead).toHaveBeenCalledTimes(1)
    await advance(PROBE_MS - 1)
    expect(probe.probeHead).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(probe.probeHead).toHaveBeenCalledTimes(2)
  })

  it('focus probes, but not within the throttle of the last probe (or of the page’s read)', async () => {
    await render()
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(probe.probeHead).toHaveBeenCalledTimes(0)
    await advance(FOCUS_THROTTLE_MS)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(probe.probeHead).toHaveBeenCalledTimes(1)
    // A tab switch fires visibilitychange and focus together: one probe.
    await advance(FOCUS_THROTTLE_MS)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    expect(probe.probeHead).toHaveBeenCalledTimes(2)
    // The minute counts from the last probe.
    await advance(PROBE_MS - 1)
    expect(probe.probeHead).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(probe.probeHead).toHaveBeenCalledTimes(3)
  })

  it('stops once something was found, until the page re-reads (a new key)', async () => {
    probe.probeHead.mockResolvedValueOnce({ found: PUSH, events: null })
    await render()
    await advance(PROBE_MS)
    expect(state.found).toEqual(PUSH)
    await advance(PROBE_MS * 5)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(probe.probeHead).toHaveBeenCalledTimes(1)
    // The ref update it announced is passed on, so it is never announced again.
    await render({ k: 'k2' })
    expect(state.found).toBeNull()
    await advance(PROBE_MS)
    expect(probe.probeHead).toHaveBeenCalledTimes(2)
    expect((probe.probeHead.mock.calls[1]![1] as ProbeBase).announced?.has('r1')).toBe(true)
  })

  it('dismiss (Refresh) clears the finding and probes again, even when the re-read changes nothing', async () => {
    probe.probeHead.mockResolvedValueOnce({ found: PUSH, events: null })
    await render()
    await advance(PROBE_MS)
    await act(async () => state.dismiss())
    expect(state.found).toBeNull()
    await advance(PROBE_MS)
    expect(probe.probeHead).toHaveBeenCalledTimes(2)
  })

  it('a refused composite drops the branch from the probe; a second refusal stops it', async () => {
    probe.probeHead.mockImplementation(async (_sdk: unknown, _b: ProbeBase, opts: { onFallback?: () => void }) => {
      opts.onFallback?.()
      return nothing
    })
    await render()
    await advance(PROBE_MS)
    await advance(PROBE_MS)
    expect((probe.probeHead.mock.calls[1]![1] as ProbeBase).branch).toBeNull()
    await advance(PROBE_MS * 5)
    expect(probe.probeHead).toHaveBeenCalledTimes(2)
  })

  it('passes the advanced event mark to the next probe', async () => {
    probe.probeHead.mockResolvedValueOnce({ found: null, events: { at: 9, ids: ['x'] } })
    await render()
    await advance(PROBE_MS * 2)
    expect((probe.probeHead.mock.calls[1]![1] as ProbeBase).events).toEqual({ at: 9, ids: ['x'] })
  })

  it('a failed probe is no news; the next minute asks again', async () => {
    probe.probeHead.mockRejectedValueOnce(new Error('node down'))
    await render()
    await advance(PROBE_MS)
    expect(state.found).toBeNull()
    await advance(PROBE_MS)
    expect(probe.probeHead).toHaveBeenCalledTimes(2)
  })

  it('does nothing while disabled (a closed or merged PR)', async () => {
    await render({ enabled: false })
    await advance(PROBE_MS * 3)
    await show('visible')
    expect(probe.probeHead).not.toHaveBeenCalled()
  })
})

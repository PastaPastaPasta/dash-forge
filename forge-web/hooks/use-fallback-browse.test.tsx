// @vitest-environment jsdom
/**
 * A clone that started without asking and stopped at its budget is offered to the user, not
 * decoded again: on a page that joins the run another page started, and on every page after.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PackManifest, RepoRef } from '@/lib/repo'

const view = vi.hoisted(() => {
  class FallbackTooLargeError extends Error {
    constructor(readonly automatic: boolean) {
      super('too large')
    }
  }
  return {
    FallbackTooLargeError,
    cachedFallback: vi.fn(),
    fallbackNeedsAsk: vi.fn(),
    restoreFallback: vi.fn(),
    startFallback: vi.fn(),
  }
})

const sdk = vi.hoisted(() => ({}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk }) }))
vi.mock('@/lib/repo', () => ({ repoContractIds: () => [], repoKey: (r: { repoId: string }) => r.repoId }))
vi.mock('@/lib/view', () => view)

import { useFallbackBrowse, type FallbackBrowse } from './use-fallback-browse'

const repo = { repoId: 'r1' } as RepoRef
const packs = [{ sizeBytes: 1024, packHash: 'aa' }] as unknown as PackManifest[]

let root: Root
let el: HTMLDivElement
let state: FallbackBrowse
function Probe(): null {
  state = useFallbackBrowse(repo, packs)
  return null
}

async function mount(): Promise<void> {
  await act(async () => root.render(<Probe />))
  // Let the cache probe, the restore and the run settle.
  for (let i = 0; i < 5; i++) await act(async () => Promise.resolve())
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const f of [view.cachedFallback, view.fallbackNeedsAsk, view.restoreFallback, view.startFallback]) f.mockReset()
  view.cachedFallback.mockReturnValue(null)
  view.fallbackNeedsAsk.mockReturnValue(false)
  view.restoreFallback.mockResolvedValue(null)
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

describe('useFallbackBrowse over its budget', () => {
  it('offers the clone when the run it joined stopped at its budget', async () => {
    // Another page started the clone without asking; this one joins it from the session cache.
    view.cachedFallback.mockReturnValue(Promise.reject(new view.FallbackTooLargeError(true)))
    await mount()
    expect(state.needsAsk).toBe(true)
    expect(state.status).toBe('idle')
    expect(state.error).toBeNull()
  })

  it('asks, rather than starting again, once a clone of these packs stopped at its budget', async () => {
    view.fallbackNeedsAsk.mockReturnValue(true)
    await mount()
    expect(view.startFallback).not.toHaveBeenCalled()
    expect(state.needsAsk).toBe(true)
    expect(state.status).toBe('idle')
  })

  it('starts a small repo without asking otherwise, and offers it when that stops', async () => {
    view.startFallback.mockReturnValue(Promise.reject(new view.FallbackTooLargeError(true)))
    await mount()
    expect(view.startFallback).toHaveBeenCalledOnce()
    expect(view.startFallback.mock.calls[0]?.[4]).toBe(true)
    expect(state.needsAsk).toBe(true)
  })

  it('shows the error when a clone the user asked for is too large', async () => {
    view.cachedFallback.mockReturnValue(Promise.reject(new view.FallbackTooLargeError(false)))
    await mount()
    expect(state.needsAsk).toBe(false)
    expect(state.status).toBe('error')
  })
})

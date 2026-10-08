// @vitest-environment jsdom
/**
 * The banner over a copy loaded into the browser says why the published index was not used: it
 * falls short (behind), was never published, or exists and could not be reached (Q5).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '@/lib/repo'

let state: Record<string, unknown> = {}
vi.mock('@/hooks/use-browse-reader', () => ({ useBrowseReader: () => state }))
vi.mock('@/hooks/use-trust-view', () => ({ useTrustView: () => null }))
vi.mock('@/lib/view/reconnect', () => ({
  readOutages: () => 0,
  scheduleReconnect: () => () => undefined,
  subscribeReadOutages: () => () => undefined,
}))

const { BrowseBoundary } = await import('./browse-boundary')

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

const REPO = { repoId: 'r1', ownerId: 'o', name: 'p', visibility: 'public' } as unknown as RepoRef
const fake = { forView: () => ({}) }
const ready = (why: { behind: boolean; unreachable: boolean }): Record<string, unknown> => ({ kind: 'ready', reader: fake, version: 'v', local: true, unavailable: [], ...why })
const render = (): void => act(() => root.render(<BrowseBoundary repo={REPO}>{() => <p>files</p>}</BrowseBoundary>))

describe('BrowseBoundary: why the published index was not used', () => {
  it('says an index that did not answer could not be fetched or read, not that it falls short', () => {
    state = ready({ behind: false, unreachable: true })
    render()
    expect(el.textContent).toContain("this repo's browse index could not be fetched or read right now.")
    expect(el.textContent).not.toContain("doesn't cover")
  })

  it('keeps its words for an index that falls short and for one never published', () => {
    state = ready({ behind: true, unreachable: false })
    render()
    expect(el.textContent).toContain("this repo's browse index doesn't cover everything stored yet.")
    state = ready({ behind: false, unreachable: false })
    render()
    expect(el.textContent).toContain("this repo's browse index hasn't been published yet.")
  })

  it('offers the load with the same distinction', () => {
    state = { kind: 'offer', behind: false, unreachable: true, sizeBytes: 5_000_000, start: () => undefined }
    render()
    expect(el.textContent).toContain('Browse index could not be loaded')
    expect(el.textContent).toContain('could not be fetched or read')
  })
})

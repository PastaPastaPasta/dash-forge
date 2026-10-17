// @vitest-environment jsdom
/**
 * "A new version is available" (INC-14): nothing until the watcher reports a newer build, then a
 * status strip with a reload button; nothing at all on an immutable (IPFS) copy.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const watch = vi.hoisted(() => ({ onNewer: null as null | (() => void), stop: vi.fn(), immutable: false }))
vi.mock('@/lib/new-build', () => ({
  isImmutableCopy: () => watch.immutable,
  watchForNewBuild: ({ onNewer }: { onNewer: () => void }) => {
    watch.onNewer = onNewer
    return watch.stop
  },
}))

import { NewBuildBanner } from './new-build-banner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  watch.onNewer = null
  watch.immutable = false
  watch.stop.mockClear()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

describe('NewBuildBanner', () => {
  it('shows nothing until a newer build is reported, then offers a reload', () => {
    act(() => root.render(<NewBuildBanner />))
    expect(el.querySelector('[data-testid="new-build-banner"]')).toBeNull()
    act(() => watch.onNewer?.())
    const banner = el.querySelector('[data-testid="new-build-banner"]')
    expect(banner?.getAttribute('role')).toBe('status')
    expect(banner?.textContent).toContain('A new version is available')
    expect(banner?.querySelector('button')?.textContent).toContain('Reload')
  })

  it('stops watching when the page goes away', () => {
    act(() => root.render(<NewBuildBanner />))
    act(() => root.unmount())
    expect(watch.stop).toHaveBeenCalledTimes(1)
    root = createRoot(el)
  })

  it('an IPFS copy never watches', () => {
    watch.immutable = true
    act(() => root.render(<NewBuildBanner />))
    expect(watch.onNewer).toBeNull()
  })
})

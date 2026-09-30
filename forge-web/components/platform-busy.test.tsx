// @vitest-environment jsdom
/**
 * The status pill says when reads are held for a quorum rotation the network's quorum service
 * has not caught up with (#212): a status, not an error, and gone once the reads go through.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ since: null as number | null, listeners: new Set<() => void>() }))
vi.mock('@/lib/sdk', () => ({
  evoSdkService: {
    get quorumWaitSince() {
      return sdk.since
    },
    subscribe: (l: () => void) => {
      sdk.listeners.add(l)
      return () => sdk.listeners.delete(l)
    },
  },
}))

import { PlatformBusy } from './platform-busy'

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  sdk.since = null
})

const hold = (since: number | null): void =>
  act(() => {
    sdk.since = since
    sdk.listeners.forEach((l) => l())
  })

describe('PlatformBusy: a quorum rotation wait', () => {
  it('shows while reads are held for a new quorum, and goes once they are not', () => {
    act(() => root.render(<PlatformBusy />))
    expect(host.querySelector('[data-testid="quorum-wait"]')).toBeNull()
    hold(Date.now())
    const pill = host.querySelector('[data-testid="quorum-wait"]')
    expect(pill?.getAttribute('role')).toBe('status')
    expect(pill?.textContent).toContain('Waiting for the network’s new quorum')
    hold(null)
    expect(host.querySelector('[data-testid="quorum-wait"]')).toBeNull()
  })
})

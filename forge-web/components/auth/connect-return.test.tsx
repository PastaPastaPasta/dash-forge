// @vitest-environment jsdom
/**
 * The page a wallet returns to after an App Connect v2 approval: it nudges the tab that showed the
 * code, and when none answers says what the wallet reported and points back to that tab. It never
 * continues a sign-in itself.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALLBACK_CHANNEL, ACK_WAIT_MS } from '@/lib/auth/connect-callback'

const replace = vi.hoisted(() => vi.fn())
// The router object is stable across renders, as Next's is (the page's effect depends on it).
const router = vi.hoisted(() => ({ replace }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

const { ConnectReturn } = await import('./connect-return')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HASH = 'ab'.repeat(20)
let host: HTMLDivElement
let root: Root

function visit(search: string): void {
  window.history.replaceState(null, '', `/connect/${search}`)
  act(() => root.render(<ConnectReturn />))
}
const text = (): string => host.textContent ?? ''

beforeEach(() => {
  replace.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  window.history.replaceState(null, '', '/')
})

describe('the wallet return page', () => {
  it('goes home when the link is not a well-formed callback', () => {
    visit('?r=nope&ac=ok')
    expect(replace).toHaveBeenCalledWith('/')
  })

  it('says what a declined or failed approval was, without waiting for a tab', () => {
    visit(`?r=${HASH}&ac=declined`)
    expect(text()).toContain('Sign-in declined')
    // A fresh page load for the next one.
    act(() => root.unmount())
    root = createRoot(host)
    visit(`?r=${HASH}&ac=failed`)
    expect(text()).toContain("Your wallet couldn't finish")
  })

  it('tells the tab with the code about a decline too, so it can stop waiting', async () => {
    const waiting = new BroadcastChannel(CALLBACK_CHANNEL)
    const seen: unknown[] = []
    waiting.onmessage = (e: MessageEvent) => seen.push(e.data)
    visit(`?r=${HASH}&ac=declined`)
    await act(async () => new Promise((r) => setTimeout(r, 60)))
    expect(seen).toEqual([{ type: 'forge-app-connect-callback', requestHash: HASH, status: 'declined' }])
    expect(text()).toContain('Sign-in declined')
    waiting.close()
  })

  it('tells the tab with the code, and steps aside when it answers', async () => {
    const waiting = new BroadcastChannel(CALLBACK_CHANNEL)
    const seen: unknown[] = []
    waiting.onmessage = (e: MessageEvent) => {
      seen.push(e.data)
      waiting.postMessage({ type: 'forge-app-connect-ack', requestHash: HASH })
    }
    visit(`?r=${HASH}&ac=ok`)
    await act(async () => new Promise((r) => setTimeout(r, 60)))
    expect(seen).toEqual([{ type: 'forge-app-connect-callback', requestHash: HASH, status: 'ok' }])
    expect(text()).toContain("You're signing in on your other Forge tab")
    waiting.close()
  })

  it('points back to the Forge tab where the user started when none answers', () => {
    vi.useFakeTimers()
    visit(`?r=${HASH}&ac=ok`)
    expect(text()).toContain('Finishing sign-in')
    act(() => void vi.advanceTimersByTime(ACK_WAIT_MS + 10))
    expect(text()).toContain('Go back to Forge')
    expect(text()).toContain('Forge tab where you started')
    expect(host.querySelector('a')!.getAttribute('href')).toBe('/')
  })
})

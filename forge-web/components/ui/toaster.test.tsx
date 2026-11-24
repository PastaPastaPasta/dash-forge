// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { toast, useToasts } from '@/hooks/use-toasts'
import { Toaster } from './toaster'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function clearAll(): void {
  const s = useToasts.getState()
  for (const t of s.toasts) s.dismiss(t.id)
}

beforeEach(() => {
  clearAll()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  clearAll()
})

describe('Toaster', () => {
  it('never line-clamps error toast details', () => {
    const detail = 'Operator note: this write failed because the quorum is rotating. Retry in 30 seconds or check status.'
    act(() => {
      root.render(<Toaster />)
      toast({ title: 'Write failed', detail, tone: 'error' })
    })
    const status = host.querySelector('[role="status"]')!
    expect(status.textContent).toContain(detail)
    expect(status.innerHTML).not.toContain('line-clamp-2')
  })

  it('offers an expand toggle when a non-error detail overflows', () => {
    const origScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const origClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 64 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 32 })
    try {
      const detail = 'Long informational detail text that wraps past two lines in a narrow toast.'
      act(() => {
        root.render(<Toaster />)
        toast({ title: 'Saved', detail, tone: 'ok' })
      })
      const toggle = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show more')
      expect(toggle).toBeDefined()
      expect(toggle?.getAttribute('aria-expanded')).toBe('false')
      act(() => toggle!.click())
      expect(toggle?.getAttribute('aria-expanded')).toBe('true')
      expect(toggle?.textContent).toBe('Show less')
    } finally {
      if (origScroll) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', origScroll)
      if (origClient) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClient)
    }
  })
})

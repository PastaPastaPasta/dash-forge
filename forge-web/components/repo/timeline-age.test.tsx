// @vitest-environment jsdom
/**
 * QW-070: on a phone a timeline event's age wrapped onto a line of its own ("· 1m ago"). The
 * event is one sentence now, and its age is kept with the sentence's last word.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))

import { WithAge } from './timeline'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('p')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('WithAge', () => {
  it('keeps the last word and the age in one unbreakable run', () => {
    act(() => root.render(<WithAge text="added the enhancement label" age="1m ago" />))
    expect(host.textContent).toBe('added the enhancement label · 1m ago')
    const run = host.querySelector('span.whitespace-nowrap')
    expect(run?.textContent).toBe('label · 1m ago')
  })

  it('keeps a one-word phrase whole with its age', () => {
    act(() => root.render(<WithAge text="closed" age="now" />))
    expect(host.querySelector('span.whitespace-nowrap')?.textContent).toBe('closed · now')
  })
})

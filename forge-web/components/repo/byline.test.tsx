// @vitest-environment jsdom
/**
 * FG-6 (L-04): an imported item from a trusted mirror shows its original author (as text, never a
 * Forge profile link: L-38) and its original date, tagged "mirrored"; anything else shows its
 * signer and the chain time.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Byline } from './byline'

vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span data-testid="author">{identityId}</span> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const MIRRORED_AT = Date.parse('2026-09-28T10:00:00Z')

describe('Byline', () => {
  it('shows the original author and date of a trusted import', () => {
    const origin = { author: 'aigon89', createdAt: Date.parse('2018-06-22T09:00:00Z'), url: 'https://github.com/dashpay/dash/issues/2143', host: 'github.com' }
    act(() => root.render(<Byline author="M1rror" createdAt={MIRRORED_AT} origin={origin} verb="opened" />))
    expect(host.querySelector('[data-testid="origin-author"]')!.textContent).toBe('@aigon89 on github.com')
    expect(host.querySelector('[data-testid="author"]')).toBeNull()
    expect(host.querySelector('a')).toBeNull()
    const time = host.querySelector('time')!
    expect(time.getAttribute('dateTime')).toBe('2018-06-22T09:00:00.000Z')
    expect(time.getAttribute('title')).toBe('2018-06-22 09:00 UTC')
    expect(host.textContent).toContain('mirrored')
  })

  it('shows the signer and the chain time otherwise', () => {
    act(() => root.render(<Byline author="Alice" createdAt={MIRRORED_AT} origin={null} verb="opened" />))
    expect(host.querySelector('[data-testid="author"]')!.textContent).toBe('Alice')
    expect(host.querySelector('time')!.getAttribute('dateTime')).toBe('2026-09-28T10:00:00.000Z')
    expect(host.textContent).not.toContain('mirrored')
  })
})

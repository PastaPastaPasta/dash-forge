// @vitest-environment jsdom
/** SignatureBadge (P1-7): GitHub's labels, the panel that says why, and nothing for unsigned. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span data-testid="author">{identityId}</span> }))

import { SignatureBadge } from './signature-badge'

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

const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`)

describe('SignatureBadge', () => {
  it('shows nothing for an unsigned commit, and "Signed…" while checking', () => {
    act(() => root.render(<SignatureBadge state={undefined} />))
    expect(host.textContent).toBe('')
    act(() => root.render(<SignatureBadge state="checking" />))
    expect(q('signature-checking')?.textContent).toBe('Signed…')
  })

  it('opens a verified panel naming the signer and key, and closes on Escape', () => {
    act(() =>
      root.render(<SignatureBadge state={{ status: 'verified', reason: null, format: 'ssh', key: 'SHA256:abc', signer: 'ALICE' }} />),
    )
    const button = host.querySelector('button') as HTMLButtonElement
    expect(button.textContent).toContain('Verified')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    act(() => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(q('signature-panel')?.textContent).toContain('SSH key fingerprint: SHA256:abc')
    expect(q('author')?.textContent).toBe('ALICE')
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(q('signature-panel')).toBeNull()
  })

  it('says why a signature is unverified', () => {
    act(() =>
      root.render(<SignatureBadge state={{ status: 'unverified', reason: 'bad_signature', format: 'openpgp', key: 'C209DB5A73261B84', signer: null }} />),
    )
    expect(q('signature-badge')?.getAttribute('data-reason')).toBe('bad_signature')
    act(() => (host.querySelector('button') as HTMLButtonElement).click())
    expect(q('signature-panel')?.textContent).toContain('does not match this commit')
    expect(q('signature-panel')?.textContent).toContain('GPG key ID: C209DB5A73261B84')
  })
})

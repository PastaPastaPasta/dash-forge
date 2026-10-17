// @vitest-environment jsdom
/**
 * SECU-08: the QR step tells the user to scan only a code shown on this site's own address, what a
 * scan grants, and the only way to undo it.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiStore } from '@/hooks/use-ui-store'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))

const { ScanOnlyHere } = await import('./scan-warning')
const { SITE_HOST, siteUrl } = await import('@/lib/site')

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

describe('ScanOnlyHere', () => {
  it("names this build's own address, what a scan grants and how to undo it", () => {
    act(() => root.render(<ScanOnlyHere />))
    const note = host.querySelector('[data-testid="scan-warning"]')!
    expect(note.getAttribute('role')).toBe('note')
    expect(host.querySelector('[data-testid="scan-host"]')!.textContent).toBe(SITE_HOST)
    expect(note.textContent).toContain(`Scan only a code shown on ${SITE_HOST}.`)
    expect(note.textContent).toContain('can sign as you on Forge')
    expect(note.textContent).toContain('no spending limit unless your wallet sets one')
    expect(note.textContent).toContain('encryption key that opens your private and members-only content')
    expect(note.textContent).toContain('Disabling the key stops it signing')
    expect(note.textContent).toContain('replace your encryption key too')
    expect(note.textContent).not.toContain('CID')
    expect(host.querySelector('[data-testid="scan-warning-keys"]')!.getAttribute('href')).toBe('/settings/keys/')
  })

  it('on a copy served by CID, names the gateway host and points to checking the CID', () => {
    const was = window.location.href
    window.history.replaceState(null, '', '/')
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, protocol: 'https:', hostname: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.dweb.link', host: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.dweb.link', pathname: '/' } })
    try {
      act(() => root.render(<ScanOnlyHere />))
      expect(host.querySelector('[data-testid="scan-host"]')!.textContent).toContain('.ipfs.dweb.link')
      expect(host.textContent).toContain('CID against the release')
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: new URL(was) })
    }
  })

  it('shows the host it is given (a self-hosted build)', () => {
    act(() => root.render(<ScanOnlyHere host="forge.example.org" />))
    expect(host.querySelector('[data-testid="scan-host"]')!.textContent).toBe('forge.example.org')
  })

  it('closes the sign-in sheet when the way to disable the key is followed', () => {
    act(() => useUiStore.getState().openLogin('wallet'))
    act(() => root.render(<ScanOnlyHere />))
    // jsdom cannot navigate; the click is only to reach the handler.
    document.addEventListener('click', (e) => e.preventDefault(), { once: true })
    act(() => host.querySelector<HTMLAnchorElement>('[data-testid="scan-warning-keys"]')!.click())
    expect(useUiStore.getState().loginOpen).toBe(false)
  })
})

describe('the build address (siteUrl)', () => {
  it('is forge.dashhq.org unless a self-hosted build sets its own', () => {
    expect(siteUrl(undefined, undefined)).toBe('https://forge.dashhq.org/')
    expect(siteUrl('', '/x')).toBe('https://forge.dashhq.org/')
    expect(new URL(siteUrl(undefined, undefined)).host).toBe('forge.dashhq.org')
  })

  it('adds the base path of a project site once, and keeps the host', () => {
    expect(siteUrl('https://example.org/', undefined)).toBe('https://example.org/')
    expect(siteUrl('https://example.org', '/forge/')).toBe('https://example.org/forge/')
    expect(siteUrl('https://example.org/forge', '/forge')).toBe('https://example.org/forge/')
    expect(new URL(siteUrl('https://example.org:8443', '/forge')).host).toBe('example.org:8443')
  })
})

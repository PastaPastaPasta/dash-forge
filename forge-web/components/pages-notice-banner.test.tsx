// @vitest-environment jsdom
/**
 * The operator's banner: nothing without a notice; `advisory` and `paused` are both a polite
 * status with the reason and a link to the advisory, and neither can be dismissed; it is in the
 * static HTML, and it shows on any network.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { parsePagesNotice } from '@/lib/pages-notice'
import { PagesNoticeBanner } from './pages-notice-banner'

const notice = (mode: string, text?: string, url?: string) => parsePagesNotice({ mode, text, url })

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PagesNoticeBanner', () => {
  it('shows nothing when no notice is set', () => {
    expect(renderToString(<PagesNoticeBanner notice={null} />)).toBe('')
    expect(renderToString(<PagesNoticeBanner />)).toBe('')
  })

  it('advisory: the reason and a link to the advisory, no dismiss button', () => {
    const html = renderToString(<PagesNoticeBanner notice={notice('advisory', 'A key bug was found.', 'https://example.org/advisory')} />)
    expect(html).toContain('role="status"')
    expect(html).toContain('data-notice="advisory"')
    expect(html).toContain('Security notice.')
    expect(html).toContain('A key bug was found.')
    expect(html).toContain('href="https://example.org/advisory"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).not.toContain('<button')
  })

  it('paused: says writing is paused, no dismiss button', () => {
    const html = renderToString(<PagesNoticeBanner notice={notice('paused', 'Fixing a signing bug.')} />)
    expect(html).toContain('data-notice="paused"')
    expect(html).toContain('Writing is paused.')
    expect(html).toContain('Fixing a signing bug.')
    expect(html).toContain('What happened')
    expect(html).not.toContain('<button')
  })

  it('long advisory body stays visible (line-clamped, never collapsed) and toggles cleanly when overflowing', () => {
    const longText =
      'A signing bug was found in an earlier build affecting browser keys registered before Tuesday. Please revoke affected keys in Settings and register a fresh key once the patched build is live.'
    const html = renderToString(<PagesNoticeBanner notice={notice('advisory', longText, 'https://example.org/advisory')} />)
    expect(html).toContain(longText)
    expect(html).not.toContain('<details')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const origScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const origClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 80 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 36 })
    try {
      act(() => root.render(<PagesNoticeBanner notice={notice('advisory', longText, 'https://example.org/advisory')} />))
      const body = host.querySelector('[data-testid="pages-notice-body"]')!
      expect(body.textContent).toBe(longText)
      expect(body.className).toContain('line-clamp-2')
      const toggle = host.querySelector('button')!
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(toggle.textContent).toBe('Show full notice')
      act(() => toggle.click())
      expect(body.className).not.toContain('line-clamp-2')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(toggle.textContent).toBe('Show less')
    } finally {
      act(() => root.unmount())
      host.remove()
      if (origScroll) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', origScroll)
      if (origClient) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClient)
    }
  })
})

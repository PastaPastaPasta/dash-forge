// @vitest-environment jsdom
/**
 * The operator's banner: nothing without a notice; `advisory` and `paused` are both a polite
 * status with the reason and a link to the advisory, and neither can be dismissed; it is in the
 * static HTML, and it shows on any network.
 */

import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { parsePagesNotice } from '@/lib/pages-notice'
import { PagesNoticeBanner } from './pages-notice-banner'

const notice = (mode: string, text?: string, url?: string) => parsePagesNotice({ mode, text, url })

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
})

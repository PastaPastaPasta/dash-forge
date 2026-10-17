import { describe, expect, it } from 'vitest'

import { DEFAULT_ADVISORY_URL, MAX_TEXT, PAGES_NOTICE, pagesNoticeCopy, pagesWritesPausedReason, parsePagesNotice } from './pages-notice'

const env = (mode: string | undefined, text?: string, url?: string) => ({ mode, text, url })

describe('parsePagesNotice', () => {
  it('is off when unset or empty (the Pages variable passes an empty string when it is not set)', () => {
    expect(parsePagesNotice(env(undefined))).toBeNull()
    expect(parsePagesNotice(env(''))).toBeNull()
    expect(parsePagesNotice(env('  ', 'text left behind', 'https://example.org/a'))).toBeNull()
  })

  it('reads both modes, trimmed and case-folded, with the default advisory address', () => {
    expect(parsePagesNotice(env('advisory'))).toEqual({ mode: 'advisory', text: null, url: DEFAULT_ADVISORY_URL })
    expect(parsePagesNotice(env(' Paused '))).toEqual({ mode: 'paused', text: null, url: DEFAULT_ADVISORY_URL })
  })

  it('keeps the reason (whitespace collapsed) and an https advisory address', () => {
    const n = parsePagesNotice(env('paused', '  A key bug\n  was found. ', 'https://github.com/PastaPastaPasta/dash-forge/security/advisories/GHSA-1'))
    expect(n).toEqual({
      mode: 'paused',
      text: 'A key bug was found.',
      url: 'https://github.com/PastaPastaPasta/dash-forge/security/advisories/GHSA-1',
    })
  })

  it('fails the build on a typo, so the notice cannot be silently off', () => {
    expect(() => parsePagesNotice(env('pause'))).toThrow(/NEXT_PUBLIC_PAGES_NOTICE "pause": expected "advisory", "paused" or nothing/)
    expect(() => parsePagesNotice(env('upcoming'))).toThrow(/NEXT_PUBLIC_PAGES_NOTICE/)
  })

  it('fails the build on a reason that is too long or an address that is not https', () => {
    expect(() => parsePagesNotice(env('advisory', 'x'.repeat(MAX_TEXT + 1)))).toThrow(/at most 400/)
    expect(() => parsePagesNotice(env('advisory', 'x'.repeat(MAX_TEXT)))).not.toThrow()
    expect(() => parsePagesNotice(env('advisory', undefined, 'http://example.org/a'))).toThrow(/NEXT_PUBLIC_PAGES_NOTICE_URL/)
    expect(() => parsePagesNotice(env('advisory', undefined, 'javascript:alert(1)'))).toThrow(/NEXT_PUBLIC_PAGES_NOTICE_URL/)
    expect(() => parsePagesNotice(env('advisory', undefined, 'not a url'))).toThrow(/NEXT_PUBLIC_PAGES_NOTICE_URL/)
  })
})

describe('pagesWritesPausedReason', () => {
  it('nothing is paused without a notice or for an advisory', () => {
    expect(pagesWritesPausedReason(null)).toBeNull()
    expect(pagesWritesPausedReason(parsePagesNotice(env('advisory', 'Read this.')))).toBeNull()
  })

  it('paused carries the operator reason, or the default wording', () => {
    expect(pagesWritesPausedReason(parsePagesNotice(env('paused', 'A signing bug is being fixed.')))).toBe('Writing is paused: A signing bug is being fixed.')
    expect(pagesWritesPausedReason(parsePagesNotice(env('paused')))).toMatch(/^Writing is paused: Dash Forge's maintainers paused writes.* Reading still works\.$/)
  })

  it('this test build has no notice', () => {
    expect(PAGES_NOTICE).toBeNull()
    expect(pagesWritesPausedReason()).toBeNull()
  })
})

describe('pagesNoticeCopy', () => {
  it('says what each mode is and links the advisory', () => {
    const advisory = pagesNoticeCopy(parsePagesNotice(env('advisory'))!)
    expect(advisory.lead).toBe('Security notice.')
    expect(advisory.link).toBe('Read the advisory')
    const paused = pagesNoticeCopy(parsePagesNotice(env('paused', 'Fixing a bug.'))!)
    expect(paused).toEqual({ lead: 'Writing is paused.', body: 'Fixing a bug.', link: 'What happened' })
  })
})

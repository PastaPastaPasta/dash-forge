/** FG-6: reading what forge-import records about an imported item's origin. */

import { describe, expect, it } from 'vitest'

import { importedVerdictOf, originOf, pullOriginOf, releasePublishedOf, trustedOrigin } from './provenance'

const MIRROR = 'M1rror'
const HEADER = '> Mirrored from github.com/dashpay/dash#7762 by @thepastaclaw (pull request, 2026-09-20)'

describe('originOf / trustedOrigin (L-04)', () => {
  const doc = { $ownerId: MIRROR, imported: { author: 'aigon89', createdAt: 1_529_625_600, url: 'https://github.com/dashpay/dash/issues/2143' } }

  it('reads the original author, time and host', () => {
    expect(originOf(doc)).toEqual({
      author: 'aigon89',
      createdAt: 1_529_625_600_000,
      url: 'https://github.com/dashpay/dash/issues/2143',
      host: 'github.com',
    })
    expect(originOf({ $ownerId: MIRROR })).toBeNull()
    expect(originOf({ imported: { createdAt: 5 } })).toBeNull()
    // A non-https URL names no host.
    expect(originOf({ imported: { author: 'x', url: 'http://evil.example/1' } })?.host).toBe('')
  })

  it("believes only the owner's or a maintainer's record", () => {
    const origin = originOf(doc)
    expect(trustedOrigin(origin, MIRROR, new Set([MIRROR]))).toEqual(origin)
    // A stranger may write any `imported` record into their own issue.
    expect(trustedOrigin(origin, 'Stranger', new Set([MIRROR]))).toBeNull()
    // Unknown trust (still loading): the signer shows.
    expect(trustedOrigin(origin, MIRROR, null)).toBeNull()
  })
})

describe('pullOriginOf (L-36, L-37)', () => {
  const base = 'ab'.repeat(20)

  it("reads a mirrored PR's base commit and a fork's head branch", () => {
    expect(pullOriginOf(`${HEADER}\n> Base ${base} · head thepastaclaw:backport-0.26-b060-misc\n\nbody`)).toEqual({
      baseOid: base,
      headLabel: 'thepastaclaw:backport-0.26-b060-misc',
    })
    expect(pullOriginOf(`${HEADER}\n> Base ${base}\n\nbody`)).toEqual({ baseOid: base, headLabel: '' })
    expect(pullOriginOf(`${HEADER}\n> head feature`)).toEqual({ baseOid: '', headLabel: 'feature' })
    // As forge-import writes it: an empty quote line between, so it renders on its own line.
    expect(pullOriginOf(`${HEADER}\n>\n> Base ${base} · head o:b\n\nbody`)).toEqual({ baseOid: base, headLabel: 'o:b' })
  })

  it('ignores the line anywhere but right after the provenance quote', () => {
    expect(pullOriginOf(`${HEADER}\n\n> Base ${base}`)).toBeNull()
    expect(pullOriginOf(`hello\n> Base ${base}`)).toBeNull()
    expect(pullOriginOf(`${HEADER}\n> Base nothex`)).toBeNull()
  })
})

describe('importedVerdictOf (L-45)', () => {
  it("reads a mirrored review's source verdict", () => {
    const review = (kind: string): string => `> Mirrored from github.com/o/r#7 by @bob (${kind}, 2026-09-20)\n\nLGTM`
    expect(importedVerdictOf(review('review, approved'))).toBe('approved')
    expect(importedVerdictOf(review('review, requested changes'))).toBe('requested changes')
    expect(importedVerdictOf(review('review, commented'))).toBe('commented')
    expect(importedVerdictOf(review('comment'))).toBeNull()
    expect(importedVerdictOf('LGTM')).toBeNull()
  })
})

describe('releasePublishedOf (L-04 for releases)', () => {
  it('reads who published a mirrored release and when, and leaves the notes', () => {
    const { published, rest } = releasePublishedOf('> Published on github.com by @UdjinM6 on 2026-08-03\n\nThis release fixes things.')
    expect(published).toEqual({ host: 'github.com', author: 'UdjinM6', at: Date.parse('2026-08-03T00:00:00Z') })
    expect(rest).toBe('This release fixes things.')
    expect(releasePublishedOf('> Published on gitlab.example.com on 2025-01-02').published?.author).toBe('')
    expect(releasePublishedOf('Plain notes').published).toBeNull()
    expect(releasePublishedOf('Plain notes').rest).toBe('Plain notes')
  })
})

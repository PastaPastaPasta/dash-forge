/**
 * Content-check ledger — the per-repo record the trust panel reads.
 *
 * Pins that counts accumulate per repo, that a no-op update does not notify (the panel
 * subscribes with `useSyncExternalStore`, which needs stable snapshots), and that sources
 * are named by host.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  beginView,
  contentChecks,
  externalSourceName,
  NO_CONTENT_CHECKS,
  noteContentCheck,
  noteViewPack,
  objectObserver,
  resetContentChecks,
  subscribeContentChecks,
  viewSources,
} from './content-checks'

afterEach(() => resetContentChecks())

describe('content-check ledger', () => {
  it('starts empty and accumulates per repo', () => {
    expect(contentChecks('repo-a')).toBe(NO_CONTENT_CHECKS)
    const observe = objectObserver('repo-a')
    observe('verified')
    observe('verified')
    observe('failed')
    noteContentCheck('repo-a', { packsVerified: 2, source: 'platform' })

    expect(contentChecks('repo-a')).toMatchObject({
      objectsVerified: 2,
      objectsFailed: 1,
      packsVerified: 2,
      sources: ['platform'],
    })
    expect(contentChecks('repo-b')).toBe(NO_CONTENT_CHECKS)
  })

  it('keeps the snapshot stable and stays quiet when nothing changes', () => {
    let notified = 0
    const unsubscribe = subscribeContentChecks(() => {
      notified += 1
    })
    noteContentCheck('repo-a', { source: 'platform' })
    const snap = contentChecks('repo-a')
    expect(notified).toBe(1)

    noteContentCheck('repo-a', { source: 'platform' }) // already recorded
    noteContentCheck('repo-a', {}) // nothing at all
    expect(contentChecks('repo-a')).toBe(snap)
    expect(notified).toBe(1)

    noteContentCheck('repo-a', { objectsVerified: 1 })
    expect(contentChecks('repo-a')).not.toBe(snap)
    expect(notified).toBe(2)
    unsubscribe()
  })

  it('records each unavailable pack once, case-insensitively', () => {
    noteContentCheck('repo-a', { unavailablePack: 'AB'.repeat(32) })
    const snap = contentChecks('repo-a')
    noteContentCheck('repo-a', { unavailablePack: 'ab'.repeat(32) })
    expect(contentChecks('repo-a')).toBe(snap)
    expect(snap.unavailablePacks).toEqual(['ab'.repeat(32)])
  })

  it("records which places served each pack, and the packs of the current view's objects (L-18)", () => {
    let notified = 0
    const unsubscribe = subscribeContentChecks(() => {
      notified += 1
    })
    noteContentCheck('repo-a', { source: 'platform', pack: 'AA' })
    noteContentCheck('repo-a', { source: 'files.example', pack: 'bb' })
    noteContentCheck('repo-a', { source: 'files.example', pack: 'bb' }) // already recorded
    expect(contentChecks('repo-a').packSources).toEqual({ aa: ['platform'], bb: ['files.example'] })
    expect(contentChecks('repo-a').sources).toEqual(['platform', 'files.example'])

    const home = '/repo?name=x'
    beginView('repo-a', home)
    noteViewPack('repo-a', 'aa', home)
    noteViewPack('repo-a', 'BB', home)
    expect(viewSources(contentChecks('repo-a'))).toEqual(['platform', 'files.example'])
    const before = notified
    const snap = contentChecks('repo-a')
    noteViewPack('repo-a', 'bb', home) // already in this view: no change, no notification
    beginView('repo-a', home) // the rail re-rendering the same view
    expect(contentChecks('repo-a')).toBe(snap)
    expect(notified).toBe(before)

    // A new view starts empty; the session's record of each pack stays.
    const file = '/repo/blob?name=x&path=s3file.txt'
    beginView('repo-a', file)
    expect(contentChecks('repo-a').viewPacks).toEqual([])
    expect(viewSources(contentChecks('repo-a'))).toEqual([])
    noteViewPack('repo-a', 'bb', file)
    expect(viewSources(contentChecks('repo-a'))).toEqual(['files.example'])
    expect(contentChecks('repo-b')).toBe(NO_CONTENT_CHECKS)
    unsubscribe()
  })

  it('drops reads of a view that is not on screen (L-18)', () => {
    noteContentCheck('repo-a', { source: 'platform', pack: 'aa' })
    noteContentCheck('repo-a', { source: 'files.example', pack: 'bb' })
    beginView('repo-a', '/repo/blob?path=f')
    noteViewPack('repo-a', 'bb', '/repo/blob?path=f')
    // The home page's history walk, still running, reads a Platform-stored commit: dropped.
    noteViewPack('repo-a', 'aa', '/repo')
    expect(viewSources(contentChecks('repo-a'))).toEqual(['files.example'])
  })

  it('names the copy that served a read, not a sibling copy the reader rejected (L-18)', () => {
    // Two writers' copies of one pack: a bad mirror answered ranges of copy c1, copy c2 verified.
    noteContentCheck('repo-a', { source: 'bad.example', pack: 'aa', copy: 'C1' })
    noteContentCheck('repo-a', { source: 'good.example', pack: 'aa', copy: 'c2' })
    expect(contentChecks('repo-a').packSources['aa']).toEqual(['bad.example', 'good.example'])
    beginView('repo-a', '/v')
    noteViewPack('repo-a', 'aa#c2', '/v')
    expect(viewSources(contentChecks('repo-a'))).toEqual(['good.example'])
    // No copy-level record (a whole-pack fetch): the pack's places.
    noteContentCheck('repo-a', { source: 'platform', pack: 'bb' })
    noteViewPack('repo-a', 'bb#x', '/v')
    expect(viewSources(contentChecks('repo-a'))).toEqual(['good.example', 'platform'])
  })

  it('names an external source by its host', () => {
    expect(externalSourceName('https://ipfs.io/ipfs/bafy')).toBe('ipfs.io')
    expect(externalSourceName('https://bucket.s3.amazonaws.com/p.pack')).toBe('bucket.s3.amazonaws.com')
    expect(externalSourceName('not a url')).toBe('external')
  })
})

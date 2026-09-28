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

    noteViewPack('repo-a', 'aa')
    noteViewPack('repo-a', 'BB')
    expect(viewSources(contentChecks('repo-a'))).toEqual(['platform', 'files.example'])
    const before = notified
    const snap = contentChecks('repo-a')
    noteViewPack('repo-a', 'bb') // already in this view: no change, no notification
    expect(contentChecks('repo-a')).toBe(snap)
    expect(notified).toBe(before)

    // A new view starts empty; the session's record of each pack stays.
    beginView('repo-a')
    expect(contentChecks('repo-a').viewPacks).toEqual([])
    expect(viewSources(contentChecks('repo-a'))).toEqual([])
    noteViewPack('repo-a', 'bb')
    expect(viewSources(contentChecks('repo-a'))).toEqual(['files.example'])
    expect(contentChecks('repo-b')).toBe(NO_CONTENT_CHECKS)
    unsubscribe()
  })

  it('names an external source by its host', () => {
    expect(externalSourceName('https://ipfs.io/ipfs/bafy')).toBe('ipfs.io')
    expect(externalSourceName('https://bucket.s3.amazonaws.com/p.pack')).toBe('bucket.s3.amazonaws.com')
    expect(externalSourceName('not a url')).toBe('external')
  })
})

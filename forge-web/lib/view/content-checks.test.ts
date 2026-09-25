/**
 * Content-check ledger — the per-repo record the trust panel reads.
 *
 * Pins that counts accumulate per repo, that a no-op update does not notify (the panel
 * subscribes with `useSyncExternalStore`, which needs stable snapshots), and that sources
 * are named by host.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  contentChecks,
  externalSourceName,
  NO_CONTENT_CHECKS,
  noteContentCheck,
  objectObserver,
  resetContentChecks,
  subscribeContentChecks,
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

  it('names an external source by its host', () => {
    expect(externalSourceName('https://ipfs.io/ipfs/bafy')).toBe('ipfs.io')
    expect(externalSourceName('https://bucket.s3.amazonaws.com/p.pack')).toBe('bucket.s3.amazonaws.com')
    expect(externalSourceName('not a url')).toBe('external')
  })
})

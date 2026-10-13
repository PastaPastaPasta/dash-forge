import type { EvoSDK } from '@dashevo/evo-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cachedDpnsName, clearDpnsCache, displayDpnsName, DPNS_FAILURE_TTL_MS, dpnsCacheVersion, dpnsLabelHolder, dpnsReadFailed, lookupDpnsName, looksLikeDpnsName, noteRegisteredDpnsName, resolveDpnsId, resolveDpnsName, seedFromDomains, subscribeDpnsCache, UNKNOWN_HOLDER } from './dpns'

const A = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const B = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const domain = (id: string, label: string) => ({ label, normalizedParentDomainName: 'dash', records: { identity: id } })

// The same fakeSdk shape lib/sdk/query.test.ts uses: `documents.query` mocks `sdk.documents.query`.
function fakeSdk(query: (q: unknown) => Promise<Map<string, unknown>>): EvoSDK {
  return { documents: { query }, version: () => 14 } as unknown as EvoSDK
}
const domainDoc = (id: string, label: string, parent = 'dash') => ({
  toJSON: () => ({ label, normalizedParentDomainName: parent, records: { identity: id } }),
})

/** Resolve `name` against an empty DPNS and return the one query's where clause. */
async function whereFor(name: string): Promise<unknown[][]> {
  const query = vi.fn(async (_q: unknown) => new Map())
  await resolveDpnsId(fakeSdk(query), name, 'devnet')
  expect(query).toHaveBeenCalledTimes(1)
  return (query.mock.calls[0]?.[0] as { where: unknown[][] }).where
}

beforeEach(() => clearDpnsCache())

describe('seeding names from a DPNS lookup', () => {
  it('records names and proves the rest nameless from a short page', () => {
    seedFromDomains('devnet', [A, B], [domain(A, 'alice')])
    expect(cachedDpnsName('devnet', A)).toBe('alice.dash')
    expect(cachedDpnsName('devnet', B)).toBeNull()
  })

  it('records the names of a full page without proving anyone nameless', () => {
    const full = Array.from({ length: 100 }, (_, i) => domain(i === 0 ? A : `id${i}`, `n${i}`))
    seedFromDomains('devnet', [A, B], full)
    expect(cachedDpnsName('devnet', A)).toBe('n0.dash')
    // B was not in the (possibly cut) page: unknown, left for the per-id resolver.
    expect(cachedDpnsName('devnet', B)).toBeUndefined()
  })
})

describe('looksLikeDpnsName / displayDpnsName', () => {
  it('accepts a bare label or label.parent, rejects an empty or space-containing value', () => {
    expect(looksLikeDpnsName('alice')).toBe(true)
    expect(looksLikeDpnsName('alice.dash')).toBe(true)
    expect(looksLikeDpnsName('')).toBe(false)
    expect(looksLikeDpnsName('.dash')).toBe(false)
    expect(looksLikeDpnsName('has spaces')).toBe(false)
  })

  // L-72: the platform's own DPNS contract requires a 3-63 character label (both dpns-contract
  // schema v1 and v2 set `label`'s minLength to 3); a value too short to ever resolve should
  // never spend a read on one.
  it('requires a label of at least 3 characters (the contract minimum), up to 63', () => {
    expect(looksLikeDpnsName('a')).toBe(false)
    expect(looksLikeDpnsName('ab')).toBe(false)
    expect(looksLikeDpnsName('abc')).toBe(true)
    expect(looksLikeDpnsName('a'.repeat(63))).toBe(true)
    expect(looksLikeDpnsName('a'.repeat(64))).toBe(false)
  })

  it('displays a bare label defaulted to .dash, and label.parent unchanged', () => {
    expect(displayDpnsName('alice')).toBe('alice.dash')
    expect(displayDpnsName('alice.dash')).toBe('alice.dash')
  })
})

describe('resolveDpnsId (review: forward name -> id resolution)', () => {
  // 'mark' has no o/l/i characters, so it survives homograph normalization unchanged — these two
  // tests are about the where-clause shape and the bare-name/dash default, not normalization.
  it('queries the parentNameAndLabel index with a bare name defaulted to the dash parent', async () => {
    expect(await whereFor('mark')).toEqual([
      ['normalizedParentDomainName', '==', 'dash'],
      ['normalizedLabel', '==', 'mark'],
    ])
  })

  it('splits an explicit label.parent instead of defaulting the parent to dash', async () => {
    expect(await whereFor('mark.xyz')).toEqual([
      ['normalizedParentDomainName', '==', 'xyz'],
      ['normalizedLabel', '==', 'mark'],
    ])
  })

  it('normalizes homograph-ambiguous characters before querying (o->0, l/i->1)', async () => {
    expect(await whereFor('Cool.dash')).toEqual([
      ['normalizedParentDomainName', '==', 'dash'],
      ['normalizedLabel', '==', 'c001'],
    ])
  })

  it('dedupes concurrent lookups of the same normalized name (case-insensitive)', async () => {
    let resolve!: (m: Map<string, unknown>) => void
    const query = vi.fn(() => new Promise<Map<string, unknown>>((r) => (resolve = r)))
    const sdk = fakeSdk(query)
    const a = resolveDpnsId(sdk, 'mark', 'devnet')
    const b = resolveDpnsId(sdk, 'MARK', 'devnet')
    resolve(new Map([['id', domainDoc(A, 'mark')]]))
    expect(await Promise.all([a, b])).toEqual([A, A])
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed lookup: the next call retries', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(new Map([['id', domainDoc(A, 'alice')]]))
    const sdk = fakeSdk(query)
    expect(await resolveDpnsId(sdk, 'alice', 'devnet')).toBeNull()
    expect(await resolveDpnsId(sdk, 'alice', 'devnet')).toBe(A)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('caches a proven absence (0 docs): the next call does not re-query', async () => {
    const query = vi.fn(async () => new Map())
    const sdk = fakeSdk(query)
    expect(await resolveDpnsId(sdk, 'nobody', 'devnet')).toBeNull()
    expect(await resolveDpnsId(sdk, 'nobody', 'devnet')).toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('resolves an empty or invalid-shaped label to null without querying', async () => {
    const query = vi.fn(async () => new Map())
    const sdk = fakeSdk(query)
    expect(await resolveDpnsId(sdk, '', 'devnet')).toBeNull()
    expect(await resolveDpnsId(sdk, '.dash', 'devnet')).toBeNull()
    expect(await resolveDpnsId(sdk, 'has spaces', 'devnet')).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it('seeds the reverse (id -> name) cache with the resolved domain on a hit', async () => {
    const query = vi.fn(async () => new Map([['id', domainDoc(A, 'alice')]]))
    await resolveDpnsId(fakeSdk(query), 'alice', 'devnet')
    expect(cachedDpnsName('devnet', A)).toBe('alice.dash')
  })
})

describe('a failed reverse read is not a name that does not exist', () => {
  afterEach(() => vi.useRealTimers())

  it('is not cached as none: it reads again once its lifetime has passed', async () => {
    vi.useFakeTimers()
    const query = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(new Map([['id', domainDoc(A, 'alice')]]))
    const sdk = fakeSdk(query)
    expect(await resolveDpnsName(sdk, A, 'devnet')).toBeNull()
    // Not a proven absence: nothing cached, and the failure is known as one.
    expect(cachedDpnsName('devnet', A)).toBeUndefined()
    expect(dpnsReadFailed('devnet', A)).toBe(true)
    // Within its lifetime a page of pills does not hammer a node that is down.
    expect(await resolveDpnsName(sdk, A, 'devnet')).toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(DPNS_FAILURE_TTL_MS + 1)
    expect(dpnsReadFailed('devnet', A)).toBe(false)
    expect(await resolveDpnsName(sdk, A, 'devnet')).toBe('alice.dash')
    expect(query).toHaveBeenCalledTimes(2)
    expect(cachedDpnsName('devnet', A)).toBe('alice.dash')
  })

  it('caches a proven absence for good, unlike a failure', async () => {
    const query = vi.fn(async () => new Map())
    const sdk = fakeSdk(query)
    expect(await resolveDpnsName(sdk, A, 'devnet')).toBeNull()
    expect(cachedDpnsName('devnet', A)).toBeNull()
    expect(dpnsReadFailed('devnet', A)).toBe(false)
    expect(await resolveDpnsName(sdk, A, 'devnet')).toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('a username registered in this tab (#452)', () => {
  it('reads as the identity’s name both ways and tells subscribers', async () => {
    const seen = vi.fn()
    const off = subscribeDpnsCache(seen)
    // A "no name" read before the registration is what the tab believed until now.
    seedFromDomains('devnet', [A], [])
    expect(cachedDpnsName('devnet', A)).toBeNull()
    const before = dpnsCacheVersion()
    noteRegisteredDpnsName('devnet', A, 'Alice-Forge2')
    expect(cachedDpnsName('devnet', A)).toBe('Alice-Forge2.dash')
    expect(dpnsCacheVersion()).toBeGreaterThan(before)
    expect(seen).toHaveBeenCalled()
    // The forward lookup is answered without a read (homograph-safe, any case).
    const query = vi.fn(async (_q: unknown) => new Map())
    expect(await resolveDpnsId(fakeSdk(query), 'alice-f0rge2', 'devnet')).toBe(A)
    expect(query).not.toHaveBeenCalled()
    off()
  })

  it('a name found by a fresh lookup (registered elsewhere) tells subscribers too', async () => {
    const seen = vi.fn()
    const off = subscribeDpnsCache(seen)
    const query = vi.fn(async (_q: unknown) => new Map([['d', domainDoc(A, 'alice2')]]))
    expect(await lookupDpnsName(fakeSdk(query), A, 'devnet')).toBe('alice2.dash')
    expect(seen).toHaveBeenCalledTimes(1)
    off()
  })
})

describe('dpnsLabelHolder: is this name free? (#452)', () => {
  it('reads the unique parent+label index once, homograph-safe', async () => {
    const query = vi.fn(async (_q: unknown) => new Map([['d', domainDoc(B, 'b0b')]]))
    expect(await dpnsLabelHolder(fakeSdk(query), 'Bob', 'devnet')).toBe(B)
    expect((query.mock.calls[0]?.[0] as { where: unknown[][] }).where).toEqual([
      ['normalizedParentDomainName', '==', 'dash'],
      ['normalizedLabel', '==', 'b0b'],
    ])
  })

  it('answers null for a free name, and REJECTS a failed read (never "free")', async () => {
    expect(await dpnsLabelHolder(fakeSdk(async () => new Map()), 'nobody-here7', 'devnet')).toBeNull()
    await expect(dpnsLabelHolder(fakeSdk(async () => Promise.reject(new Error('quorum not found'))), 'nobody-here7', 'devnet')).rejects.toThrow()
  })
})

describe('dpnsLabelHolder: a domain whose record does not read', () => {
  it('is taken, not free', async () => {
    const odd = { toJSON: () => ({ label: 'x7x', normalizedParentDomainName: 'dash', records: {} }) }
    expect(await dpnsLabelHolder(fakeSdk(async () => new Map([['d', odd]])), 'x7x', 'devnet')).toBe(UNKNOWN_HOLDER)
  })
})

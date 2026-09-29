import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cachedDpnsName, clearDpnsCache, displayDpnsName, looksLikeDpnsName, resolveDpnsId, seedFromDomains } from './dpns'

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

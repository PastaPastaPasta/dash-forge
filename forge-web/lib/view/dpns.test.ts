import { beforeEach, describe, expect, it } from 'vitest'

import { cachedDpnsName, clearDpnsCache, seedFromDomains } from './dpns'

const A = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const B = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const domain = (id: string, label: string) => ({ label, normalizedParentDomainName: 'dash', records: { identity: id } })

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

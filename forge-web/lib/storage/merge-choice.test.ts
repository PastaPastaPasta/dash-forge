import { describe, expect, it } from 'vitest'

import { estimateChunkCredits } from '../sdk/cost'
import { fragmentBytes, storageChoice, withinPreAgreement } from './merge-choice'
import type { StorageProfile } from './profiles'

const platform = { name: 'chain', settings: { kind: 'platform', provider: 'platform' }, secrets: {} } as unknown as StorageProfile
const bucket = { name: 'r2', settings: { kind: 's3', provider: 'r2' }, secrets: {} } as unknown as StorageProfile
const estimate = { bytes: 5_000, objectCount: 4 }
const price = estimateChunkCredits(5_000) + estimateChunkCredits(fragmentBytes(4))

describe('where a merge will store its pack, decided before it starts', () => {
  it('nothing configured: Platform, priced, allowed by default', () => {
    expect(storageChoice(null, [], estimate)).toEqual({
      label: 'Dash Platform (no storage configured)',
      platform: { kind: 'only', reason: 'No storage is configured for browser pushes to this repo.' },
      platformCredits: price,
      allowByDefault: true,
    })
    expect(storageChoice({ targets: [], replicas: 1, platformFallback: false }, [], estimate).platform.kind).toBe('only')
  })

  it('the policy lists Platform: named, priced, allowed by default', () => {
    const c = storageChoice({ targets: ['r2', 'chain'], replicas: 2, platformFallback: false }, [platform, bucket], estimate)
    expect(c).toMatchObject({ label: 'r2, chain', platform: { kind: 'policy' }, platformCredits: price, allowByDefault: true })
  })

  it('external targets with the Platform fallback: priced, but not allowed by default', () => {
    const c = storageChoice({ targets: ['r2'], replicas: 1, platformFallback: true }, [bucket], estimate)
    expect(c).toMatchObject({ label: 'r2, with Dash Platform as a fallback', platform: { kind: 'fallback' }, platformCredits: price, allowByDefault: false })
  })

  it('external targets without a fallback never touch Platform', () => {
    expect(storageChoice({ targets: ['r2'], replicas: 1, platformFallback: false }, [bucket], estimate)).toEqual({ label: 'r2', platform: { kind: 'never' }, platformCredits: null, allowByDefault: false })
  })

  it('without an estimate yet the row still says where, with no price', () => {
    expect(storageChoice(null, [], null).platformCredits).toBeNull()
  })

  it('a pre-answer covers a Platform copy up to its cap only', () => {
    expect(withinPreAgreement(null, 1)).toBe(false)
    expect(withinPreAgreement(1000, 1000)).toBe(true)
    expect(withinPreAgreement(1000, 1001)).toBe(false)
  })
})

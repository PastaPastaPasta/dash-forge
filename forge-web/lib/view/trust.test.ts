/**
 * Trust-state derivation — the assay panel may only claim what a check established.
 *
 * Pins roadmap invariant 4 at the unit level: no link reads `verified` unless its check ran
 * and passed, a failed check wins the headline, and the trust-anchor disclosure names the
 * active network's quorum endpoint rather than a hard-coded "testnet".
 */

import { describe, expect, it } from 'vitest'

import { NETWORKS, QUORUM_KEY_ENDPOINT } from '../constants'
import type { RefState } from '../rules'
import { NO_CONTENT_CHECKS, type ContentChecks } from './content-checks'
import { connectionTrust, deriveConnectionTrust, deriveTrust, worstOf, type TrustInputs } from './trust'

const RESOLVED: RefState = { state: 'resolved', oid: 'ab'.repeat(20), author: 'pusher', createdAt: 1 }
const DIVERGED: RefState = {
  state: 'diverged',
  heads: [
    { id: 'a', oid: 'aa'.repeat(20), author: 'p1', createdAt: 1 },
    { id: 'b', oid: 'bb'.repeat(20), author: 'p2', createdAt: 2 },
  ],
}

function checks(over: Partial<ContentChecks> = {}): ContentChecks {
  return { ...NO_CONTENT_CHECKS, ...over }
}

function inputs(over: Partial<TrustInputs> = {}): TrustInputs {
  return {
    network: 'testnet',
    connection: 'trusted',
    tip: RESOLVED,
    checks: NO_CONTENT_CHECKS,
    configuredBackend: 'platform',
    ...over,
  }
}

describe('connectionTrust', () => {
  it('is connecting until ready, then follows the trusted flag', () => {
    expect(connectionTrust(false, true)).toBe('connecting')
    expect(connectionTrust(true, true)).toBe('trusted')
    expect(connectionTrust(true, false)).toBe('untrusted')
  })
})

describe('deriveTrust — proofs and refs', () => {
  it('claims nothing while the connection is still coming up', () => {
    const r = deriveTrust(inputs({ connection: 'connecting' }))
    expect(r.proofs.state).toBe('pending')
    expect(r.refs.state).toBe('pending')
    expect(r.overall).toBe('pending')
  })

  it('verifies proofs and a resolved ref on a trusted connection', () => {
    const r = deriveTrust(inputs())
    expect(r.proofs.state).toBe('verified')
    expect(r.refs.state).toBe('verified')
  })

  it('reports proofs and refs as unverified on a connection that does not check proofs', () => {
    const r = deriveTrust(inputs({ connection: 'untrusted' }))
    expect(r.proofs.state).toBe('unverified')
    expect(r.refs.state).toBe('unverified')
    expect(r.overall).toBe('unverified')
  })

  it('marks a diverged ref partial: the shown head is provisional', () => {
    const r = deriveTrust(inputs({ tip: DIVERGED }))
    expect(r.refs.state).toBe('partial')
    expect(r.refs.detail).toMatch(/2 concurrent pushes/)
    expect(r.overall).toBe('partial')
  })

  it('verifies the absence of a ref from the proof-checked log', () => {
    expect(deriveTrust(inputs({ tip: 'missing' })).refs.state).toBe('verified')
    expect(deriveTrust(inputs({ tip: { state: 'unborn' } })).refs.state).toBe('verified')
  })
})

describe('deriveTrust — content hashes', () => {
  it('is pending, not verified, before any object has been read', () => {
    const r = deriveTrust(inputs())
    expect(r.content.state).toBe('pending')
    expect(r.source.state).toBe('pending')
    // A page that only read refs is verified for what it showed.
    expect(r.overall).toBe('verified')
  })

  it('is verified once objects were re-hashed and matched', () => {
    const r = deriveTrust(inputs({ checks: checks({ objectsVerified: 3, sources: ['platform'] }) }))
    expect(r.content.state).toBe('verified')
    expect(r.content.summary).toBe('3 objects')
    expect(r.source.state).toBe('verified')
    expect(r.source.summary).toBe('platform')
  })

  it('counts whole-pack sha256 checks from the fallback clone', () => {
    const r = deriveTrust(inputs({ checks: checks({ packsVerified: 2, objectsVerified: 1 }) }))
    expect(r.content.state).toBe('verified')
    expect(r.content.detail).toMatch(/2 packs/)
  })

  it('is partial when some objects were shown without a hash check', () => {
    const r = deriveTrust(inputs({ checks: checks({ objectsVerified: 4, objectsUnchecked: 1 }) }))
    expect(r.content.state).toBe('partial')
  })

  it('is unverified when nothing shown was checked', () => {
    const r = deriveTrust(inputs({ checks: checks({ objectsUnchecked: 2 }) }))
    expect(r.content.state).toBe('unverified')
  })

  it('fails, and wins the headline, when any object or pack mismatched', () => {
    const obj = deriveTrust(inputs({ checks: checks({ objectsVerified: 9, objectsFailed: 1, sources: ['ipfs.io'] }) }))
    expect(obj.content.state).toBe('failed')
    expect(obj.source.state).toBe('failed') // a source is only as good as what it served
    expect(obj.overall).toBe('failed')

    const pack = deriveTrust(inputs({ checks: checks({ packsFailed: 1 }) }))
    expect(pack.content.state).toBe('failed')
    expect(pack.content.detail).toMatch(/1 pack did not match its manifest/)
  })

  it('names every source bytes actually came from', () => {
    const r = deriveTrust(inputs({ checks: checks({ objectsVerified: 1, sources: ['platform', 'ipfs.io'] }) }))
    expect(r.source.summary).toBe('2 sources')
    expect(r.source.detail).toMatch(/platform, ipfs\.io/)
  })
})

describe('trust-anchor disclosure', () => {
  it('names the active network and its quorum endpoint', () => {
    for (const network of ['testnet', 'mainnet'] as const) {
      const r = deriveTrust(inputs({ network }))
      expect(r.quorumEndpoint).toBe(QUORUM_KEY_ENDPOINT[network])
      expect(r.proofs.detail).toContain(network)
      expect(r.proofs.detail).toContain(new URL(QUORUM_KEY_ENDPOINT[network]).host)
    }
    expect(deriveTrust(inputs({ network: 'mainnet' })).proofs.detail).not.toContain('testnet')
  })

  it('names the network by its key in copy', () => {
    expect(deriveTrust(inputs({ network: 'testnet' })).networkLabel).toBe('testnet')
    // Unnamed in this (testnet) build's resolution; a devnet build would read `devnet-<name>`.
    expect(deriveConnectionTrust('devnet', 'connecting').detail).toContain(NETWORKS.devnet.key)
  })

  it('the landing-page connection link follows the same rules', () => {
    expect(deriveConnectionTrust('mainnet', 'trusted').state).toBe('verified')
    expect(deriveConnectionTrust('mainnet', 'trusted').detail).toContain('mainnet')
    expect(deriveConnectionTrust('testnet', 'untrusted').state).toBe('unverified')
    expect(deriveConnectionTrust('testnet', 'connecting').state).toBe('pending')
  })
})

describe('worstOf', () => {
  it('ranks failed > unverified > partial > verified > pending', () => {
    expect(worstOf(['verified', 'failed', 'partial'])).toBe('failed')
    expect(worstOf(['verified', 'unverified', 'partial'])).toBe('unverified')
    expect(worstOf(['pending', 'verified'])).toBe('verified')
    expect(worstOf(['pending', 'pending'])).toBe('pending')
    expect(worstOf([])).toBe('pending')
  })
})

/**
 * The failure copy names the part that failed (QW-056, QW-057): the quorum key service is not
 * Platform, a quorum the app has no key for yet is not an outage, and a proof that failed is a
 * verification failure, never a raw GroveDB hash dump.
 */

import { describe, expect, it } from 'vitest'

import { QUORUM_KEY_ENDPOINT } from '../constants'
import { isProofFailure, isQuorumServiceError, isUnreachableError } from '../sdk/unreachable'
import { urlHost } from './format'
import { connectFailureCopy, proofFailureCopy, unreachableReadCopy } from './platform-failure'

/** What wasm-sdk's trusted context throws when the quorum service does not answer (measured). */
const PREFETCH = 'Failed to prefetch quorums: HTTP request error: error sending request'
/** The getDocuments bit-flip on bonsia (QA wave, code-browsing/19-tamper-getDocuments-bitflip). */
const GROVEDB =
  'grovedb: invalid proof: V1 mismatch in lower layer hash, expected 0a77b19486fb1d5cadbb2bb3f042ccc49cd3defcc8d0d2bafd57353446342d43, got c071e547e3f178bdb4f8b46aae0dde36368d766b5d77e0c3dbe26a4cbc7c90cf'
const QUORUM_GONE = 'context provider error: invalid quorum: Quorum not found in cache for hash: 00ab'

describe('connectFailureCopy', () => {
  it('names the quorum key service, not Platform, when the key prefetch failed', () => {
    const c = connectFailureCopy(PREFETCH, { network: 'testnet', cached: false })
    expect(c.title).toBe("Can't reach the quorum key service right now")
    expect(c.title).not.toMatch(/Dash Platform/)
    const host = urlHost(QUORUM_KEY_ENDPOINT.testnet)
    expect(host).not.toBe('')
    expect(c.body).toContain(host)
    expect(c.body).toMatch(/Dash Platform itself may be up/)
    // Failing closed is right: it still says nothing can be read or checked.
    expect(c.body).toMatch(/Nothing can be read or checked/)
  })

  it('with cached content, says it is not being re-checked', () => {
    expect(connectFailureCopy(PREFETCH, { network: 'testnet', cached: true }).body).toMatch(/not being re-checked/)
  })

  it('keeps the Platform wording for a DAPI outage', () => {
    const c = connectFailureCopy('Connecting to Platform timed out after 45 s', { network: 'testnet', cached: false })
    expect(c.title).toBe("Can't reach Dash Platform right now")
    expect(c.body).toBe('Nothing can be read or checked until the connection comes back.')
  })
})

describe('unreachableReadCopy', () => {
  it('a quorum the app has no key for yet is the key service lagging, not Platform down (#212)', () => {
    const c = unreachableReadCopy(QUORUM_GONE, { network: 'testnet', offline: false })
    expect(c.title).toBe('Waiting for new quorum keys')
    expect(c.body).toContain(urlHost(QUORUM_KEY_ENDPOINT.testnet))
    expect(c.body).toMatch(/try again by itself/)
  })

  it('offline wins, and a plain outage keeps its words', () => {
    expect(unreachableReadCopy(QUORUM_GONE, { network: 'testnet', offline: true }).title).toBe("You're offline")
    expect(unreachableReadCopy('Failed to fetch', { network: 'testnet', offline: false }).title).toBe("Couldn't reach Dash Platform")
  })
})

describe('proofFailureCopy', () => {
  it('turns a GroveDB proof mismatch into a plain verification failure without the hashes', () => {
    const c = proofFailureCopy(GROVEDB)
    expect(c).not.toBeNull()
    expect(c!.title).toMatch(/^Verification failed/)
    expect(c!.title + c!.body).not.toMatch(/grovedb|0a77b19486|lower layer/i)
    expect(c!.body).toMatch(/none of it is shown/)
  })

  it('is null for anything that is not a failed proof', () => {
    expect(proofFailureCopy('Failed to fetch')).toBeNull()
    expect(proofFailureCopy(QUORUM_GONE)).toBeNull()
    expect(proofFailureCopy('Invalid proof verification parameters: limit')).toBeNull()
  })
})

describe('classifiers', () => {
  it('a failed proof is an answer, not an outage', () => {
    expect(isProofFailure(GROVEDB)).toBe(true)
    expect(isProofFailure(new Error('Invalid proof: root hash'))).toBe(true)
    expect(isUnreachableError(GROVEDB)).toBe(false)
  })

  it('the key prefetch failure is the quorum service', () => {
    expect(isQuorumServiceError(PREFETCH)).toBe(true)
    expect(isQuorumServiceError(new Error('Fetching current quorums from: https://q failed'))).toBe(true)
    expect(isQuorumServiceError('Failed to fetch')).toBe(false)
    expect(isQuorumServiceError(QUORUM_GONE)).toBe(false)
  })
})

// @vitest-environment jsdom
/** The reader's own quorum service (Settings): what is accepted, and where it takes effect. */

import { afterEach, describe, expect, it } from 'vitest'

import { DEPLOYMENTS } from './deployments'
import { defaultQuorumEndpoint, quorumEndpoint, resolveNetworks } from './constants'
import { normalizeQuorumUrl, setUserQuorumUrl, userQuorumUrl } from './quorum-url'

afterEach(() => localStorage.clear())

describe('normalizeQuorumUrl', () => {
  it('takes an https URL, without a trailing slash', () => {
    expect(normalizeQuorumUrl(' https://quorums.example.org/ ')).toBe('https://quorums.example.org')
    expect(normalizeQuorumUrl('https://example.org:8443/dash/quorums/')).toBe('https://example.org:8443/dash/quorums')
  })

  it('refuses plain http, credentials, queries and non-URLs', () => {
    expect(normalizeQuorumUrl('http://quorums.example.org')).toBeNull()
    expect(normalizeQuorumUrl('https://user:pw@quorums.example.org')).toBeNull()
    expect(normalizeQuorumUrl('https://quorums.example.org/?x=1')).toBeNull()
    expect(normalizeQuorumUrl('quorums.example.org')).toBeNull()
    expect(normalizeQuorumUrl('')).toBeNull()
  })
})

describe('the saved quorum service', () => {
  it('is kept per network and cleared with null', () => {
    setUserQuorumUrl('testnet', 'https://quorums.example.org/')
    expect(userQuorumUrl('testnet')).toBe('https://quorums.example.org')
    expect(userQuorumUrl('mainnet')).toBeNull()
    setUserQuorumUrl('testnet', null)
    expect(userQuorumUrl('testnet')).toBeNull()
  })

  it('replaces the endpoint the SDK is given and the trust panel names', () => {
    const { networks } = resolveNetworks({ devnetName: 'sakura' }, DEPLOYMENTS)
    setUserQuorumUrl('testnet', 'https://quorums.example.org')
    setUserQuorumUrl('devnet-sakura', 'https://q.example.net')
    expect(quorumEndpoint(networks.testnet)).toBe('https://quorums.example.org')
    expect(defaultQuorumEndpoint(networks.testnet)).toBe('https://quorums.testnet.networks.dash.org')
    expect(quorumEndpoint(networks.devnet)).toBe('https://q.example.net')
    expect(quorumEndpoint(networks.mainnet)).toBe('https://quorums.mainnet.networks.dash.org')
  })

  it('ignores a stored value that is no longer acceptable', () => {
    localStorage.setItem('forge.quorumUrl.testnet', 'http://quorums.example.org')
    expect(userQuorumUrl('testnet')).toBeNull()
  })
})

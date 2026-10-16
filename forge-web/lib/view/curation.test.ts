/**
 * Hosted curation (docs/hosted-curation.md): the committed file is well formed, malformed
 * entries fail, and the filter drops hidden repos and the repos of hidden identities.
 */

import { describe, expect, it } from 'vitest'

import curationFile from '../../../forge-contracts/config/curation.json'
import { NETWORKS } from '../constants'
import { CURATION, curates, dropHidden, hiddenFor, isHiddenIdentity, isHiddenRepo, parseCuration } from './curation'

const ID_A = 'Amc7FjA3CJLae4stwztokTumqCX8KfDCkA3zNwVVYRZB'
const ID_B = 'Hynz8VtPiEBXn7VcMLCLCPgNo4uVK2KKveGn5P4CvinW'
const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, added: '2026-10-16', note: 'ticket 12', ...extra })
const file = (net: Record<string, unknown>) => ({ networks: { testnet: { hiddenRepos: [], hiddenIdentities: [], ...net } } })

describe('forge-contracts/config/curation.json', () => {
  it('is well formed, and lists the networks the web app is built for', () => {
    expect(() => parseCuration(curationFile)).not.toThrow()
    expect(Object.keys(CURATION).sort()).toEqual(['devnet-sakura', 'mainnet', 'testnet'])
    for (const net of Object.values(CURATION)) {
      expect(Array.isArray(net.hiddenRepos)).toBe(true)
      expect(Array.isArray(net.hiddenIdentities)).toBe(true)
    }
  })

  it('is keyed by the keys the build reports (ACTIVE_NETWORK.key)', () => {
    expect(NETWORKS.testnet.key).toBe('testnet')
    expect(NETWORKS.mainnet.key).toBe('mainnet')
    expect(CURATION[NETWORKS.testnet.key]).toBeDefined()
    expect(CURATION[NETWORKS.mainnet.key]).toBeDefined()
  })
})

describe('parseCuration', () => {
  it('reads entries with an id, a date and a note', () => {
    const parsed = parseCuration(file({ hiddenRepos: [entry(ID_A)], hiddenIdentities: [entry(ID_B, { note: 'abuse report 4' })] }))
    expect(parsed['testnet']?.hiddenRepos).toEqual([entry(ID_A)])
    expect(parsed['testnet']?.hiddenIdentities[0]?.note).toBe('abuse report 4')
  })

  it.each([
    ['a file that is not an object', 'nope'],
    ['no networks object', {}],
    ['a network that is not an object', { networks: { testnet: [] } }],
    ['a network missing a list', { networks: { testnet: { hiddenRepos: [] } } }],
    ['an unknown field on a network', { networks: { testnet: { hiddenRepos: [], hiddenIdentities: [], extra: [] } } }],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseCuration(raw)).toThrow(/curation\.json/)
  })

  it.each([
    ['an entry that is a bare id string', ID_A],
    ['an id that is not base58', entry('not-an-id!')],
    ['an id of the wrong length', entry('3mjPLkvnvTZ')],
    ['a missing date', { id: ID_A, note: 'x' }],
    ['a date that is not a date', entry(ID_A, { added: '2026-13-45' })],
    ['a date in another format', entry(ID_A, { added: '16 Oct 2026' })],
    ['an empty note', entry(ID_A, { note: '  ' })],
    ['a note of more than 200 characters', entry(ID_A, { note: 'x'.repeat(201) })],
    ['an unknown field', entry(ID_A, { reason: 'x' })],
  ])('rejects %s', (_name, bad) => {
    expect(() => parseCuration(file({ hiddenRepos: [bad] }))).toThrow(/hiddenRepos\[0\]/)
    expect(() => parseCuration(file({ hiddenIdentities: [bad] }))).toThrow(/hiddenIdentities\[0\]/)
  })

  it('rejects an id listed twice in one list', () => {
    expect(() => parseCuration(file({ hiddenRepos: [entry(ID_A), entry(ID_A)] }))).toThrow(/listed twice/)
  })
})

describe('hiding', () => {
  const hidden = hiddenFor('testnet', parseCuration(file({ hiddenRepos: [entry(ID_A)], hiddenIdentities: [entry(ID_B)] })))
  const repo = (key: string, ownerId: string) => ({ key, ownerId, name: key })

  it('hides a listed repo, and every repo of a listed identity', () => {
    expect(isHiddenRepo(ID_A, 'someone', hidden)).toBe(true)
    expect(isHiddenRepo('other-repo', ID_B, hidden)).toBe(true)
    expect(isHiddenRepo('other-repo', 'someone', hidden)).toBe(false)
    expect(isHiddenIdentity(ID_B, hidden)).toBe(true)
    // A hidden repo does not hide its owner's profile; only a hidden identity does.
    expect(isHiddenIdentity('someone', hidden)).toBe(false)
  })

  it('drops them from a list and keeps the order of the rest', () => {
    const rows = [repo('a', 'x'), repo(ID_A, 'x'), repo('b', ID_B), repo('c', 'y')]
    expect(dropHidden(rows, hidden).map((r) => r.key)).toEqual(['a', 'c'])
  })

  it('hides nothing for a network the file does not list, or an empty list', () => {
    const rows = [repo('a', 'x')]
    expect(dropHidden(rows, hiddenFor('devnet-unlisted', CURATION))).toEqual(rows)
    expect(curates(hiddenFor('testnet', parseCuration(file({}))))).toBe(false)
    expect(curates(hidden)).toBe(true)
  })

  it('reads each network apart', () => {
    const both = parseCuration({ networks: { testnet: { hiddenRepos: [entry(ID_A)], hiddenIdentities: [] }, mainnet: { hiddenRepos: [], hiddenIdentities: [] } } })
    expect(hiddenFor('testnet', both).repos.has(ID_A)).toBe(true)
    expect(hiddenFor('mainnet', both).repos.has(ID_A)).toBe(false)
  })
})

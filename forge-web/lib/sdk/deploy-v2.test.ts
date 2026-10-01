/**
 * The offline parts of `forge-contracts/scripts/deploy-v2.mjs` and `snapshot-contracts.mjs`
 * for the three-contract registration: the dependent contracts and their order, each schema
 * naming forge-core through the placeholder and loading once it is substituted, and the
 * snapshot covering forge-community.
 */

import { describe, expect, it } from 'vitest'

import { DEPENDENT_CONTRACTS, communityId, dependentSupersedeError, loadSchema, placeholderFor, schemaHash, supersedes } from '../../../forge-contracts/scripts/deploy-v2.mjs'
import { snapshotIds } from '../../../forge-contracts/scripts/snapshot-contracts.mjs'

const CORE_ID = '4xQ1gLbVttHSnHSNAexse7ByXJd7BQCRLgLYuPevrcTW'
const COLLAB_ID = '2EMkNwZUsFRdojAw4A1y3HrJsrvGBQuH8mPb6sDV4zxk'

/** A schema with the ids of the contracts registered before it (forge-community's events name forge-collab). */
const withCore = (name: string, coreId = CORE_ID) =>
  loadSchema(name, { FORGE_CORE_CONTRACT_ID: coreId, FORGE_COLLAB_CONTRACT_ID: COLLAB_ID }) as { documentSchemas: Record<string, unknown> }

describe('deploy-v2: the three forge-v2 contracts', () => {
  it('registers forge-collab, then forge-community, after forge-core', () => {
    expect(DEPENDENT_CONTRACTS).toEqual([
      { key: 'forgeCollab', schemaName: 'forge-collab', only: 'collab' },
      { key: 'forgeCommunity', schemaName: 'forge-community', only: 'community' },
    ])
  })

  it('refuses a dependent schema whose forge-core placeholder is left unresolved', () => {
    for (const { schemaName } of DEPENDENT_CONTRACTS) {
      expect(() => loadSchema(schemaName)).toThrow(/unresolved contract id placeholder/)
    }
  })

  it('substitutes forge-core id into every cross-contract reference', () => {
    for (const { schemaName } of DEPENDENT_CONTRACTS) {
      const text = JSON.stringify(withCore(schemaName))
      expect(text).not.toContain('_CONTRACT_ID')
      expect(text).toContain(CORE_ID)
    }
  })

  it("substitutes forge-collab's id into forge-community (its events name collab's issues and PRs)", () => {
    expect(() => loadSchema('forge-community', { FORGE_CORE_CONTRACT_ID: CORE_ID })).toThrow(/unresolved contract id placeholder/)
    expect(JSON.stringify(withCore('forge-community'))).toContain(COLLAB_ID)
    expect(JSON.stringify(withCore('forge-collab'))).not.toContain(COLLAB_ID)
  })

  it('names each placeholder after its contract', () => {
    expect(placeholderFor('forge-core')).toBe('FORGE_CORE_CONTRACT_ID')
    expect(placeholderFor('forge-collab')).toBe('FORGE_COLLAB_CONTRACT_ID')
  })

  it('splits the types between the three contracts with none shared', () => {
    const types = (name: string) => Object.keys(withCore(name).documentSchemas).sort()
    const collab = types('forge-collab')
    const community = types('forge-community')
    expect(collab).toEqual(['comment', 'issue', 'patch', 'repoKey', 'review', 'transition'])
    // starBeat only on the beat shape: a fused star (RC2 C1) carries Trending itself.
    const beat = community.includes('starBeat') ? ['starBeat'] : []
    expect(community).toEqual(['authorEvent', 'checkRun', 'event', 'follow', 'milestone', 'policy', 'profile', 'runner', 'star', ...beat, 'watch', 'webhook'])
    expect(types('forge-core').filter((t) => collab.includes(t) || community.includes(t))).toEqual([])
  })

  it("hashes the schema with forge-core's id substituted, so a new forge-core means a new hash", () => {
    const a = schemaHash(withCore('forge-community'))
    const b = schemaHash(withCore('forge-community', 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1'))
    expect(a).not.toBe(b)
  })
})

describe('deploy-v2: --force-new', () => {
  it('supersedes only a completed registration from another schema', () => {
    expect(supersedes({ status: 'registered', schemaHash: 'a' }, 'b')).toBe(true)
    expect(supersedes({ status: 'registered' }, 'b')).toBe(true) // predates schemaHash
    expect(supersedes({ status: 'registered', schemaHash: 'b' }, 'b')).toBe(false)
    expect(supersedes({ status: 'broadcasting', schemaHash: 'a' }, 'b')).toBe(false)
    expect(supersedes(undefined, 'b')).toBe(false)
  })

  it('refuses to add a dependent to the existing group unless --same-group, when forge-core is kept', () => {
    const at = { key: 'forgeCommunity', schemaName: 'forge-community', contractId: 'X' }
    expect(dependentSupersedeError({ ...at, coreSuperseded: false, sameGroup: false })).toMatch(/--same-group/)
    expect(dependentSupersedeError({ ...at, coreSuperseded: false, sameGroup: true })).toBeNull()
    expect(dependentSupersedeError({ ...at, coreSuperseded: true, sameGroup: false })).toBeNull()
  })
})

describe('deploy-v2: communityId', () => {
  it("is the record's forge-community, or forge-collab on a pre-split deployment", () => {
    expect(communityId({ v2: { forgeCollab: { contractId: 'L' }, forgeCommunity: { contractId: 'M' } } })).toBe('M')
    expect(communityId({ v2: { forgeCollab: { contractId: 'L' } } })).toBe('L')
    expect(communityId({})).toBeUndefined()
  })
})

describe('snapshot-contracts: snapshotIds', () => {
  it('includes forge-community beside DPNS, forge-core, forge-collab and the key exchange', () => {
    const ids = snapshotIds({
      v2: { forgeCore: { contractId: 'core' }, forgeCollab: { contractId: 'collab' }, forgeCommunity: { contractId: 'community' } },
      keyExchange: { contractId: 'kx' },
    })
    expect(ids).toEqual(['GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec', 'core', 'collab', 'community', 'kx'])
  })
})

/**
 * The offline parts of `forge-contracts/scripts/deploy-v2.mjs` and `snapshot-contracts.mjs`
 * for the three-contract registration: the dependent contracts and their order, each schema
 * naming forge-core through the placeholder and loading once it is substituted, and the
 * snapshot covering forge-community.
 */

import { describe, expect, it } from 'vitest'

import { DEPENDENT_CONTRACTS, dependentSupersedeError, loadSchema, schemaHash, supersedes } from '../../../forge-contracts/scripts/deploy-v2.mjs'
import { snapshotIds } from '../../../forge-contracts/scripts/snapshot-contracts.mjs'

const CORE_ID = '4xQ1gLbVttHSnHSNAexse7ByXJd7BQCRLgLYuPevrcTW'

const withCore = (name: string, coreId = CORE_ID) =>
  loadSchema(name, { FORGE_CORE_CONTRACT_ID: coreId }) as { documentSchemas: Record<string, unknown> }

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
      expect(text).not.toContain('FORGE_CORE_CONTRACT_ID')
      expect(text).toContain(CORE_ID)
    }
  })

  it('splits the types between the three contracts with none shared', () => {
    const types = (name: string) => Object.keys(withCore(name).documentSchemas).sort()
    const collab = types('forge-collab')
    const community = types('forge-community')
    expect(collab).toEqual(['authorEvent', 'comment', 'event', 'issue', 'milestone', 'patch', 'review', 'transition'])
    expect(community).toEqual(['checkRun', 'follow', 'policy', 'profile', 'star', 'starBeat', 'watch', 'webhook'])
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

describe('snapshot-contracts: snapshotIds', () => {
  it('includes forge-community beside DPNS, forge-core, forge-collab and the key exchange', () => {
    const ids = snapshotIds({
      v2: { forgeCore: { contractId: 'core' }, forgeCollab: { contractId: 'collab' }, forgeCommunity: { contractId: 'community' } },
      keyExchange: { contractId: 'kx' },
    })
    expect(ids).toEqual(['GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec', 'core', 'collab', 'community', 'kx'])
  })
})

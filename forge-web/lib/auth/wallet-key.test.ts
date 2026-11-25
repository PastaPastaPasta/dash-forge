import { describe, expect, it } from 'vitest'

import { contractKind, type ForgeIds } from '../deployments'
import { APP_CONNECT_CONTRACT_ID } from './app-connect-port'
import { heldToDisable } from './limited-key'
import { isForgeContract, isSigningContract, isUnlimited, keyScope, scopeCovers } from './wallet-key'
import { encodeWif } from './wif'

const FORGE: ForgeIds = {
  core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1',
  collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS', community: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
  group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC',
}

describe('which keys Forge signs with', () => {
  const bound = (b: { $type: string; id: string } | null) => ({ contractBounds: b ? { toJSON: () => b } : undefined })

  it('scopes keys by their bounds', () => {
    // FORGE is moutai's pre-split deployment: forge-community is forge-collab there
    expect(keyScope(bound({ $type: 'contractGroup', id: FORGE.group }), FORGE)).toEqual({ core: true, collab: true, community: true, meta: true, unbounded: false })
    expect(keyScope(bound({ $type: 'singleContract', id: FORGE.core }), FORGE)).toEqual({ core: true, collab: false, community: false, meta: true, unbounded: false })
    expect(keyScope(bound({ $type: 'singleContract', id: FORGE.collab }), FORGE)).toEqual({ core: false, collab: true, community: true, meta: true, unbounded: false })
    expect(keyScope(bound(null), FORGE)).toEqual({ core: true, collab: true, community: true, meta: true, unbounded: true })
    // Another app's key, a superseded group, or a document-type bound: not Forge's to use.
    expect(keyScope(bound({ $type: 'singleContract', id: APP_CONNECT_CONTRACT_ID }), FORGE)).toBeNull()
    expect(keyScope(bound({ $type: 'contractGroup', id: '23iVLZABbVQ5a4heSa6GLVbVqSWr74JTSESSMTEYNd6o' }), FORGE)).toBeNull()
    expect(keyScope(bound({ $type: 'documentType', id: FORGE.core }), FORGE)).toBeNull()
    const core = keyScope(bound({ $type: 'singleContract', id: FORGE.core }), FORGE)!
    expect(scopeCovers(core, FORGE, FORGE.core)).toBe(true)
    expect(scopeCovers(core, FORGE, FORGE.collab)).toBe(false)
    expect(scopeCovers(core, FORGE, 'SomeOtherContract')).toBe(false)
    // Even an unbounded key is only ever asked about Forge's two contracts.
    expect(scopeCovers(keyScope(bound(null), FORGE)!, FORGE, 'SomeOtherContract')).toBe(false)
  })

  it('lets a group-bound key sign on forge-user, never a key bound to one Forge contract', () => {
    const synced = { ...FORGE, user: 'UserContractId1111111111111111111111111111' }
    expect(scopeCovers(keyScope(bound({ $type: 'contractGroup', id: FORGE.group }), synced)!, synced, synced.user)).toBe(true)
    expect(scopeCovers(keyScope(bound(null), synced)!, synced, synced.user)).toBe(true)
    expect(scopeCovers(keyScope(bound({ $type: 'singleContract', id: FORGE.core }), synced)!, synced, synced.user)).toBe(false)
    expect(isSigningContract(synced, synced.user)).toBe(true)
    expect(isSigningContract(FORGE, synced.user)).toBe(false)
    expect(isForgeContract(synced, synced.user)).toBe(false)
  })

  it('scopes keys over three contracts: a forge-community key covers forge-community only', () => {
    const three = { ...FORGE, community: 'CommunityContractId1111111111111111111111111' }
    expect(keyScope(bound({ $type: 'singleContract', id: three.community }), three)).toEqual({ core: false, collab: false, community: true, meta: true, unbounded: false })
    expect(keyScope(bound({ $type: 'singleContract', id: three.collab }), three)).toEqual({ core: false, collab: true, community: false, meta: true, unbounded: false })
    expect(keyScope(bound({ $type: 'contractGroup', id: three.group }), three)).toEqual({ core: true, collab: true, community: true, meta: true, unbounded: false })
    const collabOnly = keyScope(bound({ $type: 'singleContract', id: three.collab }), three)!
    expect(scopeCovers(collabOnly, three, three.community)).toBe(false)
    expect(contractKind(three, three.community)).toBe('community')
    // Pre-split: the shared id reads as collab
    expect(contractKind(FORGE, FORGE.community)).toBe('collab')
    expect(contractKind(three, 'SomeOtherContract')).toBeNull()
  })

  it('scopes keys over four contracts (D44): a forge-meta key covers forge-meta only', () => {
    const four = { ...FORGE, community: 'CommunityContractId1111111111111111111111111', meta: 'MetaContractId11111111111111111111111111111' }
    expect(keyScope(bound({ $type: 'singleContract', id: four.meta }), four)).toEqual({ core: false, collab: false, community: false, meta: true, unbounded: false })
    expect(keyScope(bound({ $type: 'singleContract', id: four.core }), four)).toEqual({ core: true, collab: false, community: false, meta: false, unbounded: false })
    expect(keyScope(bound({ $type: 'contractGroup', id: four.group }), four)).toEqual({ core: true, collab: true, community: true, meta: true, unbounded: false })
    const core = keyScope(bound({ $type: 'singleContract', id: four.core }), four)!
    expect(scopeCovers(core, four, four.meta)).toBe(false)
    expect(contractKind(four, four.meta)).toBe('meta')
  })

  it('flags a key without a budget or an expiry as unlimited', () => {
    expect(isUnlimited({ limits: null })).toBe(true)
    expect(isUnlimited({ limits: { remaining: 1n, total: 1n, expiresAt: null } })).toBe(true)
    expect(isUnlimited({ limits: { remaining: 1n, total: 1n, expiresAt: 1 } })).toBe(false)
  })

  it('disables only live HIGH keys the stored private key controls (a key id alone picks nothing)', () => {
    const wif = encodeWif(new Uint8Array(32).fill(3), 'devnet')
    const mk = (keyId: number, controls: boolean, extra: Partial<{ purposeNumber: number; securityLevelNumber: number; disabledAt: bigint }> = {}) => ({
      keyId,
      purposeNumber: 0,
      securityLevelNumber: 2,
      ...extra,
      validatePrivateKey: (b: Uint8Array) => controls && b.every((x) => x === 3),
    })
    const keys = [mk(0, true, { securityLevelNumber: 0 }), mk(1, true, { securityLevelNumber: 1 }), mk(5, true), mk(6, false), mk(7, true, { disabledAt: 1n })]
    const held = [0, 1, 5, 6, 7, 99].map((keyId) => ({ keyId, wif }))
    expect(heldToDisable(keys, held, 'devnet')).toEqual([5])
    expect(heldToDisable(keys, [{ keyId: 5, wif: 'not a wif' }], 'devnet')).toEqual([])
  })
})

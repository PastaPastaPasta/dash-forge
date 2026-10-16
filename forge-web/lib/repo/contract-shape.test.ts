/** Feature detection from the registered contract: whether its forge-core admits the Bot role. */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import { contractAdmitsBots, contractImmutableWhen, contractPropertyMaximum, contractVisibilityOneWay, resetContractShapes } from './contract-shape'
import type { RepoRef } from './contract'
import { NoBotRoleError, grantMembershipDoc } from './writes'

/** An SDK whose one contract has a `writer` type with `role` up to `max` (none: no `role`). */
function sdkWith(max: number | null): EvoSDK {
  const role = max === null ? {} : { role: { type: 'integer', minimum: 1, maximum: max } }
  return {
    contracts: { fetch: async () => ({ schemas: { writer: { properties: { repoId: { type: 'array' }, ...role } } } }) },
  } as unknown as EvoSDK
}

describe('the Bot role by contract shape', () => {
  beforeEach(() => resetContractShapes())

  it("is offered only where writer.role goes up to 4 (the mainnet registration), never on sakura's (3)", async () => {
    expect(await contractAdmitsBots(sdkWith(4), 'core-4')).toBe(true)
    expect(await contractAdmitsBots(sdkWith(3), 'core-3')).toBe(false)
    expect(await contractAdmitsBots(sdkWith(null), 'core-rc1')).toBe(false)
  })

  it('reads an integer property maximum, and null where there is none', async () => {
    const sdk = sdkWith(3)
    expect(await contractPropertyMaximum(sdk, 'c', 'writer', 'role')).toBe(3)
    expect(await contractPropertyMaximum(sdk, 'c', 'writer', 'repoId')).toBeNull()
    expect(await contractPropertyMaximum(sdk, 'c', 'nope', 'role')).toBeNull()
  })
})

describe('a Bot grant', () => {
  beforeEach(() => resetContractShapes())

  it("is refused before anything is signed where the contract has no Bot role", async () => {
    const repo: RepoRef = {
      forge: { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' },
      repoId: '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB',
      ownerId: '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB',
      name: 'r',
      visibility: 'public',
    }
    const auth = { identityId: repo.ownerId, network: 'devnet' as const, getSigningKeyWif: () => 'x' }
    await expect(grantMembershipDoc(sdkWith(3), auth, repo, 'CiBot1111111111111111111111111111111111111', 'bot')).rejects.toThrow(NoBotRoleError)
  })
})

/** An SDK whose one contract's `repo` type has the `immutable` list `immutable`. */
function sdkWithImmutable(immutable: unknown): EvoSDK {
  return {
    contracts: { fetch: async () => ({ schemas: { repo: { properties: { name: {}, visibility: {}, forkOf: {} }, immutable } } }) },
  } as unknown as EvoSDK
}

describe("a repo's visibility by contract shape (forge-core immutable_when)", () => {
  beforeEach(() => resetContractShapes())

  it('is one-way only where it is frozen under a `when` (mainnet C1), never where it is frozen outright (sakura)', async () => {
    const sakura = sdkWithImmutable(['name', 'visibility', 'forkOf'])
    expect(await contractImmutableWhen(sakura, 'live', 'repo', 'visibility')).toBe(true)
    expect(await contractVisibilityOneWay(sakura, 'live')).toBe(false)
    const mainnet = sdkWithImmutable(['name', 'forkOf', { property: 'visibility', when: { equal: ['$old.visibility', { const: 'public' }] } }])
    expect(await contractImmutableWhen(mainnet, 'mainnet', 'repo', 'visibility')).toBe(false)
    expect(await contractVisibilityOneWay(mainnet, 'mainnet')).toBe(true)
    // an entry without `when` freezes it outright; the first entry naming it decides
    expect(await contractImmutableWhen(sdkWithImmutable([{ property: 'visibility' }, 'x']), 'bare', 'repo', 'visibility')).toBe(true)
    // not listed at all, no list, an unknown type: not one-way (nothing says it may change only once)
    expect(await contractImmutableWhen(sdkWithImmutable(['name']), 'none', 'repo', 'visibility')).toBeNull()
    expect(await contractVisibilityOneWay(sdkWithImmutable(undefined), 'nolist')).toBe(false)
    expect(await contractImmutableWhen(sdkWithImmutable([]), 'empty', 'issue', 'visibility')).toBeNull()
  })
})

/**
 * The membership cache: a read records over a cached one only when it started later (a newer
 * read's revocation shows at once, however young the cached entry), never when it started before
 * a membership change made through this tab, and a decision's read is never answered from it.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import type { Membership } from '../rules/v2'
import type { DocumentQuery } from '../sdk'
import type { RepoRef } from './contract'
import { invalidateMembers, membersGeneration, readMembershipsCached, readMembershipsFresh, seedMemberships } from './members'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const WRITER = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const REPO: RepoRef = { forge: FORGE, repoId: 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd', ownerId: OWNER, name: 'demo', visibility: 'public' }

const member = (identity: string, role: Membership['role']): Membership => ({ identity, role, createdAt: 1 })
const ids = (ms: readonly Membership[]): string[] => ms.map((m) => m.identity)

/** An SDK whose `maintainer` / `writer` documents are `docs` now, counting the queries. */
function fakeSdk(docs: { maintainer: string[]; writer: string[] }): { sdk: EvoSDK; queries: () => number } {
  let queries = 0
  const sdk = {
    documents: {
      query: (q: DocumentQuery) => {
        queries += 1
        const rows = (docs[q.documentTypeName as 'maintainer' | 'writer'] ?? []).map((id) => ({ $id: `${q.documentTypeName}:${id}`, $ownerId: OWNER, $createdAt: 1, repoId: REPO.repoId, memberId: id }))
        return Promise.resolve(new Map(rows.map((d) => [d.$id, d])))
      },
    },
  } as unknown as EvoSDK
  return { sdk, queries: () => queries }
}

beforeEach(() => invalidateMembers(REPO, 'devnet'))

describe('seedMemberships', () => {
  it('a newer read lands over a young cached one: a revocation it proves shows at once', async () => {
    const before = membersGeneration()
    seedMemberships(REPO, 'devnet', [member(MAINT, 'maintainer'), member(WRITER, 'writer')], before)
    const after = membersGeneration()
    seedMemberships(REPO, 'devnet', [member(MAINT, 'maintainer')], after)
    const { sdk, queries } = fakeSdk({ maintainer: [], writer: [] })
    expect(ids(await readMembershipsCached(sdk, REPO, 'devnet'))).toEqual([MAINT])
    expect(queries()).toBe(0)
  })

  it('an older read never lands over a newer one', async () => {
    const older = membersGeneration()
    const newer = membersGeneration()
    seedMemberships(REPO, 'devnet', [member(MAINT, 'maintainer')], newer)
    seedMemberships(REPO, 'devnet', [member(MAINT, 'maintainer'), member(WRITER, 'writer')], older)
    const { sdk } = fakeSdk({ maintainer: [], writer: [] })
    expect(ids(await readMembershipsCached(sdk, REPO, 'devnet'))).toEqual([MAINT])
  })

  it('a read that started before the cached read was issued does not replace it', async () => {
    const older = membersGeneration()
    const { sdk, queries } = fakeSdk({ maintainer: [MAINT], writer: [] })
    const read = readMembershipsCached(sdk, REPO, 'devnet')
    seedMemberships(REPO, 'devnet', [member(MAINT, 'maintainer'), member(WRITER, 'writer')], older)
    expect(ids(await read)).toEqual([MAINT])
    expect(ids(await readMembershipsCached(sdk, REPO, 'devnet'))).toEqual([MAINT])
    expect(queries()).toBe(2)
  })

  it('a read that started before a member change through this tab never lands', async () => {
    const started = membersGeneration()
    invalidateMembers(REPO, 'devnet')
    seedMemberships(REPO, 'devnet', [member(MAINT, 'maintainer'), member(WRITER, 'writer')], started)
    const { sdk, queries } = fakeSdk({ maintainer: [MAINT], writer: [] })
    expect(ids(await readMembershipsCached(sdk, REPO, 'devnet'))).toEqual([MAINT])
    expect(queries()).toBe(2)
  })
})

describe('readMembershipsFresh', () => {
  it('reads past a warm cache, and the cache then holds what it read', async () => {
    seedMemberships(REPO, 'devnet', [member(MAINT, 'maintainer'), member(WRITER, 'writer')], membersGeneration())
    const { sdk, queries } = fakeSdk({ maintainer: [MAINT], writer: [] })
    expect(ids(await readMembershipsFresh(sdk, REPO, 'devnet'))).toEqual([MAINT])
    expect(queries()).toBe(2)
    expect(ids(await readMembershipsCached(sdk, REPO, 'devnet'))).toEqual([MAINT])
    expect(queries()).toBe(2)
  })
})

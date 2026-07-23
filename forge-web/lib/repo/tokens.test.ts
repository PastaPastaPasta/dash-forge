/**
 * Token-history authz reconstruction + its effect on the issue fold.
 *
 * Proves the ported `tokens.rs::token_history()` invariants: owner baseSupply seeding,
 * mint→holder reconstruction, and owner-freeze observation — and, end to end, that a
 * non-author MAINTAIN holder's `close` now folds an issue to CLOSED while a non-holder's
 * does not (the gap the empty resolver left open).
 */

import { describe, expect, it } from 'vitest'

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode } from '../auth/base58'
import { AuthzResolver, foldIssueState, type Event } from '../rules'
import type { RepoRef } from './contract'
import { invalidateAuthz, readTokenHistory, resolveAuthz } from './tokens'

/** A deterministic base58 32-byte id from a seed byte. */
function id(seed: number): string {
  const b = new Uint8Array(32)
  for (let i = 0; i < 32; i++) b[i] = (seed + i) & 0xff
  return base58Encode(b)
}

const OWNER = id(1)
const MAINTAINER = id(50)
const OUTSIDER = id(120)
const AUTHOR = id(200)

const REPO: RepoRef = { contractId: id(9), ownerId: OWNER }

// Token ids the mock returns for positions 0 (write) / 1 (maintain).
const WRITE_TOKEN = id(70)
const MAINTAIN_TOKEN = id(80)

interface Doc {
  readonly $id: string
  readonly $createdAt: number
  readonly recipientId?: string
  readonly frozenIdentityId?: string
}

/** Build a mock EvoSDK whose token facade + document queries serve a fixed history. */
function mockSdk(history: {
  mints: Record<string, Doc[]> // keyed by base58 token id
  freezes?: Record<string, Doc[]>
}): EvoSDK {
  const opFor = (docType: string): Record<string, Doc[]> =>
    docType === 'mint' ? history.mints : docType === 'freeze' ? (history.freezes ?? {}) : {}

  const operand = (where: readonly (readonly unknown[])[] | undefined, field: string): string | null => {
    const clause = (where ?? []).find((w) => w[0] === field)
    return clause && typeof clause[2] === 'string' ? clause[2] : null
  }

  return {
    tokens: {
      calculateId: (_contractId: string, position: number): Promise<string> =>
        Promise.resolve(position === 0 ? WRITE_TOKEN : MAINTAIN_TOKEN),
    },
    documents: {
      query: (q: {
        documentTypeName: string
        where?: readonly (readonly unknown[])[]
      }): Promise<Map<string, Doc>> => {
        // Operands are base58 identifiers (tokenId / frozenIdentityId are identifier-typed).
        const tokenB58 = operand(q.where, 'tokenId')
        const frozenB58 = operand(q.where, 'frozenIdentityId')
        let docs = (tokenB58 && opFor(q.documentTypeName)[tokenB58]) || []
        if (frozenB58 !== null) {
          docs = docs.filter((d) => d.frozenIdentityId === frozenB58)
        }
        const map = new Map<string, Doc>()
        for (const d of docs) map.set(d.$id, d)
        return Promise.resolve(map)
      },
    },
  } as unknown as EvoSDK
}

describe('readTokenHistory', () => {
  it('seeds the owner baseSupply on both tokens at createdAt 0', async () => {
    const sdk = mockSdk({ mints: {} })
    const records = await readTokenHistory(sdk, REPO)
    const ownerSeeds = records.filter((r) => r.identity === OWNER && r.createdAt === 0 && r.op === 'mint')
    expect(ownerSeeds.map((r) => r.token).sort()).toEqual(['maintain', 'write'])
  })

  it('reconstructs a MAINTAIN mint as a holder record', async () => {
    const sdk = mockSdk({
      mints: {
        [MAINTAIN_TOKEN]: [{ $id: 'mint1', $createdAt: 100, recipientId: MAINTAINER }],
      },
    })
    const records = await readTokenHistory(sdk, REPO)
    const m = records.find((r) => r.identity === MAINTAINER)
    expect(m).toMatchObject({ token: 'maintain', op: 'mint', createdAt: 100 })
  })

  it('degrades to empty history on unknown (mainnet) network', async () => {
    const sdk = mockSdk({ mints: {} })
    expect(await readTokenHistory(sdk, REPO, 'mainnet')).toEqual([])
  })
})

describe('issue fold with reconstructed authz', () => {
  const issueClosedBy = (actor: string, at: number): Event => ({
    id: `e-${actor}-${at}`,
    targetId: 'issue-1',
    kind: 'close',
    actor,
    createdAt: at,
  })

  it('folds a non-author MAINTAINER close to CLOSED, but ignores a non-holder close', async () => {
    const sdk = mockSdk({
      mints: {
        [MAINTAIN_TOKEN]: [{ $id: 'mint1', $createdAt: 100, recipientId: MAINTAINER }],
      },
    })
    const resolver = new AuthzResolver(await readTokenHistory(sdk, REPO))

    // Maintainer (holds MAINTAIN since t=100) closes at t=200 → applies.
    expect(foldIssueState([issueClosedBy(MAINTAINER, 200)], AUTHOR, resolver).open).toBe(false)

    // Outsider (never minted) closes at t=200 → inert, stays open.
    expect(foldIssueState([issueClosedBy(OUTSIDER, 200)], AUTHOR, resolver).open).toBe(true)

    // Maintainer's action BEFORE its mint (t=50 < 100) is not yet authorized.
    expect(foldIssueState([issueClosedBy(MAINTAINER, 50)], AUTHOR, resolver).open).toBe(true)
  })

  it('observes an owner freeze: the owner cannot close while frozen', async () => {
    const sdk = mockSdk({
      mints: {},
      freezes: {
        [MAINTAIN_TOKEN]: [{ $id: 'fz1', $createdAt: 100, frozenIdentityId: OWNER }],
        [WRITE_TOKEN]: [{ $id: 'fz2', $createdAt: 100, frozenIdentityId: OWNER }],
      },
    })
    const resolver = new AuthzResolver(await readTokenHistory(sdk, REPO))

    // Owner acts before the freeze (t=50) → holds baseSupply, close applies.
    expect(foldIssueState([issueClosedBy(OWNER, 50)], AUTHOR, resolver).open).toBe(false)

    // Owner acts after the freeze (t=200) → frozen on both tokens, close is inert.
    expect(foldIssueState([issueClosedBy(OWNER, 200)], AUTHOR, resolver).open).toBe(true)
  })
})

describe('resolveAuthz caching', () => {
  /** Wrap a mock sdk with a document-query counter. */
  function counting(sdk: EvoSDK): { sdk: EvoSDK; queries: () => number } {
    const inner = sdk as unknown as { documents: { query: (q: unknown) => Promise<unknown> } }
    let n = 0
    const wrapped = {
      ...(sdk as unknown as Record<string, unknown>),
      documents: {
        query: (q: unknown): Promise<unknown> => {
          n += 1
          return inner.documents.query(q)
        },
      },
    } as unknown as EvoSDK
    return { sdk: wrapped, queries: () => n }
  }

  it('caches a successful resolver per contract; invalidateAuthz drops it', async () => {
    const repo: RepoRef = { contractId: id(30), ownerId: OWNER }
    const { sdk, queries } = counting(
      mockSdk({ mints: { [MAINTAIN_TOKEN]: [{ $id: 'm1', $createdAt: 100, recipientId: MAINTAINER }] } }),
    )

    await resolveAuthz(sdk, repo)
    const afterFirst = queries()
    expect(afterFirst).toBeGreaterThan(0)

    await resolveAuthz(sdk, repo)
    expect(queries()).toBe(afterFirst) // served from cache — no new reads

    invalidateAuthz(repo.contractId)
    await resolveAuthz(sdk, repo)
    expect(queries()).toBeGreaterThan(afterFirst)
    invalidateAuthz(repo.contractId)
  })

  it('does not cache a failed (degraded) reconstruction', async () => {
    const repo: RepoRef = { contractId: id(31), ownerId: OWNER }
    let calculateCalls = 0
    const sdk = {
      tokens: {
        calculateId: (): Promise<string> => {
          calculateCalls += 1
          return Promise.reject(new Error('unreachable'))
        },
      },
      documents: { query: (): Promise<Map<string, Doc>> => Promise.resolve(new Map()) },
    } as unknown as EvoSDK

    const degraded = await resolveAuthz(sdk, repo)
    expect(degraded.holdingsAsOf(OWNER, 1).write).toBe(false) // empty resolver
    expect(calculateCalls).toBeGreaterThan(0)

    const before = calculateCalls
    await resolveAuthz(sdk, repo) // failure was NOT pinned — the read retries
    expect(calculateCalls).toBeGreaterThan(before)
    invalidateAuthz(repo.contractId)
  })
})

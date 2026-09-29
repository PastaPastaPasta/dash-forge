/**
 * The web's transition reads and writes (`./transitions`) against a mock SDK: the document a
 * close / reopen / merge / draft / ready writes for each role and state, the retries around
 * consensus refusals, and the key encoding of the proved sum and grouped count reads.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Decode, base58Encode } from '../auth/base58'
import { ConsensusRefusal, uintGroupKey, uintOfGroupKey, type DocumentQuery, type WriteResult } from '../sdk'
import type { RepoRef } from './contract'
import { IllegalTransitionError, isStaleStateRefusal, readKindCounts, readStateCodes, transitionData, writeTransition, type StateTarget } from './transitions'

const id = (name: string): string => base58Encode(sha256(new TextEncoder().encode(name)))
const hex = (b58: string): string => [...base58Decode(b58)].map((b) => b.toString(16).padStart(2, '0')).join('')

const REPO: RepoRef = { forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }, repoId: id('repo'), ownerId: id('owner'), name: 'r', visibility: 'public' }
const AUTHOR = id('author')
const MAINT = id('maint')
const PR: StateTarget = { id: id('pr'), number: 7, type: 'patch', author: AUTHOR }
const ISSUE: StateTarget = { id: id('issue'), number: 3, type: 'issue', author: AUTHOR }
const OK: WriteResult = { documentId: 'T', confirmed: true, cost: { credits: 0, dash: 0, tokenAmount: 0 }, actualCredits: 0 } as unknown as WriteResult

/** An SDK whose sum query answers `codes` (base58 id → state code), recording each query. */
function sumSdk(codes: () => Record<string, number>, seen: DocumentQuery[] = []): EvoSDK {
  return {
    documents: {
      sum: async (q: DocumentQuery & { groupBy?: string[] }, property: string) => {
        seen.push(q)
        expect(property).toBe('delta')
        expect(q.groupBy).toEqual(['targetId'])
        return new Map(Object.entries(codes()).filter(([, c]) => c !== 0).map(([k, c]) => [hex(k), BigInt(c)]))
      },
    },
  } as unknown as EvoSDK
}

describe('transitionData', () => {
  it('writes the legal move with its delta, target kind and asAuthor', () => {
    const d = transitionData(PR, 0, 'close', 'author')
    expect(d).toMatchObject({ targetNumber: 7, targetKind: 1, kind: 11, delta: 1, asAuthor: 7 })
    expect(d['targetId']).toEqual(base58Decode(PR.id))
    expect(transitionData(PR, 8, 'close', 'member')).toMatchObject({ kind: 16, delta: 1, asAuthor: 0 })
    expect(transitionData(ISSUE, 1, 'reopen', 'member')).toMatchObject({ kind: 2, delta: -1, targetKind: 0, asAuthor: 0 })
    const merge = transitionData(PR, 0, 'merge', 'member', 'ab'.repeat(20))
    expect(merge).toMatchObject({ kind: 13, delta: 2, asAuthor: 0 })
    expect(merge['oid']).toEqual(new Uint8Array(20).fill(0xab))
  })

  it('refuses before signing what consensus would refuse', () => {
    expect(() => transitionData(PR, 2, 'reopen', 'member')).toThrow(/merged/)
    expect(() => transitionData(PR, 8, 'merge', 'member')).toThrow(/ready for review before merging/)
    expect(() => transitionData(PR, 1, 'merge', 'member')).toThrow(/reopen/)
    expect(() => transitionData(PR, 0, 'merge', 'author')).toThrow(IllegalTransitionError)
    expect(() => transitionData(PR, 0, 'merge', 'member')).toThrow(/names its commit/)
    expect(() => transitionData(ISSUE, 1, 'close', 'member')).toThrow(/already closed/)
    expect(() => transitionData(ISSUE, 0, 'draft', 'member')).toThrow(IllegalTransitionError)
    expect(() => transitionData(ISSUE, 0, 'close', 'other')).toThrow(IllegalTransitionError)
  })
})

describe('writeTransition', () => {
  const auth = (who: string) => ({ identityId: who, network: 'devnet' as const, getSigningKeyWif: () => '' })

  it('reads the state, then writes one transition as a member', async () => {
    const writes: Record<string, unknown>[] = []
    const seen: DocumentQuery[] = []
    await writeTransition(sumSdk(() => ({}), seen), auth(MAINT), REPO, async (type, data) => {
      expect(type).toBe('transition')
      writes.push(data)
      return OK
    }, { target: PR, action: 'draft', isMember: true })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ kind: 14, delta: 8, asAuthor: 0 })
    expect(seen[0]?.where).toEqual([['targetId', 'in', [PR.id]]])
  })

  it('writes as the author when the member gate refuses a stale membership', async () => {
    const writes: Record<string, unknown>[] = []
    let calls = 0
    await writeTransition(sumSdk(() => ({})), auth(AUTHOR), REPO, async (_t, data) => {
      calls++
      if (calls === 1) throw new ConsensusRefusal(40120, 'gate', {}, false)
      writes.push(data)
      return OK
    }, { target: PR, action: 'close', isMember: true })
    expect(writes).toEqual([expect.objectContaining({ kind: 11, asAuthor: 7 })])
  })

  it('re-reads and retries once when a state rule refuses (the target moved meanwhile)', async () => {
    let code = 0
    const writes: Record<string, unknown>[] = []
    await writeTransition(sumSdk(() => ({ [PR.id]: code })), auth(MAINT), REPO, async (_t, data) => {
      if (writes.length === 0 && data['kind'] === 11 && code === 0) {
        // Someone converted it to a draft between the read and the write.
        code = 8
        writes.push({ refused: true })
        throw new ConsensusRefusal(10422, 'A document of type "transition" breaks its propertyConstraints rule "c1_closedAfter": it does not hold', {}, false)
      }
      writes.push(data)
      return OK
    }, { target: PR, action: 'close', isMember: true })
    expect(writes[1]).toMatchObject({ kind: 16 })
  })

  it('says plainly when the move is not legal any more', async () => {
    await expect(
      writeTransition(sumSdk(() => ({ [PR.id]: 2 })), auth(MAINT), REPO, async () => OK, { target: PR, action: 'close', isMember: true }),
    ).rejects.toThrow(/merged/)
  })

  it('refuses a stranger and an author merge before reading anything', async () => {
    const seen: DocumentQuery[] = []
    await expect(writeTransition(sumSdk(() => ({}), seen), auth(id('x')), REPO, async () => OK, { target: PR, action: 'close', isMember: false })).rejects.toThrow(/author or a maintainer/)
    await expect(writeTransition(sumSdk(() => ({}), seen), auth(AUTHOR), REPO, async () => OK, { target: PR, action: 'merge', isMember: false, oidHex: 'ab'.repeat(20) })).rejects.toThrow(/maintainer or writer can merge/)
    expect(seen).toEqual([])
  })

  it('returns without writing when an earlier attempt already landed (a retry after a timeout)', async () => {
    const writes: unknown[] = []
    const r = await writeTransition(sumSdk(() => ({ [PR.id]: 2 })), auth(MAINT), REPO, async (_t, d) => {
      writes.push(d)
      return OK
    }, { target: PR, action: 'merge', isMember: true, oidHex: 'ab'.repeat(20), intent: 'm1' })
    expect(writes).toEqual([])
    expect(r).toMatchObject({ documentId: '', confirmed: true, actualCredits: 0 })
    // Close of a closed issue, ready of a ready PR: the same.
    await writeTransition(sumSdk(() => ({ [ISSUE.id]: 1 })), auth(MAINT), REPO, async () => { throw new Error('no write') }, { target: ISSUE, action: 'close', isMember: true })
    await writeTransition(sumSdk(() => ({})), auth(MAINT), REPO, async () => { throw new Error('no write') }, { target: PR, action: 'ready', isMember: true })
  })

  it('keys the intent by the action, so a retry replays the same write whatever it reads', async () => {
    const intents: (string | undefined)[] = []
    await writeTransition(sumSdk(() => ({})), auth(MAINT), REPO, async (_t, _d, intent) => {
      intents.push(intent)
      return OK
    }, { target: PR, action: 'close', isMember: true, intent: 'x' })
    expect(intents).toEqual(['x:close:m'])
  })

  it('still falls back to the author after a stale-state retry', async () => {
    let code = 0
    const seen: string[] = []
    await writeTransition(sumSdk(() => ({ [PR.id]: code })), auth(AUTHOR), REPO, async (_t, d) => {
      seen.push(`${d['kind']}/${d['asAuthor']}`)
      if (seen.length === 1) {
        code = 8
        throw new ConsensusRefusal(10422, 'breaks its propertyConstraints rule \\"c1_closedAfter\\": it does not hold', {}, false)
      }
      if (seen.length === 2) throw new ConsensusRefusal(40120, 'gate', {}, false)
      return OK
    }, { target: PR, action: 'close', isMember: true })
    expect(seen).toEqual(['11/0', '16/0', '16/7'])
  })

  it('recognises only the state rules as a stale-state refusal, quotes plain or escaped', () => {
    expect(isStaleStateRefusal(new ConsensusRefusal(10422, 'breaks its propertyConstraints rule \\"c2_openAfter\\": it does not hold'))).toBe(true)
    expect(isStaleStateRefusal(new ConsensusRefusal(10422, 'breaks its propertyConstraints rule "c3_mergedAfter": it does not hold'))).toBe(true)
    expect(isStaleStateRefusal(new ConsensusRefusal(10422, 'breaks its propertyConstraints rule "b1_closeDelta": it does not hold'))).toBe(false)
    expect(isStaleStateRefusal(new Error('rule "c1_closedAfter"'))).toBe(false)
  })
})

describe('proved reads', () => {
  it('reads a page of state codes in batches of 100, absent targets at 0', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => id(`t${i}`))
    const seen: DocumentQuery[] = []
    const codes = await readStateCodes(sumSdk(() => ({ [ids[3]!]: 1, [ids[120]!]: 9 }), seen), REPO, ids)
    expect(seen).toHaveLength(2)
    expect(codes.get(ids[3]!)).toBe(1)
    expect(codes.get(ids[120]!)).toBe(9)
    expect(codes.get(ids[0]!)).toBe(0)
    expect(codes.size).toBe(150)
  })

  it('decodes a grouped kind count from the tree key (top bit flipped), at any integer width', async () => {
    expect(uintGroupKey(1)).toBe('81')
    expect(uintGroupKey(13)).toBe('8d')
    expect(uintGroupKey(0x1234, 2)).toBe('9234')
    expect([uintOfGroupKey('81'), uintOfGroupKey('8000000d'), uintOfGroupKey('800000000000000b'), uintOfGroupKey('zz'), uintOfGroupKey('')]).toEqual([1, 13, 11, null, null])
    const sdk = (keys: [string, bigint][]) =>
      ({
        documents: {
          count: async (q: DocumentQuery & { groupBy?: string[]; limit?: number }) => {
            expect(q.groupBy).toEqual(['kind'])
            // A GroupByIn aggregate refuses any limit.
            expect(q.limit).toBeUndefined()
            return new Map(keys)
          },
        },
      }) as unknown as EvoSDK
    expect([...(await readKindCounts(sdk([['81', 5n], ['82', 2n], ['8d', 1n]]), REPO))]).toEqual([[1, 5], [2, 2], [13, 1]])
    // A u32-sized kind (a contract without sized integers) reads the same; unknown kinds are dropped.
    expect([...(await readKindCounts(sdk([['80000001', 4n], ['80000003', 9n]]), REPO))]).toEqual([[1, 4]])
  })
})

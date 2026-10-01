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
import { ISSUE_LOCK, ISSUE_UNLOCK, PR_CLOSE, PR_DRAFT, PR_DRAFT_CLOSE, PR_LOCK, isLocked, stateCode, statusOfCode, threadStateOf } from '../rules/transition'
import { IllegalTransitionError, closeReasonData, isStaleStateRefusal, readCloseReasons, readKindCounts, readStateCodes, readThreadStates, transitionData, writeLock, writeTransition, type StateTarget } from './transitions'
import { resetContractShapes } from './contract-shape'

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

  /** `sumSdk` over a forge-collab whose transition has (or lacks) the QW-069 rider. */
  const riderSdk = (rider: boolean): EvoSDK => {
    resetContractShapes()
    const props = rider ? { kind: {}, reason: {}, dupNumber: {} } : { kind: {} }
    return { ...sumSdk(() => ({})), contracts: { fetch: async (cid: string) => (cid === 'COLLAB' ? { schemas: { transition: { properties: props } } } : null) } } as unknown as EvoSDK
  }

  it('records why an issue closes where the contract has the rider (QW-069)', async () => {
    const writes: Record<string, unknown>[] = []
    const intents: (string | undefined)[] = []
    const record = async (_t: string, data: Record<string, unknown>, intent?: string) => {
      writes.push(data)
      intents.push(intent)
      return OK
    }
    await writeTransition(riderSdk(true), auth(MAINT), REPO, record, { target: ISSUE, action: 'close', isMember: true, intent: 'i', closed: { reason: 'duplicate', duplicateOf: 1 } })
    await writeTransition(riderSdk(true), auth(MAINT), REPO, record, { target: ISSUE, action: 'close', isMember: true, intent: 'i', closed: { reason: 'not_planned', duplicateOf: null } })
    // a contract without it: the plain close
    await writeTransition(riderSdk(false), auth(MAINT), REPO, record, { target: ISSUE, action: 'close', isMember: true, closed: { reason: 'not_planned', duplicateOf: null } })
    // a PR close never says why
    await writeTransition(riderSdk(true), auth(MAINT), REPO, record, { target: PR, action: 'close', isMember: true, closed: { reason: 'not_planned', duplicateOf: null } })
    expect(writes.map((w) => [w['kind'], w['reason'], w['dupNumber']])).toEqual([
      [1, 3, 1],
      [1, 2, undefined],
      [1, undefined, undefined],
      [11, undefined, undefined],
    ])
    // each reason its own intent: a retry never replays another reason's bytes
    expect(intents.slice(0, 2)).toEqual(['i:close:m:3-1', 'i:close:m:2'])
  })

  it('refuses a duplicate of itself, or a canonical beside another reason', () => {
    expect(closeReasonData({ reason: 'completed', duplicateOf: null }, 3)).toEqual({ reason: 1 })
    expect(() => closeReasonData({ reason: 'duplicate', duplicateOf: 3 }, 3)).toThrow(/cannot be a duplicate of #3/)
    expect(() => closeReasonData({ reason: 'not_planned', duplicateOf: 2 }, 3)).toThrow(/only a close as a duplicate/)
  })

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

describe('the lock bit (RC1 R-15: kinds 3/4 and 18/19, delta ±16, sums read mod 16)', () => {
  const auth = (who: string) => ({ identityId: who, network: 'devnet' as const, getSigningKeyWif: () => '' })

  it('reads a locked target as its state code mod 16 plus the lock bit', async () => {
    const sums = { [PR.id]: 16 + 9, [ISSUE.id]: 16 + 1 }
    expect(await readStateCodes(sumSdk(() => sums), REPO, [PR.id, ISSUE.id])).toEqual(new Map([[PR.id, 9], [ISSUE.id, 1]]))
    expect(await readThreadStates(sumSdk(() => sums), REPO, [PR.id])).toEqual(new Map([[PR.id, { code: 9, locked: true }]]))
    expect(threadStateOf(0)).toEqual({ code: 0, locked: false })
    expect(threadStateOf(-3)).toEqual({ code: 13, locked: false })
  })

  it('folds a timeline: a lock and an unlock leave the state untouched', () => {
    const t = (kind: number) => ({ kind })
    expect(stateCode([t(PR_CLOSE), t(PR_LOCK)])).toBe(1)
    expect(isLocked([t(PR_CLOSE), t(PR_LOCK)])).toBe(true)
    expect(isLocked([t(ISSUE_LOCK), t(ISSUE_UNLOCK)])).toBe(false)
    // A lock on a closed draft still leaves it a closed draft.
    expect(statusOfCode(stateCode([t(PR_DRAFT), t(PR_DRAFT_CLOSE), t(PR_LOCK)]))).toEqual({ open: false, merged: false, draft: true })
  })

  it('a state move on a locked target is picked from the code, not the raw sum', async () => {
    const writes: Record<string, unknown>[] = []
    await writeTransition(sumSdk(() => ({ [ISSUE.id]: 16 })), auth(MAINT), REPO, async (_type, data) => {
      writes.push(data)
      return OK
    }, { target: ISSUE, action: 'close', isMember: true })
    expect(writes[0]).toMatchObject({ kind: 1, delta: 1 })
  })

  it('locks as a member (asAuthor 0), and writes nothing when already in the asked state', async () => {
    const writes: Record<string, unknown>[] = []
    const write = async (_type: string, data: Record<string, unknown>) => {
      writes.push(data)
      return OK
    }
    await writeLock(sumSdk(() => ({ [PR.id]: 1 })), auth(MAINT), REPO, write, { target: PR, lock: true, isMember: true })
    await writeLock(sumSdk(() => ({ [ISSUE.id]: 16 })), auth(MAINT), REPO, write, { target: ISSUE, lock: false, isMember: true })
    const done = await writeLock(sumSdk(() => ({ [ISSUE.id]: 17 })), auth(MAINT), REPO, write, { target: ISSUE, lock: true, isMember: true })
    expect(writes).toEqual([
      expect.objectContaining({ kind: PR_LOCK, delta: 16, targetKind: 1, asAuthor: 0 }),
      expect.objectContaining({ kind: ISSUE_UNLOCK, delta: -16, targetKind: 0, asAuthor: 0 }),
    ])
    expect(done.documentId).toBe('')
    await expect(writeLock(sumSdk(() => ({})), auth(AUTHOR), REPO, write, { target: ISSUE, lock: true, isMember: false })).rejects.toThrow(/maintainer or writer/)
  })

  it('re-reads once when c6 refuses (someone locked it meanwhile)', async () => {
    let sum = 0
    let calls = 0
    const done = await writeLock(sumSdk(() => ({ [PR.id]: sum })), auth(MAINT), REPO, async () => {
      calls++
      sum = 16
      throw new ConsensusRefusal(10422, 'breaks its propertyConstraints rule "c6_lockedAfter"')
    }, { target: PR, lock: true, isMember: true })
    expect(calls).toBe(1)
    expect(done.documentId).toBe('')
  })
})

describe('readCloseReasons (QW-069)', () => {
  it('reads a page of closed issues\' transitions once, and says why each closed', async () => {
    const A = { id: id('a'), number: 1 }
    const B = { id: id('b'), number: 2 }
    const seen: DocumentQuery[] = []
    const sdk = {
      documents: {
        query: async (q: DocumentQuery) => {
          seen.push(q)
          const doc = (target: string, kind: number, at: number, reason?: number) => ({ $id: id(`${target}${at}`), $ownerId: MAINT, $createdAt: at, targetId: target, kind, asAuthor: 0, ...(reason ? { reason } : {}) })
          const rows = [doc(A.id, 1, 1, 2), doc(B.id, 1, 1, 2), doc(B.id, 2, 2), doc(B.id, 1, 3)]
          return new Map(rows.map((d) => [d.$id, d]))
        },
      },
    } as unknown as EvoSDK
    const got = await readCloseReasons(sdk, REPO, [A, B])
    expect([...got]).toEqual([[A.id, { reason: 'not_planned', duplicateOf: null }]])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.where).toEqual([['targetId', 'in', [A.id, B.id].sort()]])
    // more than one proved `in` can name: none read
    const many = Array.from({ length: 101 }, (_, i) => ({ id: id(`m${i}`), number: i + 1 }))
    expect((await readCloseReasons(sdk, REPO, many)).size).toBe(0)
    expect(seen).toHaveLength(1)
  })
})

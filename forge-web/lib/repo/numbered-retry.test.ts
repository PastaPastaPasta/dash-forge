/**
 * A numbered write (issue, PR) retried after an edit (D-008, review N1/N2): once the write
 * engine answers "your earlier attempt was posted", every later retry of the same action must
 * go back to the same number (whose intent holds the engine's tombstone), never allocate the
 * next number and post the edited version as a second issue.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { RepoRef } from './contract'

/** The intents the engine was asked to write, in order. */
const intents: (string | undefined)[] = []
/** What the engine answers for each intent. */
let answer: (intent: string | undefined) => Promise<unknown>
/** Issue numbers visible on Platform (what numbering reads). */
let visible: number[] = []

vi.mock('../sdk/write', async (orig) => {
  const real = await orig<typeof import('../sdk/write')>()
  return {
    ...real,
    createDocumentIdempotent: async (_sdk: unknown, _auth: unknown, p: { intent?: string }) => {
      intents.push(p.intent)
      return answer(p.intent)
    },
  }
})
vi.mock('../sdk/query', async (orig) => {
  const real = await orig<typeof import('../sdk/query')>()
  const rows = (): Record<string, unknown>[] => visible.map((n) => ({ $id: `id${n}`, $ownerId: 'someone', number: n }))
  return {
    ...real,
    countDocuments: async () => visible.length,
    // The repo has no maintainer documents: the owner alone is trusted (and wrote nothing).
    queryAllDocuments: async () => [],
    queryDocumentsWithProof: async (_sdk: unknown, q: { where?: [string, string, unknown][]; orderBy?: [string, string][] }) => {
      let docs = rows()
      for (const [field, op, v] of q.where ?? []) {
        if (field === '$ownerId') docs = docs.filter((d) => d['$ownerId'] === v)
        if (field !== 'number') continue
        docs = docs.filter((d) => {
          const n = d['number'] as number
          return op === '<=' ? n <= (v as number) : op === '>' ? n > (v as number) : op === '==' ? n === v : true
        })
      }
      if (q.orderBy?.some(([f, dir]) => f === 'number' && dir === 'desc')) docs.reverse()
      return { documents: docs, proof: true }
    },
  }
})

const { createIssue } = await import('./writes')
const { SupersededWriteError, UnconfirmedWriteError } = await import('../sdk/write')

const REPO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' },
  repoId: base58Encode(new Uint8Array(32).fill(0x11)),
  ownerId: base58Encode(new Uint8Array(32).fill(0x21)),
  name: 'repo',
  visibility: 'public',
}
const AUTH = { identityId: base58Encode(new Uint8Array(32).fill(0x21)), network: 'devnet' as const, getSigningKeyWif: () => 'W' }
const sdk = {} as EvoSDK

beforeEach(() => {
  intents.length = 0
  visible = [1, 2]
  const store = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
})

describe('a numbered write retried after an edit (review N1/N2)', () => {
  it('after "your earlier attempt was posted", every retry returns to that number', async () => {
    // A (#3) times out.
    answer = async () => {
      throw new UnconfirmedWriteError('A')
    }
    await expect(createIssue(sdk, AUTH, REPO, { title: 'A', body: '', intent: 'draft' })).rejects.toBeInstanceOf(UnconfirmedWriteError)
    // A lands; the edited retry is told so (the engine's tombstone under `draft#3`).
    visible = [1, 2, 3]
    answer = async () => {
      throw new SupersededWriteError('A')
    }
    await expect(createIssue(sdk, AUTH, REPO, { title: 'B', body: '', intent: 'draft' })).rejects.toBeInstanceOf(SupersededWriteError)
    // The same click again: back to #3 (the tombstone answers), never #4.
    await expect(createIssue(sdk, AUTH, REPO, { title: 'B', body: '', intent: 'draft' })).rejects.toBeInstanceOf(SupersededWriteError)
    expect(intents).toEqual(['draft#3', 'draft#3', 'draft#3'])
  })

  it('a write refused for good frees the number: the next attempt allocates afresh', async () => {
    const { ConsensusRefusal } = await import('../sdk/write')
    answer = async () => {
      throw new ConsensusRefusal(40218, 'budget', {}, false)
    }
    await expect(createIssue(sdk, AUTH, REPO, { title: 'A', body: '', intent: 'draft2' })).rejects.toBeInstanceOf(ConsensusRefusal)
    visible = [1, 2, 3]
    answer = async () => ({ documentId: 'X', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: 0 })
    const r = await createIssue(sdk, AUTH, REPO, { title: 'A', body: '', intent: 'draft2' })
    expect(r.number).toBe(4)
    expect(intents).toEqual(['draft2#3', 'draft2#4'])
  })
})

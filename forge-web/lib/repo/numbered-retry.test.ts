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
/** Issue numbers visible on Platform (what numbering reads: issue and PR totals, one sequence). */
let visible: number[] = []
/** PRs visible on Platform. */
let visiblePatches = 0
/** The document types and data the engine was asked to write, in order. */
const types: (string | undefined)[] = []
const datas: (Record<string, unknown> | undefined)[] = []

vi.mock('../sdk/write', async (orig) => {
  const real = await orig<typeof import('../sdk/write')>()
  return {
    ...real,
    createDocumentIdempotent: async (_sdk: unknown, _auth: unknown, p: { intent?: string; documentType?: string; data?: Record<string, unknown> }) => {
      intents.push(p.intent)
      types.push(p.documentType)
      datas.push(p.data)
      return answer(p.intent)
    },
  }
})
vi.mock('../sdk/query', async (orig) => {
  const real = await orig<typeof import('../sdk/query')>()
  const rows = (): Record<string, unknown>[] => visible.map((n) => ({ $id: `id${n}`, $ownerId: 'someone', number: n }))
  return {
    ...real,
    countDocuments: async (_sdk: unknown, q: { documentTypeName: string }) => (q.documentTypeName === 'patch' ? visiblePatches : visible.length),
    // No transitions yet: every target is open and ready.
    sumDocumentsGrouped: async () => new Map(),
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

const { createIssue, createPatch, DraftMarkError } = await import('./writes')
const { SupersededWriteError, UnconfirmedWriteError } = await import('../sdk/write')

const REPO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', group: 'GROUP' },
  repoId: base58Encode(new Uint8Array(32).fill(0x11)),
  ownerId: base58Encode(new Uint8Array(32).fill(0x21)),
  name: 'repo',
  visibility: 'public',
}
const AUTH = { identityId: base58Encode(new Uint8Array(32).fill(0x21)), network: 'devnet' as const, getSigningKeyWif: () => 'W' }
const sdk = {} as EvoSDK

beforeEach(() => {
  intents.length = 0
  types.length = 0
  datas.length = 0
  visible = [1, 2]
  visiblePatches = 0
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

  it('retries with a fresh count when the dense rule refuses the number (another create landed first)', async () => {
    const { ConsensusRefusal } = await import('../sdk/write')
    let first = true
    const retried: [number, number][] = []
    answer = async () => {
      if (first) {
        first = false
        // A PR took #3 between the count and the write.
        visiblePatches = 1
        throw new ConsensusRefusal(10422, 'A document of type "issue" breaks its propertyConstraints rule "dense": it does not hold', {}, true)
      }
      return { documentId: 'X', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: 0 }
    }
    const r = await createIssue(sdk, AUTH, REPO, { title: 'A', body: '', intent: 'dense' }, (taken, next) => retried.push([taken, next]))
    expect(r.number).toBe(4)
    expect(intents).toEqual(['dense#3', 'dense#4'])
    expect(retried).toEqual([[3, 4]])
  })

  it('does not retry a refusal naming another rule', async () => {
    const { ConsensusRefusal } = await import('../sdk/write')
    answer = async () => {
      throw new ConsensusRefusal(10422, 'A document of type "issue" breaks its propertyConstraints rule "hasTitle": it does not hold', {}, false)
    }
    await expect(createIssue(sdk, AUTH, REPO, { title: 'A', body: '', intent: 'other' })).rejects.toBeInstanceOf(ConsensusRefusal)
    expect(intents).toEqual(['other#3'])
  })

  it('numbers issues and PRs in one sequence: two issues and one PR, the next issue is #4', async () => {
    visiblePatches = 1
    answer = async () => ({ documentId: 'X', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: 0 })
    expect((await createIssue(sdk, AUTH, REPO, { title: 'A', body: '' })).number).toBe(4)
  })

  it('a draft PR is the patch then its author’s draft transition; a failed mark never posts the PR again', async () => {
    const { ConsensusRefusal } = await import('../sdk/write')
    const OK = { documentId: 'PATCH', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: 0 }
    const input = { title: 'P', body: '', baseRefName: 'refs/heads/main', sourceRepoId: REPO.repoId, sourceRefName: 'refs/heads/x', headOid: 'ab'.repeat(20), draft: true, intent: 'pr' }
    // The patch lands; the draft mark goes through.
    answer = async () => ({ ...OK, documentId: base58Encode(new Uint8Array(32).fill(0x33)) })
    const ok = await createPatch(sdk, AUTH, REPO, input)
    expect(ok.number).toBe(3)
    expect(types).toEqual(['patch', 'transition'])
    expect(datas[0]).toMatchObject({ number: 3, tk: 1 })
    expect('draft' in (datas[0] ?? {})).toBe(false)
    expect(datas[1]).toMatchObject({ kind: 14, delta: 8, targetKind: 1, asAuthor: 3, targetNumber: 3 })

    // The patch lands; the draft mark is refused: the error names the PR that landed.
    types.length = 0
    answer = async (intent) => {
      if (intent?.includes(':draft')) throw new ConsensusRefusal(40218, 'budget', {}, false)
      return { ...OK, documentId: base58Encode(new Uint8Array(32).fill(0x34)) }
    }
    const err = await createPatch(sdk, AUTH, REPO, { ...input, intent: 'pr2' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DraftMarkError)
    expect((err as InstanceType<typeof DraftMarkError>).created.number).toBe(3)
    expect(types).toEqual(['patch', 'transition'])
  })
})

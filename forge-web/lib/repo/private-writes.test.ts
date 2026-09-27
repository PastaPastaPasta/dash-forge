/**
 * Sealed writes (`private-repos.md` §4, §5.3) over an in-memory chain: the public writers
 * (`createIssue`, `createPatch`, `createComment`, `createReview`, `writeRefUpdate`) seal a
 * private repo's content under the current write epoch, and what they post opens through a
 * member's gate with the same text, and never carries a plaintext content field. Also: a
 * private create writes repo → maintainer → the owner's epoch-0 self-wrap → the sealed anchor.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { EncKeyLike, EncryptionOps } from '../auth/encryption-key'
import { EpochKeys, WrapError, sealDoc } from '../private'
import type { Membership } from '../rules/v2'
import { base64ToBytes, bytesToBase64, type DocumentQuery } from '../sdk'
import type { RepoRef } from './contract'

type Doc = Record<string, unknown>
const chain: Record<string, Doc[]> = {}
let height = 1000
let seq = 0
const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const REPO = id(0x11)
const ALICE = id(0x21)
const CAROL = id(0x23)
const FORGE = { core: 'CORE', collab: 'COLLAB', group: 'GROUP' }
const REPO_REF: RepoRef = { forge: FORGE, repoId: b58(REPO), ownerId: b58(ALICE), name: 'secret', visibility: 'private' }
const K0 = Uint8Array.from({ length: 32 }, (_, i) => i)
const K1 = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i)

function nextId(): string {
  seq += 1
  const u = new Uint8Array(32)
  new DataView(u.buffer).setUint32(28, seq)
  return b58(u)
}
const stored = (v: unknown): unknown => (v instanceof Uint8Array ? (v.length === 32 ? b58(v) : bytesToBase64(v)) : v)

vi.mock('../sdk/write', async (orig) => {
  const real = await orig<typeof import('../sdk/write')>()
  return {
    ...real,
    createDocumentIdempotent: async (_sdk: unknown, auth: { identityId: string }, p: { documentType: string; data: Doc; intent?: string }) => {
      intents.push(p.intent)
      // Someone else holds this number (the unique `(repoId, number)` index refuses it).
      if ((p.documentType === 'issue' || p.documentType === 'patch') && squatted.has(p.data['number'] as number)) {
        squatted.delete(p.data['number'] as number)
        throw new real.ConsensusRefusal(real.DUPLICATE_UNIQUE_CODE, 'duplicate unique index')
      }
      height += 1
      const doc: Doc = { $id: nextId(), $ownerId: auth.identityId, $createdAt: height * 1000, $createdAtBlockHeight: height }
      for (const [k, v] of Object.entries(p.data)) doc[k] = k === 'enc' || k === 'wrapped' || k.endsWith('Hash') || k.endsWith('Oid') ? (v instanceof Uint8Array ? bytesToBase64(v) : v) : stored(v)
      ;(chain[p.documentType] ??= []).push(doc)
      return { documentId: String(doc['$id']), confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: 0 }
    },
  }
})
vi.mock('../sdk/facade', async (orig) => ({ ...(await orig<typeof import('../sdk/facade')>()), sleep: async () => undefined }))

let members: Membership[] = []
/** Issue / PR numbers another writer takes first (their write refuses ours once). */
const squatted = new Set<number>()
/** How many sessions were loaded (one per write action, not per document). */
let sessionLoads = 0
/** The intent of every write (the engine replays a cached signed write per intent). */
const intents: (string | undefined)[] = []
vi.mock('./members', async (orig) => ({ ...(await orig<typeof import('./members')>()), readMemberships: async () => members, invalidateMembers: () => undefined }))

const encKey = (keyId = 4): EncKeyLike => ({ keyId, purposeNumber: 1, keyTypeNumber: 0, data: '02' + 'ab'.repeat(32) })
/** The identity's public keys (a newer encryption key 5 can be added). */
let identityKeys: EncKeyLike[] = [encKey()]
const ops: EncryptionOps = {
  keyId: 4,
  unwrap: async (p) => (await ops.unwrapRaw(p)).keys,
  unwrapRaw: async (p) => {
    const bytes = p.document['wrapped']
    const raw = typeof bytes === 'string' ? base64ToBytes(bytes) : new Uint8Array(0)
    if (raw.length !== 32) throw new WrapError('wrapUnreadable')
    return { keys: await EpochKeys.import(p.repoId, p.epoch, raw), raw: new Uint8Array(raw) }
  },
  wrap: async (p) => ({ wrapped: new Uint8Array(p.raw), recipientKeyId: 4, senderKeyId: 4 }),
}
let held: EncryptionOps | null = ops
vi.mock('../auth/encryption-key', async (orig) => ({ ...(await orig<typeof import('../auth/encryption-key')>()), encryptionOps: async () => held }))

function query(q: DocumentQuery): Map<string, Doc> {
  if (q.documentTypeName === 'config' && (q.where ?? []).length === 1) sessionLoads += 1
  let rows = [...(chain[q.documentTypeName] ?? [])]
  for (const [f, op, v] of q.where ?? []) {
    if (op === '==') rows = rows.filter((d) => String(d[f]) === String(v))
    if (op === '<=') rows = rows.filter((d) => (d[f] as number) <= (v as number))
    if (op === '>') rows = rows.filter((d) => (d[f] as number) > (v as number))
  }
  const [field, dir] = q.orderBy?.at(-1) ?? ['$createdAt', 'asc']
  rows.sort((a, b) => ((a[field] as number) - (b[field] as number)) * (dir === 'desc' ? -1 : 1))
  return new Map(rows.slice(0, q.limit ?? 100).map((d) => [String(d['$id']), d]))
}
const sdk = {
  documents: { query: async (q: DocumentQuery) => query(q), count: async (q: DocumentQuery) => new Map([['', BigInt(query(q).size)]]) },
  identities: { fetch: async () => ({ publicKeys: identityKeys, balance: 0n }) },
} as unknown as EvoSDK
const auth = { identityId: b58(ALICE), network: 'devnet' as const, getSigningKeyWif: () => 'x' }

async function anchor(owner: Uint8Array, keys: EpochKeys, fields: Parameters<typeof sealDoc>[2]): Promise<void> {
  height += 1
  ;(chain['config'] ??= []).push({
    $id: nextId(),
    $ownerId: b58(owner),
    $createdAt: height * 1000,
    $createdAtBlockHeight: height,
    repoId: b58(REPO),
    epoch: keys.epoch,
    enc: bytesToBase64(await sealDoc(keys, { type: 'config', ownerId: owner, epoch: keys.epoch }, fields, { anchor: true })),
    backend: { mode: 0 },
  })
}
function wrap(owner: Uint8Array, member: Uint8Array, epoch: number, raw: Uint8Array): void {
  height += 1
  ;(chain['repoKey'] ??= []).push({
    $id: nextId(), $ownerId: b58(owner), $createdAt: height * 1000, $createdAtBlockHeight: height,
    repoId: b58(REPO), memberId: b58(member), epoch, recipientKeyId: 4, senderKeyId: 4, wrapped: bytesToBase64(raw),
  })
}

beforeEach(async () => {
  for (const k of Object.keys(chain)) delete chain[k]
  held = ops
  squatted.clear()
  sessionLoads = 0
  intents.length = 0
  identityKeys = [encKey()]
  members = [
    { identity: b58(ALICE), role: 'maintainer', createdAt: 1 },
    { identity: b58(CAROL), role: 'writer', createdAt: 2 },
  ]
  await anchor(ALICE, await EpochKeys.import(REPO, 0, K0), { defaultBranch: 'main', protectedPatterns: ['refs/heads/main'] })
  wrap(ALICE, ALICE, 0, K0)
})

const { createComment, createIssue, createPatch, createReview, createRepo } = await import('./writes')
const { writeRefUpdate } = await import('./push')
const { loadPrivateSession, sdkSessionSource, sessionUnwrapper } = await import('./private-session')
const { createEpochZero } = await import('./private-members')

async function session() {
  return loadPrivateSession({ repo: REPO_REF, network: 'devnet', reader: b58(ALICE), source: sdkSessionSource(sdk, REPO_REF), unwrapper: sessionUnwrapper(ops) })
}
async function open(type: 'issue' | 'patch' | 'comment' | 'review' | 'refUpdate' | 'protectedRefUpdate', doc: Doc) {
  const s = await session()
  return s.gate.admit(type, doc)
}
const PLAINTEXT = ['title', 'body', 'baseRefName', 'sourceRefName', 'path', 'refName', 'defaultBranch', 'protectedPatterns']
const noPlaintext = (d: Doc): string[] => PLAINTEXT.filter((f) => d[f] !== undefined)

describe('sealed writes to a private repo', () => {
  it('an issue is sealed under the current epoch and opens with its text', async () => {
    await createIssue(sdk, auth, REPO_REF, { title: 'secret bug', body: 'it leaks' })
    const doc = chain['issue']?.[0] as Doc
    expect(noPlaintext(doc)).toEqual([])
    expect(doc['epoch']).toBe(0)
    const a = await open('issue', doc)
    expect(a.ok && a.doc['title']).toBe('secret bug')
    expect(a.ok && a.doc['body']).toBe('it leaks')
  })

  it('a PR carries keyed ref-name hashes, never sha256, and opens', async () => {
    await createPatch(sdk, auth, REPO_REF, {
      title: 'fix', body: '', baseRefName: 'refs/heads/main', sourceRepoId: b58(REPO), sourceRefName: 'refs/heads/fix', headOid: 'ab'.repeat(20),
    })
    const doc = chain['patch']?.[0] as Doc
    expect(noPlaintext(doc)).toEqual([])
    const k0 = await EpochKeys.import(REPO, 0, K0)
    const { refNameHash } = await import('../private')
    expect(doc['baseRefNameHash']).toBe(bytesToBase64(await refNameHash(k0, 'refs/heads/main')))
    const a = await open('patch', doc)
    expect(a.ok && a.doc['sourceRefName']).toBe('refs/heads/fix')
  })

  it('an inline comment seals its body and path; a review its body', async () => {
    await createIssue(sdk, auth, REPO_REF, { title: 't', body: '' })
    const target = String(chain['issue']?.[0]?.['$id'])
    await createComment(sdk, auth, REPO_REF, { targetId: target, body: 'looks off' })
    const c = chain['comment']?.[0] as Doc
    expect(noPlaintext(c)).toEqual([])
    const a = await open('comment', c)
    expect(a.ok && a.doc['body']).toBe('looks off')
    await createPatch(sdk, auth, REPO_REF, { title: 'p', body: '', baseRefName: 'refs/heads/main', sourceRepoId: b58(REPO), sourceRefName: 'refs/heads/x', headOid: 'cd'.repeat(20) })
    const patchId = String(chain['patch']?.[0]?.['$id'])
    await createReview(sdk, auth, REPO_REF, { patchId, verdict: 'approve', commitOid: 'cd'.repeat(20), body: 'ship it' })
    const r = chain['review']?.[0] as Doc
    expect(noPlaintext(r)).toEqual([])
    const ar = await open('review', r)
    expect(ar.ok && ar.doc['body']).toBe('ship it')
  })

  it('a ref update is routed by the decrypted protected patterns and sealed', async () => {
    const s = await session()
    const repo = { ...REPO_REF, session: s }
    const r = await writeRefUpdate(sdk, auth, repo, { refName: 'refs/heads/main', newOid: 'ef'.repeat(20) })
    expect(r.documentType).toBe('protectedRefUpdate')
    const doc = chain['protectedRefUpdate']?.[0] as Doc
    expect(noPlaintext(doc)).toEqual([])
    const a = await open('protectedRefUpdate', doc)
    expect(a.ok && a.doc['refName']).toBe('refs/heads/main')
  })

  it('writes under the newest epoch after a rotation, never the one the page last saw', async () => {
    const stale = await session()
    const k1 = await EpochKeys.import(REPO, 1, K1)
    await anchor(ALICE, k1, { defaultBranch: 'main', protectedPatterns: ['refs/heads/main'], prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(ALICE, ALICE, 1, K1)
    await createIssue(sdk, auth, { ...REPO_REF, session: stale }, { title: 'after', body: '' })
    expect(chain['issue']?.[0]?.['epoch']).toBe(1)
  })

  it('without an encryption key in this browser nothing is written', async () => {
    held = null
    await expect(createIssue(sdk, auth, REPO_REF, { title: 'x', body: '' })).rejects.toThrow(/encryption key/)
    expect(chain['issue']).toBeUndefined()
  })

  it('a burned current epoch or a non-member holding the key refuses the write', async () => {
    // CAROL removed, but still wrapped epoch 0: writeEpoch is null until a rotation.
    wrap(ALICE, CAROL, 0, K0)
    members = members.filter((m) => m.identity !== b58(CAROL))
    await expect(createIssue(sdk, auth, REPO_REF, { title: 'x', body: '' })).rejects.toThrow(/Repair/)
    expect(chain['issue']).toBeUndefined()
  })

  it('refuses text over the sealed limit with the limit in the message', async () => {
    await expect(createIssue(sdk, auth, REPO_REF, { title: 't', body: 'x'.repeat(6000) })).rejects.toThrow(/at most \d+ bytes/)
  })
})

describe('private create', () => {
  it('writes repo, maintainer, the owner epoch-0 self-wrap, then the sealed anchor; the name only in enc', async () => {
    for (const k of Object.keys(chain)) delete chain[k]
    members = []
    const created = await createRepo(sdk, auth, FORGE, { name: 'hidden', defaultBranch: 'trunk', visibility: 'private' }, undefined, {
      ops,
      epochZero: createEpochZero,
    })
    const repoDoc = chain['repo']?.[0] as Doc
    expect(repoDoc['visibility']).toBe('private')
    expect(repoDoc['defaultBranch']).toBeUndefined()
    expect(chain['maintainer']).toHaveLength(1)
    const wraps = chain['repoKey'] ?? []
    expect(wraps).toHaveLength(1)
    expect(wraps[0]?.['memberId']).toBe(b58(ALICE))
    const cfg = chain['config']?.[0] as Doc
    expect(cfg['defaultBranch']).toBeUndefined()
    expect(cfg['epoch']).toBe(0)
    members = [{ identity: b58(ALICE), role: 'maintainer', createdAt: 1 }]
    const ref: RepoRef = { forge: FORGE, repoId: created.repoId, ownerId: b58(ALICE), name: 'hidden', visibility: 'private' }
    const s = await loadPrivateSession({ repo: ref, network: 'devnet', reader: b58(ALICE), source: sdkSessionSource(sdk, ref), unwrapper: sessionUnwrapper(ops) })
    expect(s.resolution.writeEpoch).toBe(0)
    expect(s.config?.defaultBranch).toBe('trunk')
  })

  it('refuses a private create with no encryption key before writing anything', async () => {
    for (const k of Object.keys(chain)) delete chain[k]
    await expect(createRepo(sdk, auth, FORGE, { name: 'nokey', visibility: 'private' })).rejects.toThrow(/encryption key/)
    expect(chain['repo']).toBeUndefined()
  })
})

describe('correctness review of the sealed writes', () => {
  it('a renumbered issue is re-sealed with the new number in its AD (the old enc would not open)', async () => {
    squatted.add(1)
    await createIssue(sdk, auth, REPO_REF, { title: 'taken', body: '' })
    const doc = chain['issue']?.[0] as Doc
    expect(doc['number']).toBe(2)
    const a = await open('issue', doc)
    expect(a.ok && a.doc['title']).toBe('taken')
  })

  it('an inline comment through the real commentData seals its path; its anchor stays plaintext', async () => {
    const { postComment } = await import('./review-writes')
    await createPatch(sdk, auth, REPO_REF, { title: 'p', body: '', baseRefName: 'refs/heads/main', sourceRepoId: b58(REPO), sourceRefName: 'refs/heads/x', headOid: 'cd'.repeat(20) })
    const prId = String(chain['patch']?.[0]?.['$id'])
    await postComment(sdk, auth, REPO_REF, { targetId: prId, body: 'nit', anchor: { path: 'src/secret.rs', line: 3, side: 1, commitOid: 'cd'.repeat(20) } })
    const c = chain['comment']?.[0] as Doc
    expect(c['path']).toBeUndefined()
    expect(c['line']).toBe(3)
    const a = await open('comment', c)
    expect(a.ok && a.doc['path']).toBe('src/secret.rs')
  })

  it('a burned current epoch refuses the write, and names it', async () => {
    const k1 = await EpochKeys.import(REPO, 1, K1)
    await anchor(ALICE, k1, { defaultBranch: 'main', protectedPatterns: ['refs/heads/main'], prevEpoch: 0, burned: true })
    wrap(ALICE, ALICE, 1, K1)
    await expect(createIssue(sdk, auth, REPO_REF, { title: 'x', body: '' })).rejects.toThrow(/epoch 1 is closed/)
    expect(chain['issue']).toBeUndefined()
  })

  it('the text limits are the TLV cap minus framing: issue 5085, PR 5079, comment 5085, review 5088; nothing is written past them', async () => {
    const { SEALED_TEXT_LIMIT } = await import('./private-writes')
    expect(SEALED_TEXT_LIMIT).toEqual({ issue: 5085, patch: 5079, comment: 5085, review: 5088 })
    const pr = (n: number) => ({ title: 't', body: 'x'.repeat(n - 1 - 'refs/heads/main'.length - 'refs/heads/x'.length), baseRefName: 'refs/heads/main', sourceRepoId: b58(REPO), sourceRefName: 'refs/heads/x', headOid: 'cd'.repeat(20) })
    await expect(createPatch(sdk, auth, REPO_REF, pr(5080))).rejects.toThrow(/at most 5079 bytes/)
    expect(chain['patch']).toBeUndefined()
    await createPatch(sdk, auth, REPO_REF, pr(5079))
    expect(chain['patch']).toHaveLength(1)
    await expect(createIssue(sdk, auth, REPO_REF, { title: 't', body: 'x'.repeat(5085) })).rejects.toThrow(/at most 5085 bytes/)
    await createIssue(sdk, auth, REPO_REF, { title: 't', body: 'x'.repeat(5084) })
    expect(chain['issue']).toHaveLength(1)
  })

  it('a ref update on a private repo without a session is refused before any read', async () => {
    const before = sessionLoads
    await expect(writeRefUpdate(sdk, auth, REPO_REF, { refName: 'refs/heads/main', newOid: 'ef'.repeat(20) })).rejects.toThrow(/sealed/)
    expect(sessionLoads).toBe(before)
    expect(chain['refUpdate']).toBeUndefined()
  })

  it('a ref update routes on the fresh session’s patterns, not the page’s', async () => {
    const stale = await session()
    // A rotation to epoch 1 protects refs/heads/dev too.
    const k1 = await EpochKeys.import(REPO, 1, K1)
    await anchor(ALICE, k1, { defaultBranch: 'main', protectedPatterns: ['refs/heads/main', 'refs/heads/dev'], prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(ALICE, ALICE, 1, K1)
    const r = await writeRefUpdate(sdk, auth, { ...REPO_REF, session: stale }, { refName: 'refs/heads/dev', newOid: 'ef'.repeat(20) })
    expect(r.documentType).toBe('protectedRefUpdate')
  })

  it('a review with its comments loads one session for the whole submit', async () => {
    const { submitReviewDraft } = await import('./review-writes')
    await createPatch(sdk, auth, REPO_REF, { title: 'p', body: '', baseRefName: 'refs/heads/main', sourceRepoId: b58(REPO), sourceRefName: 'refs/heads/x', headOid: 'cd'.repeat(20) })
    const prId = String(chain['patch']?.[0]?.['$id'])
    const s = await session()
    const repo = { ...REPO_REF, session: s }
    const draft = {
      draftId: 'd', network: 'devnet', identity: b58(ALICE), repoId: b58(REPO), prId, headOid: 'cd'.repeat(20), verdict: 'comment' as const, summary: 'ok', startedAt: 1,
      comments: Array.from({ length: 5 }, (_, i) => ({ localId: String(i), anchor: { path: `f${i}`, line: 1, side: 1 as const }, body: `c${i}` })),
    }
    const before = sessionLoads
    await submitReviewDraft(sdk, auth, repo, draft)
    expect(chain['comment']).toHaveLength(5)
    expect(sessionLoads - before).toBe(1)
  })

  it('a review draft on a private repo needs a session, so landed comments are never re-posted', async () => {
    const { submitReviewDraft } = await import('./review-writes')
    const draft = { draftId: 'd', network: 'devnet', identity: b58(ALICE), repoId: b58(REPO), prId: b58(id(0x44)), headOid: 'cd'.repeat(20), verdict: 'comment' as const, summary: '', startedAt: 1, attemptedAt: 2, comments: [] }
    await expect(submitReviewDraft(sdk, auth, REPO_REF, draft)).rejects.toThrow(/member/)
    expect(chain['review']).toBeUndefined()
  })

  it('a sealed artifact is cached per repo and plaintext, reused under the same key, and re-sealed after a rotation', async () => {
    const { sealArtifact } = await import('./private-writes')
    const { parseHeader } = await import('../private')
    const plain = new TextEncoder().encode('PACK plaintext')
    const a = await sealArtifact(sdk, auth, REPO_REF, plain)
    const b = await sealArtifact(sdk, auth, REPO_REF, plain)
    expect(b).toEqual(a)
    expect(parseHeader(a).epoch).toBe(0)
    const k1 = await EpochKeys.import(REPO, 1, K1)
    await anchor(ALICE, k1, { defaultBranch: 'main', protectedPatterns: ['refs/heads/main'], prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(ALICE, ALICE, 1, K1)
    const c = await sealArtifact(sdk, auth, REPO_REF, plain)
    expect(parseHeader(c).epoch).toBe(1)
    expect(new TextDecoder().decode(c)).not.toContain('plaintext')
  })
})

describe('private create, correctness review', () => {
  beforeEach(() => {
    for (const k of Object.keys(chain)) delete chain[k]
    members = []
  })

  it('refuses before writing anything when the key in this browser is not the identity’s current encryption key', async () => {
    identityKeys = [encKey(), encKey(5)]
    await expect(createRepo(sdk, auth, FORGE, { name: 'stale', visibility: 'private' }, undefined, { ops, epochZero: createEpochZero })).rejects.toThrow(/key 5/)
    expect(chain['repo']).toBeUndefined()
  })

  it('refuses a private fork', () => {
    return expect(createRepo(sdk, auth, FORGE, { name: 'pf', visibility: 'private', forkOf: b58(REPO) }, undefined, { ops, epochZero: createEpochZero })).rejects.toThrow(/fork/)
  })

  it('refuses to resume onto an existing repo whose visibility is missing or the other one', async () => {
    height += 1
    ;(chain['repo'] ??= []).push({ $id: nextId(), $ownerId: b58(ALICE), $createdAt: height * 1000, $createdAtBlockHeight: height, name: 'odd' })
    await expect(createRepo(sdk, auth, FORGE, { name: 'odd', visibility: 'private' }, undefined, { ops, epochZero: createEpochZero })).rejects.toThrow(/visibility/)
    ;(chain['repo'] ??= []).push({ $id: nextId(), $ownerId: b58(ALICE), $createdAt: height * 1000, $createdAtBlockHeight: height, name: 'pub', visibility: 'public' })
    await expect(createRepo(sdk, auth, FORGE, { name: 'pub', visibility: 'private' }, undefined, { ops, epochZero: createEpochZero })).rejects.toThrow(/other visibility/)
    expect(chain['maintainer']).toBeUndefined()
  })

  it('resumes a create whose self-wrap landed: the anchor uses that key', async () => {
    const first = createRepo(sdk, auth, FORGE, { name: 'resume', visibility: 'private' }, undefined, {
      ops,
      epochZero: async () => {
        throw new Error('tab closed')
      },
    })
    await expect(first).rejects.toThrow(/tab closed/)
    const repoId = String(chain['repo']?.[0]?.['$id'])
    wrap(ALICE, ALICE, 0, K0)
    chain['repoKey']![chain['repoKey']!.length - 1]!['repoId'] = repoId
    members = [{ identity: b58(ALICE), role: 'maintainer', createdAt: 1 }]
    await createRepo(sdk, auth, FORGE, { name: 'resume', visibility: 'private' }, undefined, { ops, epochZero: createEpochZero })
    expect(chain['repoKey']).toHaveLength(1)
    const ref: RepoRef = { forge: FORGE, repoId, ownerId: b58(ALICE), name: 'resume', visibility: 'private' }
    const s = await loadPrivateSession({ repo: ref, network: 'devnet', reader: b58(ALICE), source: sdkSessionSource(sdk, ref), unwrapper: sessionUnwrapper(ops) })
    expect(s.resolution.writeEpoch).toBe(0)
  })
})

describe('security review of the sealed writes', () => {
  it('M1 a retried write after a rotation signs afresh: its intent names the key it was sealed under', async () => {
    await createComment(sdk, auth, REPO_REF, { targetId: b58(id(0x44)), body: 'first', intent: 'draft-1' })
    const k1 = await EpochKeys.import(REPO, 1, K1)
    await anchor(ALICE, k1, { defaultBranch: 'main', protectedPatterns: ['refs/heads/main'], prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(ALICE, ALICE, 1, K1)
    await createComment(sdk, auth, REPO_REF, { targetId: b58(id(0x44)), body: 'first', intent: 'draft-1' })
    expect(intents[0]).not.toBe(intents[1])
    expect(intents[0]).toMatch(/^draft-1:e0:/)
    expect(intents[1]).toMatch(/^draft-1:e1:/)
  })

  it('M1 a numbered create names the key too, per number', async () => {
    squatted.add(1)
    await createIssue(sdk, auth, REPO_REF, { title: 't', body: '', intent: 'i' })
    expect(intents.filter((x) => x !== undefined)).toEqual([expect.stringMatching(/^i#1:e0:/), expect.stringMatching(/^i#2:e0:/)])
  })

  it('L7 the sealed-artifact cache is keyed without the plaintext hash', async () => {
    const { sealArtifact } = await import('./private-writes')
    const { idbEntries } = await import('../idb')
    const plain = new TextEncoder().encode('PACK key check')
    await sealArtifact(sdk, auth, REPO_REF, plain)
    const { sha256Hex } = await import('../storage/sigv4')
    const keys = (await idbEntries('journal', 'sealed-pack')).map(([k]) => k)
    expect(keys.length).toBeGreaterThan(0)
    const hash = await sha256Hex(plain)
    expect(keys.some((k) => k.includes(hash))).toBe(false)
  })

  it('a private repo cannot be forked (its names would go into a public fork)', async () => {
    const { forkRepoV2 } = await import('./fork')
    await expect(forkRepoV2(sdk, auth, REPO_REF, { name: 'leak' })).rejects.toThrow(/private/)
    expect(chain['repo']).toBeUndefined()
  })

  it('a private review draft is never written to this browser’s storage', async () => {
    const { saveReviewDraft, loadReviewDraft } = await import('./review-writes')
    const draft = { draftId: 'd', network: 'devnet', identity: b58(ALICE), repoId: b58(REPO), prId: 'P', headOid: 'ab'.repeat(20), verdict: 'comment' as const, summary: 'secret summary', startedAt: 1, comments: [], private: true }
    await saveReviewDraft(draft)
    const { idbEntries } = await import('../idb')
    expect(JSON.stringify(await idbEntries('journal'))).not.toContain('secret summary')
    expect((await loadReviewDraft('devnet', b58(ALICE), 'P'))?.summary).toBe('secret summary')
  })
})

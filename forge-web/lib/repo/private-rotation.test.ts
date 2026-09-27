/**
 * The rotation flow (§5.5) end to end over an in-memory chain: a write engine that replays a
 * cached signed write for the same intent (as the real one does), a unique index on
 * `(repoId, memberId, epoch, $ownerId)`, and fake wraps (the wrapped key's bytes, readable by
 * both parties). What it pins: a retried rotation never anchors a key other than the one in the
 * rotator's own standing self-wrap, and a lagging member list never lets a removed maintainer's
 * pre-posted anchor count.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { EncKeyLike, EncryptionOps } from '../auth/encryption-key'
import { EpochKeys, WrapError, bytesToHex, sealDoc } from '../private'
import type { Membership } from '../rules/v2'
import { bytesToBase64, base64ToBytes, type DocumentQuery } from '../sdk'
import type { RepoRef } from './contract'

// ---------------------------------------------------------------------------
// The fake chain
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>
const chain: Record<string, Doc[]> = {}
/** Signed writes cached by intent: a retry with the same intent re-broadcasts the same bytes. */
const signed = new Map<string, Doc>()
/** How many more writes of each type fail as "sent, not visible yet" after landing. */
const unconfirm: Record<string, number> = {}
/** How many more writes of each type fail before landing (a network error). */
const failNext: Record<string, number> = {}
/** Writes that land but stay invisible to reads (a lagging node). */
const hidden = new Set<string>()
let height = 1000
let seq = 0

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const REPO = id(0x11)
const ALICE = id(0x21)
const BOB = id(0x22)
const CAROL = id(0x23)
const FORGE = { core: 'CORE', collab: 'COLLAB', group: 'GROUP' }
const REPO_REF: RepoRef = { forge: FORGE, repoId: b58(REPO), ownerId: b58(ALICE), name: 'secret', visibility: 'private' }

/** Raw epoch keys by their commitment hex: what a fake wrap "encrypts". */
const rawByCommit = new Map<string, Uint8Array>()

function nextId(): string {
  seq += 1
  const u = new Uint8Array(32)
  new DataView(u.buffer).setUint32(28, seq)
  return b58(u)
}

function asB58(v: unknown): string {
  return v instanceof Uint8Array ? b58(v) : String(v)
}

vi.mock('../sdk/write', async (orig) => {
  const real = await orig<typeof import('../sdk/write')>()
  return {
    ...real,
    createDocumentIdempotent: async (_sdk: unknown, auth: { identityId: string }, p: { documentType: string; data: Doc; intent?: string }) => {
      if ((failNext[p.documentType] ?? 0) > 0) {
        failNext[p.documentType] = (failNext[p.documentType] ?? 0) - 1
        throw new Error('network: request failed')
      }
      const key = `${auth.identityId}:${p.documentType}:${p.intent ?? nextId()}`
      let doc = signed.get(key)
      if (doc === undefined) {
        doc = { ...p.data }
        signed.set(key, doc)
      }
      const rows = (chain[p.documentType] ??= [])
      const landed = rows.find((d) => d === doc)
      if (landed === undefined) {
        if (p.documentType === 'repoKey') {
          const dup = rows.find((d) => d['memberId'] === asB58(doc!['memberId']) && d['epoch'] === doc!['epoch'] && d['$ownerId'] === auth.identityId)
          if (dup !== undefined) {
            // The refusal proves the row is in state: the node answering from now on has it.
            hidden.delete(String(dup['$id']))
            throw new real.ConsensusRefusal(real.DUPLICATE_UNIQUE_CODE, 'duplicate unique index')
          }
        }
        height += 1
        Object.assign(doc, {
          $id: nextId(),
          $ownerId: auth.identityId,
          $createdAt: height * 1000,
          $createdAtBlockHeight: height,
          repoId: b58(REPO),
          ...(doc['memberId'] !== undefined ? { memberId: asB58(doc['memberId']) } : {}),
          ...(doc['enc'] instanceof Uint8Array ? { enc: bytesToBase64(doc['enc'] as Uint8Array) } : {}),
          ...(doc['wrapped'] instanceof Uint8Array ? { wrapped: bytesToBase64(doc['wrapped'] as Uint8Array) } : {}),
        })
        rows.push(doc)
      }
      if ((unconfirm[p.documentType] ?? 0) > 0) {
        unconfirm[p.documentType] = (unconfirm[p.documentType] ?? 0) - 1
        hidden.add(String(doc['$id']))
        throw new real.UnconfirmedWriteError(String(doc['$id']))
      }
      return { documentId: String(doc['$id']), confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: 0 }
    },
  }
})

vi.mock('../sdk/facade', async (orig) => ({ ...(await orig<typeof import('../sdk/facade')>()), sleep: async () => undefined }))

let members: Membership[] = []
let revokeFails = false
/** Identities with no encryption key (they cannot be wrapped). */
const keyless = new Set<string>()
/** What a lagging node answers for the member list (null: the truth). */
let staleMembers: Membership[] | null = null
/** One-off answers for the next member-list reads, in order (a node per read). */
const readQueue: Membership[][] = []

vi.mock('./members', async (orig) => {
  const real = await orig<typeof import('./members')>()
  return {
    ...real,
    readMemberships: async () => readQueue.shift() ?? staleMembers ?? members,
    invalidateMembers: () => undefined,
  }
})

vi.mock('./writes', async (orig) => {
  const real = await orig<typeof import('./writes')>()
  return {
    ...real,
    revokeMember: async (_s: unknown, _a: unknown, _r: unknown, memberId: string, role: string) => {
      if (revokeFails) throw new Error('network: revoke failed')
      members = members.filter((m) => !(m.identity === memberId && m.role === role))
      return { deleted: true, actualCredits: 0 }
    },
  }
})

function visible(type: string): Doc[] {
  return (chain[type] ?? []).filter((d) => !hidden.has(String(d['$id'])))
}

function query(q: DocumentQuery): Map<string, Doc> {
  let rows = visible(q.documentTypeName)
  for (const [f, op, v] of q.where ?? []) if (op === '==') rows = rows.filter((d) => String(d[f]) === String(v))
  rows = [...rows].sort((a, b) => (a['$createdAt'] as number) - (b['$createdAt'] as number))
  if (q.startAfter !== undefined) rows = rows.slice(rows.findIndex((d) => d['$id'] === q.startAfter) + 1)
  return new Map(rows.slice(0, q.limit ?? 100).map((d) => [String(d['$id']), d]))
}

const encKey = (keyId = 4): EncKeyLike => ({ keyId, purposeNumber: 1, keyTypeNumber: 0, data: '02' + 'ab'.repeat(32) })

const sdk = {
  documents: { query: async (q: DocumentQuery) => query(q), count: async () => new Map() },
  identities: { fetch: async (id: string) => ({ publicKeys: keyless.has(id) ? [] : [encKey()], balance: 0n }) },
} as unknown as EvoSDK

/** Fake wrap ops: a wrap "encrypts" the raw key as itself; anyone in the test can open it. */
const ops: EncryptionOps = {
  keyId: 4,
  unwrap: async (p) => (await ops.unwrapRaw(p)).keys,
  unwrapRaw: async (p) => {
    const bytes = p.document['wrapped']
    const raw = typeof bytes === 'string' ? base64ToBytes(bytes) : new Uint8Array(0)
    if (raw.length !== 32) throw new WrapError('wrapUnreadable')
    return { keys: await EpochKeys.import(p.repoId, p.epoch, raw), raw: new Uint8Array(raw) }
  },
  wrap: async (p) => {
    rawByCommit.set(bytesToHex(p.keys.commit), new Uint8Array(p.raw))
    return { wrapped: new Uint8Array(p.raw), recipientKeyId: 4, senderKeyId: 4 }
  },
}

const auth = { identityId: b58(ALICE), network: 'devnet' as const, getSigningKeyWif: () => 'x' }

async function anchor(owner: Uint8Array, keys: EpochKeys, fields: Parameters<typeof sealDoc>[2]): Promise<void> {
  const enc = await sealDoc(keys, { type: 'config', ownerId: owner, epoch: keys.epoch }, fields, { anchor: true })
  height += 1
  ;(chain['config'] ??= []).push({
    $id: nextId(),
    $ownerId: b58(owner),
    $createdAt: height * 1000,
    $createdAtBlockHeight: height,
    repoId: b58(REPO),
    epoch: keys.epoch,
    enc: bytesToBase64(enc),
    backend: { mode: 0 },
  })
}

function wrap(owner: Uint8Array, member: Uint8Array, epoch: number, raw: Uint8Array): void {
  height += 1
  ;(chain['repoKey'] ??= []).push({
    $id: nextId(),
    $ownerId: b58(owner),
    $createdAt: height * 1000,
    $createdAtBlockHeight: height,
    repoId: b58(REPO),
    memberId: b58(member),
    epoch,
    recipientKeyId: 4,
    senderKeyId: 4,
    wrapped: bytesToBase64(raw),
  })
}

const K0 = Uint8Array.from({ length: 32 }, (_, i) => i)

beforeEach(async () => {
  for (const k of Object.keys(chain)) delete chain[k]
  signed.clear()
  hidden.clear()
  for (const k of Object.keys(unconfirm)) delete unconfirm[k]
  for (const k of Object.keys(failNext)) delete failNext[k]
  revokeFails = false
  staleMembers = null
  readQueue.length = 0
  keyless.clear()
  members = [
    { identity: b58(ALICE), role: 'maintainer', createdAt: 1 },
    { identity: b58(BOB), role: 'writer', createdAt: 2 },
    { identity: b58(CAROL), role: 'writer', createdAt: 3 },
  ]
  const k0 = await EpochKeys.import(REPO, 0, K0)
  await anchor(ALICE, k0, { defaultBranch: 'main' })
  for (const m of [ALICE, BOB, CAROL]) wrap(ALICE, m, 0, K0)
})

const { rotateRepoKey, removePrivateMember } = await import('./private-members')
const { loadPrivateSession, sdkSessionSource, sessionUnwrapper } = await import('./private-session')

const ctx = { sdk, auth, repo: REPO_REF, network: 'devnet' as const, ops }

async function aliceSession() {
  return loadPrivateSession({ repo: REPO_REF, network: 'devnet', reader: b58(ALICE), source: sdkSessionSource(sdk, REPO_REF), unwrapper: sessionUnwrapper(ops) })
}

describe('rotation retries', () => {
  it('a retry whose read lags its own self-wrap never anchors a key it cannot read', async () => {
    // Attempt 1: the self-wrap lands but reads do not show it yet, and the call errors out.
    unconfirm['repoKey'] = 1
    await expect(rotateRepoKey(ctx, [b58(CAROL)], 'intent-1')).rejects.toThrow()
    // Attempt 2 (a fresh confirm: a new intent). Its read still misses the self-wrap, so it
    // draws another key; posting it hits the standing self-wrap. It must not go on under either
    // key from a read that missed its own wraps: it stops, and nothing else is written.
    const wrapsBefore = (chain['repoKey'] ?? []).length
    await expect(rotateRepoKey(ctx, [b58(CAROL)], 'intent-2')).rejects.toThrow(/already wrapped epoch 1/)
    expect((chain['repoKey'] ?? []).length).toBe(wrapsBefore)
    expect((chain['config'] ?? []).length).toBe(1)
    // Attempt 3 reads everything (the refusal proved the row). A removal never resumes: a fresh
    // epoch above the pending one, whose wraps (like epoch 1's) never reach CAROL.
    await expect(rotateRepoKey(ctx, [b58(CAROL)], 'intent-3')).resolves.toBe(2)
    hidden.clear()
    const s = await aliceSession()
    expect(s.resolution.currentEpoch).toBe(2)
    // ALICE can read the epoch she anchored: her self-wrap and the anchor carry the same key.
    expect(s.resolution.writeEpoch).toBe(2)
    expect(s.resolution.alerts).toEqual([])
    // BOB's wrap carries the anchored key too; CAROL got nothing for epoch 1 or 2.
    const e2 = (chain['repoKey'] ?? []).filter((d) => d['epoch'] === 2)
    expect(new Set(e2.map((d) => d['wrapped'])).size).toBe(1)
    expect((chain['repoKey'] ?? []).some((d) => (d['epoch'] as number) >= 1 && d['memberId'] === b58(CAROL))).toBe(false)
  })
})

describe('keys never reach a removed member', () => {
  it('an earlier run that wrapped a now-removed member is never anchored, even from a read that missed it', async () => {
    // A crashed rotation to epoch 1 wrapped ALICE and CAROL, but reads miss both wraps.
    const leakedKey = new Uint8Array(32).fill(0x55)
    wrap(ALICE, ALICE, 1, leakedKey)
    wrap(ALICE, CAROL, 1, leakedKey)
    const e1 = (chain['repoKey'] ?? []).filter((d) => d['epoch'] === 1)
    for (const d of e1) hidden.add(String(d['$id']))
    // CAROL is removed; the rotation's read does not see epoch 1 at all.
    members = members.filter((m) => m.identity !== b58(CAROL))
    // The rotation's read misses epoch 1, picks it, and hits its own standing self-wrap: it stops.
    await expect(rotateRepoKey(ctx, [b58(CAROL)], 'rm-1')).rejects.toThrow(/already wrapped epoch 1/)
    // The next run sees that self-wrap but still misses CAROL's wrap. It removes someone, so it
    // never resumes epoch 1: it takes a fresh one above it.
    await expect(rotateRepoKey(ctx, [b58(CAROL)], 'rm-2')).resolves.toBe(2)
    hidden.clear()
    const s = await aliceSession()
    expect(s.resolution.currentEpoch).toBe(2)
    expect(s.resolution.anchors.has(1)).toBe(false)
    expect((chain['repoKey'] ?? []).some((d) => d['epoch'] === 2 && d['memberId'] === b58(CAROL))).toBe(false)
  })

  it('no key goes out while the member list still changes between reads', async () => {
    // Two nodes: the session's read comes from one that still lists CAROL, the re-read from one
    // that does not. The settle check sees the difference and refuses before any wrap.
    const lagging = [...members]
    members = members.filter((m) => m.identity !== b58(CAROL))
    readQueue.push(lagging)
    const wrapsBefore = (chain['repoKey'] ?? []).length
    await expect(rotateRepoKey(ctx, [], 'flip')).rejects.toThrow(/member list is still changing/)
    expect((chain['repoKey'] ?? []).length).toBe(wrapsBefore)
  })
})

describe('review round 3', () => {
  it('#3 a remaining member with no encryption key does not block a rotation their earlier wrap reached', async () => {
    // BOB has no key now; an earlier run of a repair rotation wrapped epoch 1 to ALICE and BOB
    // (BOB had a key then). A repair rotation (nobody excluded) resumes epoch 1: BOB is still a
    // member, so his wrap there is no leak.
    wrap(ALICE, ALICE, 1, new Uint8Array(32).fill(0x31))
    wrap(ALICE, BOB, 1, new Uint8Array(32).fill(0x31))
    keyless.add(b58(BOB))
    await expect(rotateRepoKey(ctx, [], 'repair-bob')).resolves.toBe(1)
  })

  it('#4 a rotation that fails after the revoke runs the repair check on its own', async () => {
    // The rotation's anchor write fails once; the removal then repairs by itself (a fresh
    // rotation that excludes CAROL), so CAROL never keeps the current key.
    failNext['config'] = 1
    const steps: string[] = []
    await removePrivateMember(ctx, b58(CAROL), 'writer', 'rm-auto', (s) => steps.push(s.kind)).catch(() => undefined)
    const s = await aliceSession()
    const cur = s.resolution.currentEpoch as number
    expect(cur).toBeGreaterThanOrEqual(1)
    expect((chain['repoKey'] ?? []).some((d) => d['epoch'] === cur && d['memberId'] === b58(CAROL))).toBe(false)
  })

  it('#5 a lost rotation reports lost, never anchored', async () => {
    // Another maintainer anchors epoch 1 first (their config comes before ours by height).
    members.push({ identity: b58(BOB), role: 'maintainer', createdAt: 5 })
    const theirs = await EpochKeys.import(REPO, 1, new Uint8Array(32).fill(0x42))
    await anchor(BOB, theirs, { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    hidden.add(String((chain['config'] ?? []).at(-1)?.['$id']))
    const steps: string[] = []
    const run = rotateRepoKey(ctx, [], 'race', (s) => {
      steps.push(s.kind)
      if (s.kind === 'waiting') hidden.clear()
    })
    await expect(run).rejects.toThrow(/first/)
    expect(steps).toContain('lost')
    expect(steps).not.toContain('anchored')
  })

  it('#7 a re-anchor this signer already posted is not paid for twice', async () => {
    // BOB, a maintainer, anchored epoch 1 (ALICE was wrapped by BOB and by herself).
    members.push({ identity: b58(BOB), role: 'maintainer', createdAt: 5 })
    const k1raw = new Uint8Array(32).fill(0x71)
    const k1 = await EpochKeys.import(REPO, 1, k1raw)
    await anchor(BOB, k1, { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(BOB, ALICE, 1, k1raw)
    wrap(ALICE, ALICE, 1, k1raw)
    wrap(BOB, CAROL, 1, k1raw)
    const e1 = (): number => (chain['config'] ?? []).filter((d) => d['epoch'] === 1).length
    // First attempt re-anchors epoch 1 under ALICE, then fails at the revoke.
    revokeFails = true
    await expect(removePrivateMember(ctx, b58(BOB), 'maintainer', 'rm-a')).rejects.toThrow(/revoke failed/)
    revokeFails = false
    expect(e1()).toBe(2)
    // The retry (a new confirm) sees ALICE's re-anchor with the same commitment: none posted.
    await removePrivateMember(ctx, b58(BOB), 'maintainer', 'rm-b').catch(() => undefined)
    expect(e1()).toBe(2)
  })
})

describe('a lagging member list', () => {
  it("never lets a removed maintainer's pre-posted anchor become the epoch a rotation chains from", { timeout: 120_000 }, async () => {
    members.push({ identity: b58(CAROL), role: 'maintainer', createdAt: 4 })
    // CAROL, still a maintainer, pre-posts an anchor and a wrap for epoch 1 with her own key.
    const evil = new Uint8Array(32).fill(0x66)
    const kEvil = await EpochKeys.import(REPO, 1, evil)
    await anchor(CAROL, kEvil, { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(CAROL, ALICE, 1, evil)
    // The owner removes both of CAROL's roles; one node keeps listing her as maintainer.
    await removePrivateMember(ctx, b58(CAROL), 'writer', 'rm-writer')
    staleMembers = [...members, { identity: b58(CAROL), role: 'maintainer', createdAt: 4 }]
    await removePrivateMember(ctx, b58(CAROL), 'maintainer', 'rm-maint').catch(() => undefined)
    staleMembers = null
    const s = await aliceSession()
    // Whatever landed, no epoch the reader holds chains through CAROL's key.
    expect(s.resolution.alerts.filter((a) => a.kind === 'chainBroken')).toEqual([])
    expect(s.resolution.writeEpoch).toBe(s.resolution.currentEpoch)
  })
})

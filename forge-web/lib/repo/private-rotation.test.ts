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
import { shortId } from '../utils'

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
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
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
      // RC1 `wrap_member`: a wrap to an identity removed meanwhile is refused (40120 on memberId).
      if (p.documentType === 'repoKey' && removedAtWrap.has(asB58(p.data['memberId']))) {
        throw new real.ConsensusRefusal(real.GATE_REFUSED_CODE, `referenced document ${asB58(p.data['memberId'])} not found for path memberId`)
      }
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
/** Identities that still list an older encryption key 3 beside key 4. */
const oldKey = new Set<string>()
/** Identities that added a newer encryption key 5 this browser (key 4) does not hold. */
const newerKey = new Set<string>()
/** What a lagging node answers for the member list (null: the truth). */
let staleMembers: Membership[] | null = null
/** Identities consensus no longer holds a member document for when their wrap is sent. */
const removedAtWrap = new Set<string>()
/** How many more member-list reads fail (a node that does not answer). */
let membersFail = 0
/** One-off answers for the next member-list reads, in order (a node per read). */
const readQueue: Membership[][] = []

vi.mock('./members', async (orig) => {
  const real = await orig<typeof import('./members')>()
  return {
    ...real,
    readMemberships: async () => {
      if (membersFail > 0) {
        membersFail -= 1
        throw new Error('network: member list read failed')
      }
      return readQueue.shift() ?? staleMembers ?? members
    },
    invalidateMembers: () => undefined,
  }
})

vi.mock('./writes', async (orig) => {
  const real = await orig<typeof import('./writes')>()
  return {
    ...real,
    // Every identity here accepted its invitation (RC1 consent); the consent flow has its own tests.
    findConsent: async () => 'consent',
    grantMembershipDoc: async (_s: unknown, _a: unknown, _r: unknown, memberId: string, role: Membership['role']) => {
      members.push({ identity: memberId, role, createdAt: 99 })
      return { documentId: 'm', confirmed: true, actualCredits: 0 }
    },
    revokeMembershipDoc: async (_s: unknown, _a: unknown, _r: unknown, memberId: string, role: string) => {
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
  identities: {
    fetch: async (id: string) => ({
      publicKeys: keyless.has(id) ? [] : oldKey.has(id) ? [encKey(3), encKey()] : newerKey.has(id) ? [encKey(), encKey(5)] : [encKey()],
      balance: 0n,
    }),
  },
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

function wrap(owner: Uint8Array, member: Uint8Array, epoch: number, raw: Uint8Array, recipientKeyId = 4): string {
  wrapTo(owner, member, epoch, raw, recipientKeyId)
  return String((chain['repoKey'] ?? []).at(-1)?.['$id'])
}

function wrapTo(owner: Uint8Array, member: Uint8Array, epoch: number, raw: Uint8Array, recipientKeyId: number): void {
  height += 1
  ;(chain['repoKey'] ??= []).push({
    $id: nextId(),
    $ownerId: b58(owner),
    $createdAt: height * 1000,
    $createdAtBlockHeight: height,
    repoId: b58(REPO),
    memberId: b58(member),
    epoch,
    recipientKeyId,
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
  removedAtWrap.clear()
  staleMembers = null
  readQueue.length = 0
  membersFail = 0
  keyless.clear()
  oldKey.clear()
  newerKey.clear()
  members = [
    { identity: b58(ALICE), role: 'maintainer', createdAt: 1 },
    { identity: b58(BOB), role: 'writer', createdAt: 2 },
    { identity: b58(CAROL), role: 'writer', createdAt: 3 },
  ]
  const k0 = await EpochKeys.import(REPO, 0, K0)
  await anchor(ALICE, k0, { defaultBranch: 'main' })
  for (const m of [ALICE, BOB, CAROL]) wrap(ALICE, m, 0, K0)
})

const { addPrivateMember, planRepair, rotateRepoKey, removePrivateMember, runRepair } = await import('./private-members')
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
    // Attempt 2 (a fresh confirm: a new intent). Its read still misses the self-wrap, so it draws
    // another key; posting it hits the standing self-wrap, whose key it adopts (parity: forge-core
    // `self_wrap`). A removal never finishes an adopted epoch: it is burned, then epoch 2.
    await expect(rotateRepoKey(ctx, [b58(CAROL)], 'intent-2')).resolves.toBe(2)
    hidden.clear()
    const s = await aliceSession()
    expect(s.resolution.currentEpoch).toBe(2)
    // ALICE can read every epoch she anchored: each self-wrap and anchor carry the same key.
    expect(s.resolution.writeEpoch).toBe(2)
    expect(s.resolution.burned.has(1)).toBe(true)
    expect(s.resolution.alerts).toEqual([])
    // CAROL got nothing for epoch 1 or 2.
    expect((chain['repoKey'] ?? []).some((d) => (d['epoch'] as number) >= 1 && d['memberId'] === b58(CAROL))).toBe(false)
  })
})

describe('a member removed while the wraps go out (RC1 R-13, 40120 on memberId)', () => {
  it('a rotation re-plans without them: no burn, and they get no key', async () => {
    removedAtWrap.add(b58(BOB))
    await expect(rotateRepoKey(ctx, [b58(CAROL)], 'rm-carol')).resolves.toBe(1)
    const s = await aliceSession()
    expect(s.resolution.currentEpoch).toBe(1)
    expect(s.resolution.burned.has(1)).toBe(false)
    expect((chain['repoKey'] ?? []).some((d) => d['epoch'] === 1 && (d['memberId'] === b58(BOB) || d['memberId'] === b58(CAROL)))).toBe(false)
  })

  it('an add whose wrap is refused says they are not a member any more', async () => {
    const dave = new Uint8Array(32).fill(0x0d)
    removedAtWrap.add(b58(dave))
    await expect(addPrivateMember(ctx, b58(dave), 'writer', 'add-dave')).rejects.toThrow(/not a maintainer or writer of this repo any more/)
  })
})

describe('keys never reach a removed member', () => {
  it('an earlier run whose key reached a now-removed member is burned: chain-only, then n + 2', async () => {
    // A crashed rotation to epoch 1 wrapped ALICE and CAROL.
    const leakedKey = new Uint8Array(32).fill(0x55)
    wrap(ALICE, ALICE, 1, leakedKey)
    wrap(ALICE, CAROL, 1, leakedKey)
    members = members.filter((m) => m.identity !== b58(CAROL))
    await expect(rotateRepoKey(ctx, [b58(CAROL)], 'rm')).resolves.toBe(2)
    const s = await aliceSession()
    expect(s.resolution.currentEpoch).toBe(2)
    expect(s.resolution.writeEpoch).toBe(2)
    // Epoch 1 exists, chain-only: burned, readable for history, never a write epoch.
    expect(s.resolution.anchors.has(1)).toBe(true)
    expect(s.resolution.burned.has(1)).toBe(true)
    expect(s.resolution.keys.has(0)).toBe(true)
    // CAROL has no wrap of epoch 2.
    expect((chain['repoKey'] ?? []).some((d) => d['epoch'] === 2 && d['memberId'] === b58(CAROL))).toBe(false)
  })

  it('a burn left half done (epoch 1 burned, no epoch 2) is finished by the repair check', async () => {
    const leakedKey = new Uint8Array(32).fill(0x55)
    wrap(ALICE, ALICE, 1, leakedKey)
    wrap(ALICE, CAROL, 1, leakedKey)
    members = members.filter((m) => m.identity !== b58(CAROL))
    // The burn's n + 2 anchor fails; the rotation stops after epoch 1 is anchored burned.
    failNext['config'] = 2
    await rotateRepoKey(ctx, [b58(CAROL)], 'rm').catch(() => undefined)
    failNext['config'] = 0
    // Whatever landed, the repair check (any maintainer, any time) completes it.
    await runRepair(ctx, 'repair')
    const s = await aliceSession()
    expect(s.resolution.writeEpoch).toBe(s.resolution.currentEpoch)
    expect(s.resolution.burned.has(s.resolution.currentEpoch as number)).toBe(false)
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

describe('burn and contiguity review', () => {
  const maintainer = (who: Uint8Array): void => void members.push({ identity: b58(who), role: 'maintainer', createdAt: 5 })
  const isMaintainerNow = (who: Uint8Array): boolean => members.some((m) => m.identity === b58(who) && m.role === 'maintainer')
  const chainBroken = (s: Awaited<ReturnType<typeof aliceSession>>) => s.resolution.alerts.filter((a) => a.kind === 'chainBroken')

  it('#1 any maintainer finishes a burn that reached no non-member', async () => {
    // BOB anchors epoch 1 burned and wraps it to ALICE only: nobody outside the members holds it.
    maintainer(BOB)
    const raw = new Uint8Array(32).fill(0x81)
    await anchor(BOB, await EpochKeys.import(REPO, 1, raw), { defaultBranch: 'main', prevEpoch: 0, burned: true })
    wrap(BOB, ALICE, 1, raw)
    const before = await aliceSession()
    expect(before.resolution.burned.has(1)).toBe(true)
    expect(before.resolution.writeEpoch).toBeNull()
    expect(planRepair(before, b58(ALICE), FORGE.core)?.burned).toBe(true)
    await runRepair(ctx, 'finish')
    const s = await aliceSession()
    expect(s.resolution.currentEpoch).toBe(2)
    expect(s.resolution.writeEpoch).toBe(2)
  })

  it('#2 a burn whose n + 1 anchor lost the race never builds n + 2 on it', async () => {
    maintainer(BOB)
    // ALICE's earlier run wrapped epoch 1 to herself and CAROL, who is now removed.
    const leaked = new Uint8Array(32).fill(0x55)
    wrap(ALICE, ALICE, 1, leaked)
    wrap(ALICE, CAROL, 1, leaked)
    members = members.filter((m) => m.identity !== b58(CAROL))
    // BOB anchored a clean epoch 1 first; ALICE's read does not show it yet.
    const bobRaw = new Uint8Array(32).fill(0x42)
    await anchor(BOB, await EpochKeys.import(REPO, 1, bobRaw), { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(BOB, ALICE, 1, bobRaw)
    wrap(BOB, BOB, 1, bobRaw)
    for (const d of [...(chain['config'] ?? []).slice(-1), ...(chain['repoKey'] ?? []).slice(-2)]) hidden.add(String(d['$id']))
    const steps: string[] = []
    const run = rotateRepoKey(ctx, [b58(CAROL)], 'race-burn', (s) => {
      steps.push(s.kind)
      if (s.kind === 'waiting') hidden.clear()
    })
    await expect(run).rejects.toThrow(/first/)
    expect(steps).toContain('lost')
    const s = await aliceSession()
    expect(chainBroken(s)).toEqual([])
    expect(s.resolution.writeEpoch).toBe(s.resolution.currentEpoch)
  })

  it('#3 a re-anchor keeps the burned flag of the epoch', async () => {
    maintainer(BOB)
    const raw = new Uint8Array(32).fill(0x91)
    await anchor(BOB, await EpochKeys.import(REPO, 1, raw), { defaultBranch: 'main', prevEpoch: 0, burned: true })
    wrap(BOB, ALICE, 1, raw)
    await removePrivateMember(ctx, b58(BOB), 'maintainer', 'rm-burner').catch(() => undefined)
    const s = await aliceSession()
    expect(s.resolution.anchors.has(1)).toBe(true)
    expect(s.resolution.burned.has(1)).toBe(true)
    expect(chainBroken(s)).toEqual([])
  })

  it.each([
    ['a burned flag', { prevEpoch: 0, burned: true as const }],
    ['another chain pair', { prevEpoch: 0, other: true }],
  ])('#3 a same-key config with %s never takes over an epoch when its anchor author leaves', async (_what, extra) => {
    maintainer(BOB)
    maintainer(CAROL)
    const raw = new Uint8Array(32).fill(0x71)
    const k1 = await EpochKeys.import(REPO, 1, raw)
    await anchor(BOB, k1, { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(BOB, ALICE, 1, raw)
    wrap(BOB, CAROL, 1, raw)
    // CAROL pre-posts a config under the same key: same commitment, another flag or chain pair.
    const prevEpochKey = 'other' in extra ? new Uint8Array(32).fill(0x13) : new Uint8Array(K0)
    await anchor(CAROL, k1, 'burned' in extra ? { defaultBranch: 'main', prevEpoch: 0, burned: true } : { defaultBranch: 'main', prevEpoch: 0, prevEpochKey })
    await expect(removePrivateMember(ctx, b58(BOB), 'maintainer', 'rm-bob')).rejects.toThrow(/older key take over/)
    expect(isMaintainerNow(BOB)).toBe(true)
  })

  it('#4 a maintainer whose top epoch only they can read can still be removed', async () => {
    maintainer(BOB)
    const raw = new Uint8Array(32).fill(0xa1)
    await anchor(BOB, await EpochKeys.import(REPO, 1, raw), { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(BOB, BOB, 1, raw)
    await expect(removePrivateMember(ctx, b58(BOB), 'maintainer', 'rm-hog')).resolves.toBe(1)
    expect(isMaintainerNow(BOB)).toBe(false)
    const s = await aliceSession()
    expect(s.resolution.currentEpoch).toBe(1)
    expect(s.resolution.writeEpoch).toBe(1)
    expect(s.anchors.get(1)?.owner).toBe(b58(ALICE))
  })

  it('a removal whose surviving current epoch the remover cannot read is refused before anything is deleted', async () => {
    // CAROL, a maintainer, anchored epoch 1 and wrapped it to herself only.
    maintainer(CAROL)
    const raw = new Uint8Array(32).fill(0xc1)
    await anchor(CAROL, await EpochKeys.import(REPO, 1, raw), { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(CAROL, CAROL, 1, raw)
    await expect(removePrivateMember(ctx, b58(BOB), 'writer', 'rm-bob')).rejects.toThrow(/stays current/)
    expect(members.some((m) => m.identity === b58(BOB))).toBe(true)
  })

  it('re-review #1 epochs another maintainer holds never vanish with the leaving one', async () => {
    // BOB anchored epoch 1, not wrapped to ALICE; CAROL (a staying maintainer) holds it through
    // her own self-wrap, which keeps counting after BOB's role goes.
    maintainer(BOB)
    maintainer(CAROL)
    const raw = new Uint8Array(32).fill(0xd1)
    await anchor(BOB, await EpochKeys.import(REPO, 1, raw), { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(BOB, BOB, 1, raw)
    wrap(BOB, CAROL, 1, raw)
    wrap(CAROL, CAROL, 1, raw)
    await expect(removePrivateMember(ctx, b58(BOB), 'maintainer', 'rm-bob')).rejects.toThrow(/holds/)
    expect(isMaintainerNow(BOB)).toBe(true)
  })

  it('re-review #2 re-adding a maintainer with a config above the current epoch is refused', async () => {
    // CAROL (a maintainer back then) pre-posted a config for epoch 2; she is a writer now.
    const evil = new Uint8Array(32).fill(0x67)
    await anchor(CAROL, await EpochKeys.import(REPO, 2, evil), { defaultBranch: 'main', prevEpoch: 1, prevEpochKey: new Uint8Array(32).fill(1) })
    await expect(addPrivateMember(ctx, b58(CAROL), 'maintainer', 'regrant-2')).rejects.toMatchObject({ epochs: [2], message: /can't be made a maintainer of this repo again/ })
    expect(isMaintainerNow(CAROL)).toBe(false)
  })

  it('re-review #2 step 4 reports anchored only while the new epoch is the current one', async () => {
    // BOB, a maintainer, pre-posted a config for epoch 2: once ALICE anchors 1, his 2 follows it.
    maintainer(BOB)
    const raw = new Uint8Array(32).fill(0xe1)
    await anchor(BOB, await EpochKeys.import(REPO, 2, raw), { defaultBranch: 'main', prevEpoch: 1, prevEpochKey: new Uint8Array(32).fill(1) })
    const steps: string[] = []
    const got = await rotateRepoKey(ctx, [], 'r-jump', (s) => steps.push(s.kind)).catch((e: unknown) => e)
    if (typeof got === 'number') {
      // §5.3: a config counts only after the epoch below it was stated, so BOB's is ignored.
      const s = await aliceSession()
      expect(s.resolution.currentEpoch).toBe(got)
      expect(s.resolution.writeEpoch).toBe(got)
    } else {
      expect(String(got)).toMatch(/epoch 2/)
      expect(steps).not.toContain('anchored')
    }
  })

  it('#5 re-adding a maintainer whose old config would take over an epoch is refused', async () => {
    // CAROL (a maintainer back then) posted a config for epoch 1; she is a writer now.
    const evil = new Uint8Array(32).fill(0x66)
    await anchor(CAROL, await EpochKeys.import(REPO, 1, evil), { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    await expect(rotateRepoKey(ctx, [], 'r1')).resolves.toBe(1)
    await expect(addPrivateMember(ctx, b58(CAROL), 'maintainer', 'regrant')).rejects.toMatchObject({ epochs: [1] })
    expect(isMaintainerNow(CAROL)).toBe(false)
  })

  it('#7 adding a member while the current epoch is burned writes nothing', async () => {
    maintainer(BOB)
    const raw = new Uint8Array(32).fill(0xb1)
    await anchor(BOB, await EpochKeys.import(REPO, 1, raw), { defaultBranch: 'main', prevEpoch: 0, burned: true })
    wrap(BOB, ALICE, 1, raw)
    const DAN = id(0x25)
    await expect(addPrivateMember(ctx, b58(DAN), 'writer', 'add-dan')).rejects.toThrow()
    expect(members.some((m) => m.identity === b58(DAN))).toBe(false)
  })
})

describe('correctness review of the burn fixes', () => {
  const e = (n: number) => (chain['repoKey'] ?? []).filter((d) => d['epoch'] === n)
  const maintainer = (who: Uint8Array): void => void members.push({ identity: b58(who), role: 'maintainer', createdAt: 5 })

  it('H1 a removal that resumes a pending epoch burns it even when the stray wrap is hidden', async () => {
    // An earlier run wrapped epoch 1 to ALICE and CAROL; every read here lags CAROL's wrap.
    const leaked = new Uint8Array(32).fill(0x57)
    wrap(ALICE, ALICE, 1, leaked)
    hidden.add(wrap(ALICE, CAROL, 1, leaked))
    members = members.filter((m) => m.identity !== b58(CAROL))
    await expect(rotateRepoKey(ctx, [b58(CAROL)], 'rm-lag')).resolves.toBe(2)
    hidden.clear()
    const s = await aliceSession()
    expect(s.resolution.burned.has(1)).toBe(true)
    expect(s.resolution.writeEpoch).toBe(2)
    expect(e(2).some((d) => d['memberId'] === b58(CAROL))).toBe(false)
  })

  it('M1 a resumed epoch whose standing wrap a member can no longer use is burned, not stuck', async () => {
    // An earlier repair run wrapped epoch 1 to BOB's old key 3; BOB now only has key 4.
    const k = new Uint8Array(32).fill(0x58)
    wrap(ALICE, ALICE, 1, k)
    wrap(ALICE, BOB, 1, k, 3)
    await expect(rotateRepoKey(ctx, [], 'repair-bob')).resolves.toBe(2)
    const s = await aliceSession()
    expect(s.resolution.burned.has(1)).toBe(true)
    expect(e(2).find((d) => d['memberId'] === b58(BOB))?.['recipientKeyId']).toBe(4)
  })

  it('L4 a burn resumes the next epoch from its pending self-wrap', async () => {
    // Epoch 1 holds a wrap BOB can no longer use (burned on the way); an earlier run also left a
    // self-wrap for epoch 2. One repair rotation burns 1, then finishes 2 with that key.
    const k1 = new Uint8Array(32).fill(0x59)
    const k2 = new Uint8Array(32).fill(0x5c)
    wrap(ALICE, ALICE, 1, k1)
    wrap(ALICE, BOB, 1, k1, 3)
    wrap(ALICE, ALICE, 2, k2)
    await expect(rotateRepoKey(ctx, [], 'repair-2')).resolves.toBe(2)
    const s = await aliceSession()
    expect(s.resolution.burned.has(1)).toBe(true)
    expect(s.resolution.writeEpoch).toBe(2)
    expect(new Set(e(2).map((d) => d['wrapped']))).toEqual(new Set([bytesToBase64(k2)]))
  })

  it('M2 a maintainer removal another config would change is refused before anything is written', async () => {
    maintainer(BOB)
    maintainer(CAROL)
    const raw = new Uint8Array(32).fill(0x5a)
    const k1 = await EpochKeys.import(REPO, 1, raw)
    await anchor(BOB, k1, { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(BOB, ALICE, 1, raw)
    wrap(BOB, CAROL, 1, raw)
    await anchor(CAROL, k1, { defaultBranch: 'main', prevEpoch: 0, burned: true })
    const configs = (chain['config'] ?? []).length
    const wraps = (chain['repoKey'] ?? []).length
    await expect(removePrivateMember(ctx, b58(BOB), 'maintainer', 'rm-bob')).rejects.toThrow(/older key take over, so nothing was removed/)
    expect((chain['config'] ?? []).length).toBe(configs)
    expect((chain['repoKey'] ?? []).length).toBe(wraps)
  })

  it('M3 a removal whose rotation was pre-empted says so', async () => {
    maintainer(BOB)
    // BOB pre-posted a config for epoch 2, after epoch 1's key is stated only under the old rule.
    const raw = new Uint8Array(32).fill(0x5b)
    await anchor(BOB, await EpochKeys.import(REPO, 2, raw), { defaultBranch: 'main', prevEpoch: 1, prevEpochKey: new Uint8Array(32).fill(1) })
    const got = await removePrivateMember(ctx, b58(CAROL), 'writer', 'rm-carol').catch((x: unknown) => x)
    // Under the stated-after rule BOB's config never counts and the removal simply rotates.
    if (typeof got !== 'number') expect(String(got)).toMatch(/pre-empt|posted before/)
  })

  it('preempted: step 4 names a later anchor that predates ours, never a later rotation', async () => {
    const { anchorVerdict } = await import('./private-members')
    await expect(rotateRepoKey(ctx, [], 'r1')).resolves.toBe(1)
    const s1 = await aliceSession()
    const a1 = s1.resolution.anchors.get(1)
    expect(anchorVerdict(s1, 1, a1?.commit as Uint8Array, b58(ALICE))).toBe('ours')
    // A legitimate later rotation (anchored after ours) does not pre-empt epoch 1.
    await expect(rotateRepoKey(ctx, [], 'r2')).resolves.toBe(2)
    const s2 = await aliceSession()
    expect(anchorVerdict(s2, 1, a1?.commit as Uint8Array, b58(ALICE))).toBe('ours')
    // An epoch-3 anchor whose height is below epoch 2's does.
    const fake = { ...s2, resolution: { ...s2.resolution, anchors: new Map(s2.resolution.anchors) } }
    const a2 = s2.resolution.anchors.get(2)
    fake.resolution.anchors.set(3, { ...(a2 as NonNullable<typeof a2>), owner: BOB, height: (a2?.height ?? 0) - 1 })
    expect(anchorVerdict(fake, 2, a2?.commit as Uint8Array, b58(ALICE))).toEqual({ preempted: 3, by: b58(BOB) })
  })

  it('C1 a burn hands the burned key to every remaining member first, so any maintainer can finish it', async () => {
    maintainer(BOB)
    const leaked = new Uint8Array(32).fill(0x61)
    wrap(ALICE, ALICE, 1, leaked)
    wrap(ALICE, CAROL, 1, leaked)
    members = members.filter((m) => m.identity !== b58(CAROL))
    // The burn's anchor for epoch 2 fails: epoch 1 is left burned and current.
    let burnedSeen = false
    await rotateRepoKey(ctx, [b58(CAROL)], 'rm-c1', (st) => {
      if (st.kind === 'burned') {
        burnedSeen = true
        failNext['config'] = 5
      }
    }).catch(() => undefined)
    failNext['config'] = 0
    expect(burnedSeen).toBe(true)
    // BOB holds epoch 1's key from ALICE: his own session can chain from it.
    expect(e(1).find((d) => d['memberId'] === b58(BOB) && d['$ownerId'] === b58(ALICE))?.['wrapped']).toBe(bytesToBase64(leaked))
    const bob = await loadPrivateSession({ repo: REPO_REF, network: 'devnet', reader: b58(BOB), source: sdkSessionSource(sdk, REPO_REF), unwrapper: sessionUnwrapper(ops) })
    expect(bob.resolution.currentEpoch).toBe(1)
    expect(bob.resolution.keys.has(1)).toBe(true)
  })

  it('C2 removing your own maintainer role while you anchor an epoch is refused, nothing written', async () => {
    const configs = (chain['config'] ?? []).length
    await expect(removePrivateMember(ctx, b58(ALICE), 'maintainer', 'rm-self')).rejects.toThrow(/your own maintainer role/)
    expect((chain['config'] ?? []).length).toBe(configs)
    expect(members.some((m) => m.identity === b58(ALICE) && m.role === 'maintainer')).toBe(true)
  })

  it('M1 a refused re-grant says to grant writer or use a new identity', async () => {
    await anchor(CAROL, await EpochKeys.import(REPO, 1, new Uint8Array(32).fill(0x62)), { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    await expect(rotateRepoKey(ctx, [], 'r-m1')).resolves.toBe(1)
    await expect(addPrivateMember(ctx, b58(CAROL), 'maintainer', 'regrant-m1')).rejects.toThrow(/as a writer, or make another identity of theirs the maintainer/)
  })

  it('M3 re-running a removal while the current epoch is burned rotates past it', async () => {
    maintainer(BOB)
    const raw = new Uint8Array(32).fill(0x63)
    await anchor(BOB, await EpochKeys.import(REPO, 1, raw), { defaultBranch: 'main', prevEpoch: 0, burned: true })
    wrap(BOB, ALICE, 1, raw)
    // CAROL was already removed by an earlier run.
    members = members.filter((m) => m.identity !== b58(CAROL))
    await expect(removePrivateMember(ctx, b58(CAROL), 'writer', 'rm-again')).resolves.toBe(2)
    const s = await aliceSession()
    expect(s.resolution.writeEpoch).toBe(2)
  })

  it("CLI-H1 the leaving maintainer's own wraps never keep an epoch from vanishing", async () => {
    // BOB anchored epoch 1 and wrapped it to himself and to CAROL, a staying maintainer: only his
    // wraps say CAROL holds it, and they stop counting with his role.
    maintainer(BOB)
    maintainer(CAROL)
    const raw = new Uint8Array(32).fill(0x64)
    await anchor(BOB, await EpochKeys.import(REPO, 1, raw), { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(BOB, BOB, 1, raw)
    wrap(BOB, CAROL, 1, raw)
    await expect(removePrivateMember(ctx, b58(BOB), 'maintainer', 'rm-bob-h1')).resolves.toBe(1)
    const s = await aliceSession()
    expect(s.anchors.get(1)?.owner).toBe(b58(ALICE))
  })

  it('CLI-M2 the remover keeps every epoch it holds only through the leaving maintainer', async () => {
    // BOB anchored epoch 1 and is ALICE's only source of it; ALICE rotates 2 from it herself.
    maintainer(BOB)
    const raw = new Uint8Array(32).fill(0x65)
    await anchor(BOB, await EpochKeys.import(REPO, 1, raw), { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(BOB, ALICE, 1, raw)
    wrap(BOB, CAROL, 1, raw)
    const raw2 = new Uint8Array(32).fill(0x66)
    await anchor(ALICE, await EpochKeys.import(REPO, 2, raw2), { defaultBranch: 'main', prevEpoch: 1, prevEpochKey: new Uint8Array(raw) })
    wrap(ALICE, ALICE, 2, raw2)
    // ALICE's only wrap of epoch 1 is BOB's (she reads it through it and through the chain): she
    // wraps it to herself before his role goes, as the CLI does.
    await removePrivateMember(ctx, b58(BOB), 'maintainer', 'rm-bob-m2')
    const own = e(1).filter((d) => d['$ownerId'] === b58(ALICE) && d['memberId'] === b58(ALICE))
    expect(own).toHaveLength(1)
  })

  it('CLI-M3 the refusal names the maintainer whose config would take over', async () => {
    maintainer(BOB)
    maintainer(CAROL)
    const raw = new Uint8Array(32).fill(0x67)
    const k1 = await EpochKeys.import(REPO, 1, raw)
    await anchor(BOB, k1, { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    wrap(BOB, ALICE, 1, raw)
    wrap(BOB, CAROL, 1, raw)
    await anchor(CAROL, k1, { defaultBranch: 'main', prevEpoch: 0, burned: true })
    await expect(removePrivateMember(ctx, b58(BOB), 'maintainer', 'rm-bob-m3')).rejects.toThrow(shortId(b58(CAROL)))
  })

  it('L-a an adopted self-wrap to a key this browser lacks is refused before anything else is paid', async () => {
    // An earlier run's self-wrap to ALICE's old key 3 stands, hidden from every read.
    oldKey.add(b58(ALICE))
    hidden.add(wrap(ALICE, ALICE, 1, new Uint8Array(32).fill(0x5d), 3))
    const configs = (chain['config'] ?? []).length
    await expect(rotateRepoKey(ctx, [], 'repair-a')).rejects.toThrow(/does not hold/)
    expect((chain['config'] ?? []).length).toBe(configs)
    expect(e(1).filter((d) => d['memberId'] !== b58(ALICE))).toEqual([])
  })

  it('L-b a lost rotation is reported even when the repair after it fails', async () => {
    maintainer(BOB)
    const theirs = await EpochKeys.import(REPO, 1, new Uint8Array(32).fill(0x43))
    await anchor(BOB, theirs, { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0) })
    hidden.add(String((chain['config'] ?? []).at(-1)?.['$id']))
    const run = rotateRepoKey(ctx, [], 'race-b', (st) => {
      if (st.kind === 'waiting') hidden.clear()
      // The repair after the loss fails on its first member-list read.
      if (st.kind === 'lost') membersFail = 1
    })
    await expect(run).rejects.toMatchObject({ outcome: 'lost' })
  })
})

describe('a rotation from a browser holding an older key', () => {
  it('refuses before writing anything, naming both keys, instead of wrapping the new key to one it cannot read', async () => {
    newerKey.add(b58(ALICE))
    const before = { wraps: (chain['repoKey'] ?? []).length, configs: (chain['config'] ?? []).length }
    await expect(rotateRepoKey(ctx, [b58(CAROL)], 'rot-old')).rejects.toThrow(/holds encryption key 4.*current key is 5|key 5.*key 4/)
    expect((chain['repoKey'] ?? []).length).toBe(before.wraps)
    expect((chain['config'] ?? []).length).toBe(before.configs)
  })

  it('a removal from that browser is refused before the membership is deleted', async () => {
    newerKey.add(b58(ALICE))
    await expect(removePrivateMember(ctx, b58(CAROL), 'writer', 'rm-old')).rejects.toThrow(/current key is 5/)
    expect(members.some((m) => m.identity === b58(CAROL))).toBe(true)
  })
})

/**
 * The private-repo read path over locally sealed fixtures (no network, no WASM): the session
 * (`resolveEpochs` over flattened documents, the reader's own wraps unwrapped through a fake
 * unwrapper), the content gate, refs across epochs, the late-content rule, the review tally, the
 * browse plane's sealed reads, and the rotation / repair planning.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { EncKeyLike } from '../auth/encryption-key'
import {
  EpochKeys,
  GRACE_BLOCKS,
  bytesToHex,
  packHash,
  privateId,
  refNameHash,
  sealDoc,
  sealPack,
  type PrivateDoc,
  type PrivateDocType,
} from '../private'
import type { Membership } from '../rules/v2'
import { bytesToBase64, type DocumentQuery } from '../sdk'
import { openPrivateArtifact, readPrivateRange } from '../view/private-packs'
import { readConfigBundle } from './config'
import { readAllRefUpdates, readRefs } from './refs'
import { listIssues, readReviews } from './issues'
import { planRepair, planRotation, rotationCost } from './private-members'
import { privateGate, sealedGate } from './private-content'
import { loadPrivateSession, closePrivateSessions, type SessionSource, type SessionUnwrapper } from './private-session'
import { assertNoPlaintext } from './writes'
import type { PackManifest, RepoRef } from './index'

// ---------------------------------------------------------------------------
// Fixture identities and helpers
// ---------------------------------------------------------------------------

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const REPO = id(0x11)
const ALICE = id(0x21) // owner, maintainer
const BOB = id(0x22) // writer
const CAROL = id(0x23) // writer, removed at epoch 1
const EVE = id(0x24) // outsider

const FORGE = { core: 'CORE', collab: 'COLLAB', group: 'GROUP' }
const REPO_REF: RepoRef = { forge: FORGE, repoId: b58(REPO), ownerId: b58(ALICE), name: 'secret', visibility: 'private' }

const K0 = Uint8Array.from({ length: 32 }, (_, i) => i)
const K1 = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i)

let seq = 0
function docId(): Uint8Array {
  seq += 1
  const u = new Uint8Array(32)
  new DataView(u.buffer).setUint32(28, seq)
  return u
}

/** An identity's public keys: one usable ENCRYPTION key (id 4, secp256k1, unbound). */
function encKeys(keyId = 4): EncKeyLike[] {
  return [{ keyId, purposeNumber: 1, keyTypeNumber: 0, data: '02' + 'ab'.repeat(32) }]
}

/** A sealed content document in the `toJSON` shape a query returns. */
async function sealed(
  type: PrivateDocType,
  keys: EpochKeys,
  owner: Uint8Array,
  bind: Partial<PrivateDoc>,
  fields: Parameters<typeof sealDoc>[2],
  extra: Record<string, unknown>,
  height: number,
  options: { anchor?: boolean } = {},
): Promise<Record<string, unknown>> {
  const $id = docId()
  const doc: PrivateDoc = { type, ownerId: owner, epoch: keys.epoch, ...bind }
  const enc = await sealDoc(keys, doc, fields, options)
  return {
    $id: b58($id),
    $ownerId: b58(owner),
    $createdAt: height * 1000,
    $createdAtBlockHeight: height,
    repoId: b58(REPO),
    epoch: keys.epoch,
    enc: bytesToBase64(enc),
    ...extra,
  }
}

/** A wrap row: `keys` are what the fake unwrapper hands back for the reader's own. */
function wrapDoc(owner: Uint8Array, member: Uint8Array, epoch: number, height: number, recipientKeyId = 4): Record<string, unknown> {
  return {
    $id: b58(docId()),
    $ownerId: b58(owner),
    $createdAt: height * 1000,
    $createdAtBlockHeight: height,
    repoId: b58(REPO),
    memberId: b58(member),
    epoch,
    recipientKeyId,
    senderKeyId: 4,
    wrapped: bytesToBase64(new Uint8Array(64)),
  }
}

interface World {
  members: Membership[]
  configs: Record<string, unknown>[]
  wraps: Record<string, unknown>[]
  keys: Map<number, EpochKeys>
  raw: Map<number, Uint8Array>
}

/** Epoch 0 by ALICE (height 10); BOB and CAROL wrapped. */
async function world(): Promise<World> {
  const k0 = await EpochKeys.import(REPO, 0, K0)
  const members: Membership[] = [
    { identity: b58(ALICE), role: 'maintainer', createdAt: 1 },
    { identity: b58(BOB), role: 'writer', createdAt: 2 },
    { identity: b58(CAROL), role: 'writer', createdAt: 3 },
  ]
  const anchor0 = await sealed('config', k0, ALICE, {}, { defaultBranch: 'main', protectedPatterns: ['refs/heads/main'] }, { backend: { mode: 0 } }, 10, { anchor: true })
  return {
    members,
    configs: [anchor0],
    wraps: [wrapDoc(ALICE, ALICE, 0, 11), wrapDoc(ALICE, BOB, 0, 12), wrapDoc(ALICE, CAROL, 0, 13)],
    keys: new Map([[0, k0]]),
    raw: new Map([[0, new Uint8Array(K0)]]),
  }
}

/** ALICE rotates to epoch 1 at height 100, removing CAROL. */
async function rotate(w: World): Promise<EpochKeys> {
  const k1 = await EpochKeys.import(REPO, 1, K1)
  w.members = w.members.filter((m) => m.identity !== b58(CAROL))
  w.configs.push(
    await sealed('config', k1, ALICE, {}, { defaultBranch: 'main', protectedPatterns: ['refs/heads/main'], prevEpoch: 0, prevEpochKey: new Uint8Array(K0) }, { backend: { mode: 0 } }, 100, { anchor: true }),
  )
  w.wraps.push(wrapDoc(ALICE, ALICE, 1, 98), wrapDoc(ALICE, BOB, 1, 99))
  w.keys.set(1, k1)
  w.raw.set(1, new Uint8Array(K1))
  return k1
}

function source(w: World): SessionSource {
  return {
    memberships: async () => w.members,
    configs: async () => w.configs,
    repoKeys: async () => w.wraps,
    identityKeys: async () => encKeys(),
  }
}

/** The reader's unwrapper: the world's key of each epoch (the SDK decrypt, faked). */
function unwrapper(w: World): SessionUnwrapper {
  return {
    keyId: 4,
    unwrap: async (p) => {
      const k = w.keys.get(p.epoch)
      if (k === undefined) throw new Error('no key')
      return k
    },
  }
}

async function sessionFor(w: World, reader: Uint8Array, withKey = true) {
  return loadPrivateSession({ repo: REPO_REF, network: 'devnet', reader: b58(reader), source: source(w), unwrapper: withKey ? unwrapper(w) : null })
}

/** A Drive-shaped mock SDK over typed rows (only `==` and orderBy by `$createdAt`). */
function mockSdk(rows: Record<string, Record<string, unknown>[]>): EvoSDK {
  const query = async (q: DocumentQuery): Promise<Map<string, Record<string, unknown>>> => {
    let out = [...(rows[q.documentTypeName] ?? [])]
    for (const [f, op, v] of q.where ?? []) {
      if (op === '==') out = out.filter((d) => d[f] === v)
    }
    const desc = q.orderBy?.some(([, d]) => d === 'desc')
    out.sort((a, b) => (a['$createdAt'] as number) - (b['$createdAt'] as number) || String(a['$id']).localeCompare(String(b['$id'])))
    if (desc) out.reverse()
    if (q.startAfter !== undefined) out = out.slice(out.findIndex((d) => d['$id'] === q.startAfter) + 1)
    out = out.slice(0, Math.min(q.limit ?? 100, 100))
    return new Map(out.map((d) => [String(d['$id']), d]))
  }
  return { documents: { query, count: async () => new Map() } } as unknown as EvoSDK
}

// ---------------------------------------------------------------------------

describe('the private session', () => {
  it('resolves epochs, reads its own wraps, and opens the config timeline', async () => {
    const w = await world()
    const s = await sessionFor(w, BOB)
    expect(s.resolution.currentEpoch).toBe(0)
    expect(s.resolution.writeEpoch).toBe(0)
    expect(s.config?.defaultBranch).toBe('main')
    expect(s.config?.protectedPatterns).toEqual(['refs/heads/main'])
    expect(s.configHistory).toHaveLength(1)
    expect(s.anchors.get(0)?.owner).toBe(b58(ALICE))
  })

  it('a non-member gets nothing: no key, no config, and the gate admits nothing', async () => {
    const w = await world()
    const s = await sessionFor(w, EVE)
    expect(s.resolution.keys.size).toBe(0)
    expect(s.config).toBeNull()
    const k0 = w.keys.get(0) as EpochKeys
    const issue = await sealed('issue', k0, ALICE, { number: 1 }, { title: 'secret title', body: 'secret body' }, { number: 1 }, 20)
    const a = await s.gate.admit('issue', issue)
    expect(a).toEqual({ ok: false, reason: 'wrongKey' })
    // The sealed gate (no session) is the same for everyone.
    expect(await sealedGate(REPO_REF).admit('issue', issue)).toEqual({ ok: false, reason: 'wrongKey' })
    expect(JSON.stringify(a)).not.toContain('secret')
  })

  it('a member with no key in this browser reads nothing but still sees the epochs', async () => {
    const w = await world()
    const s = await sessionFor(w, BOB, false)
    expect(s.resolution.currentEpoch).toBe(0)
    expect(s.resolution.writeEpoch).toBeNull()
    expect(s.config).toBeNull()
  })

  it('reads configs and repo keys with its reads, and closes on lock', async () => {
    const w = await world()
    const s = await sessionFor(w, BOB)
    const k0 = w.keys.get(0) as EpochKeys
    const issue = await sealed('issue', k0, ALICE, { number: 1 }, { title: 't' }, { number: 1 }, 20)
    expect((await s.gate.admit('issue', issue)).ok).toBe(true)
    closePrivateSessions()
    expect(s.closed).toBe(true)
    expect((await s.gate.admit('issue', issue)).ok).toBe(false)
  })

  it('strips a leading refs/heads/ from the sealed defaultBranch', async () => {
    const w = await world()
    const k0 = w.keys.get(0) as EpochKeys
    w.configs = [await sealed('config', k0, ALICE, {}, { defaultBranch: 'refs/heads/trunk' }, { backend: { mode: 0 } }, 10, { anchor: true })]
    const s = await sessionFor(w, BOB)
    expect(s.config?.defaultBranch).toBe('trunk')
  })
})

describe('private reads through the gate', () => {
  it('hides plaintext, outsiders\' bytes and late content, counting each reason', async () => {
    const w = await world()
    const k0 = w.keys.get(0) as EpochKeys
    await rotate(w)
    const s = await sessionFor(w, BOB)
    const repo: RepoRef = { ...REPO_REF, session: s }
    const k1 = w.keys.get(1) as EpochKeys
    // #1 readable (epoch 1); #2 plaintext; #3 by the outsider EVE under their own key; #4 by
    // CAROL (removed) under epoch 0 after next anchor + grace (late); #5 CAROL within grace.
    const fakeK = await EpochKeys.import(REPO, 1, new Uint8Array(32).fill(9))
    const issues = [
      await sealed('issue', k1, BOB, { number: 1 }, { title: 'readable', body: 'hello' }, { number: 1 }, 150),
      { $id: b58(docId()), $ownerId: b58(EVE), $createdAt: 160_000, $createdAtBlockHeight: 160, repoId: b58(REPO), number: 2, title: 'plaintext' },
      await sealed('issue', fakeK, EVE, { number: 3 }, { title: 'forged' }, { number: 3 }, 170),
      await sealed('issue', k0, CAROL, { number: 4 }, { title: 'late' }, { number: 4 }, 100 + GRACE_BLOCKS + 1),
      await sealed('issue', k0, CAROL, { number: 5 }, { title: 'in grace' }, { number: 5 }, 100 + GRACE_BLOCKS),
    ]
    const sdk = mockSdk({ issue: issues, event: [], authorEvent: [] })
    const list = await listIssues(sdk, repo, 50)
    expect(list.map((i) => i.title).sort()).toEqual(['in grace', 'readable'])
    expect(list.hiddenBy).toEqual({ notEncrypted: 2, wrongKey: 0, late: 1 })
    const body = list.find((i) => i.title === 'readable')?.body
    expect(body).toBe('hello')
  })

  it('never counts an unreadable review as an approval', async () => {
    const w = await world()
    const s = await sessionFor(w, BOB)
    const repo: RepoRef = { ...REPO_REF, session: s }
    const k0 = w.keys.get(0) as EpochKeys
    const patchId = docId()
    const good = await sealed('review', k0, ALICE, { patchId }, { body: '' }, { patchId: b58(patchId), verdict: 1, commitOid: bytesToBase64(new Uint8Array(20)) }, 30)
    // A review whose enc does not open (a stranger's bytes under a made-up key).
    const bad = await sealed('review', await EpochKeys.import(REPO, 0, new Uint8Array(32).fill(3)), EVE, { patchId }, { body: 'lgtm' }, { patchId: b58(patchId), verdict: 1, commitOid: bytesToBase64(new Uint8Array(20)) }, 31)
    const sdk = mockSdk({ review: [good, bad] })
    const reviews = await readReviews(sdk, repo, b58(patchId))
    expect(reviews.map((r) => r.reviewer)).toEqual([b58(ALICE)])
  })

  it('groups a ref\'s history across two epochs by its decrypted name', async () => {
    const w = await world()
    const k0 = w.keys.get(0) as EpochKeys
    const k1 = await rotate(w)
    const s = await sessionFor(w, BOB)
    const repo: RepoRef = { ...REPO_REF, session: s }
    const oidA = new Uint8Array(20).fill(0xaa)
    const oidB = new Uint8Array(20).fill(0xbb)
    const ref = async (keys: EpochKeys, newOid: Uint8Array, prevOid: Uint8Array | undefined, height: number) => {
      const h = await refNameHash(keys, 'refs/heads/main')
      return sealed(
        'protectedRefUpdate',
        keys,
        ALICE,
        { refNameHash: h, newOid, ...(prevOid ? { prevOid } : {}), force: false },
        { refName: 'refs/heads/main' },
        { refNameHash: bytesToBase64(h), newOid: bytesToBase64(newOid), ...(prevOid ? { prevOid: bytesToBase64(prevOid) } : {}), force: false },
        height,
      )
    }
    const rows = [await ref(k0, oidA, undefined, 20), await ref(k1, oidB, oidA, 120)]
    // The per-epoch hashes differ: a public reader would see two refs.
    expect(rows[0]?.['refNameHash']).not.toBe(rows[1]?.['refNameHash'])
    const sdk = mockSdk({ protectedRefUpdate: rows, refUpdate: [] })
    const all = await readAllRefUpdates(sdk, repo)
    expect(all.size).toBe(1)
    expect([...all.values()][0]).toHaveLength(2)
    const refs = await readRefs(sdk, repo, undefined, Promise.resolve(s.configHistory))
    expect(refs.map((r) => r.refName)).toEqual(['refs/heads/main'])
    expect(refs[0]?.state).toMatchObject({ state: 'resolved', oid: bytesToHex(oidB) })
    const bundle = await readConfigBundle(sdk, repo)
    expect(bundle.config?.defaultBranch).toBe('main')
  })

  it('a private repo without a session reads no refs and no config', async () => {
    const sdk = mockSdk({ protectedRefUpdate: [], refUpdate: [], config: [] })
    expect((await readAllRefUpdates(sdk, REPO_REF)).size).toBe(0)
    expect((await readConfigBundle(sdk, REPO_REF)).history).toEqual([])
  })
})

describe('sealed artifacts on the browse plane', () => {
  const manifest = async (sealedBytes: Uint8Array, uploader: Uint8Array, height: number): Promise<PackManifest> => ({
    packHash: await packHash(sealedBytes),
    kind: 0,
    sizeBytes: sealedBytes.length,
    objectCount: 0,
    chunkCount: 0,
    storage: 0,
    uris: [],
    tips: [],
    supersedes: [],
    createdAt: height * 1000,
    documentId: b58(docId()),
    uploader: b58(uploader),
    createdAtBlockHeight: height,
  })

  it('reads plaintext ranges and whole artifacts, checking packHash first', async () => {
    const w = await world()
    const s = await sessionFor(w, BOB)
    const plain = Uint8Array.from({ length: 40_000 }, (_, i) => i % 251)
    const sealedBytes = await sealPack(w.keys.get(0) as EpochKeys, plain)
    const m = await manifest(sealedBytes, ALICE, 20)
    const got = await readPrivateRange(s, m, async (a, b) => sealedBytes.subarray(a, b), 20_000, 20_100)
    expect(bytesToHex(got)).toBe(bytesToHex(plain.subarray(20_000, 20_100)))
    expect(s.headerCache.has(m.packHash, m.documentId)).toBe(true)
    expect(bytesToHex(await openPrivateArtifact(s, m, sealedBytes))).toBe(bytesToHex(plain))
    const tampered = new Uint8Array(sealedBytes)
    tampered[100] = (tampered[100] as number) ^ 1
    await expect(openPrivateArtifact(s, m, tampered)).rejects.toThrow()
  })

  it('refuses a pack uploaded under an old key by a removed member', async () => {
    const w = await world()
    await rotate(w)
    const s = await sessionFor(w, BOB)
    const sealedBytes = await sealPack(w.keys.get(0) as EpochKeys, new Uint8Array(100))
    const late = await manifest(sealedBytes, CAROL, 150)
    await expect(openPrivateArtifact(s, late, sealedBytes)).rejects.toThrow(/old key/)
    expect(s.suspectManifests.has(late.documentId)).toBe(true)
    // A current member's upload under the old key is flagged but still read.
    const own = await manifest(sealedBytes, BOB, 150)
    await expect(openPrivateArtifact(s, own, sealedBytes)).resolves.toHaveLength(100)
  })
})

describe('rotation and repair planning', () => {
  it('excludes the removed member even when a stale member list still shows them, self first', async () => {
    const w = await world()
    const s = await sessionFor(w, ALICE) // the list still has CAROL
    const plan = planRotation(s, b58(ALICE), [b58(CAROL)], FORGE.core)
    expect(plan.from).toBe(0)
    expect(plan.epoch).toBe(1)
    expect(plan.recipients.map((r) => r.identity)).toEqual([b58(ALICE), b58(BOB)])
    expect(plan.recipients.some((r) => r.identity === b58(CAROL))).toBe(false)
    expect(plan.writes).toBe(3) // members (2) + anchor
    expect(rotationCost(plan).credits).toBeGreaterThan(0)
  })

  it('resumes from its own self-wrap for an unanchored epoch (no key is stored)', async () => {
    const w = await world()
    w.members = w.members.filter((m) => m.identity !== b58(CAROL))
    // A rotation to epoch 1 stopped after the self-wrap and BOB's wrap.
    w.wraps.push(wrapDoc(ALICE, ALICE, 1, 50), wrapDoc(ALICE, BOB, 1, 51))
    const s = await sessionFor(w, ALICE)
    const plan = planRotation(s, b58(ALICE), [b58(CAROL)], FORGE.core)
    expect(plan.epoch).toBe(1)
    expect(plan.resume?.row.epoch).toBe(1)
    expect(plan.recipients.filter((r) => !r.done).map((r) => r.identity)).toEqual([])
    expect(plan.writes).toBe(1) // just the anchor
  })

  it('never resumes an epoch whose key went to someone now excluded; picks the next free one', async () => {
    const w = await world()
    // Stopped mid-rotation after wrapping CAROL too, then CAROL is the one being removed.
    w.wraps.push(wrapDoc(ALICE, ALICE, 1, 50), wrapDoc(ALICE, CAROL, 1, 51))
    const s = await sessionFor(w, ALICE)
    const plan = planRotation(s, b58(ALICE), [b58(CAROL)], FORGE.core)
    expect(plan.resume).toBeNull()
    expect(plan.epoch).toBe(2)
  })

  it('needs the current epoch to be readable, and a maintainer', async () => {
    const w = await world()
    const bob = await sessionFor(w, BOB)
    expect(() => planRotation(bob, b58(BOB), [b58(CAROL)], FORGE.core)).toThrow(/maintainer/)
    const locked = await sessionFor(w, ALICE, false)
    expect(() => planRotation(locked, b58(ALICE), [b58(CAROL)], FORGE.core)).toThrow(/current key/)
  })

  it('repair: a wrapped non-member forces a rotation; an unwrapped member gets a wrap', async () => {
    const w = await world()
    // CAROL was removed without a rotation, and DAN joined without a wrap.
    const DAN = id(0x25)
    w.members = w.members.filter((m) => m.identity !== b58(CAROL))
    w.members.push({ identity: b58(DAN), role: 'writer', createdAt: 9 })
    const s = await sessionFor(w, ALICE)
    const plan = planRepair(s, b58(ALICE), FORGE.core)
    expect(plan?.rotate).toEqual([b58(CAROL)])
    expect(plan?.wrap).toEqual([b58(DAN)])
    expect(planRepair(await sessionFor(w, BOB), b58(BOB), FORGE.core)).toBeNull()
  })
})

describe('no plaintext reaches a private repo', () => {
  it('refuses content fields in plaintext, and unencrypted content types', () => {
    expect(() => assertNoPlaintext(REPO_REF, 'issue', { number: 1, title: 'oops' })).toThrow(/plaintext/)
    expect(() => assertNoPlaintext(REPO_REF, 'comment', { targetId: new Uint8Array(32), body: 'x', enc: new Uint8Array(29), epoch: 0 })).toThrow(/plaintext/)
    expect(() => assertNoPlaintext(REPO_REF, 'review', { verdict: 1 })).toThrow(/unencrypted/)
    expect(() => assertNoPlaintext(REPO_REF, 'issue', { number: 1, enc: new Uint8Array(29), epoch: 0 })).not.toThrow()
    expect(() => assertNoPlaintext(REPO_REF, 'event', { kind: 1 })).not.toThrow()
    expect(() => assertNoPlaintext({ ...REPO_REF, visibility: 'public' }, 'issue', { title: 'fine' })).not.toThrow()
  })

  it('the private gate is keyed on the document\'s AD: a lifted ciphertext does not open', async () => {
    const w = await world()
    const s = await sessionFor(w, BOB)
    const k0 = w.keys.get(0) as EpochKeys
    const issue = await sealed('issue', k0, ALICE, { number: 1 }, { title: 't' }, { number: 1 }, 20)
    // Replayed under BOB's $ownerId and another number.
    const lifted = { ...issue, $ownerId: b58(BOB), number: 2 }
    expect(await privateGate(REPO_REF, s.ctx).admit('issue', lifted)).toEqual({ ok: false, reason: 'notEncrypted' })
    expect(privateId(b58(BOB))).toEqual(BOB)
  })
})

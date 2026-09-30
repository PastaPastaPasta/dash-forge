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
  WrapError,
} from '../private'
import type { Membership } from '../rules/v2'
import { bytesToBase64, previewCreate, type DocumentQuery } from '../sdk'
import { openPrivateArtifact, readPrivateRange } from '../view/private-packs'
import { readConfigBundle } from './config'
import { readAllRefUpdates, readRefs } from './refs'
import { readReviews } from './issues'
import { queryIssues } from './issue-index'
import { anchorVerdict, epochsAnchoredBy, needsKeepWrap, planRepair, planRotation, removalEffect, rotationCost, wrapOutcome } from './private-members'
import { privateGate, sealedGate } from './private-content'
import { editFields, sealContent } from './private-writes'
import { loadPrivateSession, closePrivateSessions, type SessionSource, type SessionUnwrapper } from './private-session'
import { assertNoPlaintext, grantMember, revokeMember } from './writes'
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

const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
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
      if (k === undefined) throw new WrapError('wrapUnreadable')
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
  return { documents: { query, count: async () => new Map(), sum: async () => new Map() } } as unknown as EvoSDK
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

  it('a locked vault is an error, not a member without keys', async () => {
    const w = await world()
    const locked: SessionUnwrapper = { keyId: 4, unwrap: async () => Promise.reject(new Error('unlock this browser to read private repos')) }
    await expect(
      loadPrivateSession({ repo: REPO_REF, network: 'devnet', reader: b58(BOB), source: source(w), unwrapper: locked }),
    ).rejects.toThrow(/unlock/)
  })

  it('a load that straddles a lock never hands out its session', async () => {
    const w = await world()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow: SessionUnwrapper = {
      keyId: 4,
      unwrap: async (p) => {
        await gate
        return w.keys.get(p.epoch) as EpochKeys
      },
    }
    const loading = loadPrivateSession({ repo: REPO_REF, network: 'devnet', reader: b58(BOB), source: source(w), unwrapper: slow })
    await new Promise((r) => setTimeout(r, 0))
    closePrivateSessions()
    release()
    await expect(loading).rejects.toThrow(/locked/)
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
    const page = await queryIssues(sdk, repo, { state: 'all', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 100 } as const, null, 'devnet')
    const list = page.rows
    expect(list.map((i) => i.title).sort()).toEqual(['in grace', 'readable'])
    expect(page.hiddenBy).toEqual({ notEncrypted: 2, wrongKey: 0, late: 1, lateEdit: 0 })
    const body = list.find((i) => i.title === 'readable')?.body
    expect(body).toBe('hello')
  })

  it('a removed member’s edit after the grace period is judged late too (§8.2 "edits are judged too")', async () => {
    const w = await world()
    const k0 = w.keys.get(0) as EpochKeys
    await rotate(w)
    const s = await sessionFor(w, BOB)
    const repo: RepoRef = { ...REPO_REF, session: s }
    // CAROL (removed) wrote #6 in time, then replaced it long after the rotation; #7 was edited
    // within the grace period.
    const issues = [
      await sealed('issue', k0, CAROL, { number: 6 }, { title: 'edited late' }, { number: 6, $updatedAtBlockHeight: 100 + GRACE_BLOCKS + 50 }, 90),
      await sealed('issue', k0, CAROL, { number: 7 }, { title: 'edited in grace' }, { number: 7, $updatedAtBlockHeight: 100 + GRACE_BLOCKS }, 90),
    ]
    const page = await queryIssues(mockSdk({ issue: issues, event: [], authorEvent: [] }), repo, { state: 'all', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 100 } as const, null, 'devnet')
    const list = page.rows
    expect(list.map((i) => i.title)).toEqual(['edited in grace'])
    expect(page.hiddenBy).toEqual({ notEncrypted: 0, wrongKey: 0, late: 0, lateEdit: 1 })
    // Maintainers read why (the CLI's bucket text is the same).
    const { HIDDEN_REASON_TEXT } = await import('./private-content')
    expect(HIDDEN_REASON_TEXT.lateEdit).toBe('edited after its author was removed; the original text is gone')
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
    // The late copy is readable once any copy of the same bytes qualifies (a member re-uploaded).
    await expect(openPrivateArtifact(s, { ...late, copies: [late, own] }, sealedBytes)).resolves.toHaveLength(100)
    // A copy with no block height never qualifies, whoever uploaded it.
    const { createdAtBlockHeight: _h, ...noHeight } = own
    await expect(openPrivateArtifact(s, noHeight, sealedBytes)).rejects.toThrow(/old key/)
  })
})

describe('rotation and repair planning', () => {
  it('excludes the removed member even when a stale member list still shows them, self first', async () => {
    const w = await world()
    const s = await sessionFor(w, ALICE) // the list still has CAROL
    const plan = planRotation(s, b58(ALICE), [b58(CAROL)], FORGE.core, 4)
    expect(plan.from).toBe(0)
    expect(plan.epoch).toBe(1)
    expect(plan.recipients.map((r) => r.identity)).toEqual([b58(ALICE), b58(BOB)])
    expect(plan.recipients.some((r) => r.identity === b58(CAROL))).toBe(false)
    expect(plan.recipients.filter((r) => !r.done)).toHaveLength(2) // + the anchor
    expect(rotationCost(plan).credits).toBeGreaterThan(0)
  })

  it('a pending n + 1 is resumed by a repair rotation: its self-wrap is the journal (no key is stored)', async () => {
    const w = await world()
    w.members = w.members.filter((m) => m.identity !== b58(CAROL))
    // A rotation to epoch 1 stopped after the self-wrap and BOB's wrap.
    w.wraps.push(wrapDoc(ALICE, ALICE, 1, 50), wrapDoc(ALICE, BOB, 1, 51))
    const s = await sessionFor(w, ALICE)
    const plan = planRotation(s, b58(ALICE), [], FORGE.core, 4)
    expect(plan.epoch).toBe(1)
    expect(plan.resume?.row.epoch).toBe(1)
    expect(plan.burn).toBe(false)
    expect(plan.recipients.filter((r) => !r.done).map((r) => r.identity)).toEqual([]) // just the anchor
    // A removal never finishes a resumed epoch: a lagging read may hide a wrap to the one leaving.
    expect(planRotation(s, b58(ALICE), [b58(CAROL)], FORGE.core, 4).burn).toBe(true)
  })

  it('a pending n + 1 to a key this browser does not hold is refused, not skipped', async () => {
    const w = await world()
    w.members = w.members.filter((m) => m.identity !== b58(CAROL))
    // The interrupted self-wrap went to key 3, an older key; this browser holds key 4.
    w.wraps.push(wrapDoc(ALICE, ALICE, 1, 50, 3))
    const s = await sessionFor(w, ALICE)
    expect(() => planRotation(s, b58(ALICE), [b58(CAROL)], FORGE.core, 4)).toThrow(/does not hold/)
  })

  it('a pending n + 1 whose key reached someone now excluded is burned, then n + 2', async () => {
    const w = await world()
    // Stopped mid-rotation after wrapping CAROL too, then CAROL is the one being removed.
    w.wraps.push(wrapDoc(ALICE, ALICE, 1, 50), wrapDoc(ALICE, CAROL, 1, 51))
    const s = await sessionFor(w, ALICE)
    const plan = planRotation(s, b58(ALICE), [b58(CAROL)], FORGE.core, 4)
    expect(plan.epoch).toBe(1)
    expect(plan.burn).toBe(true)
    // The cost counts what the burn writes: the burned key to BOB (ALICE already has hers), the
    // burned anchor, then ALICE and BOB at epoch 2 and its anchor.
    const wrap = previewCreate('repoKey').credits
    const config = previewCreate('config').credits
    expect(rotationCost(plan).credits).toBe(3 * wrap + 2 * config)
  })

  it('epochs are contiguous: the new one is n + 1, whatever higher numbers others posted', async () => {
    const w = await world()
    // A wrap for epoch 7 from CAROL (never a maintainer) and a config at 2^32-1: both ignored.
    w.wraps.push(wrapDoc(CAROL, CAROL, 7, 60))
    const s = await sessionFor(w, ALICE)
    expect(planRotation(s, b58(ALICE), [b58(CAROL)], FORGE.core, 4).epoch).toBe(1)
  })

  it('removing a role: who is excluded, and what re-anchoring costs', async () => {
    const w = await world()
    await rotate(w)
    w.members.push({ identity: b58(BOB), role: 'maintainer', createdAt: 50 })
    const s = await sessionFor(w, ALICE)
    expect(removalEffect(s.members, b58(BOB), 'maintainer')).toBe('rotate-keep')
    expect(removalEffect(s.members, b58(BOB), 'writer')).toBe('none')
    expect(removalEffect(s.members, b58(ALICE), 'maintainer')).toBe('rotate-exclude')
    expect(epochsAnchoredBy(s, b58(ALICE))).toEqual([0, 1])
    expect(epochsAnchoredBy(s, b58(BOB))).toEqual([])
  })

  it('keeps the current key when the remover holds it only from the leaving maintainer', async () => {
    const w = await world()
    // BOB, a maintainer, is wrapped epoch 0 only by ALICE; removing ALICE would drop BOB's key.
    w.members.push({ identity: b58(BOB), role: 'maintainer', createdAt: 50 })
    const bob = await sessionFor(w, BOB)
    expect(needsKeepWrap(bob, b58(BOB), b58(ALICE))).toBe(true)
    // With a second wrap from another current maintainer (BOB's own), no keep-wrap is needed.
    w.wraps.push(wrapDoc(BOB, BOB, 0, 70))
    expect(needsKeepWrap(await sessionFor(w, BOB), b58(BOB), b58(ALICE))).toBe(false)
  })

  it('a rotation session drops the removed membership even when a node still lists it', async () => {
    const w = await world()
    await rotate(w) // CAROL's writer row is gone from `w.members` here
    // A lagging node still lists CAROL, now as a maintainer who pre-posted a config and a wrap for
    // epoch 2 (the §5.4 C1 threat).
    const stale = [...w.members, { identity: b58(CAROL), role: 'maintainer' as const, createdAt: 3 }]
    const kEvil = await EpochKeys.import(REPO, 2, new Uint8Array(32).fill(0x66))
    w.configs.push(await sealed('config', kEvil, CAROL, {}, { defaultBranch: 'main', prevEpoch: 1, prevEpochKey: new Uint8Array(K1) }, {}, 105, { anchor: true }))
    const src = { ...source(w), memberships: async () => stale }
    const naive = await loadPrivateSession({ repo: REPO_REF, network: 'devnet', reader: b58(ALICE), source: src, unwrapper: unwrapper(w) })
    expect(naive.resolution.currentEpoch).toBe(2)
    const dropped = await loadPrivateSession({
      repo: REPO_REF,
      network: 'devnet',
      reader: b58(ALICE),
      source: src,
      unwrapper: unwrapper(w),
      drop: [{ identity: b58(CAROL) }],
    })
    expect(dropped.resolution.currentEpoch).toBe(1)
    expect(dropped.members.some((m) => m.identity === b58(CAROL))).toBe(false)
  })

  it('step 4 confirms only an anchor with our key, readable as the write epoch', async () => {
    const w = await world()
    const k1 = await rotate(w)
    const s = await sessionFor(w, ALICE)
    expect(anchorVerdict(s, 1, k1.commit, b58(ALICE))).toBe('ours')
    // Same owner, another key (a replayed anchor): never "ours".
    expect(anchorVerdict(s, 1, new Uint8Array(32).fill(1), b58(ALICE))).toBe('mismatch')
    expect(anchorVerdict(s, 1, k1.commit, b58(BOB))).toBe('lost')
    expect(anchorVerdict(s, 5, k1.commit, b58(ALICE))).toBe('pending')
  })

  it('a standing wrap counts only with the same key to the same recipient key', () => {
    const c = new Uint8Array(32).fill(7)
    expect(wrapOutcome(null, { commit: c, keyId: 4 })).toEqual({ kind: 'unreadable' })
    expect(wrapOutcome({ commit: c, recipientKeyId: 4 }, { commit: c, keyId: 4 })).toEqual({ kind: 'same' })
    expect(wrapOutcome({ commit: c, recipientKeyId: 3 }, { commit: c, keyId: 4 })).toEqual({ kind: 'different' })
    expect(wrapOutcome({ commit: new Uint8Array(32), recipientKeyId: 4 }, { commit: c, keyId: 4 })).toEqual({ kind: 'different' })
  })

  it('needs the current epoch to be readable, and a maintainer', async () => {
    const w = await world()
    const bob = await sessionFor(w, BOB)
    expect(() => planRotation(bob, b58(BOB), [b58(CAROL)], FORGE.core, 4)).toThrow(/maintainer/)
    const locked = await sessionFor(w, ALICE, false)
    expect(() => planRotation(locked, b58(ALICE), [b58(CAROL)], FORGE.core, 4)).toThrow(/current key/)
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

describe('a private repo has no plain membership path', () => {
  it('the plain grant and revoke writers refuse a private repo before any read or write', async () => {
    const noSdk = new Proxy({}, { get: () => { throw new Error('touched the SDK') } }) as unknown as EvoSDK
    const auth = { identityId: b58(ALICE), network: 'devnet' as const, getSigningKeyWif: () => 'x' }
    await expect(grantMember(noSdk, auth, REPO_REF, b58(CAROL), 'writer')).rejects.toThrow(/private-repo flow/)
    await expect(revokeMember(noSdk, auth, REPO_REF, b58(CAROL), 'writer')).rejects.toThrow(/private-repo flow/)
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

  it('an imported document’s sealed provenance comes back as its `imported` object', async () => {
    const w = await world()
    const s = await sessionFor(w, ALICE)
    const k0 = w.keys.get(0) as EpochKeys
    const issue = await sealed(
      'issue',
      k0,
      ALICE,
      { number: 9 },
      { title: 'from GitHub', importedAuthor: 'octocat', importedUrl: 'https://github.com/acme/secret/issues/9' },
      { number: 9, imported: { createdAt: 1700000000 } },
      20,
    )
    const a = await privateGate(REPO_REF, s.ctx).admit('issue', issue)
    expect(a.ok).toBe(true)
    if (a.ok) {
      expect(a.doc['imported']).toEqual({ createdAt: 1700000000, author: 'octocat', url: 'https://github.com/acme/secret/issues/9' })
      expect(a.doc['importedAuthor']).toBeUndefined()
      expect(a.doc['importedUrl']).toBeUndefined()
    }
  })

  it('an edit of an imported private document re-seals its provenance (editFields → sealContent)', async () => {
    const w = await world()
    const s = await sessionFor(w, ALICE)
    const k0 = w.keys.get(0) as EpochKeys
    const issue = await sealed(
      'issue',
      k0,
      ALICE,
      { number: 9 },
      { title: 'from GitHub', importedAuthor: 'octocat', importedUrl: 'https://github.com/acme/secret/issues/9' },
      { number: 9, imported: { createdAt: 1700000000 } },
      20,
    )
    const a = await privateGate(REPO_REF, s.ctx).admit('issue', issue)
    if (!a.ok) throw new Error('not admitted')
    const imported = a.doc['imported'] as Record<string, unknown>
    const out = await sealContent(k0, 'issue', ALICE, editFields('issue', { number: 9 }, { title: 'from GitHub' }, { title: 'edited' }, imported))
    const edited = { ...issue, enc: bytesToBase64(out['enc'] as Uint8Array), imported: out['imported'] }
    const b = await privateGate(REPO_REF, s.ctx).admit('issue', edited)
    expect(b.ok).toBe(true)
    if (b.ok) {
      expect(b.doc['title']).toBe('edited')
      expect(b.doc['imported']).toEqual({ createdAt: 1700000000, author: 'octocat', url: 'https://github.com/acme/secret/issues/9' })
    }
  })

  it('an opened config never carries a raw key of another epoch into the plaintext view', async () => {
    const w = await world()
    await rotate(w)
    const s = await sessionFor(w, ALICE)
    const k1 = w.keys.get(1) as EpochKeys
    const cfg = await sealed(
      'config',
      k1,
      ALICE,
      {},
      { defaultBranch: 'main', prevEpoch: 0, prevEpochKey: new Uint8Array(K0), skipEpochKey: new Uint8Array(K0) },
      { backend: { mode: 0 } },
      120,
    )
    const a = await privateGate(REPO_REF, s.ctx).admit('config', cfg)
    expect(a.ok).toBe(true)
    if (a.ok) {
      expect(a.doc['prevEpochKey']).toBeUndefined()
      expect(a.doc['skipEpochKey']).toBeUndefined()
    }
  })
})

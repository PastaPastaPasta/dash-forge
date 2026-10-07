/**
 * Members-only content in a public repo, read per document (DESIGN §4.1, D14, D15; stream 1B):
 * the public gate gives outsiders placeholders, never errors; a member's members-key session
 * opens v0x03 documents beside plaintext ones; a members-key session is not a private session (it
 * leaves the public config and refs unchanged); a sealed review's verdict counts for everyone.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { EpochKeys, sealMembersDoc, type OpenContext, type PrivateDoc } from '../private'
import { readConfig, readConfigBundle } from './config'
import { contentKey, repoKey, type RepoRef } from './contract'
import { readableReviews } from './issues'
import { AUDIENCE_FIELD, HiddenTally, admitAll, admittedAudience, defaultGate, gateFor, hiddenReasonOf, laneGate, placeholderShown } from './private-content'
import { loadPrivateSession, type PrivateSession, type SessionSource } from './private-session'
import { readRefUpdates } from './refs'
import { bytesToBase64, type DocumentQuery } from '../sdk'
import { refNameHash } from './push'

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const REPO = id(0x31)
const ALICE = id(0x41) // owner, maintainer
const BOB = id(0x42) // writer
const EVE = id(0x44) // outsider
const ISSUE = id(0x51)

const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const PUBLIC: RepoRef = { forge: FORGE, repoId: b58(REPO), ownerId: b58(ALICE), name: 'mixed', visibility: 'public' }

const K0 = Uint8Array.from({ length: 32 }, (_, i) => 0x60 + i)
const K_OTHER = Uint8Array.from({ length: 32 }, (_, i) => 0x90 + i)

const ANCHOR0 = id(0x71)

async function ctxWith(raw: Uint8Array | null): Promise<OpenContext> {
  const keys = new Map<number, EpochKeys>()
  if (raw !== null) keys.set(0, await EpochKeys.import(REPO, 0, new Uint8Array(raw)))
  return {
    keys,
    anchors: new Map([[0, { id: ANCHOR0, height: 10, statedHeight: 10 }]]),
    members: { has: (x: Uint8Array) => [ALICE, BOB].some((m) => m.every((b, i) => b === x[i])) },
  }
}

let seq = 0x80
function nextId(): string {
  seq += 1
  return b58(id(seq))
}

/** A members-only comment on ISSUE by `owner`, sealed under `raw` (as the SDK hands it back). */
async function membersComment(owner: Uint8Array, body: string, raw: Uint8Array, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const keys = await EpochKeys.import(REPO, 0, new Uint8Array(raw))
  const doc: PrivateDoc = { type: 'comment', vis: 'public', ownerId: owner, epoch: 0, targetId: ISSUE }
  return {
    $id: nextId(),
    $ownerId: b58(owner),
    $createdAt: 1000 + seq,
    $createdAtBlockHeight: 20,
    repoId: b58(REPO),
    targetId: b58(ISSUE),
    vis: 'public',
    epoch: 0,
    enc: await sealMembersDoc(keys, doc, { body }),
    ...extra,
  }
}

function plainComment(owner: Uint8Array, body: string): Record<string, unknown> {
  return { $id: nextId(), $ownerId: b58(owner), $createdAt: 1000 + seq, repoId: b58(REPO), targetId: b58(ISSUE), vis: 'public', body }
}

/** A well-framed v0x04 letter's bytes (the gate never opens one; it only frames it). */
function letterComment(owner: Uint8Array): Record<string, unknown> {
  const enc = new Uint8Array(66 + 64 + 40)
  enc[0] = 0x04
  enc[1] = 1
  return { $id: nextId(), $ownerId: b58(owner), $createdAt: 1000 + seq, $createdAtBlockHeight: 20, repoId: b58(REPO), targetId: b58(ISSUE), vis: 'public', epoch: 0, enc }
}

describe('an outsider reads a public repo with members-only content', () => {
  it('plaintext passes, members-only and specific-people documents are placeholders, never errors', async () => {
    const plain = plainComment(EVE, 'hello')
    const members = await membersComment(BOB, 'MEMBERS-SECRET', K0, { asMember: b58(BOB) })
    const stranger = await membersComment(EVE, 'junk', K_OTHER)
    const letter = letterComment(EVE)
    // a v0x01 envelope is private-only: malformed in a public repo
    const v01 = { ...members, $id: nextId(), enc: Uint8Array.from([0x01, ...new Uint8Array(60)]) }
    const tally = new HiddenTally()
    const { docs } = await admitAll(defaultGate(PUBLIC), 'comment', [plain, members, stranger, letter, v01], tally)
    expect(docs.map((d) => d['body'])).toEqual(['hello'])
    expect(tally.value).toMatchObject({ membersOnly: 2, letter: 1, notEncrypted: 1 })
    const items = tally.placeholders
    expect(items.map((p) => [p.author, p.asMember, p.audience, p.why])).toEqual([
      [b58(BOB), true, 'members', 'noKey'],
      [b58(EVE), false, 'members', 'noKey'],
      [b58(EVE), false, 'specificPeople', 'letter'],
    ])
    // D14: only the member's (asMember) is shown; a stranger's sealed bytes are counted only
    expect(items.map(placeholderShown)).toEqual([true, false, false])
    // nothing of the sealed text anywhere in what the outsider gets
    expect(JSON.stringify([docs, items])).not.toContain('MEMBERS-SECRET')
  })

  it('a members-only issue is a row ("#N · members-only"): its placeholder keeps the number', async () => {
    const keys = await EpochKeys.import(REPO, 0, new Uint8Array(K0))
    const enc = await sealMembersDoc(keys, { type: 'issue', vis: 'public', ownerId: BOB, epoch: 0, number: 7 }, { title: 'x' })
    const issue = { $id: nextId(), $ownerId: b58(BOB), $createdAt: 5, $createdAtBlockHeight: 20, number: 7, vis: 'public', epoch: 0, enc }
    const a = await defaultGate(PUBLIC).admit('issue', issue)
    expect(a.ok).toBe(false)
    if (a.ok) return
    expect(a.placeholder?.number).toBe(7)
    expect(placeholderShown(a.placeholder!)).toBe(true)
  })
})

describe("a member's members-key session (laneGate)", () => {
  it('opens members-only documents with vis public beside plaintext ones, and marks their audience', async () => {
    const gate = laneGate(PUBLIC, await ctxWith(K0))
    const plain = plainComment(EVE, 'public words')
    const members = await membersComment(BOB, 'members words', K0, { asMember: b58(BOB) })
    const { docs } = await admitAll(gate, 'comment', [plain, members])
    expect(docs.map((d) => d['body'])).toEqual(['public words', 'members words'])
    expect(docs.map(admittedAudience)).toEqual(['public', 'members'])
    expect(docs[1]?.['enc']).toBeUndefined()
    expect(docs[1]?.[AUDIENCE_FIELD]).toBe('members')
  })

  it('files a document made for another key (the commitment fails) as "not encrypted for this repo", as forge-core does', async () => {
    const gate = laneGate(PUBLIC, await ctxWith(K0))
    const tally = new HiddenTally()
    const forged = await membersComment(BOB, 'forged', K_OTHER, { asMember: b58(BOB) })
    await admitAll(gate, 'comment', [forged], tally)
    expect(tally.value.notEncrypted).toBe(1)
    expect(tally.placeholders[0]?.why).toBe('notForThisRepo')
    expect(hiddenReasonOf('commitMismatch')).toBe('notEncrypted')
    expect(hiddenReasonOf('badTag')).toBe('notEncrypted')
    expect(hiddenReasonOf('letter')).toBe('letter')
    expect(hiddenReasonOf('noKey')).toBe('wrongKey')
  })

  it('a member without the epoch key sees placeholders with the wrong-key reason', async () => {
    const gate = laneGate(PUBLIC, await ctxWith(null))
    const tally = new HiddenTally()
    await admitAll(gate, 'comment', [await membersComment(BOB, 'later', K0, { asMember: b58(BOB) })], tally)
    expect(tally.value.wrongKey).toBe(1)
    expect(tally.placeholders[0]?.why).toBe('notReadable')
  })
})

describe('a member removed since reads with the key shares they still hold (DESIGN §12 item 6)', () => {
  it('opens what was written under the epochs they held; later writing is a placeholder', async () => {
    // Their session: the epoch-0 key only (the removal rotated to epoch 1, never shared with them).
    const ctx = await ctxWith(K0)
    const K1 = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i)
    const earlier = await membersComment(BOB, 'written while they were a member', K0, { asMember: b58(BOB) })
    const keys1 = await EpochKeys.import(REPO, 1, new Uint8Array(K1))
    const later = {
      ...(await membersComment(BOB, 'placeholder', K0, { asMember: b58(BOB) })),
      epoch: 1,
      enc: await sealMembersDoc(keys1, { type: 'comment', vis: 'public', ownerId: BOB, epoch: 1, targetId: ISSUE }, { body: 'written after the removal' }),
    }
    const tally = new HiddenTally()
    const { docs } = await admitAll(laneGate(PUBLIC, ctx), 'comment', [earlier, later], tally)
    expect(docs.map((d) => d['body'])).toEqual(['written while they were a member'])
    expect(tally.placeholders).toHaveLength(1)
    expect(JSON.stringify(tally.placeholders)).not.toContain('written after the removal')
  })
})

// ---------------------------------------------------------------------------
// A members-key session is not a private session
// ---------------------------------------------------------------------------

/** A Drive-shaped mock SDK over typed rows (only `==` and orderBy by `$createdAt`; as in private-session.test.ts). */
function fakeSdk(rows: Record<string, Record<string, unknown>[]>): EvoSDK {
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

describe("a member's members-key session leaves the public config, branches and packs unchanged (DESIGN §4.1 acceptance)", () => {
  const plainConfig = { $id: b58(id(0xa1)), $ownerId: b58(ALICE), $createdAt: 100, repoId: b58(REPO), vis: 'public', defaultBranch: 'trunk', protectedPatterns: ['refs/heads/trunk'], backend: { mode: 0 } }
  // the members-key anchor: a sealed config, newer than every plaintext one
  const anchor = { $id: b58(ANCHOR0), $ownerId: b58(ALICE), $createdAt: 200, $createdAtBlockHeight: 10, repoId: b58(REPO), vis: 'public', epoch: 0, enc: Uint8Array.from([0x02, ...new Uint8Array(84)]) }

  async function laneSession(): Promise<PrivateSession> {
    const source: SessionSource = {
      memberships: async () => [
        { identity: b58(ALICE), role: 'maintainer', createdAt: 1 },
        { identity: b58(BOB), role: 'reader', createdAt: 2 },
      ],
      configs: async () => [plainConfig, anchor],
      repoKeys: async () => [],
      identityKeys: async () => [],
    }
    return loadPrivateSession({ repo: PUBLIC, network: 'devnet', reader: b58(BOB), source, unwrapper: null })
  }

  it('the session carries no settings of its own, and its gate is the public repo’s', async () => {
    const s = await laneSession()
    expect(s.config).toBeNull()
    expect(s.configHistory).toEqual([])
    expect(s.gate.visibility).toBe('public')
    s.close()
  })

  it('readConfig, readConfigBundle and readRefUpdates read the same with and without the session', async () => {
    const s = await laneSession()
    const main = 'refs/heads/trunk'
    const ref = {
      $id: b58(id(0xb1)),
      $ownerId: b58(ALICE),
      $createdAt: 150,
      repoId: b58(REPO),
      vis: 'public',
      refName: main,
      refNameHash: bytesToBase64(refNameHash(main)),
      newOid: bytesToBase64(new Uint8Array(20).fill(7)),
    }
    const sdk = fakeSdk({ config: [plainConfig, anchor], refUpdate: [ref], protectedRefUpdate: [] })
    const withLane: RepoRef = { ...PUBLIC, lane: s }
    expect(gateFor(withLane)).toBe(s.gate)
    expect(await readConfig(sdk, withLane)).toEqual(await readConfig(sdk, PUBLIC))
    expect((await readConfig(sdk, withLane))?.defaultBranch).toBe('trunk')
    expect(await readConfigBundle(sdk, withLane)).toEqual(await readConfigBundle(sdk, PUBLIC))
    const key = bytesToBase64(refNameHash(main))
    const plainRefs = await readRefUpdates(sdk, PUBLIC, key)
    expect(plainRefs).toHaveLength(1)
    expect(await readRefUpdates(sdk, withLane, key)).toEqual(plainRefs)
    // the git plane's cache identity is unchanged; only discussion caches follow the session
    expect(repoKey(withLane)).toBe(repoKey(PUBLIC))
    expect(contentKey(withLane)).toBe(`${PUBLIC.repoId}#${s.id}`)
    s.close()
  })
})

// ---------------------------------------------------------------------------
// D15
// ---------------------------------------------------------------------------

describe('D15: a members-only review counts for every reader', () => {
  async function sealedReview(owner: Uint8Array, verdict: number, asMember: boolean): Promise<Record<string, unknown>> {
    const keys = await EpochKeys.import(REPO, 0, new Uint8Array(K0))
    const enc = await sealMembersDoc(keys, { type: 'review', vis: 'public', ownerId: owner, epoch: 0, patchId: ISSUE }, { body: 'LGTM' })
    return {
      $id: nextId(),
      $ownerId: b58(owner),
      $createdAt: 1000 + seq,
      $createdAtBlockHeight: 20,
      patchId: b58(ISSUE),
      verdict,
      commitOid: new Uint8Array(20).fill(9),
      vis: 'public',
      epoch: 0,
      enc,
      ...(asMember ? { asMember: b58(owner) } : {}),
    }
  }

  it('an outsider counts an asMember verdict without its text; a stranger’s sealed verdict is not counted', async () => {
    const member = await sealedReview(BOB, 1, true)
    const stranger = await sealedReview(EVE, 1, false)
    const out = await readableReviews(defaultGate(PUBLIC), 'public', [member, stranger])
    expect(out.shown).toEqual([])
    expect(out.counted.map((r) => [r.reviewer, r.verdict, r.body, r.membersOnly])).toEqual([[b58(BOB), 'approve', '', true]])
  })

  it('a member opens the same review and counts the same verdict', async () => {
    const member = await sealedReview(BOB, 1, true)
    const out = await readableReviews(laneGate(PUBLIC, await ctxWith(K0)), 'public', [member])
    expect(out.shown.map((r) => r.body)).toEqual(['LGTM'])
    expect(out.counted.map((r) => r.reviewer)).toEqual([b58(BOB)])
  })

  it('a private repo never counts a review its reader cannot open (§8.1)', async () => {
    const member = await sealedReview(BOB, 1, true)
    const out = await readableReviews(defaultGate({ ...PUBLIC, visibility: 'private' }), 'private', [member])
    expect(out.counted).toEqual([])
  })
})

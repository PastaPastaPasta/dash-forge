/**
 * Reading messages to specific people (DESIGN §4.2 reader rule; stream 2A): a recipient's letter
 * reader opens them with the document owner's keys only, beside plaintext and members-only
 * documents; anyone else (and a tab that must unlock first) gets a placeholder that says how many
 * people it went to, never an error.
 */

import { getPublicKey } from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { EncKeyLike } from '../auth/encryption-key'
import { sealLetter, type LetterRecipient, type PrivateDoc } from '../private'
import { contentKey, type RepoRef } from './contract'
import { AUDIENCE_FIELD, HiddenTally, LETTER_GROUP, LETTER_TO, admitAll, admittedLetter, defaultGate, gateFor, placeholderShown, viewAudience } from './private-content'
import { letterSession, lettersGate } from './letter-session'
import type { LetterGroup } from '../rules/letters'

const id = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (u: Uint8Array): string => base58Encode(u)
const secret = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const REPO = id(0x31)
const ISSUE = id(0x51)
const ALICE = id(0x41)
const BOB = id(0x42)
const CAROL = id(0x43)
const S = { alice: secret(0x11), bob: secret(0x12), carol: secret(0x13) }

const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const PUBLIC: RepoRef = { forge: FORGE, repoId: b58(REPO), ownerId: b58(ALICE), name: 'mixed', visibility: 'public' }
const PRIVATE: RepoRef = { ...PUBLIC, visibility: 'private' }

const party = (who: Uint8Array, s: Uint8Array): LetterRecipient => ({ identityId: who, publicKey: getPublicKey(s, true) })
const encKey = (s: Uint8Array, keyId = 4): EncKeyLike => ({ keyId, purposeNumber: 1, keyTypeNumber: 0, data: bytesToHex(getPublicKey(s, true)) })

let seq = 0x80
/** A letter comment by `owner` (secret `s`) to `to`, as the SDK hands it back. */
async function letterComment(owner: Uint8Array, s: Uint8Array, to: readonly LetterRecipient[], body: string, vis: 'public' | 'private' = 'public', group: LetterGroup | null = null): Promise<Record<string, unknown>> {
  seq += 1
  const doc: PrivateDoc = { type: 'comment', vis, ownerId: owner, epoch: 0, targetId: ISSUE }
  return {
    $id: b58(id(seq)),
    $ownerId: b58(owner),
    $createdAt: 1000 + seq,
    $createdAtBlockHeight: 20,
    repoId: b58(REPO),
    targetId: b58(ISSUE),
    vis,
    epoch: 0,
    enc: await sealLetter(REPO, s, 4, doc, { body }, [party(owner, s), ...to], group),
    asMember: b58(owner),
  }
}

/** A letter reader for `who` (secret `s`), counting the identity reads it makes. */
function readerFor(who: Uint8Array, s: Uint8Array, opts: { locked?: boolean } = {}) {
  const identityKeys = vi.fn(async (ident: string): Promise<EncKeyLike[] | null> => {
    const known: Record<string, Uint8Array> = { [b58(ALICE)]: S.alice, [b58(BOB)]: S.bob, [b58(CAROL)]: S.carol }
    const k = known[ident]
    return k === undefined ? null : [encKey(k)]
  })
  const session = letterSession({ reader: b58(who), locked: opts.locked === true, source: { identityKeys, withReader: (use) => use({ identityId: who, secrets: [s] }) } })
  return { session, identityKeys }
}

describe('a recipient reads a message to specific people', () => {
  it('opens it with who it went to and its group, beside plaintext, in a public repo', async () => {
    const letter = await letterComment(ALICE, S.alice, [party(BOB, S.bob)], 'for alice and bob', 'public', 'maintainers')
    const plain = { $id: b58(id(0x99)), $ownerId: b58(CAROL), $createdAt: 5, repoId: b58(REPO), targetId: b58(ISSUE), vis: 'public', body: 'hello' }
    const { session, identityKeys } = readerFor(BOB, S.bob)
    const repo: RepoRef = { ...PUBLIC, letters: session }
    const { docs, hidden } = await admitAll(gateFor(repo), 'comment', [plain, letter, letter])
    expect(hidden.total).toBe(0)
    expect(docs[0]?.['body']).toBe('hello')
    const opened = docs[1] as Record<string, unknown>
    expect(opened['body']).toBe('for alice and bob')
    expect(opened['enc']).toBeUndefined()
    expect(opened[AUDIENCE_FIELD]).toBe('specificPeople')
    expect(opened[LETTER_TO]).toEqual([b58(ALICE), b58(BOB)])
    expect(opened[LETTER_GROUP]).toBe('maintainers')
    expect(admittedLetter(opened)).toEqual({ recipients: [b58(ALICE), b58(BOB)], group: 'maintainers' })
    expect(viewAudience(opened)).toEqual({ audience: 'specificPeople', letter: { recipients: [b58(ALICE), b58(BOB)], group: 'maintainers' } })
    // the owner's keys are read once for the session
    expect(identityKeys).toHaveBeenCalledTimes(1)
    expect(identityKeys).toHaveBeenCalledWith(b58(ALICE))
    // the content caches key by the letter reader too
    expect(contentKey(repo)).toBe(`${b58(REPO)}#${session.id}`)
  })

  it('opens one in a private repo through the same reader', async () => {
    const letter = await letterComment(ALICE, S.alice, [party(BOB, S.bob)], 'private letter', 'private')
    const { session } = readerFor(BOB, S.bob)
    const { docs } = await admitAll(gateFor({ ...PRIVATE, letters: session }), 'comment', [letter])
    expect(docs[0]?.['body']).toBe('private letter')
  })

  it('takes the sender key from the document owner only: a letter relabelled to another owner does not open', async () => {
    const letter = await letterComment(ALICE, S.alice, [party(BOB, S.bob)], 'x')
    const { session } = readerFor(BOB, S.bob)
    const relabelled = { ...letter, $ownerId: b58(CAROL), asMember: b58(CAROL) }
    const tally = new HiddenTally()
    const { docs } = await admitAll(gateFor({ ...PUBLIC, letters: session }), 'comment', [relabelled], tally)
    expect(docs).toEqual([])
    expect(tally.value.notEncrypted + tally.value.letter).toBe(1)
  })
})

describe('anyone else sees how many people it went to (D14)', () => {
  it('a non-recipient: a placeholder with the recipient count, never the text', async () => {
    const letter = await letterComment(ALICE, S.alice, [party(BOB, S.bob)], 'not for carol')
    const { session } = readerFor(CAROL, S.carol)
    const tally = new HiddenTally()
    const { docs } = await admitAll(gateFor({ ...PUBLIC, letters: session }), 'comment', [letter], tally)
    expect(docs).toEqual([])
    expect(tally.value.letter).toBe(1)
    const [p] = tally.placeholders
    expect(p).toMatchObject({ type: 'comment', audience: 'specificPeople', why: 'letter', recipientCount: 2, asMember: true })
    expect(p?.locked).toBeUndefined()
    expect(placeholderShown(p!)).toBe(true)
    expect(JSON.stringify(tally.placeholders)).not.toContain('not for carol')
  })

  it('an anonymous visitor: the same placeholder, through the public gate', async () => {
    const letter = await letterComment(ALICE, S.alice, [party(BOB, S.bob), party(CAROL, S.carol)], 'x')
    const tally = new HiddenTally()
    await admitAll(defaultGate(PUBLIC), 'comment', [letter], tally)
    expect(tally.placeholders[0]).toMatchObject({ audience: 'specificPeople', recipientCount: 3 })
  })

  it("a tab that must unlock first: a placeholder that says so, and nothing is opened", async () => {
    const letter = await letterComment(ALICE, S.alice, [party(BOB, S.bob)], 'x')
    const { session, identityKeys } = readerFor(BOB, S.bob, { locked: true })
    const tally = new HiddenTally()
    await admitAll(gateFor({ ...PUBLIC, letters: session }), 'comment', [letter], tally)
    expect(tally.placeholders[0]).toMatchObject({ audience: 'specificPeople', locked: true, recipientCount: 2 })
    expect(identityKeys).not.toHaveBeenCalled()
  })

  it('an owner whose keys cannot be read now: a placeholder, never an error', async () => {
    const letter = await letterComment(ALICE, S.alice, [party(BOB, S.bob)], 'x')
    const gate = lettersGate(PUBLIC, defaultGate(PUBLIC), { open: async () => Promise.reject(new Error('network down')) })
    const a = await gate.admit('comment', letter)
    expect(a).toMatchObject({ ok: false, reason: 'letter', placeholder: { recipientCount: 2 } })
  })

  it('never opens anything but content: an event sealed so goes to the inner gate', async () => {
    const letter = await letterComment(ALICE, S.alice, [party(BOB, S.bob)], 'label value')
    const { session, identityKeys } = readerFor(BOB, S.bob)
    const a = await gateFor({ ...PUBLIC, letters: session }).admit('event', { ...letter, value: undefined })
    expect(a.ok).toBe(false)
    expect(identityKeys).not.toHaveBeenCalled()
  })

  it('a closed reader opens nothing more', async () => {
    const letter = await letterComment(ALICE, S.alice, [party(BOB, S.bob)], 'x')
    const { session } = readerFor(BOB, S.bob)
    session.close()
    expect(session.closed).toBe(true)
    const tally = new HiddenTally()
    await admitAll(gateFor({ ...PUBLIC, letters: session }), 'comment', [letter], tally)
    expect(tally.placeholders[0]).toMatchObject({ locked: true })
  })
})

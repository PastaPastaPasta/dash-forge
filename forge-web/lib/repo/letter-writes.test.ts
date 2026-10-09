/**
 * Writing to specific people (DESIGN §4.2, D20, D26; stream 2A): who a message goes to is planned
 * when it is posted, from the member documents and each person's keys now; the document is a
 * v0x04 envelope every recipient (and nobody else) opens, with its role group; an edit re-seals
 * to the same people; refusals come before anything is signed, worded for the composer.
 */

import { getPublicKey } from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it } from 'vitest'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { ownerKeysOf, type EncKeyLike } from '../auth/encryption-key'
import { lockVault, storeEncryptionKey, storeInVault } from '../auth/vault'
import { encodeWif } from '../auth/wif'
import { resetMemoryStores } from '../idb'
import { openLetter, type StoredPrivateDoc } from '../private'
import type { Membership } from '../rules/v2'
import type { WriteAuth } from '../sdk'
import { NO_LETTER_ASK } from '../view/audience'
import type { RepoRef } from './contract'
import { editLetterWriter, letterContentKey, letterWriter, planInput, previewLetter, sealLetterContent, sealLetterEdit, type LetterReads, type LetterThread } from './letter-writes'

const ME = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const ME_SECRET = new Uint8Array(32).fill(0x21)
const PASS = 'correct horse battery'
const id = (b: number): string => base58Encode(new Uint8Array(32).fill(b))
const OWNER = id(0x40)
const ALICE = id(0x41)
const BOB = id(0x42)
const CAROL = id(0x43)
const DANA = id(0x44) // no encryption key
const FRANK = id(0x46) // a stranger
const secrets: Record<string, Uint8Array> = {
  [ME]: ME_SECRET,
  [OWNER]: new Uint8Array(32).fill(0x30),
  [ALICE]: new Uint8Array(32).fill(0x31),
  [BOB]: new Uint8Array(32).fill(0x32),
  [CAROL]: new Uint8Array(32).fill(0x33),
  [FRANK]: new Uint8Array(32).fill(0x36),
}
const REPO_ID = id(0x10)
const REPO: RepoRef = { forge: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'G' }, repoId: REPO_ID, ownerId: OWNER, name: 'demo', visibility: 'public' }
const m = (identity: string, role: Membership['role']): Membership => ({ identity, role, createdAt: 0 })
const MEMBERS: Membership[] = [m(ALICE, 'maintainer'), m(BOB, 'writer'), m(CAROL, 'reader'), m(DANA, 'maintainer'), m(ME, 'writer')]
const auth: WriteAuth = { identityId: ME, network: 'devnet', getSigningKeyWif: () => '' } as unknown as WriteAuth

const encKey = (s: Uint8Array, keyId = 4): EncKeyLike => ({ keyId, purposeNumber: 1, keyTypeNumber: 0, data: bytesToHex(getPublicKey(s, true)) })
function reads(members: readonly Membership[] = MEMBERS, over: Record<string, EncKeyLike[] | null> = {}): LetterReads {
  return {
    memberships: async () => members,
    identityKeys: async (who) => (who in over ? (over[who] ?? null) : secrets[who] === undefined ? [] : [encKey(secrets[who]!)]),
    heldKeyIds: async () => [4],
  }
}
const NO_THREAD: LetterThread = { parents: [], membersOnlyParent: false }
const TARGET = new Uint8Array(32).fill(0x55)

/** Open the sealed comment `data` as `who`: what it says and who it went to, or why not. */
async function openAs(who: string, data: Record<string, unknown>) {
  const doc: StoredPrivateDoc = { type: 'comment', vis: 'public', ownerId: decodeIdentifier(ME), epoch: 0, targetId: TARGET, enc: data['enc'] as Uint8Array }
  const owner = ownerKeysOf([encKey(ME_SECRET)])
  const s = secrets[who]
  return openLetter(decodeIdentifier(REPO_ID), doc, owner, { identityId: decodeIdentifier(who), secrets: s === undefined ? [] : [s] })
}

describe('who a message goes to, as the composer shows it', () => {
  const preview = (ask = NO_LETTER_ASK, thread = NO_THREAD, keyless: string[] = [DANA], members = MEMBERS) =>
    previewLetter({ owner: OWNER, viewer: ME, members, keyless: new Set(keyless), ask, thread })

  it('sizes the role groups as they are now, the owner included, and leaves out who has no key', () => {
    const p = preview({ group: 'maintainers', people: [], exact: null })
    expect(p.recipients).toEqual([ME, ...[OWNER, ALICE].sort()])
    expect(p.skipped).toEqual([DANA])
    expect(p.group).toBe('maintainers')
    // the group as it is now, the owner included (dana too: she is a maintainer, without a key)
    expect(p.groups.maintainers).toEqual({ count: 3, tooMany: false })
    // writers and maintainers: the owner, alice, dana, bob and the writer themself (never the reader)
    expect(p.groups.writers).toEqual({ count: 5, tooMany: false })
  })

  it('refuses a group over 16 (the picker disables it with its size)', () => {
    const many = Array.from({ length: 20 }, (_, i) => m(id(0x60 + i), 'writer'))
    const p = preview({ group: 'writers', people: [], exact: null }, NO_THREAD, [], many)
    expect(p.refusal).toEqual({ error: 'tooMany', count: 22 })
    expect(p.groups.writers).toEqual({ count: 21, tooMany: true })
    expect(p.groups.maintainers.tooMany).toBe(false)
  })

  it('refuses nobody named, and someone named who has no key', () => {
    expect(preview().refusal).toEqual({ error: 'noRecipients' })
    expect(preview({ group: null, people: [DANA], exact: null }).refusal).toEqual({ error: 'noEncryptionKey', people: [DANA] })
    expect(preview({ group: null, people: [FRANK], exact: null }).recipients).toEqual([ME, FRANK])
  })

  it('names only members under a members-only parent', () => {
    expect(preview({ group: null, people: [FRANK], exact: null }, { parents: [], membersOnlyParent: true }).refusal).toEqual({ error: 'notMembers', people: [FRANK] })
  })

  it('re-lists a thread, says who reads from this reply on, and refuses leaving someone out', () => {
    const thread: LetterThread = { parents: [{ recipients: [ALICE, ME, BOB], group: null }], membersOnlyParent: false }
    const relisted = preview(NO_LETTER_ASK, thread)
    expect(relisted.recipients).toEqual([ME, ...[ALICE, BOB].sort()])
    expect(relisted.relisted).toEqual([ALICE, BOB].sort())
    expect(relisted.widened).toEqual([])
    const wider = preview({ group: null, people: [], exact: [ALICE, BOB, FRANK] }, thread)
    expect(wider.widened).toEqual([FRANK])
    const narrower = preview({ group: null, people: [], exact: [ALICE] }, thread)
    expect(narrower.refusal).toEqual({ error: 'narrower', people: [BOB] })
  })

  it('re-lists a group parent as the group is now', () => {
    const thread: LetterThread = { parents: [{ recipients: [ALICE, OWNER], group: 'maintainers' }], membersOnlyParent: false }
    const p = preview(NO_LETTER_ASK, thread, [DANA])
    // everyone but the writer is in the group now: it is still sent to the group
    expect(p.group).toBe('maintainers')
    expect(new Set(p.recipients)).toEqual(new Set([ME, ALICE, OWNER]))
    expect(planInput(NO_LETTER_ASK)).toEqual({ request: null, exact: null })
  })
})

describe('writing a message to specific people', () => {
  beforeEach(async () => {
    resetMemoryStores()
    lockVault()
    await storeInVault('devnet', { identityId: ME, keyId: 5, wif: encodeWif(new Uint8Array(32).fill(7), 'devnet') }, { passphrase: PASS })
    await storeEncryptionKey('devnet', ME, 4, new Uint8Array(ME_SECRET))
  }, 30_000)

  it('seals a v0x04 comment every recipient opens, with its group, and nobody else does', async () => {
    const writer = await letterWriter(auth, REPO, { group: 'maintainers', people: [], exact: null }, NO_THREAD, reads())
    expect(writer.recipients).toEqual([ME, ...[OWNER, ALICE].sort()])
    expect(writer.skipped).toEqual([DANA])
    expect(writer.group).toBe('maintainers')
    const data = await sealLetterContent(auth, REPO, 'comment', { targetId: TARGET, body: 'for the maintainers' }, writer)
    const enc = data['enc'] as Uint8Array
    expect(enc[0]).toBe(0x04)
    expect(enc[1]).toBe(3)
    expect(data['epoch']).toBe(0)
    expect(data['body']).toBeUndefined()
    // a member's write carries its proof (D14)
    expect(base58Encode(data['asMember'] as Uint8Array)).toBe(ME)
    for (const who of [ME, OWNER, ALICE]) {
      const opened = await openAs(who, data)
      expect(opened).toMatchObject({ status: 'readable', fields: { body: 'for the maintainers' }, group: 'maintainers' })
      if (opened.status === 'readable') expect(opened.recipients.map((r) => base58Encode(r))).toEqual(writer.recipients)
    }
    expect(await openAs(BOB, data)).toEqual({ status: 'unreadable', reason: 'notARecipient' })
  })

  it("a stranger's message carries no membership proof", async () => {
    const writer = await letterWriter(auth, REPO, { group: null, people: [FRANK], exact: null }, NO_THREAD, reads(MEMBERS.filter((x) => x.identity !== ME)))
    expect(writer.isMember).toBe(false)
    const data = await sealLetterContent(auth, REPO, 'comment', { targetId: TARGET, body: 'hi frank' }, writer)
    expect(data['asMember']).toBeUndefined()
    expect(await openAs(FRANK, data)).toMatchObject({ status: 'readable', group: null })
  })

  it('refuses before signing, in the composer’s words', async () => {
    await expect(letterWriter(auth, REPO, { group: null, people: [DANA], exact: null }, NO_THREAD, reads())).rejects.toThrow(/can't receive members-only messages yet/)
    await expect(letterWriter(auth, REPO, NO_LETTER_ASK, NO_THREAD, reads())).rejects.toThrow('Choose who to send it to.')
    const many = Array.from({ length: 20 }, (_, i) => m(id(0x60 + i), 'writer'))
    const keys = Object.fromEntries(many.map((x, i) => [x.identity, [encKey(new Uint8Array(32).fill(0x80 + i))]]))
    await expect(letterWriter(auth, REPO, { group: 'writers', people: [], exact: null }, NO_THREAD, reads(many, keys))).rejects.toThrow(
      'Writers and maintainers is 22 people. A message can go to at most 16. Choose All members or pick people.',
    )
    // no usable key of the writer's own in this browser
    await expect(letterWriter(auth, REPO, { group: null, people: [ALICE], exact: null }, NO_THREAD, { ...reads(), heldKeyIds: async () => [9] })).rejects.toThrow(/encryption key/)
    // a thread's people can't be left out
    const thread: LetterThread = { parents: [{ recipients: [ALICE, ME, BOB], group: null }], membersOnlyParent: false }
    await expect(letterWriter(auth, REPO, { group: null, people: [], exact: [ALICE] }, thread, reads())).rejects.toThrow(/Replies can't leave out people who could read earlier messages: @/)
  })

  it('refuses text too long for its people, and a pull request or an event value', async () => {
    const writer = await letterWriter(auth, REPO, { group: null, people: [ALICE], exact: null }, NO_THREAD, reads())
    await expect(sealLetterContent(auth, REPO, 'comment', { targetId: TARGET, body: 'x'.repeat(5000) }, writer)).rejects.toThrow('This message is too long to send to 2 people: shorten it or send it to fewer people.')
    await expect(sealLetterContent(auth, REPO, 'event', { targetId: TARGET, value: 'bug' }, writer)).rejects.toThrow("Labels, milestones and assignees can't be set on a message to specific people yet.")
    await expect(sealLetterContent(auth, REPO, 'patch', { title: 'x' }, writer)).rejects.toThrow(/can't be sent to specific people yet/)
  })

  it("keys a retry by its action, never by the text: the same action's retry finds its attempt", async () => {
    const writer = await letterWriter(auth, REPO, { group: null, people: [ALICE], exact: null }, NO_THREAD, reads())
    const a = await letterContentKey(writer, 'said', 'intent-1')
    expect(await letterContentKey({ ...writer }, 'said', 'intent-1')).toBe(a)
    expect(await letterContentKey(writer, 'said', 'intent-2')).not.toBe(a)
    expect(await letterContentKey(writer, 'other', 'intent-1')).not.toBe(a)
    expect(await letterContentKey({ ...writer, recipients: [ME] }, 'said', 'intent-1')).not.toBe(a)
    expect(a).not.toContain('said')
  })

  it('an edit re-seals to the same people and group, and is refused when one of them has no key now', async () => {
    const letter = { recipients: [ME, ALICE, OWNER], group: 'maintainers' as const }
    const writer = await editLetterWriter(auth, REPO, letter, reads())
    const edited = await sealLetterEdit(auth, REPO, 'comment', { targetId: TARGET }, { body: 'old' }, { body: 'new' }, writer)
    expect(Object.keys(edited).sort()).toEqual(['asMember', 'enc', 'epoch'])
    expect(await openAs(ALICE, edited)).toMatchObject({ status: 'readable', fields: { body: 'new' }, group: 'maintainers' })
    await expect(editLetterWriter(auth, REPO, letter, reads(MEMBERS, { [ALICE]: [] }))).rejects.toThrow(/can't receive it any more, so this message can't be edited/)
    await expect(editLetterWriter(auth, REPO, { recipients: [ALICE, ME], group: null }, reads())).rejects.toThrow(/Only its author/)
  })
})

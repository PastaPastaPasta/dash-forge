/**
 * The signed-in reader's letter reader (DESIGN §4.2, `docs/security/private-repos.md` §4.1): what
 * opens the issues, comments and reviews written to specific people (`enc` v0x04) that name this
 * reader, in a public or a private repo, member or not (a stranger can be a recipient).
 *
 * Reader rule, unweakened: a letter opens with `openLetter` against the identity keys of **that
 * document's** `$ownerId` (read once per owner for the session; the sender key comes from nowhere
 * else) and every encryption key this browser holds for the reader (`withLetterReader`). A tab
 * that must unlock first keeps every letter a placeholder that says so, never an error. An opened
 * letter comes back as plaintext, like an opened members-only document, with who it went to
 * (`LETTER_TO`, `LETTER_GROUP`).
 *
 * One reader per (network, identity, unlocked or not) in this tab, ended with every private
 * session (lock, key change, sign-out: `closePrivateSessions`); nothing it opens is kept beyond
 * the page caches keyed by its id.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { encryptionKeyState, fetchIdentityKeys, ownerKeysOf, withLetterReader, type EncKeyLike } from '../auth/encryption-key'
import { VaultLockedError } from '../auth/vault'
import type { Network } from '../constants'
import { bytesToHex, openLetter, randomBytes, type LetterOpenResult, type LetterReader, type OwnerKey, type PrivateDocType, type StoredPrivateDoc } from '../private'
import type { PlainDocument } from '../sdk'
import type { RepoRef } from './contract'
import { noteMembersKey } from './members-key-cache'
import { noteOpenedDoc } from './members-texts'
import {
  AUDIENCE_FIELD,
  LETTER_GROUP,
  LETTER_TO,
  asPlaintext,
  docAudience,
  storedPrivateDoc,
  unopened,
  wellFormedAs,
  type Admission,
  type ContentGate,
  type LetterReading,
} from './private-content'
import { trackReaderSession } from './private-session'

/** What a letter reader reads with: owners' identity keys, and the reader's held keys. */
export interface LetterSource {
  /** An identity's public keys, or null when it does not exist. */
  identityKeys(identityId: string): Promise<readonly EncKeyLike[] | null>
  /** Run `use` with every encryption key this browser holds for the reader (throws when locked). */
  withReader<T>(use: (reader: LetterReader) => Promise<T>): Promise<T>
}

/** A reader's letter reader ({@link LetterReading} for `RepoRef.letters`). */
export interface LetterSession extends LetterReading {
  /** The reader, base58. */
  readonly reader: string
  /** This tab must unlock before it can open any letter. */
  readonly locked: boolean
  readonly closed: boolean
  /** Open one stored letter of `repoId`; `'locked'` when this tab can't open letters now. */
  open(repoId: Uint8Array, doc: StoredPrivateDoc): Promise<LetterOpenResult | 'locked'>
  close(): void
}

/** The sender key id a letter names (`enc[2..6]`), or null when `enc` is too short. */
function senderKeyIdOf(enc: Uint8Array): number | null {
  return enc.length < 6 ? null : new DataView(enc.buffer, enc.byteOffset).getUint32(2)
}

/** A reader over `source` for `reader` (`locked`: this tab holds the key but must unlock first). */
export function letterSession(input: { readonly reader: string; readonly locked: boolean; readonly source: LetterSource }): LetterSession {
  const { reader, locked, source } = input
  const id = bytesToHex(randomBytes(12))
  let closed = false
  // Owners' keys by identity, read once each (again when a letter names a key they did not have).
  const owners = new Map<string, Promise<readonly OwnerKey[] | null>>()
  const ownerKeys = async (ownerId: string, keyId: number | null): Promise<readonly OwnerKey[] | null> => {
    let hit = owners.get(ownerId)
    if (hit !== undefined) {
      const keys = await hit.catch(() => null)
      if (keys !== null && (keyId === null || keys.some((k) => k.id === keyId))) return keys
    }
    hit = source.identityKeys(ownerId).then((keys) => (keys === null ? null : ownerKeysOf(keys)))
    owners.set(ownerId, hit)
    hit.catch(() => {
      if (owners.get(ownerId) === hit) owners.delete(ownerId)
    })
    return hit
  }
  const open = async (repoId: Uint8Array, doc: StoredPrivateDoc): Promise<LetterOpenResult | 'locked'> => {
    if (closed || locked) return 'locked'
    const keys = await ownerKeys(base58Encode(doc.ownerId), senderKeyIdOf(doc.enc))
    if (keys === null) return { status: 'malformed' }
    try {
      return await source.withReader((r) => openLetter(repoId, doc, keys, r))
    } catch (e) {
      if (e instanceof VaultLockedError) return 'locked'
      throw e
    }
  }
  const close = trackReaderSession(id, () => {
    closed = true
    owners.clear()
  })
  const session: LetterSession = {
    id,
    reader,
    locked,
    get closed() {
      return closed
    },
    open,
    close,
    gate: (repo, inner) => lettersGate(repo, inner, session),
  }
  return session
}

/** The document types a message to specific people is (a PR's are read too, though only phase 3 writes them). */
const LETTER_CONTENT: ReadonlySet<PrivateDocType> = new Set(['issue', 'patch', 'comment', 'review'])

/**
 * `inner` with the specific-people documents opened by `session`: one that names this reader
 * comes back as plaintext with {@link AUDIENCE_FIELD} `specificPeople` and who it went to; one
 * that does not (or that this tab can't open yet) is its placeholder, with its recipient count.
 * Everything else goes to `inner` unchanged.
 */
export function lettersGate(repo: RepoRef, inner: ContentGate, session: Pick<LetterSession, 'open'>): ContentGate {
  return {
    visibility: inner.visibility,
    async admit(type, doc): Promise<Admission> {
      // Only content is written to specific people; anything else sealed so (an event's value)
      // goes to the inner gate, which never opens it: every reader's folds stay the same.
      if (docAudience(doc) !== 'specificPeople' || !LETTER_CONTENT.has(type)) return inner.admit(type, doc)
      if (!wellFormedAs(repo, type, doc)) return { ok: false, reason: 'notEncrypted' }
      // Sealed content here: a public repo's writes check their parents from now on.
      if (repo.visibility === 'public') noteMembersKey(repo.repoId)
      const stored = storedPrivateDoc(type, doc, repo.visibility)
      if (stored === null) return { ok: false, reason: 'notEncrypted' }
      let opened: LetterOpenResult | 'locked'
      try {
        opened = await session.open(decodeIdentifier(repo.repoId), stored)
      } catch {
        // An owner whose keys can't be read now: shown as a letter this reader can't open.
        return unopened(type, doc, 'letter', 'letter')
      }
      if (opened === 'locked') return unopened(type, doc, 'letter', 'letter', true)
      if (opened.status === 'malformed') return { ok: false, reason: 'notEncrypted' }
      if (opened.status !== 'readable') return unopened(type, doc, 'letter', 'letter')
      const out: PlainDocument = asPlaintext(doc, opened.fields)
      out[AUDIENCE_FIELD] = 'specificPeople'
      out[LETTER_TO] = opened.recipients.map((r) => base58Encode(r))
      out[LETTER_GROUP] = opened.group
      noteOpenedDoc(repo, out)
      return { ok: true, doc: out }
    },
  }
}

/** This tab's letter readers, by (network, identity, locked). */
const sessions = new Map<string, LetterSession>()

/**
 * The letter reader of (network, identity) in this tab, or null when this browser holds no
 * encryption key for it. One per lock state: unlocking makes a new one, so the pages read again.
 */
export async function letterSessionFor(sdk: EvoSDK, network: Network, identity: string): Promise<LetterSession | null> {
  const state = await encryptionKeyState(network, identity)
  if (state === 'none') return null
  const key = `${network}:${identity}:${state}`
  const hit = sessions.get(key)
  if (hit !== undefined && !hit.closed) return hit
  const session = letterSession({
    reader: identity,
    locked: state === 'locked',
    source: {
      identityKeys: (id) => fetchIdentityKeys(sdk, id),
      withReader: (use) => withLetterReader(network, identity, use),
    },
  })
  sessions.set(key, session)
  return session
}

/**
 * Members-only writes in a public repo (DESIGN §3.3, §4.1; `private-repos.md` §17; parity:
 * forge-core `Collab::audience_for` / `child_audience` / `seal_for` / `members_writer`).
 *
 * - **Who a new document is for** is decided before anything is signed: what the writer asked
 *   for, else its parent's (an event's value follows its target; a comment or review is under the
 *   narrowest of its target, the comment it replies to and that thread's root). A public child of
 *   a members-only parent is refused. Every parent is read from the stored document, never from
 *   the repo: one that cannot be read is an error, never "public".
 * - **Members-only content** is sealed as `enc` v0x03 under the members key's current write
 *   epoch, read fresh for the action (§5.3), with `vis: "public"` and the padding of `pads`.
 *   Only a member who holds the key writes it, and the write carries `asMember` (D14).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { encryptionOps } from '../auth/encryption-key'
import { EpochKeys, MalformedError, TooLargeError, bytesToHex, refNameHash, sealMembersDoc, type PrivateDocType } from '../private'
import { fitsUnder, narrower, type Audience } from '../rules/v2'
import { queryAllDocuments, queryDocumentsWithProof, type PlainDocument, type WriteAuth } from '../sdk'
import { retryWhileMissing } from '../view/retry'
import { DOC, asIdentifierString, type RepoRef } from './contract'
import { docAudience } from './private-content'
import { loadPrivateSessionUncached, sessionUnwrapper } from './private-session'
import { PrivateWriteError, editFields, isSealedKind, sealContent, sealedTextUse, writeBlockReason } from './private-writes'
import { contractOf, repoSource } from './source'

/**
 * E311 (DESIGN §4.1, §10): a member nobody has shared the members key with yet (added by an older
 * client). Nothing repairs it on its own: a maintainer runs the repair check. The one copy of it
 * (the repo banner and the write refusal show this text).
 */
export const NO_KEY_SHARED_TEXT = "You're a member, but no key has been shared with you yet. Ask a maintainer to share it: Repair in the repo's Settings, or dg repo keys repair."

/**
 * The combined text cap of a members-only document: the private-repo cap less the 32 bytes the
 * v0x03 envelope's key commitment takes (`maxMembersPlaintext`).
 */
export const MEMBERS_TEXT_LIMIT = { issue: 5053, patch: 5047, comment: 5053, review: 5056 } as const

/** Why a members-only write cannot go ahead: the refusal is the message, nothing was written. */
function refused(message: string, code?: string): PrivateWriteError {
  return new PrivateWriteError(message.endsWith('.') ? `${message} Nothing was written.` : `${message}; nothing was written`, code)
}

/** A stored document of `repo` by id, or null (one proof-checked read). */
async function storedDoc(sdk: EvoSDK, repo: RepoRef, documentType: string, id: string): Promise<PlainDocument | null> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: contractOf(repo.forge, documentType),
    documentTypeName: documentType,
    where: [['$id', '==', id]],
    limit: 1,
  })
  const doc = documents[0]
  // Another repo's document of the same type is not this thread's.
  return doc !== undefined && asIdentifierString(doc['repoId']) === repo.repoId ? doc : null
}

/** A parent whose audience a write must know and cannot read: an error, never "public" (DESIGN §3.3). */
function parentNotFound(what: string, id: string): PrivateWriteError {
  return refused(`the ${what} ${id} could not be read, and who can read this depends on it; check it, or try again in a moment`)
}

/** Whether a stored `enc` holds bytes (any encoding the SDK returns). */
function hasBytes(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.length > 0
  const n = (v as { length?: unknown }).length
  return typeof n === 'number' && n > 0
}

/**
 * Whether `repo` has a members key: every private repo, and a public one with any sealed `config`
 * (the members-key anchor, even one that does not resolve: the check fails toward the key-aware
 * flow). The same definition `dg` uses (`keyring::has_members_key`). Uncached.
 */
export async function hasMembersKey(sdk: EvoSDK, repo: RepoRef): Promise<boolean> {
  if (repo.visibility === 'private') return true
  const rows = await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.config, { orderBy: [['$createdAt', 'asc']] }))
  const has = rows.some((d) => hasBytes(d['enc']))
  if (has) knownKeys.set(repo.repoId, { has: true, at: Date.now() })
  return has
}

/** Members keys seen, by repo id: a key, once there, never goes; "none" is re-read after {@link NO_KEY_TTL_MS}. */
const knownKeys = new Map<string, { readonly has: boolean; readonly at: number }>()
const NO_KEY_TTL_MS = 15_000

/**
 * {@link hasMembersKey} for the audience lookups of a write. Without a members key nothing in a
 * public repo can be members-only content (it is sealed under that key), so a write needs no
 * parent lookup there: every public repo without members-only content keeps its writes as cheap
 * as before. A "none" answer is trusted for a few seconds only; a held members-key session
 * (`repo.lane`) proves one.
 */
export async function repoHasMembersKey(sdk: EvoSDK, repo: RepoRef): Promise<boolean> {
  if (repo.visibility === 'private' || repo.lane !== undefined) return true
  const hit = knownKeys.get(repo.repoId)
  if (hit !== undefined && (hit.has || Date.now() - hit.at < NO_KEY_TTL_MS)) return hit.has
  const has = await hasMembersKey(sdk, repo)
  knownKeys.set(repo.repoId, { has, at: Date.now() })
  return has
}

/** Note that `repo` has a members key now (this client just turned it on). */
export function noteMembersKey(repo: RepoRef): void {
  knownKeys.set(repo.repoId, { has: true, at: Date.now() })
}

/** Audiences of documents this tab wrote or read, by `repoId/docId` (a document's audience never changes). */
const knownAudiences = new Map<string, Audience>()
const MAX_KNOWN_AUDIENCES = 500

/** Remember the audience of `repo`'s document `id` (a create that just landed: a node may not show it yet). */
export function noteAudience(repo: RepoRef, id: string, audience: Audience): void {
  if (id === '') return
  if (knownAudiences.size >= MAX_KNOWN_AUDIENCES) knownAudiences.delete(knownAudiences.keys().next().value as string)
  knownAudiences.set(`${repo.repoId}/${id}`, audience)
}

/** How often a parent that is not visible yet is read again (a block behind) before the write is refused. */
const PARENT_RETRIES = 3

/** The audience of `repo`'s issue or pull request `targetId`, read from the stored document. */
export async function targetAudience(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<Audience> {
  if (repo.visibility === 'private') return 'members'
  const known = knownAudiences.get(`${repo.repoId}/${targetId}`)
  if (known !== undefined) return known
  if (!(await repoHasMembersKey(sdk, repo))) return 'public'
  const found = await retryWhileMissing(async () => {
    for (const type of [DOC.issue, DOC.patch]) {
      const doc = await storedDoc(sdk, repo, type, targetId)
      if (doc !== null) return docAudience(doc)
    }
    return null
  }, PARENT_RETRIES)
  if (found === null) throw parentNotFound('issue or pull request', targetId)
  noteAudience(repo, targetId, found)
  return found
}

/**
 * The audience a new document of `repo` is written for, under a parent written for `parent`
 * (null: none, as an issue): `requested`, else the parent's. A public child of a members-only
 * parent is refused; specific people are not written in this release. In a private repo
 * everything is members-only.
 */
export function audienceFor(repo: RepoRef, requested: Audience | undefined, parent: Audience | null): Audience {
  if (repo.visibility === 'private') {
    if (requested === 'public') throw refused('this repo is private: everything in it is members-only')
    return 'members'
  }
  const under = parent ?? 'public'
  const audience = requested ?? under
  if (audience === 'specificPeople') throw refused('writing to specific people is not supported yet')
  if (!fitsUnder(audience, under)) {
    throw refused("this conversation is members-only, so a reply to it can't be public: everyone could read it, and it would answer text only members can read")
  }
  return audience
}

/**
 * The audience of a new comment or review on `targetId` (replying to comment `replyTo`, for a
 * comment): the narrowest of the target's, the comment replied to and its root (a reply to a
 * members-only reply under a public root is members-only), then {@link audienceFor}.
 */
export async function childAudience(
  sdk: EvoSDK,
  repo: RepoRef,
  input: { readonly targetId: string; readonly replyTo?: string; readonly requested?: Audience },
): Promise<Audience> {
  if (repo.visibility === 'private') return audienceFor(repo, input.requested, null)
  // No members key: nothing here is members-only, so no parent needs reading.
  if (!(await repoHasMembersKey(sdk, repo))) return audienceFor(repo, input.requested, 'public')
  let parent = await targetAudience(sdk, repo, input.targetId)
  if (input.replyTo !== undefined && input.replyTo !== '') {
    const replied = await storedAudience(sdk, repo, DOC.comment, input.replyTo)
    parent = narrower(parent, replied.audience)
    const root = asIdentifierString(replied.doc['replyTo'])
    if (root !== '') parent = narrower(parent, (await storedAudience(sdk, repo, DOC.comment, root)).audience)
  }
  return audienceFor(repo, input.requested, parent)
}

/** The retry-cache key of a sealed write saying `said` (a content hash): an HMAC under the epoch's ref key. */
export async function keyedContentKey(keys: EpochKeys, said: string): Promise<string> {
  return bytesToHex(await refNameHash(keys, `write-journal:${said}`))
}

/** What one members-only action seals under: the members key's current write epoch, read now. */
export interface MembersWriter {
  readonly keys: EpochKeys
}

/**
 * The signer's {@link MembersWriter} for public `repo` (§5.3: read fresh for the action): refused,
 * before anything is signed, for a non-member, a browser with no encryption key (E306), a repo
 * nobody turned members-only content on in (E312), a member the key was not shared with yet
 * (E311), and an epoch nothing can be written under.
 */
export async function membersWriter(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef): Promise<MembersWriter> {
  if (repo.visibility !== 'public') throw new Error('members-only content is written in public repos')
  const ops = await encryptionOps(sdk, auth.network, auth.identityId, repo.forge.collab)
  if (ops === null) throw refused('add your encryption key to this browser (Settings → Private repos) to write members-only content', 'E306')
  const { session: _s, lane: _l, ...plain } = repo
  void _s
  void _l
  const s = await loadPrivateSessionUncached(sdk, plain, auth.network, auth.identityId, sessionUnwrapper(ops))
  try {
    if (!s.members.some((m) => m.identity === auth.identityId)) throw refused('only members of this repo can write what only members can read')
    if (s.configRows.length === 0) throw refused("members-only content isn't turned on in this repo; a maintainer can turn it on", 'E312')
    const r = s.resolution
    const mine = s.wraps.some((w) => base58Encode(w.row.memberId) === auth.identityId)
    if (r.keys.size === 0 && !mine) throw refused(NO_KEY_SHARED_TEXT, 'E311')
    const keys = r.writeEpoch === null ? undefined : r.keys.get(r.writeEpoch)
    if (keys === undefined) throw refused(writeBlockReason(r) ?? "you can't write under this repo's current key yet; a maintainer can repair it", 'E310')
    return { keys }
  } finally {
    s.close()
  }
}

/** The sealed types members-only content takes in this release (PRs and ref updates are phase 3). */
const MEMBERS_TYPES: ReadonlySet<PrivateDocType> = new Set(['issue', 'comment', 'review', 'event'])

/**
 * Seal `data` (the plaintext document a public writer would post) as members-only content of
 * `repo` under `writer`: the content fields go into `enc` v0x03 with `vis: "public"`, `epoch` is
 * set, and `asMember` proves the signer a member (D14). Returns the document data to post.
 */
export async function sealMembersContent(auth: WriteAuth, type: PrivateDocType, data: Record<string, unknown>, writer: MembersWriter): Promise<Record<string, unknown>> {
  if (!MEMBERS_TYPES.has(type)) throw refused(`a members-only ${type} is not supported yet`)
  if (isSealedKind(type)) {
    const { used } = sealedTextUse(type, data)
    const limit = MEMBERS_TEXT_LIMIT[type]
    if (used > limit) throw refused(`the text is too long: a members-only ${type} holds at most ${limit} bytes of text (this one has ${used})`)
  }
  const owner = decodeIdentifier(auth.identityId)
  // {@link membersWriter} proved the signer a member just now: a verdict a stale "not a member"
  // read made a non-member's (4 / 5) is the member's (1 / 2), with the proof; consensus refuses a
  // 4 / 5 with `asMember`, and a member's verdict without it would not count (forge-core `stamp`).
  const verdict = data['verdict']
  const member = verdict === 4 ? { ...data, verdict: 1 } : verdict === 5 ? { ...data, verdict: 2 } : data
  try {
    const sealed = await sealContent(writer.keys, type, owner, member, (k, doc, f) => sealMembersDoc(k, { ...doc, vis: 'public' }, f))
    // An event carries no proof field (its gate is the member event type itself).
    return type === 'event' ? sealed : { ...sealed, asMember: owner }
  } catch (e) {
    if (e instanceof TooLargeError) throw refused(`the text is too long for a members-only ${type}`)
    if (e instanceof MalformedError) throw refused(`this ${type} can't be written members-only: ${e.message}`)
    throw e
  }
}

/**
 * The `enc` / `epoch` / `asMember` a replace of a members-only issue or comment posts: its content
 * re-sealed as a whole under the members key's current write epoch (`current`: the decrypted
 * content, `changes`: what the edit sets, `bind`: the plaintext bind fields; parity:
 * `private-writes.ts` `sealEdit`, forge-core `reseal_edit`). A members-only PR is not written in
 * this release.
 */
export async function sealMembersEdit(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  type: 'issue' | 'patch' | 'comment',
  bind: Record<string, unknown>,
  current: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
  imported?: Readonly<Record<string, unknown>> | null,
): Promise<Record<string, unknown>> {
  if (type === 'patch') throw refused('a members-only pull request is not supported yet')
  const merged = editFields(type, bind, current, changes, imported)
  const sealed = await sealMembersContent(auth, type, merged, await membersWriter(sdk, auth, repo))
  return { enc: sealed['enc'], epoch: sealed['epoch'], asMember: sealed['asMember'] }
}

/** The audience of `repo`'s stored `documentType` document `id`, failing closed. */
export async function storedAudience(sdk: EvoSDK, repo: RepoRef, documentType: string, id: string): Promise<{ readonly audience: Audience; readonly doc: PlainDocument }> {
  const doc = await retryWhileMissing(() => storedDoc(sdk, repo, documentType, id), PARENT_RETRIES)
  if (doc === null) throw parentNotFound(documentType, id)
  return { audience: docAudience(doc), doc }
}

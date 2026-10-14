/**
 * Bot access (mixed-visibility DESIGN §4.9, D33, §10 "Bots and runners";
 * `docs/security/private-repos.md` §22): a repo's access notices (kind 11, `lib/private/access-notice.ts`),
 * a maintainer's change to one, and asking a bot to work on an issue or pull request (event kind
 * 27, `lib/rules/agent-request.ts`) with the `read` key letter (kind 10, `lib/private/read-letter.ts`)
 * that hands it the thread as it is at that moment. The CLI's twin is forge-core
 * `collab::v2::bots` (`dg bot allow | revoke | list | ask`).
 *
 * - **Reading.** Every kind-11 manifest's bytes, checked against their `packHash`: read as they are
 *   in a public repo; in a private one the members' copy (DFPK 0x01) opens with the members key this
 *   tab holds. The bot's own copy (DFPK 0x02, to the bot and the writer) holds the same notice and is
 *   skipped. Per bot, the newest from a current maintainer or the owner counts.
 * - **Writing a notice** (maintainers and the owner, refused before signing otherwise; never for the
 *   owner or a human member): plaintext on Platform chunks in a public repo, two copies in a private
 *   one (members key, and a letter to the bot and the writer).
 * - **Asking.** Checked before anything is signed ({@link checkAsk}, E813: the bot's current notice
 *   and the viewer's role, the owner as a maintainer). Then the request event (its task follows the
 *   thread's audience, as every event value does), then, when the notice lets the bot read on
 *   request and the thread holds members-only posts, the `read` letter: every members-only (v0x03)
 *   post revision the asker opens, with its per-object key, and the request's own key; never a
 *   message to specific people (v0x04) or an older post (v0x01). Sealed to the asker (slot 0) and
 *   the bot. The web never includes code (that needs a clone: `dg bot ask`).
 *
 * Keys: a plan for the dialog derives each key only to count it and wipes it at once; the write
 * derives them again, seals the letter and wipes every key and the plaintext when done.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import * as secp from '@noble/secp256k1'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { encryptionKeyState, fetchIdentityKeys, isUsableEncryptionKey, usableEncryptionKey } from '../auth/encryption-key'
import { VaultLockedError, storedEncryptionKeyIds, withEncryptionKeys } from '../auth/vault'
import { PACK_KIND, type Network } from '../constants'
import {
  KeyLetterError,
  MAY_READ_ON_REQUEST,
  V1,
  V3,
  V4,
  bytesToHex,
  compareDocs,
  currentNotices,
  decodeNotice,
  encodeKeyLetter,
  encodeNotice,
  hexToBytes,
  noticeMay,
  openContent,
  openPack,
  readLetterToTyped,
  readObjKey,
  sealLetterArtifact,
  sealPack,
  type AccessNotice,
  type LetterDoc,
  type LetterRecipient,
  type NoticeEntry,
  type PrivateDocType,
} from '../private'
import { AGENT_REQUEST_KIND, checkAsk, isTask, refusalWords, roleWords, TASK_MAX, type AskRefusal } from '../rules/agent-request'
import type { Role } from '../rules/v2'
import { queryAllDocuments, queryDocuments, type PlainDocument, type WriteAuth, type WriteResult } from '../sdk'
import { estimateChunkCredits, previewCreate } from '../sdk/cost'
import { sha256Hex } from '../storage/sigv4'
import { retryWhileMissing } from '../view/retry'
import { DOC, asIdentifierString, type RepoRef } from './contract'
import { revisionOf } from './made-public'
import { MAX_KEY_LETTER } from '../private/key-letter'
import { readMaintainers, readViewerPermissions } from './members'
import { bytesField, isSealedDoc, storedPrivateDoc } from './private-content'
import { LONG_BODY_MANIFEST_CREDITS } from './long-body'
import { privateWriter } from './private-writes'
import type { PrivateSession } from './private-session'
import { readManifestsOfKind } from './packs'
import { putPlatformChunks, writePackManifest } from './push'
import { repoSource, contractOf } from './source'
import { writeRepoDoc } from './writes'

/** A refusal before anything was signed, or a step that could not finish: what the person reads. */
export class BotAccessError extends Error {
  constructor(
    message: string,
    /** What to do about it, when there is something. */
    readonly fix: string | null = null,
  ) {
    super(message)
    this.name = 'BotAccessError'
  }
}

/** E813: the bot's access does not allow this request. Nothing was signed. */
export class AskRefusedError extends BotAccessError {
  constructor(
    readonly refusal: AskRefusal,
    words: { readonly message: string; readonly fix: string },
  ) {
    super(words.message, words.fix)
    this.name = 'AskRefusedError'
  }
}

/** The E813 refusal of asking `bot` (as the copy names it, `@ci-bot`) in `repo` (`o/r`). */
export function askRefused(refusal: AskRefusal, bot: string, repo: string): AskRefusedError {
  return new AskRefusedError(refusal, refusalWords(refusal, bot, repo))
}

// ---------------------------------------------------------------------------------------------
// Reading notices
// ---------------------------------------------------------------------------------------------

/** A repo's access notices as this reader reads them. */
export interface Notices {
  /** Every notice that read, whoever wrote it, oldest first. */
  readonly all: readonly NoticeEntry[]
  /** The notice that counts for each bot (by its base58 id): the newest from a current maintainer or the owner. */
  readonly current: ReadonlyMap<string, NoticeEntry>
  /** Kind-11 copies this reader could not read: damaged, malformed, or under a key this tab does not hold. */
  readonly unreadable: number
}

const NO_NOTICES: Notices = { all: [], current: new Map(), unreadable: 0 }

const MAGIC = [0x44, 0x46, 0x50, 0x4b] // "DFPK"
const MEMBERS_COPY = 0x01

/** The members-key session this tab holds for `repo`: a private repo's, or a public repo's members-only session. */
export function membersSession(repo: RepoRef): PrivateSession | undefined {
  return repo.visibility === 'private' ? repo.session : repo.lane
}

/** The notice in one copy's stored bytes, `'skip'` for the bot's own copy, or null when it does not read. */
async function noticeOfCopy(repo: RepoRef, bytes: Uint8Array, sizeBytes: number): Promise<AccessNotice | 'skip' | null> {
  if (repo.visibility !== 'private') return decodeNotice(bytes)
  if (bytes.length < 9 || MAGIC.some((b, i) => bytes[i] !== b)) return null
  if (bytes[4] !== MEMBERS_COPY) return 'skip'
  const session = repo.session
  if (session === undefined) return null
  const plain = await openPack(bytes, sizeBytes, session.resolution.keys).catch(() => null)
  if (plain === null) return null
  try {
    return decodeNotice(plain)
  } finally {
    plain.fill(0)
  }
}

/**
 * Every access notice of `repo` this reader can read, and the one that counts per bot (forge-core
 * `Collab::access_notices`). Reads the maintainers fresh: a notice counts only from a current one.
 */
export async function readAccessNotices(sdk: EvoSDK, repo: RepoRef): Promise<Notices> {
  // newest first
  const manifests = await readManifestsOfKind(sdk, repo, PACK_KIND.ACCESS_NOTICE)
  if (manifests.length === 0) return NO_NOTICES
  const maintainers = new Set([...(await readMaintainers(sdk, repo)), repo.ownerId])
  // Loaded on demand: the browse plane reads through the session module this one feeds.
  const { loadStoredArtifactBytes } = await import('../view/browse-source')
  const all: NoticeEntry[] = []
  let unreadable = 0
  for (const m of [...manifests].reverse()) {
    const notice = await loadStoredArtifactBytes(sdk, repo, m)
      .then((b) => noticeOfCopy(repo, b, m.sizeBytes))
      .catch(() => null)
    if (notice === 'skip') continue
    if (notice === null) {
      unreadable += 1
      continue
    }
    all.push({ id: m.documentId, writer: m.uploader, createdAt: m.createdAt, packHash: m.packHash.toLowerCase(), notice })
  }
  const current = new Map<string, NoticeEntry>()
  for (const e of currentNotices(all, (w) => maintainers.has(w)).values()) current.set(botIdOf(e.notice), e)
  return { all, current, unreadable }
}

/** How long a repo's notices serve page views before they are read again. */
const NOTICES_TTL_MS = 60_000
const noticesCache = new Map<string, { readonly at: number; readonly promise: Promise<Notices> }>()
const noticesKey = (repo: RepoRef): string => `${repo.forge.core}:${repo.repoId}:${membersSession(repo)?.id ?? ''}`

/** {@link readAccessNotices}, shared by every reader of the page for a minute (a write here drops it). */
export function readAccessNoticesCached(sdk: EvoSDK, repo: RepoRef): Promise<Notices> {
  const key = noticesKey(repo)
  const hit = noticesCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < NOTICES_TTL_MS) return hit.promise
  const promise = readAccessNotices(sdk, repo)
  promise.catch(() => {
    if (noticesCache.get(key)?.promise === promise) noticesCache.delete(key)
  })
  noticesCache.set(key, { at: Date.now(), promise })
  return promise
}

/** Forget `repo`'s notices (this tab wrote one). */
export function invalidateAccessNotices(repo: Pick<RepoRef, 'repoId'>): void {
  for (const k of [...noticesCache.keys()]) if (k.split(':')[1] === repo.repoId) noticesCache.delete(k)
}

// ---------------------------------------------------------------------------------------------
// Sealing to a bot, and storing an artifact on Platform
// ---------------------------------------------------------------------------------------------

/** `id`'s usable encryption key (its newest public key), or null. */
async function encryptionKeyOf(sdk: EvoSDK, repo: RepoRef, id: string): Promise<Uint8Array | null> {
  const k = usableEncryptionKey((await fetchIdentityKeys(sdk, id)) ?? [], repo.forge.core)
  return k === null ? null : hexToBytes(k.data)
}

/** A notice's bot, base58 (the id every other read names it by). */
export function botIdOf(n: AccessNotice): string {
  return base58Encode(n.bot)
}

/** Whether `bot` has an encryption key, so something members-only can be sent to it. */
export async function botHasEncryptionKey(sdk: EvoSDK, repo: RepoRef, bot: string): Promise<boolean> {
  return (await encryptionKeyOf(sdk, repo, bot)) !== null
}

/** The bot's encryption key, or the refusal before anything is signed. */
async function botKey(sdk: EvoSDK, repo: RepoRef, bot: string, name: string): Promise<Uint8Array> {
  const k = await encryptionKeyOf(sdk, repo, bot)
  if (k === null) throw new BotAccessError(`${name} has no encryption key, so nothing members-only can be sent to it. Nothing was signed.`, 'ask its operator to add one')
  return k
}

/** The signer's newest usable encryption key this browser holds (the env saver's rule), or the refusal. */
async function senderKey(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef): Promise<{ readonly keyId: number; readonly data: string }> {
  const held = await storedEncryptionKeyIds(auth.network, auth.identityId)
  const own = ((await fetchIdentityKeys(sdk, auth.identityId)) ?? []).filter((k) => held.includes(k.keyId) && isUsableEncryptionKey(k, repo.forge.core)).sort((a, b) => b.keyId - a.keyId)[0]
  if (own === undefined) {
    throw new BotAccessError("This browser doesn't hold a usable encryption key of yours, so it can't send anything members-only to the bot. Nothing was signed.", 'add it under Settings → Members-only and private content')
  }
  return own
}

/**
 * Seal `plain` to the signer (slot 0) and the bot, whose encryption key is `botPublicKey`, as a
 * DFPK 0x02 artifact, from the signer's newest encryption key this browser holds (the env saver's
 * rule). The key is opened from the vault for the call only.
 */
async function sealToBot(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, bot: string, botPublicKey: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const me = auth.identityId
  const own = await senderKey(sdk, auth, repo)
  const ownKey = hexToBytes(own.data)
  const recipients: LetterRecipient[] = [
    { identityId: decodeIdentifier(me), publicKey: ownKey },
    { identityId: decodeIdentifier(bot), publicKey: botPublicKey },
  ]
  return withEncryptionKeys(auth.network, me, async (keys) => {
    const want = bytesToHex(ownKey)
    const sender = keys.find((k) => bytesToHex(secp.getPublicKey(k.secret, true)) === want)
    if (sender === undefined) throw new VaultLockedError('this browser no longer holds the encryption key it was about to use; unlock it again')
    return sealLetterArtifact(decodeIdentifier(repo.repoId), sender.secret, sender.keyId, decodeIdentifier(me), recipients, plain)
  })
}

/** Store `bytes` on Platform chunks with a `kind` manifest (forge-core `store_access_notice` / `store_key_letter`). */
async function storeOnPlatform(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, kind: 10 | 11, bytes: Uint8Array, intent: string): Promise<{ readonly id: string; readonly packHash: string; readonly result: WriteResult }> {
  const packHash = await sha256Hex(bytes)
  const { locator, chunkCount } = await putPlatformChunks(sdk, auth, repo, bytes, packHash)
  const result = await writePackManifest(sdk, auth, repo, { packHash, kind, sizeBytes: bytes.length, objectCount: 0, chunkCount, storage: 0, uris: [locator] }, `${intent}:${packHash}`)
  return { id: result.documentId, packHash, result }
}

// ---------------------------------------------------------------------------------------------
// Writing a notice
// ---------------------------------------------------------------------------------------------

export const NOT_A_MAINTAINER = 'Only maintainers can change what a bot may do. Ask a maintainer; nothing was written.'

/** Whether `identity` may change a bot's access in `repo` now: the owner or a current maintainer (read now). */
export async function canChangeBotAccess(sdk: EvoSDK, repo: RepoRef, identity: string | null): Promise<boolean> {
  if (identity === null) return false
  return identity === repo.ownerId || (await readMaintainers(sdk, repo)).includes(identity)
}

/** The role `identity` asks with: the owner as a maintainer, else its current role (null: not a member). */
export async function askerRole(sdk: EvoSDK, repo: RepoRef, identity: string, network: Network): Promise<Role | null> {
  if (identity === repo.ownerId) return 'maintainer'
  return (await readViewerPermissions(sdk, repo, identity, network))?.role ?? null
}

/**
 * Refuse, before anything is signed, access for someone who is already a member or the owner:
 * members read members-only content themselves, and access is for bots (`dg bot allow`).
 */
async function requireNotAMember(sdk: EvoSDK, repo: RepoRef, bot: string, name: string, network: Network, display: string): Promise<void> {
  if (bot === repo.ownerId) throw new BotAccessError(`${name} owns ${display}: access is for bots. Nothing was written.`)
  const role = await askerRole(sdk, repo, bot, network)
  if (role !== null && role !== 'bot') throw new BotAccessError(`${name} is a member of ${display} with ${roleWords(role)}: access is for bots. Nothing was written.`)
}

/** What {@link writeAccessNotice} wrote. */
export interface NoticeWritten {
  /** The manifest ids, the members' or public copy first. */
  readonly ids: readonly string[]
  /** That copy's `packHash` (a later notice's `revokes`). */
  readonly packHash: string
}

/**
 * Write `notice` as `repo`'s current access notice for its bot (forge-core
 * `Collab::write_access_notice`): a maintainer or the owner only, never for the owner or a human
 * member, all checked before anything is signed. `name` is how the copy names the bot (`@ci-bot`),
 * `display` the repo (`o/r`).
 */
export async function writeAccessNotice(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  notice: AccessNotice,
  opts: { readonly name: string; readonly display: string },
): Promise<NoticeWritten> {
  if (!(await canChangeBotAccess(sdk, repo, auth.identityId))) throw new BotAccessError(NOT_A_MAINTAINER)
  const bot = botIdOf(notice)
  // Taking access away is always allowed; giving it, only to a bot.
  if (notice.may.length > 0) await requireNotAMember(sdk, repo, bot, opts.name, auth.network, opts.display)
  let plain: Uint8Array
  try {
    plain = encodeNotice(notice)
  } catch (e) {
    if (e instanceof KeyLetterError) {
      throw new BotAccessError('The service name is at most 100 characters and the note at most 500, with no control characters. Nothing was written.')
    }
    throw e
  }
  const intent = `access-notice:${repo.repoId}:${bot}`
  try {
    if (repo.visibility !== 'private') {
      const one = await storeOnPlatform(sdk, auth, repo, PACK_KIND.ACCESS_NOTICE, plain, intent)
      return { ids: [one.id], packHash: one.packHash }
    }
    // Everything that can refuse is checked before the first copy is stored.
    const publicKey = await botKey(sdk, repo, bot, opts.name)
    const toBot = await sealToBot(sdk, auth, repo, bot, publicKey, plain)
    const { keys } = await privateWriter(sdk, auth, repo)
    const members = await sealPack(keys, plain)
    const first = await storeOnPlatform(sdk, auth, repo, PACK_KIND.ACCESS_NOTICE, members, intent)
    const second = await storeOnPlatform(sdk, auth, repo, PACK_KIND.ACCESS_NOTICE, toBot, `${intent}:bot`)
    return { ids: [first.id, second.id], packHash: first.packHash }
  } finally {
    plain.fill(0)
    invalidateAccessNotices(repo)
  }
}

// ---------------------------------------------------------------------------------------------
// Asking a bot
// ---------------------------------------------------------------------------------------------

/** The thread a bot is asked about. */
export interface AskTarget {
  readonly kind: 'pr' | 'issue'
  /** The issue's or pull request's `$id` (base58). */
  readonly id: string
  readonly number: number
}

/** Why a members-only post of the thread is not handed on (forge-core `NotShared`). */
export type NotShared = 'letter' | 'older' | 'unreadable'

/** What asking will hand on, planned before anything is signed. */
export interface AskPlan {
  readonly target: AskTarget
  /** The bot (base58). */
  readonly bot: string
  /** Whether the thread is members-only (the task is then members-only too). */
  readonly membersOnly: boolean
  /** The AI service the bot's notice names. */
  readonly processor: string | null
  /** The members-only posts the letter carries (none: no letter). */
  readonly shared: { readonly thread: number; readonly comments: number }
  /** The members-only posts left out, and why. */
  readonly leftOut: readonly NotShared[]
}

/** One post of the thread as it is stored, and its kind. */
type Post = { readonly type: PrivateDocType; readonly doc: PlainDocument }

/** The thread as stored: the issue or pull request, then its comments, then a PR's reviews. */
async function threadPosts(sdk: EvoSDK, repo: RepoRef, target: AskTarget): Promise<Post[]> {
  const type = target.kind === 'pr' ? DOC.patch : DOC.issue
  const own = await queryDocuments(sdk, { dataContractId: contractOf(repo.forge, type), documentTypeName: type, where: [['$id', '==', target.id]], limit: 1 })
  const root = own[0]
  if (root === undefined || asIdentifierString(root['repoId']) !== repo.repoId) throw new BotAccessError(`#${target.number} could not be read; try again in a moment`)
  const comments = await queryAllDocuments(sdk, repoSource(repo).targetQuery(DOC.comment, { where: [['targetId', '==', target.id]], orderBy: [['targetId', 'asc'], ['$createdAt', 'asc']] }))
  const reviews =
    target.kind === 'pr'
      ? await queryAllDocuments(sdk, repoSource(repo).targetQuery(DOC.review, { where: [['patchId', '==', target.id]], orderBy: [['patchId', 'asc'], ['$createdAt', 'asc']] }))
      : []
  return [
    { type: target.kind === 'pr' ? 'patch' : 'issue', doc: root },
    ...comments.map((doc): Post => ({ type: 'comment', doc })),
    ...reviews.map((doc): Post => ({ type: 'review', doc })),
  ]
}

/** The per-object key of members-only `post` as this tab opens it now, or why it is left out. */
async function postKey(repo: RepoRef, session: PrivateSession | undefined, post: Post): Promise<{ readonly doc: LetterDoc } | { readonly why: NotShared }> {
  const stored = storedPrivateDoc(post.type, post.doc, repo.visibility)
  const first = bytesField(post.doc, 'enc')?.[0]
  if (first === V4) return { why: 'letter' }
  if (first === V1) return { why: 'older' }
  if (stored === null || stored.id === undefined || first !== V3 || session === undefined) return { why: 'unreadable' }
  const opened = await openContent(stored, session.ctx)
  if (opened.status !== 'readable') return { why: 'unreadable' }
  const keys = session.resolution.keys.get(stored.epoch)
  const key = keys === undefined ? null : await readObjKey(keys, stored, stored.enc)
  return key === null ? { why: 'unreadable' } : { doc: { id: stored.id, revision: revisionOf(post.doc), key } }
}

/** Whether this tab opens members-only `post` (a private repo's older posts too). */
async function opens(repo: RepoRef, session: PrivateSession | undefined, post: Post): Promise<boolean> {
  const stored = storedPrivateDoc(post.type, post.doc, repo.visibility)
  return session !== undefined && stored !== null && (await openContent(stored, session.ctx)).status === 'readable'
}

/** What {@link plan} found: the plan, and (when kept) the letter's keys. */
interface Planned {
  readonly plan: AskPlan
  readonly docs: LetterDoc[]
  /** The bot's encryption key, when a letter will be written. */
  readonly botPublicKey: Uint8Array | null
}

/** Why a task can't be sent. */
export const TASK_PROBLEM = `The task must be 1 to ${TASK_MAX.chars} characters. Nothing was signed.`

/** Who is asked about what: the planned part of a request to a bot. */
export interface AskAbout {
  readonly target: AskTarget
  /** The bot (base58). */
  readonly bot: string
  /** How the copy names it (`@ci-bot`). */
  readonly name: string
  /** The repo as the copy names it (`o/r`). */
  readonly display: string
}

/** A request to a bot: who, about what, and the task. */
export interface AskInput extends AskAbout {
  readonly task: string
}

async function plan(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, input: AskAbout, keep: boolean): Promise<Planned> {
  const [notices, role, posts] = await Promise.all([readAccessNotices(sdk, repo), askerRole(sdk, repo, auth.identityId, auth.network), threadPosts(sdk, repo, input.target)])
  const root = posts[0] as Post
  const membersOnly = repo.visibility === 'private' || isSealedDoc(root.doc)
  const notice = notices.current.get(input.bot)?.notice ?? null
  const refusal = checkAsk(notice, role, input.target.number, membersOnly, Date.now())
  if (refusal !== null) throw askRefused(refusal, input.name, input.display)
  const docs: LetterDoc[] = []
  const leftOut: NotShared[] = []
  let thread = 0
  let comments = 0
  const session = membersSession(repo)
  // A message to specific people takes no request: its event values go to its people only.
  if (bytesField(root.doc, 'enc')?.[0] === V4) {
    throw new BotAccessError(`${input.name} can't be asked about a message to specific people. Nothing was signed.`)
  }
  // Only a thread the asker reads can be handed on.
  if (isSealedDoc(root.doc) && !(await opens(repo, session, root))) {
    throw new BotAccessError(`You can't read #${input.target.number}, so you can't ask ${input.name} to work on it. Nothing was signed.`)
  }
  let botPublicKey: Uint8Array | null = null
  try {
    if (notice !== null && noticeMay(notice, MAY_READ_ON_REQUEST) && posts.some((p) => isSealedDoc(p.doc))) {
      for (const p of posts) {
        if (!isSealedDoc(p.doc)) continue
        const got = await postKey(repo, session, p)
        if ('why' in got) {
          leftOut.push(got.why)
          continue
        }
        if (p === root) thread += 1
        else comments += 1
        if (keep) docs.push(got.doc)
        else got.doc.key.fill(0)
      }
    }
    if (thread + comments > 0) {
      // Everything the letter needs is checked here, before the request is signed.
      if (letterBytes(thread + comments + 1) > MAX_KEY_LETTER) {
        throw new BotAccessError(`#${input.target.number} has too many members-only posts to hand to ${input.name} at once (${thread + comments}). Nothing was signed.`)
      }
      botPublicKey = await botKey(sdk, repo, input.bot, input.name)
      await senderKey(sdk, auth, repo)
      if ((await encryptionKeyState(auth.network, auth.identityId)) !== 'open') {
        throw new BotAccessError(`Unlock this tab to hand the thread to ${input.name}. Nothing was signed.`)
      }
    }
  } catch (e) {
    for (const d of docs) d.key.fill(0)
    throw e
  }
  return {
    plan: {
      target: input.target,
      bot: input.bot,
      membersOnly,
      processor: notice?.processor ?? null,
      shared: { thread, comments },
      leftOut,
    },
    docs,
    botPublicKey,
  }
}

/**
 * What asking `input.bot` to work on `input.target` will hand on, read and checked now for the
 * dialog (forge-core `Collab::plan_ask`). Refused before anything is signed with
 * {@link AskRefusedError} (E813) when the bot's access does not allow it. Keeps no key.
 */
export async function planAsk(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, input: AskAbout): Promise<AskPlan> {
  return (await plan(sdk, auth, repo, input, false)).plan
}

/** What {@link writeAsk} wrote. */
export interface Asked {
  readonly plan: AskPlan
  /** The request's event id (the job). */
  readonly event: string
  /** The `read` letter's manifest id, if one was written. */
  readonly letter: string | null
}

/**
 * Ask a bot to work on a thread (forge-core `Collab::write_ask`): checked again from scratch, then
 * the request (event kind 27, `refId` the bot, the task as its value), then the `read` letter
 * naming it, with the request's own key when its task is members-only, sealed to the signer and the
 * bot and stored on Platform with a kind-10 manifest. Every key and the plaintext are wiped after.
 */
export async function writeAsk(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, input: AskInput, intent?: string): Promise<Asked> {
  if (!isTask(input.task)) throw new BotAccessError(TASK_PROBLEM)
  const planned = await plan(sdk, auth, repo, input, true)
  const docs = planned.docs
  let plain: Uint8Array | null = null
  try {
    const { target } = planned.plan
    const written = await writeRepoDoc(
      sdk,
      auth,
      repo,
      DOC.event,
      { targetId: decodeIdentifier(target.id), targetNumber: target.number, kind: AGENT_REQUEST_KIND, refId: decodeIdentifier(input.bot), value: input.task },
      intent ? `${intent}:ask` : undefined,
    )
    const event = written.documentId
    if (planned.botPublicKey === null) return { plan: planned.plan, event, letter: null }
    const unfinished = (what: string): BotAccessError =>
      new BotAccessError(`The request was written, but ${what}.`, 'ask again: the bot works only from a request it was given the thread with')
    // the request itself, when its task is members-only: the bot reads it with this key
    const stored = await retryWhileMissing(async () => {
      const got = await queryDocuments(sdk, { dataContractId: contractOf(repo.forge, DOC.event), documentTypeName: DOC.event, where: [['$id', '==', event]], limit: 1 })
      return got[0] ?? null
    }, 4)
    if (stored === null) throw unfinished('it could not be read back to share its task')
    if (isSealedDoc(stored)) {
      const got = await postKey(repo, membersSession(repo), { type: 'event', doc: stored })
      if ('why' in got) throw unfinished('its task could not be opened again to share it')
      docs.push({ ...got.doc, revision: 1 })
    }
    const sorted = dedupeDocs(docs)
    const typed = await readLetterToTyped({
      job: decodeIdentifier(event),
      asOf: Date.now(),
      target: target.kind === 'pr' ? { pr: target.number } : { issue: target.number },
      docs: sorted,
      packs: [],
      heads: [],
    })
    if (typed === null) throw unfinished('the thread could not be put together for the bot')
    try {
      plain = encodeKeyLetter(typed)
    } catch (e) {
      if (e instanceof KeyLetterError) throw unfinished('the thread is too long to hand to the bot at once')
      throw e
    }
    const sealed = await sealToBot(sdk, auth, repo, input.bot, planned.botPublicKey, plain).catch((e: unknown) => {
      throw unfinished(`the thread could not be sent to the bot (${e instanceof Error ? e.message : String(e)})`)
    })
    const letter = await storeOnPlatform(sdk, auth, repo, PACK_KIND.KEY_LETTER, sealed, `read-letter:${event}`).catch((e: unknown) => {
      throw unfinished(`the thread could not be stored for the bot (${e instanceof Error ? e.message : String(e)})`)
    })
    return { plan: planned.plan, event, letter: letter.id }
  } finally {
    for (const d of docs) d.key.fill(0)
    plain?.fill(0)
  }
}

/** `docs` sorted by (id, revision), each once (forge-core `write_ask`). */
function dedupeDocs(docs: readonly LetterDoc[]): LetterDoc[] {
  const out: LetterDoc[] = []
  for (const d of [...docs].sort(compareDocs)) {
    const last = out[out.length - 1]
    if (last === undefined || compareDocs(last, d) !== 0) out.push(d)
  }
  return out
}

/** An upper bound of a `read` letter's padded plaintext with `docs` revisions and no code. */
function letterBytes(docs: number): number {
  return 512 + 140 * docs
}

// ---------------------------------------------------------------------------------------------
// Costs, as the confirmations quote them (upper bounds)
// ---------------------------------------------------------------------------------------------

/** A padded letter or notice of `bytes`, with its artifact framing, as Platform chunks and a manifest. */
function artifactCredits(bytes: number): number {
  return LONG_BODY_MANIFEST_CREDITS + estimateChunkCredits(Math.ceil(bytes / 512) * 512 + 300)
}

/** What writing a notice costs: one copy in a public repo, two in a private one (`dg bot allow`). */
export function noticeCredits(privateRepo: boolean): number {
  return (privateRepo ? 2 : 1) * artifactCredits(1024)
}

/** What asking costs: the request, and its letter when there is one (`dg bot ask`). */
export function askCredits(p: AskPlan, task: string): number {
  const docs = p.shared.thread + p.shared.comments
  const event = previewCreate('event', { value: task.length > 0 ? task : 'x' }).credits
  return event + (docs > 0 ? artifactCredits(letterBytes(docs + 1)) : 0)
}

// ---------------------------------------------------------------------------------------------
// The dialog's copy (DESIGN §10 "Ask")
// ---------------------------------------------------------------------------------------------

/**
 * What the asker reads before signing: "Ask @ci-bot to work on #42? It will get this pull request's
 * members-only comments as they are now (37 comments). <service> processes them. It can't see
 * anything added later unless you ask again. Everyone can see that you asked; only members can see
 * what you asked." With nothing members-only to hand on, the members-only clause is dropped.
 * `codeNote`: a PR from a members-only branch, whose code the web does not include.
 */
export function askSummary(p: AskPlan, name: string, codeNote: boolean): string[] {
  const noun = p.target.kind === 'pr' ? 'pull request' : 'issue'
  const out: string[] = [`Ask ${name} to work on #${p.target.number}?`]
  const n = p.shared.comments
  if (n > 0) {
    out.push(`It will get this ${noun}'s members-only comments as they are now (${n} ${n === 1 ? 'comment' : 'comments'}).`)
    if (p.processor !== null) out.push(`${p.processor} processes them.`)
    out.push("It can't see anything added later unless you ask again.")
  } else if (p.shared.thread > 0) {
    out.push(`It will get this members-only ${noun} as it is now.`)
    if (p.processor !== null) out.push(`${p.processor} processes it.`)
    out.push("It can't see anything added later unless you ask again.")
  } else {
    out.push(`It will work on this ${noun} as everyone can read it.`)
    if (p.processor !== null) out.push(`${p.processor} processes it.`)
  }
  const letters = p.leftOut.filter((w) => w === 'letter').length
  const older = p.leftOut.filter((w) => w === 'older').length
  if (letters > 0) out.push(`${letters} ${letters === 1 ? "message to specific people isn't" : "messages to specific people aren't"} included.`)
  if (older > 0) out.push(`Older items in this repo can't be shared one at a time (${older} left out).`)
  if (codeNote) out.push("Its code isn't included: ask from a clone with dg bot ask.")
  out.push(p.membersOnly ? 'Everyone can see that you asked; only members can see what you asked.' : 'Everyone can see that you asked and what you asked.')
  return out
}

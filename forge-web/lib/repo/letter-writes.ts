/**
 * Writing to specific people (DESIGN §4.2, D2, D20, D26; `docs/security/private-repos.md` §4.1
 * writer rule): issues, comments and reviews sealed as `enc` v0x04 to a list fixed when they are
 * posted, in a public or a private repo.
 *
 * - **Who it goes to** is resolved at post time by `letterPlan` from the member documents read
 *   now (a role group's current people), the people named, and the letters it replies under
 *   (each opened with the reader rule here, never taken from the page): a reply may name more
 *   people, never fewer. A reply under a members-only parent (or in a private repo) names only
 *   members. Everyone but the writer whose identity has no usable ENCRYPTION key is left out of a
 *   group, or refuses the write when named.
 * - **Each recipient's key** is that identity's highest usable ENCRYPTION key; the writer's slot is
 *   the newest usable key this browser holds for them.
 * - **The document** carries `epoch: 0`, the repo's `vis`, and `asMember` when its writer is a
 *   member (as any member write; a stranger's carries none).
 *
 * Every refusal comes before anything is signed, worded for the composer (DESIGN §10).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { fetchIdentityKeys, openLetterAs, ownerKeysOf, sealLetterAs, usableEncryptionKey, type EncKeyLike } from '../auth/encryption-key'
import { storedEncryptionKeyIds } from '../auth/vault'
import { MalformedError, TooLargeError, bytesToHex, hexToBytes, randomBytes, type EpochKeys, type LetterRecipient, type PrivateDocType } from '../private'
import { groupNow, isLetterRefusal, letterCandidates, letterPlan, type LetterGroup, type LetterInput, type LetterRefusal, type ParentLetter } from '../rules/letters'
import type { Membership } from '../rules/v2'
import type { PlainDocument, WriteAuth } from '../sdk'
import { LETTER_EVENT_VALUE_TEXT, ONLY_RECIPIENTS_REPLY, letterEditKeylessText, letterRefusalText, letterTooLongText, type LetterAsk } from '../view/audience'
import { shortId } from '../utils'
import { cachedDpnsName } from '../view/dpns'
import { retryWhileMissing } from '../view/retry'
import { DOC, asIdentifierString, type RepoRef } from './contract'
import { readMemberships } from './members'
import { docAudience, storedPrivateDoc } from './private-content'
import { editFields, sealContent } from './private-writes'

/** Why a message to specific people can't be written as asked (nothing was signed). */
export class LetterRefusedError extends Error {
  constructor(
    message: string,
    readonly refusal?: LetterRefusal,
  ) {
    super(message)
    this.name = 'LetterRefusedError'
  }
}

/** What one write to specific people seals with: who it goes to, their keys, the group. */
export interface LetterWriter {
  /** Base58 ids, slot order: the writer first. */
  readonly recipients: readonly string[]
  /** Each recipient's identity and ENCRYPTION key, slot order. */
  readonly keys: readonly LetterRecipient[]
  readonly group: LetterGroup | null
  /** People it would have gone to who have no usable encryption key, left out. */
  readonly skipped: readonly string[]
  /** The writer holds a role in the repo now (their write carries `asMember`). */
  readonly isMember: boolean
}

/** Whether `l` is a resolved {@link LetterWriter} rather than an ask. */
export function isLetterWriter(l: LetterAsk | LetterWriter | null | undefined): l is LetterWriter {
  return l != null && 'keys' in l
}

/** The letters a new document replies under, opened, and whether one of its parents is members-only. */
export interface LetterThread {
  readonly parents: readonly ParentLetter[]
  readonly membersOnlyParent: boolean
}

/** A stored document of `repo` (`$id`), by its type, or null (one proof-checked read, no wait). */
export type StoredReader = (documentType: string, id: string) => Promise<PlainDocument | null>

/** How often a parent that is not visible yet is read again (a block behind) before the write is refused. */
const PARENT_RETRIES = 3

/** A display name for refusals: the caller's (DPNS when known), else a short id. */
export type NameOf = (identityId: string) => string

/** The names refusals give people on `network`: their DPNS label when this tab knows it, else a short id. */
export function letterNames(network: WriteAuth['network']): NameOf {
  return (id) => cachedDpnsName(network, id)?.replace(/\.dash$/, '') ?? shortId(id)
}

/**
 * Open the stored letter `doc` (a `type` of `repo`) as the writer, with its owner's keys: who it
 * went to. Refused when this writer can't read it ("Only the people this was sent to can reply").
 */
async function openParent(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, type: PrivateDocType, doc: PlainDocument): Promise<ParentLetter> {
  const stored = storedPrivateDoc(type, doc, repo.visibility)
  const owner = asIdentifierString(doc['$ownerId'])
  const keys = stored === null || owner === '' ? null : await fetchIdentityKeys(sdk, owner)
  if (stored === null || keys === null) throw new LetterRefusedError(ONLY_RECIPIENTS_REPLY)
  const opened = await openLetterAs(auth.network, auth.identityId, { repoId: decodeIdentifier(repo.repoId), doc: stored, ownerKeys: ownerKeysOf(keys) })
  if (opened.status !== 'readable') throw new LetterRefusedError(ONLY_RECIPIENTS_REPLY)
  // a stranger's group (no `asMember`) is not re-listed: anyone may set it (as the reader drops it)
  return { recipients: opened.recipients.map((r) => base58Encode(r)), group: asIdentifierString(doc['asMember']) !== '' ? opened.group : null }
}

/**
 * The letters a comment or review on `targetId` (replying to comment `replyTo`) sits under: the
 * target's, the comment replied to and its root's, each opened as the writer (the reader rule);
 * and whether any of them is members-only (a private repo's always are).
 */
export async function letterThread(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  read: StoredReader,
  input: { readonly targetId: string; readonly replyTo?: string; readonly targetType?: 'issue' | 'patch' },
): Promise<LetterThread> {
  const docs: { type: PrivateDocType; doc: PlainDocument }[] = []
  // The target's type when known (a review's is a PR); either is tried in one pass otherwise, and
  // the pass again while a node a block behind does not show it.
  const types = input.targetType === 'patch' ? (['patch'] as const) : input.targetType === 'issue' ? (['issue'] as const) : (['issue', 'patch'] as const)
  const target = await retryWhileMissing(async () => {
    for (const type of types) {
      const doc = await read(DOC[type], input.targetId)
      if (doc !== null) return { type, doc }
    }
    return null
  }, PARENT_RETRIES)
  if (target === null) throw new LetterRefusedError(`the issue or pull request ${input.targetId} could not be read, and who can read this depends on it; nothing was written`)
  docs.push(target)
  if (input.replyTo !== undefined && input.replyTo !== '') {
    const replyTo = input.replyTo
    const replied = await retryWhileMissing(() => read(DOC.comment, replyTo), PARENT_RETRIES)
    if (replied === null) throw new LetterRefusedError(`the comment ${input.replyTo} could not be read, and who can read this depends on it; nothing was written`)
    docs.push({ type: 'comment', doc: replied })
    const root = asIdentifierString(replied['replyTo'])
    if (root !== '') {
      const r = await retryWhileMissing(() => read(DOC.comment, root), PARENT_RETRIES)
      if (r === null) throw new LetterRefusedError(`the comment ${root} could not be read, and who can read this depends on it; nothing was written`)
      docs.push({ type: 'comment', doc: r })
    }
  }
  const parents: ParentLetter[] = []
  for (const d of docs) if (docAudience(d.doc) === 'specificPeople') parents.push(await openParent(sdk, auth, repo, d.type, d.doc))
  return { parents, membersOnlyParent: repo.visibility === 'private' || docs.some((d) => docAudience(d.doc) === 'members') }
}

/**
 * The identities a composer's plan may name, refusal or not: the writer, the people asked for,
 * the groups' people now, the parents' people (whose keys it reads to preview the plan).
 */
export function composerCandidates(viewer: string, owner: string, members: readonly Membership[], ask: LetterAsk | null, parents: readonly ParentLetter[]): Set<string> {
  const out = new Set<string>([viewer])
  for (const p of ask?.people ?? []) out.add(p)
  for (const p of ask?.exact ?? []) out.add(p)
  if (ask?.group != null) for (const p of groupNow(ask.group, owner, members)) out.add(p)
  for (const parent of parents) {
    for (const r of parent.recipients) out.add(r)
    if (parent.group !== null) for (const p of groupNow(parent.group, owner, members)) out.add(p)
  }
  return out
}

/** `letterPlan`'s input for `ask` (a thread re-lists its people unless the picker gave an exact list). */
export function planInput(ask: LetterAsk | null): { request: { group: LetterGroup | null; people: readonly string[] } | null; exact: readonly string[] | null } {
  if (ask === null) return { request: null, exact: null }
  if (ask.exact !== null) return { request: null, exact: ask.exact }
  // Nobody asked for: a thread's people re-listed, else nobody to send it to (refused).
  if (ask.group === null && ask.people.length === 0) return { request: null, exact: null }
  return { request: { group: ask.group, people: ask.people }, exact: null }
}

/** What a composer shows of a message to specific people before it is posted (the plan, as the write will make it). */
export interface LetterPreview {
  /** Who it goes to (slot order, the writer first), or null when refused. */
  readonly recipients: readonly string[] | null
  /** People it would have gone to who have no usable encryption key, left out. */
  readonly skipped: readonly string[]
  readonly refusal: LetterRefusal | null
  readonly group: LetterGroup | null
  /** A thread's people re-listed as they are now (its parents' lists; empty outside a thread). */
  readonly relisted: readonly string[]
  /** People named beyond the re-listed ones: they read from this reply on (D26). */
  readonly widened: readonly string[]
  /** Each role group: how many people it is now (the owner included), and whether a message to it would be too many. */
  readonly groups: Readonly<Record<LetterGroup, { readonly count: number; readonly tooMany: boolean }>>
}

/**
 * The {@link LetterPreview} of `ask` under `thread` (pure: `letterPlan` over what the composer has
 * read; the write runs the same plan again over fresh reads). `keyless`: candidates known to have
 * no usable encryption key.
 */
export function previewLetter(i: {
  readonly owner: string
  readonly viewer: string
  readonly members: readonly Membership[]
  readonly keyless: ReadonlySet<string>
  readonly ask: LetterAsk
  readonly thread: LetterThread
}): LetterPreview {
  const members = i.members.map((m) => ({ identity: m.identity, role: m.role }))
  const base = { owner: i.owner, sender: i.viewer, members, keyless: [...i.keyless], parents: i.thread.parents, membersOnlyParent: i.thread.membersOnlyParent }
  const relistedPlan = i.thread.parents.length === 0 ? null : letterPlan({ ...base, request: null, exact: null })
  const relisted = relistedPlan === null || isLetterRefusal(relistedPlan) ? [] : relistedPlan.recipients.slice(1)
  const { request, exact } = planInput(i.ask)
  const plan = letterPlan({ ...base, request, exact })
  const groupPlan = (group: LetterGroup): { count: number; tooMany: boolean } => {
    const p = letterPlan({ ...base, parents: [], request: { group, people: [] }, exact: null })
    return { count: groupNow(group, i.owner, i.members).size, tooMany: isLetterRefusal(p) && p.error === 'tooMany' }
  }
  const groups = { maintainers: groupPlan('maintainers'), writers: groupPlan('writers') }
  if (isLetterRefusal(plan)) return { recipients: null, skipped: [], refusal: plan, group: null, relisted, widened: [], groups }
  const was = new Set([i.viewer, ...relisted])
  const widened = i.thread.parents.length === 0 ? [] : plan.recipients.filter((r) => !was.has(r))
  return { recipients: plan.recipients, skipped: plan.skipped, refusal: null, group: plan.group, relisted, widened, groups }
}

/** Everything {@link letterWriter} reads, replaceable in tests. */
export interface LetterReads {
  memberships(): Promise<readonly Membership[]>
  identityKeys(identityId: string): Promise<readonly EncKeyLike[] | null>
  heldKeyIds(): Promise<readonly number[]>
}

/** The reads of {@link letterWriter} over the SDK and this browser's vault. */
export function sdkLetterReads(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef): LetterReads {
  return {
    memberships: () => readMemberships(sdk, repo),
    identityKeys: (id) => fetchIdentityKeys(sdk, id),
    heldKeyIds: () => storedEncryptionKeyIds(auth.network, auth.identityId),
  }
}

/**
 * Random keys of write actions in this tab, by intent (else by writer), for their retry cache:
 * the cache compares what an action says under its key ({@link letterContentKey}), so a retry of
 * the same action finds its earlier attempt, never a plain hash of text sent to specific people
 * (an equality oracle at rest) and never the sealed bytes (fresh on every attempt). In memory
 * only: a reload starts a new key, as it would a new action.
 */
const intentKeys = new Map<string, Promise<CryptoKey>>()
const writerKeys = new WeakMap<LetterWriter, Promise<CryptoKey>>()
const MAX_INTENT_KEYS = 200

const newJournalKey = (): Promise<CryptoKey> => crypto.subtle.importKey('raw', randomBytes(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])

/**
 * The retry-cache key of a letter write saying `said` (a content hash) to `writer`'s people,
 * under its action `intent` (absent: the writer's own key).
 */
export async function letterContentKey(writer: LetterWriter, said: string, intent?: string): Promise<string> {
  let key = intent === undefined ? writerKeys.get(writer) : intentKeys.get(intent)
  if (key === undefined) {
    key = newJournalKey()
    if (intent === undefined) writerKeys.set(writer, key)
    else {
      if (intentKeys.size >= MAX_INTENT_KEYS) intentKeys.delete(intentKeys.keys().next().value as string)
      intentKeys.set(intent, key)
    }
  }
  const message = `write-journal:${said}:${writer.recipients.join(',')}:${writer.group ?? ''}`
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(message))))
}

/**
 * The {@link LetterWriter} of a message `auth` writes in `repo` as `ask` asks (null: the thread's
 * people re-listed) under `thread`: `letterPlan` over the member documents read now and each
 * candidate's keys read now. Refused (before signing) with the composer's words.
 */
export async function letterWriter(auth: WriteAuth, repo: RepoRef, ask: LetterAsk | null, thread: LetterThread, reads: LetterReads, nameOf: NameOf = letterNames(auth.network)): Promise<LetterWriter> {
  const viewer = auth.identityId
  const members = await reads.memberships()
  // a group's size names the group only when nothing else was asked (as dg says it)
  const onlyGroup = ask !== null && ask.people.length === 0 && ask.exact === null ? ask.group : null
  const refused = (r: LetterRefusal): LetterRefusedError => new LetterRefusedError(letterRefusalText(r, nameOf, onlyGroup), r)
  const input: LetterInput = {
    owner: repo.ownerId,
    sender: viewer,
    members: members.map((m) => ({ identity: m.identity, role: m.role })),
    keyless: [],
    ...planInput(ask),
    parents: thread.parents,
    membersOnlyParent: thread.membersOnlyParent,
  }
  // Whose keys to read: everyone it could go to (the rules' own list, as `dg` reads it).
  const candidates = letterCandidates(input)
  if (!Array.isArray(candidates)) throw refused(candidates)
  const keysOf = new Map<string, EncKeyLike | null>(
    await Promise.all(candidates.map(async (id) => [id, usableEncryptionKey((await reads.identityKeys(id)) ?? [], repo.forge.core)] as const)),
  )
  // The writer's own slot: the newest usable key of theirs this browser holds.
  const held = new Set(await reads.heldKeyIds())
  const mine = usableEncryptionKey(((await reads.identityKeys(viewer)) ?? []).filter((k) => held.has(k.keyId)), repo.forge.core)
  if (mine === null) throw new LetterRefusedError('Add your encryption key to this browser (Settings → Private repos) to send to specific people. Nothing was written.')
  keysOf.set(viewer, mine)
  const plan = letterPlan({ ...input, keyless: candidates.filter((id) => keysOf.get(id) == null) })
  if (isLetterRefusal(plan)) throw refused(plan)
  return {
    recipients: plan.recipients,
    keys: recipientKeys(plan.recipients, (id) => keysOf.get(id) as EncKeyLike),
    group: plan.group,
    skipped: plan.skipped,
    isMember: isMemberOf(viewer, repo, members),
  }
}

/** Each of `ids` (slot order) with its ENCRYPTION key, as a seal takes them. */
function recipientKeys(ids: readonly string[], keyOf: (id: string) => EncKeyLike): LetterRecipient[] {
  return ids.map((id) => ({ identityId: decodeIdentifier(id), publicKey: hexToBytes(keyOf(id).data) }))
}

/** Whether `who` holds a role in `repo` now (its owner always does): their writes carry `asMember`. */
function isMemberOf(who: string, repo: RepoRef, members: readonly Membership[]): boolean {
  return who === repo.ownerId || members.some((m) => m.identity === who)
}

/** The sealed types a message to specific people takes in this release (PRs are phase 3). */
const LETTER_TYPES: ReadonlySet<PrivateDocType> = new Set(['issue', 'comment', 'review'])

/**
 * Seal `data` (the plaintext document a public writer would post) to `writer`'s recipients: the
 * content fields go into `enc` v0x04 with the repo's `vis`, `epoch: 0` (D20), and `asMember` when
 * the writer is a member. Returns the document data to post.
 */
export async function sealLetterContent(auth: WriteAuth, repo: RepoRef, type: PrivateDocType, data: Record<string, unknown>, writer: LetterWriter): Promise<Record<string, unknown>> {
  if (type === 'event') throw new LetterRefusedError(LETTER_EVENT_VALUE_TEXT)
  if (!LETTER_TYPES.has(type)) throw new LetterRefusedError(`A ${type === 'patch' ? 'pull request' : type} can't be sent to specific people yet. Nothing was written.`)
  const owner = decodeIdentifier(auth.identityId)
  // A member's verdict counts with its proof (as `sealMembersContent`): a stale non-member's 4 / 5 is theirs (1 / 2).
  const verdict = data['verdict']
  const member = !writer.isMember ? data : verdict === 4 ? { ...data, verdict: 1 } : verdict === 5 ? { ...data, verdict: 2 } : data
  // A letter is under epoch 0 (D20): `sealContent` reads nothing else of the keys for these types.
  const zero = { epoch: 0 } as unknown as EpochKeys
  try {
    const sealed = await sealContent(zero, type, owner, member, (_k, doc, fields) =>
      sealLetterAs(auth.network, auth.identityId, { repoId: decodeIdentifier(repo.repoId), doc: { ...doc, vis: repo.visibility }, fields, recipients: writer.keys, group: writer.group }),
    )
    return writer.isMember ? { ...sealed, asMember: owner } : sealed
  } catch (e) {
    if (e instanceof TooLargeError) throw new LetterRefusedError(letterTooLongText(writer.recipients.length))
    if (e instanceof MalformedError) throw new LetterRefusedError(`This can't be sent to specific people: ${e.message}. Nothing was written.`)
    throw e
  }
}

/**
 * The {@link LetterWriter} of an edit of an opened letter (DESIGN §4.2: re-sealed to the same
 * recipients and group, with their keys now and a fresh `K_obj`): refused when a recipient no
 * longer has a usable key. The writer must still hold a usable key of theirs here.
 */
export async function editLetterWriter(auth: WriteAuth, repo: RepoRef, letter: ParentLetter, reads: LetterReads, nameOf: NameOf = letterNames(auth.network)): Promise<LetterWriter> {
  if (letter.recipients[0] !== auth.identityId) throw new LetterRefusedError('Only its author can edit this message. Nothing was written.')
  const held = new Set(await reads.heldKeyIds())
  const [members, ...keys] = await Promise.all([
    reads.memberships(),
    ...letter.recipients.map(async (id, i) => {
      const all = (await reads.identityKeys(id)) ?? []
      return usableEncryptionKey(i === 0 ? all.filter((k) => held.has(k.keyId)) : all, repo.forge.core)
    }),
  ])
  const gone = letter.recipients.filter((_, i) => i > 0 && keys[i] == null)
  if (gone.length > 0) throw new LetterRefusedError(letterEditKeylessText(gone, nameOf))
  if (keys[0] == null) throw new LetterRefusedError('Add your encryption key to this browser (Settings → Private repos) to edit this message. Nothing was written.')
  return {
    recipients: letter.recipients,
    keys: recipientKeys(letter.recipients, (id) => keys[letter.recipients.indexOf(id)] as EncKeyLike),
    group: letter.group,
    skipped: [],
    isMember: isMemberOf(auth.identityId, repo, members as readonly Membership[]),
  }
}

/**
 * The `enc` / `epoch` / `asMember` a replace of an opened letter (issue or comment) posts: its
 * content re-sealed as a whole to the same people ({@link editLetterWriter}).
 */
export async function sealLetterEdit(
  auth: WriteAuth,
  repo: RepoRef,
  type: 'issue' | 'comment',
  bind: Record<string, unknown>,
  current: Readonly<Record<string, unknown>>,
  changes: Readonly<Record<string, unknown>>,
  writer: LetterWriter,
  imported?: Readonly<Record<string, unknown>> | null,
): Promise<Record<string, unknown>> {
  const sealed = await sealLetterContent(auth, repo, type, editFields(type, bind, current, changes, imported), writer)
  return { enc: sealed['enc'], epoch: sealed['epoch'], ...(sealed['asMember'] !== undefined ? { asMember: sealed['asMember'] } : {}) }
}

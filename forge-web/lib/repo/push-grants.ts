/**
 * A bot's push access (phase 4E; mixed-visibility DESIGN §4.9 "Pushing", D42, §10 "Bots and
 * runners"; `docs/security/private-repos.md` §24): a repository's `pushGrant` documents, a bot's
 * access read together with its Bot row, the maintainers and its access notice, the marks readers
 * put on a bot's pushes, and a maintainer's changes (give, renew, suspend, resume, remove). The
 * pure rules are `lib/rules/push-grant.ts`; the CLI's twin is forge-core `push_grants` and
 * `collab::v2::bot_push` with `dg bot allow --push | renew | suspend | resume | revoke --push`.
 *
 * Only the mainnet contract has grants ({@link pushGrantsSupported}: forge-core declares
 * `pushGrant` and `refUpdate.pp`). Elsewhere (sakura's live set) a bot is not a member and cannot
 * push to a repository at all: nothing here reads anything more, and every change is refused
 * before signing ("Bots can't push to this repo yet.").
 *
 * - **A grant** names one Bot row and either a public branch prefix (`bot/<name>/` by default; one
 *   branch is granted as the prefix of its full name) or one members-only branch shared with the
 *   bot (its name hash under the branch key's current generation, which only a maintainer holding
 *   that key can name), until at most 90 days ahead. Only its writer deletes it.
 * - **The notice** lists the grants it gives and the runner's push rules; a newer one without
 *   `push` (any maintainer) suspends every push. Each change here writes the grants first, then the
 *   notice, through 4B's writer (`writeAccessNotice`).
 * - **The web never writes as a bot**: it never pushes under a grant.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import {
  BranchKeys,
  allowsPush,
  bytesToHex,
  emptyNotice,
  hexToBytes,
  noticeLiveAt,
  pushEntries,
  pushPolicy,
  setPush,
  currentNotices,
  dateWords,
  type AccessNotice,
  type NoticeEntry,
  type PushEntry,
  type PushPolicy,
} from '../private'
import {
  DOC_PUSH_GRANT,
  EXACT_GRANT,
  PREFIX_GRANT,
  RENEW_WINDOW_MS,
  covers,
  isExact,
  mark,
  renewDue,
  shortPrefix,
  untilFor,
  usable,
  type GrantContext,
  type PushGrant,
  type PushMark,
  type Unusable,
} from '../rules/push-grant'
import type { RefUpdate } from '../rules/types'
import type { Membership } from '../rules/v2'
import { createDocumentIdempotent, deleteDocumentIdempotent, previewCreate, previewCredits, previewDelete, queryAllDocuments, sumPreviews, type CostPreview, type PlainDocument, type WriteAuth } from '../sdk'
import { BotAccessError, NOT_A_MAINTAINER, botIdOf, noticeCredits, readAccessNotices, readAccessNoticesCached, writeAccessNotice, type Notices } from './bot-access'
import { readHeldBranches } from './branch-ring'
import { asIdentifierString, num, type RepoRef } from './contract'
import { contractHasProperty, contractHasType } from './contract-shape'
import { readMembershipsCached, readMembershipsFresh } from './members'
import { readMembersOnlyNames } from './members-branches'
import { bytesField } from './private-content'
import { contractOf, repoSource } from './source'

/** "Bots can't push to this repo yet." (DESIGN §10): the contract has no push grants. */
export const PUSH_NOT_YET = "Bots can't push to this repo yet."

/** Before the registration: a bot pushes to its own fork and opens a pull request, as anyone does. */
export const PUSH_NOT_YET_HINT = 'A bot can push to its own fork and open a pull request.'

/**
 * "Bots can't push to o/r, a private repository." (§24.1): a bot never holds a private repository's
 * key, and a prefix grant would name its branches in public. Give and Renew are refused there
 * before signing, and the page offers neither.
 */
export function privateRepoWords(display: string): string {
  return `Bots can't push to ${display}, a private repository.`
}

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------------------------
// Reading grants
// ---------------------------------------------------------------------------------------------

/**
 * Whether `repo`'s forge-core has push grants (the mainnet set): it declares `pushGrant` and
 * `refUpdate.pp`. forge-core `RepoService::push_grants_supported`.
 */
export async function pushGrantsSupported(sdk: EvoSDK, repo: RepoRef): Promise<boolean> {
  const core = contractOf(repo.forge, DOC_PUSH_GRANT)
  return (await contractHasType(sdk, core, DOC_PUSH_GRANT)) && (await contractHasProperty(sdk, core, 'refUpdate', PREFIX_GRANT))
}

/**
 * A fetched `pushGrant`, or null for one consensus would not have admitted (no bot, both or neither
 * of `scope` and `prefix`, an `until` not after it was written). forge-core `PushGrant::from_doc`.
 */
export function grantOfDoc(d: PlainDocument): PushGrant | null {
  const createdAt = d['$createdAt']
  const until = d['until']
  const untilMs = typeof until === 'bigint' ? Number(until) : until
  if (typeof createdAt !== 'number' || typeof untilMs !== 'number' || !Number.isSafeInteger(untilMs)) return null
  const prefix = typeof d['prefix'] === 'string' ? d['prefix'] : undefined
  const scopeBytes = bytesField(d, 'scope')
  const scope = scopeBytes !== undefined && scopeBytes.length === 32 ? bytesToHex(scopeBytes) : undefined
  const bot = asIdentifierString(d['botId'])
  const id = typeof d['$id'] === 'string' ? d['$id'] : ''
  const granter = typeof d['$ownerId'] === 'string' ? d['$ownerId'] : ''
  if ((prefix === undefined) === (scope === undefined) || untilMs <= createdAt || bot === '' || id === '' || granter === '') return null
  return { id, granter, bot, ...(prefix !== undefined ? { prefix } : {}), ...(scope !== undefined ? { scope } : {}), until: untilMs, createdAt }
}

/** The grant a ref update names (`pp`, else `pg`, base58), or null. forge-core `push_grant::named_grant`. */
export function namedGrant(d: PlainDocument): string | null {
  const id = asIdentifierString(d[PREFIX_GRANT]) || asIdentifierString(d[EXACT_GRANT])
  return id === '' ? null : id
}

/** Whether a ref update is a bot's push: it claims `r` 4. forge-core `push_grant::is_bot_push`. */
export function isBotPush(d: PlainDocument): boolean {
  return num(d, 'r') === 4
}

/**
 * `repo`'s push grants, oldest first: all of them, or `bot`'s (base58) only, from the `byBot` index.
 * Empty where the contract has none; documents consensus would not have admitted are left out.
 * forge-core `RepoService::read_push_grants`.
 */
export async function readPushGrants(sdk: EvoSDK, repo: RepoRef, bot?: string): Promise<PushGrant[]> {
  if (!(await contractHasType(sdk, contractOf(repo.forge, DOC_PUSH_GRANT), DOC_PUSH_GRANT))) return []
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).repoQuery(DOC_PUSH_GRANT, {
      where: bot === undefined ? [] : [['botId', '==', bot]],
      orderBy: [
        ['botId', 'asc'],
        ['$createdAt', 'asc'],
      ],
    }),
  )
  return docs
    .map(grantOfDoc)
    .filter((g): g is PushGrant => g !== null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** What a grant covers, as it is written: a public prefix (a full `refs/heads/…` name), or one members-only branch's name hash. */
export type GrantScope = { readonly prefix: string } | { readonly exact: Uint8Array }

/** A grant's scope as written, or null. */
function scopeOf(g: PushGrant): GrantScope | null {
  if (g.prefix !== undefined && g.scope === undefined) return { prefix: g.prefix }
  if (g.scope !== undefined && g.prefix === undefined && /^[0-9a-fA-F]{64}$/.test(g.scope)) return { exact: hexToBytes(g.scope.toLowerCase()) }
  return null
}

const sameScope = (a: GrantScope, b: GrantScope): boolean =>
  'prefix' in a ? 'prefix' in b && a.prefix === b.prefix : 'exact' in b && bytesToHex(a.exact) === bytesToHex(b.exact)

/**
 * Write a push grant for `bot` over `scope` until `until` (ms). The caller has checked who may write
 * it, that `bot` holds a Bot row and the bounds; consensus checks them again. Returns its id.
 * forge-core `RepoService::write_push_grant`.
 */
async function writePushGrant(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, bot: string, scope: GrantScope, until: number, intent: string): Promise<string> {
  const data: Record<string, unknown> = {
    repoId: decodeIdentifier(repo.repoId),
    botId: decodeIdentifier(bot),
    until,
    ...('prefix' in scope ? { prefix: scope.prefix } : { scope: scope.exact }),
  }
  const result = await createDocumentIdempotent(sdk, auth, { contractId: contractOf(repo.forge, DOC_PUSH_GRANT), documentType: DOC_PUSH_GRANT, data, intent })
  return result.documentId
}

/** Delete push grant `id` (only its writer can). forge-core `RepoService::delete_push_grant`. */
async function deletePushGrant(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, id: string): Promise<void> {
  await deleteDocumentIdempotent(sdk, auth, { contractId: contractOf(repo.forge, DOC_PUSH_GRANT), documentType: DOC_PUSH_GRANT, documentId: id, repo: repo.repoId })
}

// ---------------------------------------------------------------------------------------------
// A bot's push access
// ---------------------------------------------------------------------------------------------

/** A bot's push access to one repository as clients read it now (forge-core `BotPushAccess`). */
export interface BotPushAccess {
  /** The bot (base58). */
  readonly bot: string
  /** Whether the contract has push grants at all (the mainnet set). */
  readonly supported: boolean
  /** Every grant naming the bot, oldest first, usable or not. */
  readonly grants: readonly PushGrant[]
  /** When the bot's current Bot row was written; null when it holds none. */
  readonly botRowAt: number | null
  /** The current maintainers (base58): a grant counts only while its granter is one. */
  readonly maintainers: ReadonlySet<string>
  /** The bot's current access notice, if any. */
  readonly notice: NoticeEntry | null
  /** When this was read (ms). */
  readonly now: number
}

/** What a page reads once for every bot of a repository. */
export interface PushState {
  readonly supported: boolean
  /** Every grant of the repository, oldest first. */
  readonly grants: readonly PushGrant[]
  readonly members: readonly Membership[]
  readonly now: number
}

/** When `bot`'s current Bot row was written, from `members`; null when it holds none. */
export function botRowAt(members: readonly Membership[], bot: string): number | null {
  return members.find((m) => m.identity === bot && m.role === 'bot')?.createdAt ?? null
}

/** `bot`'s push access from what a page read ({@link readPushState}) and its current notice. */
export function pushAccessOf(state: PushState, bot: string, notice: NoticeEntry | null): BotPushAccess {
  return {
    bot,
    supported: state.supported,
    grants: state.grants.filter((g) => g.bot === bot),
    botRowAt: botRowAt(state.members, bot),
    maintainers: new Set(state.members.filter((m) => m.role === 'maintainer').map((m) => m.identity)),
    notice,
    now: state.now,
  }
}

/** What {@link usable} judges `a`'s grants against. */
export function grantContext(a: BotPushAccess): GrantContext {
  return { now: a.now, botRowAt: a.botRowAt, maintainers: a.maintainers }
}

/** The grants of `a` that can be pushed under now. */
export function liveGrants(a: BotPushAccess): PushGrant[] {
  const ctx = grantContext(a)
  return a.grants.filter((g) => usable(g, ctx) === null)
}

/**
 * Whether a maintainer suspended the bot's pushes: its current notice does not allow pushing (a
 * notice that has ended allows nothing). With no notice at all the grants alone decide.
 * forge-core `BotPushAccess::suspended`.
 */
export function suspended(a: BotPushAccess): boolean {
  return a.notice !== null && (!noticeLiveAt(a.notice.notice, a.now) || !allowsPush(a.notice.notice))
}

/**
 * Who suspended `a`'s pushes (base58), when giving it push access lets it push again: its current
 * notice is in force without push while it still holds push access (as the page's "@ci-bot's
 * pushes are suspended."). Null otherwise: a bot never given push access, or one whose access has
 * ended (Give is refused then).
 */
export function suspendedBy(a: BotPushAccess): string | null {
  if (a.notice === null || !noticeLiveAt(a.notice.notice, a.now) || allowsPush(a.notice.notice)) return null
  return liveGrants(a).length > 0 ? a.notice.writer : null
}

/**
 * Every grant of `repo` and its members, read for a page (memberships through the page cache).
 * `supported` false, with nothing else read, where the contract has no grants.
 */
export async function readPushState(sdk: EvoSDK, repo: RepoRef): Promise<PushState> {
  const now = Date.now()
  if (!(await pushGrantsSupported(sdk, repo))) return { supported: false, grants: [], members: [], now }
  const [grants, members] = await Promise.all([readPushGrants(sdk, repo), readMembershipsCached(sdk, repo)])
  return { supported: true, grants, members, now }
}

/**
 * `bot`'s (base58) push access to `repo` now, read fresh for a change: its grants, its Bot row, the
 * maintainers and its current notice. forge-core `Collab::bot_push_access`.
 */
export async function readBotPushAccess(sdk: EvoSDK, repo: RepoRef, bot: string): Promise<BotPushAccess> {
  const now = Date.now()
  if (!(await pushGrantsSupported(sdk, repo))) return pushAccessOf({ supported: false, grants: [], members: [], now }, bot, null)
  const [grants, members, notices] = await Promise.all([readPushGrants(sdk, repo, bot), readMembershipsFresh(sdk, repo), readAccessNotices(sdk, repo)])
  return pushAccessOf({ supported: true, grants, members, now }, bot, notices.current.get(bot) ?? null)
}

// ---------------------------------------------------------------------------------------------
// Members-only branches a maintainer can grant
// ---------------------------------------------------------------------------------------------

/**
 * A members-only branch a maintainer can grant one bot: a branch with its own key that this
 * maintainer holds, with its name hash under each generation of that key (forge-core
 * `GrantableBranch`). An exact grant names the current one; a grant naming an earlier one stopped
 * working at the new generation and is given again by Renew.
 */
export interface GrantableBranch {
  /** The full ref name. */
  readonly name: string
  /** Its name hash under the current generation, lowercase hex. */
  readonly current: string
  /** Its name hashes under earlier generations, lowercase hex. */
  readonly earlier: readonly string[]
  /** Who it is for now (base58). */
  readonly audienceNow: ReadonlySet<string>
}

/**
 * The branches with their own key this maintainer holds in a public repository, with their name
 * hashes per generation (forge-core `Collab::grantable_branches`). Empty in a private repository,
 * or without a members session. Never rejects: a ring that cannot be read gives none.
 */
export async function readGrantableBranches(sdk: EvoSDK, repo: RepoRef): Promise<GrantableBranch[]> {
  if (repo.visibility !== 'public') return []
  const held = await readHeldBranches(sdk, repo).catch(() => null)
  if (held === null) return []
  const repoId = decodeIdentifier(repo.repoId)
  const out: GrantableBranch[] = []
  for (const b of held.ring.branches.values()) {
    const hashes: string[] = []
    for (const [g, k] of b.keys.entries()) hashes.push(bytesToHex(await (await BranchKeys.derive(repoId, g, k)).refNameHash(b.name)))
    const current = hashes[hashes.length - 1]
    if (current === undefined) continue
    out.push({ name: b.name, current, earlier: hashes.slice(0, -1), audienceNow: held.people.get(b.name) ?? new Set() })
  }
  return out
}

/** The branch an exact grant's name hash (hex) names among `branches`, under any generation. */
export function branchOfScope(branches: readonly GrantableBranch[], scope: string): GrantableBranch | undefined {
  const h = scope.toLowerCase()
  return branches.find((b) => b.current === h || b.earlier.includes(h))
}

/**
 * Whether exact grant `g` names a branch of `branches` by its hash under an earlier key generation:
 * it stopped working when the branch got a new key, and Renew gives it again under the current
 * one. forge-core `dg bot`'s `stale`.
 */
export function isStale(g: PushGrant, branches: readonly GrantableBranch[]): boolean {
  const h = g.scope?.toLowerCase()
  return h !== undefined && branches.some((b) => b.earlier.includes(h))
}

/** A branch's short name (`fix-auth`). */
export function shortBranch(name: string): string {
  return name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name
}

// ---------------------------------------------------------------------------------------------
// What the page says about a bot's push access (DESIGN §10; `dg bot list`)
// ---------------------------------------------------------------------------------------------

/** One line about a grant that needs a maintainer's attention, with what it is about. */
export type PushNote =
  /** "@ci-bot's push access to bot/ci-bot/ ends in 9 days." Renew. */
  | { readonly kind: 'renewDue'; readonly grant: PushGrant; readonly what: string; readonly days: number }
  /** "@m let @ci-bot push here; this isn't in @ci-bot's access settings." */
  | { readonly kind: 'notInNotice'; readonly grant: PushGrant; readonly what: string }
  /** "@ci-bot can no longer push to fix-auth: the branch's key changed." Renew. */
  | { readonly kind: 'stale'; readonly grant: PushGrant; readonly what: string }
  /** "@ci-bot's push access ended on 7 Nov 2026." Renew. */
  | { readonly kind: 'expired'; readonly grant: PushGrant; readonly what: string }
  /** "@ci-bot can no longer push to bot/ci-bot/: @m is no longer a maintainer." Give access again. */
  | { readonly kind: 'granterGone'; readonly grant: PushGrant; readonly what: string }
  /** "@ci-bot had push access to bot/ci-bot/ before it was removed. It won't come back; give it again if you want." */
  | { readonly kind: 'olderThanRow'; readonly grant: PushGrant; readonly what: string }

/** What the page shows of a bot's push access. */
export interface PushSummary {
  /** A maintainer suspended its pushes, and it has push access to suspend. */
  readonly suspended: boolean
  /** "Can push to bot/ci-bot/ until 7 Nov 2026 and 1 members-only branch." (not when suspended): its prefixes and how many members-only branches. */
  readonly prefixes: readonly (readonly [string, number])[]
  readonly membersBranches: number
  readonly notes: readonly PushNote[]
  /** The grants it can push under now (not a stale one: its branch got a new key). */
  readonly live: readonly PushGrant[]
  /** Who gave the live grants (base58), each once. */
  readonly granters: readonly string[]
  /** Whether Renew has something to renew: a grant that is not older than the bot's row. */
  readonly renewable: boolean
}

/**
 * What the page says of `a` (forge-core `dg bot list`'s `describe`): the push line, then a note per
 * grant that needs attention. A grant replaced by a newer usable one over the same branches says
 * nothing more. `branches` (the members-only branches this reader holds the key of) name an exact
 * grant's branch, and tell a stale one: it names an earlier key's hash, so it is neither counted
 * nor live.
 */
export function summarizePush(a: BotPushAccess, branches: readonly GrantableBranch[] = []): PushSummary {
  const ctx = grantContext(a)
  const branchName = (scope: string): string | null => {
    const b = branchOfScope(branches, scope)
    return b === undefined ? null : shortBranch(b.name)
  }
  const listed = new Set((a.notice === null ? [] : (pushEntries(a.notice.notice) ?? [])).map((e) => bytesToHex(e.grant)))
  // a suspension leaves every grant out on purpose: the suspended line says it once
  const isSuspended = suspended(a)
  const notes: PushNote[] = []
  const prefixes: [string, number][] = []
  let membersBranches = 0
  for (const g of a.grants) {
    // only a newer grant that can itself be pushed under replaces it (a removed granter's newer
    // grant hides nothing)
    const superseded = a.grants.some((o) => o.createdAt > g.createdAt && o.prefix === g.prefix && o.scope === g.scope && usable(o, ctx) === null)
    if (superseded) continue
    const what = g.prefix !== undefined ? shortPrefix(g.prefix) : (branchName(g.scope ?? '') ?? 'a members-only branch')
    const status = usable(g, ctx)
    if (status === null && isStale(g, branches)) notes.push({ kind: 'stale', grant: g, what })
    else if (status === null) {
      if (isExact(g)) membersBranches += 1
      else prefixes.push([g.prefix ?? '', g.until])
      if (renewDue(g, a.now)) notes.push({ kind: 'renewDue', grant: g, what, days: Math.min(Math.ceil((g.until - a.now) / DAY_MS), RENEW_WINDOW_MS / DAY_MS) })
      if (a.notice !== null && !isSuspended && !listed.has(idHex(g.id))) notes.push({ kind: 'notInNotice', grant: g, what })
    } else if (status === 'expired') notes.push({ kind: 'expired', grant: g, what })
    else if (status === 'granterGone') notes.push({ kind: 'granterGone', grant: g, what })
    else if (status === 'olderThanBotRow') notes.push({ kind: 'olderThanRow', grant: g, what })
  }
  const live = liveGrants(a).filter((g) => !isStale(g, branches))
  return {
    suspended: isSuspended && (prefixes.length > 0 || membersBranches > 0),
    prefixes,
    membersBranches,
    notes,
    live,
    granters: [...new Set(live.map((g) => g.granter))].sort(),
    renewable: a.grants.some((g) => !isOlderOrGone(usable(g, ctx))),
  }
}

const isOlderOrGone = (u: Unusable | null): boolean => u === 'olderThanBotRow' || u === 'notABot'

/** A grant id (base58) as a notice lists it (hex); '' for one that does not decode. */
function idHex(id: string): string {
  try {
    return bytesToHex(decodeIdentifier(id))
  } catch {
    return ''
  }
}

/** A note's words, for `bot` and the grant's granter as the copy names them (`@ci-bot`, `@m`). */
export function pushNoteWords(n: PushNote, bot: string, granter: string): string {
  switch (n.kind) {
    case 'renewDue':
      return `${bot}'s push access to ${n.what} ends in ${n.days === 1 ? '1 day' : `${n.days} days`}.`
    case 'notInNotice':
      return `${granter} let ${bot} push here; this isn't in ${bot}'s access settings.`
    case 'stale':
      return `${bot} can no longer push to ${n.what}: the branch's key changed.`
    case 'expired':
      return `${bot}'s push access ended on ${dateWords(n.grant.until)}.`
    case 'granterGone':
      return `${bot} can no longer push to ${n.what}: ${granter} is no longer a maintainer.`
    case 'olderThanRow':
      return `${bot} had push access to ${n.what} before it was removed. It won't come back; give it again if you want.`
  }
}

// ---------------------------------------------------------------------------------------------
// Readers' marks on a bot's pushes (§24.5)
// ---------------------------------------------------------------------------------------------

/**
 * How readers mark each bot push among `updates` (those that claim `r` 4 and so carry `botPush`; the
 * others are left out): {@link mark} against the grant it named, the bot's current Bot row and the
 * bot's notice in force when it landed (the newest by the owner or a then-current maintainer).
 * forge-core `Collab::bot_push_marks`.
 */
export function botPushMarks(
  updates: readonly RefUpdate[],
  grants: readonly PushGrant[],
  members: readonly Membership[],
  notices: Pick<Notices, 'all'>,
  owner: string,
): Map<string, PushMark> {
  const out = new Map<string, PushMark>()
  const maintainers = new Set(members.filter((m) => m.role === 'maintainer').map((m) => m.identity))
  for (const u of updates) {
    if (u.botPush === undefined) continue
    const at = u.createdAt
    const id = u.botPush.grant
    const grant = id === null ? null : (grants.find((g) => g.id === id) ?? null)
    const then = notices.all.filter((e) => e.createdAt <= at && botIdOf(e.notice) === u.author)
    const counted = [...currentNotices(then, (w) => w === owner || maintainers.has(w)).values()][0]
    const allows = counted === undefined ? null : noticeLiveAt(counted.notice, at) && allowsPush(counted.notice)
    out.set(u.id, mark(at, grant, botRowAt(members, u.author), allows))
  }
  return out
}

/**
 * The bots (base58) among `members`, and how each bot push among `updates` is marked, read only
 * where the contract has push grants and some update is a bot's (nothing more is read otherwise).
 */
export async function readBotPushMarks(sdk: EvoSDK, repo: RepoRef, updates: readonly RefUpdate[]): Promise<{ readonly bots: ReadonlySet<string>; readonly marks: ReadonlyMap<string, PushMark> }> {
  const none = { bots: new Set<string>(), marks: new Map<string, PushMark>() }
  if (!(await pushGrantsSupported(sdk, repo))) return none
  const members = await readMembershipsCached(sdk, repo)
  const bots = new Set(members.filter((m) => m.role === 'bot').map((m) => m.identity))
  if (!updates.some((u) => u.botPush !== undefined)) return { bots, marks: new Map() }
  const [grants, notices] = await Promise.all([readPushGrants(sdk, repo), readAccessNoticesCached(sdk, repo)])
  return { bots, marks: botPushMarks(updates, grants, members, notices, repo.ownerId) }
}

/**
 * The bots (base58) of `repo` whose pushes the branch list names ("pushed by @ci-bot (bot)"):
 * read only where the contract has push grants, else none (sakura: nothing more is read).
 */
export async function readPushingBots(sdk: EvoSDK, repo: RepoRef): Promise<ReadonlySet<string>> {
  if (!(await pushGrantsSupported(sdk, repo))) return new Set()
  return new Set((await readMembershipsCached(sdk, repo)).filter((m) => m.role === 'bot').map((m) => m.identity))
}

// ---------------------------------------------------------------------------------------------
// A maintainer's changes
// ---------------------------------------------------------------------------------------------

/** One grant a maintainer asks for: what it covers and how the copy names it (`bot/ci-bot/`, `fix-auth`). */
export interface GrantRequest {
  readonly scope: GrantScope
  readonly label: string
}

/** Who and where: the bot (base58), how the copy names it (`@ci-bot`) and the repo (`o/r`). */
export interface PushAbout {
  readonly bot: string
  readonly name: string
  readonly display: string
}

/**
 * What the maintainer reads before signing a grant (DESIGN §10, "Push"): "@ci-bot will be able to
 * push to branches starting with bot/ci-bot/ until 7 Nov 2026. It can't push to protected branches.
 * Everything it pushes to a public branch is public."
 */
export function grantWords(name: string, r: GrantRequest, until: number): string {
  const date = dateWords(until)
  if ('exact' in r.scope) return `${name} can push to ${r.label}, a branch shared with it, until ${date}. It never gets the key to other members-only content.`
  const rest = "It can't push to protected branches. Everything it pushes to a public branch is public."
  if (r.scope.prefix.endsWith('/')) return `${name} will be able to push to branches starting with ${r.label} until ${date}. ${rest}`
  return `${name} will be able to push to ${r.label} (and any branch whose name starts with ${r.label}) until ${date}. ${rest}`
}

/** The notice's entry for grant `id` (base58) over `scope`. */
function entryOf(id: string, scope: GrantScope): PushEntry {
  return { grant: decodeIdentifier(id), target: 'prefix' in scope ? { prefix: scope.prefix } : { members: scope.exact } }
}

/** The entries of `a`'s grants that can be pushed under now: not a stale one among `branches` ({@link isStale}). */
function liveEntries(a: BotPushAccess, branches: readonly GrantableBranch[]): PushEntry[] {
  return liveGrants(a).flatMap((g) => {
    const s = scopeOf(g)
    return s === null || isStale(g, branches) ? [] : [entryOf(g.id, s)]
  })
}

/** The members-only branches this maintainer holds the key of, read only when `a` has an exact grant (to tell a stale one). */
async function branchesFor(sdk: EvoSDK, repo: RepoRef, a: BotPushAccess): Promise<GrantableBranch[]> {
  return a.grants.some(isExact) ? readGrantableBranches(sdk, repo) : []
}

/** Refuse, before signing, push access to a private repository (forge-core `dg bot`'s `require_public`). */
function requirePublic(repo: RepoRef, about: PushAbout): void {
  if (repo.visibility !== 'public') throw new BotAccessError(`${privateRepoWords(about.display)} Nothing was written.`)
}

/** Why a prefix can't be checked: the repo has members-only branches this maintainer can't open now. */
export const MEMBERS_UNCHECKED = "This repo has members-only branches you can't open, so a branch prefix can't be checked against them."

/**
 * Why `requests` can't be given (forge-core `dg bot`'s `refuse_members_names`), or null: a public
 * prefix that is or covers a members-only branch's name would name it in public (the grant and the
 * notice are plaintext), so only branches shared with the bot are given, as exact grants. `names`
 * are the members-only names this maintainer opens ({@link readMembersOnlyNames}); null, when the
 * repo has some they can't open, refuses any prefix.
 */
export function membersNameRefusal(requests: readonly GrantRequest[], names: readonly string[] | null): string | null {
  const prefixes = requests.flatMap((r) => ('prefix' in r.scope ? [r.scope.prefix] : []))
  if (prefixes.length === 0) return null
  if (names === null) return MEMBERS_UNCHECKED
  const hit = names.find((n) => prefixes.some((p) => n.startsWith(p)))
  return hit === undefined ? null : `${shortBranch(hit)} is a members-only branch: only branches shared with the bot can be given.`
}

/** {@link membersNameRefusal} read now, thrown before signing. */
async function refuseMembersNames(sdk: EvoSDK, repo: RepoRef, requests: readonly GrantRequest[]): Promise<void> {
  if (!requests.some((r) => 'prefix' in r.scope)) return
  const why = membersNameRefusal(requests, await readMembersOnlyNames(sdk, repo))
  if (why === null) return
  throw new BotAccessError(
    `${why} Nothing was written.`,
    why === MEMBERS_UNCHECKED ? 'unlock members-only content first, or ask a maintainer who can open those branches' : 'share that branch with the bot and give it instead of the prefix',
  )
}

/** The bot's current notice to build on, revoking it, or one allowing nothing. */
function nextNotice(a: BotPushAccess): AccessNotice {
  if (a.notice === null) return emptyNotice(decodeIdentifier(a.bot))
  return { ...a.notice.notice, revokes: [hexToBytes(a.notice.packHash)] }
}

/** Read `about.bot`'s access for a change, refused before signing where bots can't push, or for someone who is not a maintainer. */
async function openChange(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, about: PushAbout): Promise<BotPushAccess> {
  const a = await readBotPushAccess(sdk, repo, about.bot)
  if (!a.supported) throw new BotAccessError(`${PUSH_NOT_YET} Nothing was written.`)
  if (auth.identityId !== repo.ownerId && !a.maintainers.has(auth.identityId)) throw new BotAccessError(NOT_A_MAINTAINER)
  return a
}

/** Only a maintainer row holder writes a grant (its writer must be a current maintainer at consensus). */
function requireGranter(a: BotPushAccess, auth: WriteAuth): void {
  if (!a.maintainers.has(auth.identityId)) {
    throw new BotAccessError('Only maintainers can give a bot push access, and you are not one in this repo. Nothing was written.', 'add yourself as a maintainer under Settings → Members first')
  }
}

/** Write the notice after the grants: the grants stay if it fails, so say what to do. */
async function writeNoticeAfter(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, notice: AccessNotice, about: PushAbout): Promise<void> {
  try {
    await writeAccessNotice(sdk, auth, repo, notice, { name: about.name, display: about.display })
  } catch (e) {
    throw new BotAccessError(`The push access was written, but ${about.name}'s access settings couldn't be saved.`, 'reload the page and try again: the access settings show what is missing', e)
  }
}

/** When push access asked for until `requested` (ms; null: 30 days) at `now` ends, or why not. */
export function pushUntil(now: number, requested: number | null): number | { readonly error: string } {
  // the last ms of the 90th day is a day past the bound: brought in, not refused
  if (requested !== null && requested > now + 91 * DAY_MS) return { error: 'Push access lasts at most 90 days.' }
  const got = untilFor(now, requested === null ? null : Math.min(requested, now + 90 * DAY_MS))
  return 'until' in got ? got.until : { error: got.refused === 'past' ? 'That date has passed.' : 'Push access lasts at most 90 days.' }
}

/**
 * What a change costs (an upper bound): `grants` new grants, `deletes` deleted ones (refunds) and
 * the notice. Push access is only ever given in a public repository, so its notice is a public one.
 */
export function pushChangeCost(grants: number, deletes = 0): CostPreview {
  return sumPreviews([
    ...Array.from({ length: grants }, () => previewCreate(DOC_PUSH_GRANT, { prefix: 'refs/heads/bot/ci-bot/' })),
    ...Array.from({ length: deletes }, () => previewDelete(DOC_PUSH_GRANT)),
    previewCredits(noticeCredits(false)),
  ])
}

/**
 * Give `about.bot` push access to each of `requests` until `until`, with `policy` (forge-core `dg bot
 * allow --push`): checked before anything is signed (the contract has grants, the repo is public,
 * the signer is a maintainer, the bot holds a Bot row, the end date, no prefix names a members-only
 * branch), then one grant each, then the notice listing them beside the live grants it already
 * listed. A suspended bot pushes again under the new grants (the dialog says so first).
 */
export async function givePush(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  about: PushAbout,
  input: { readonly requests: readonly GrantRequest[]; readonly until: number; readonly policy: PushPolicy },
  intent: string,
): Promise<void> {
  const a = await openChange(sdk, auth, repo, about)
  requirePublic(repo, about)
  requireGranter(a, auth)
  if (a.botRowAt === null) throw new BotAccessError(`${about.name} isn't a bot of ${about.display}: push access is for bots. Nothing was written.`, 'add it as a bot under Settings → Members first')
  if (input.requests.length === 0) throw new BotAccessError('Choose a branch or a branch prefix. Nothing was written.')
  if (a.notice !== null && !noticeLiveAt(a.notice.notice, a.now)) {
    throw new BotAccessError(`${about.name}'s access has ended, so it couldn't push. Nothing was written.`, 'change its access first')
  }
  const until = pushUntil(a.now, input.until)
  if (typeof until !== 'number') throw new BotAccessError(`${until.error} Nothing was written.`)
  await refuseMembersNames(sdk, repo, input.requests)
  const base = nextNotice(a)
  const live = new Set(liveGrants(a).map((g) => idHex(g.id)))
  const entries = (pushEntries(base) ?? []).filter((e) => live.has(bytesToHex(e.grant)))
  for (const [i, r] of input.requests.entries()) {
    const id = await writePushGrant(sdk, auth, repo, about.bot, r.scope, until, `${intent}:grant:${i}`)
    entries.push(entryOf(id, r.scope))
  }
  await writeNoticeAfter(sdk, auth, repo, setPush(base, entries, input.policy), about)
}

/**
 * What Renew would give again (forge-core `dg bot renew`): per branch or prefix, the newest grant a
 * renewal brings back (not one older than the bot's row: that access doesn't come back), with every
 * older grant over it. A members-only branch's grant is given again under the branch key's current
 * generation, only while this maintainer holds that key and the bot is among its people.
 */
export function renewPlan(a: BotPushAccess, branches: readonly GrantableBranch[]): { readonly request: GrantRequest; readonly old: readonly PushGrant[] }[] {
  const ctx = grantContext(a)
  const todo: { request: GrantRequest; old: PushGrant[] }[] = []
  for (const g of [...a.grants].reverse()) {
    if (isOlderOrGone(usable(g, ctx))) continue
    const scope = scopeOf(g)
    if (scope === null) continue
    let request: GrantRequest
    if ('prefix' in scope) request = { scope, label: shortPrefix(scope.prefix) }
    else {
      const b = branchOfScope(branches, bytesToHex(scope.exact))
      if (b === undefined || !b.audienceNow.has(a.bot)) continue
      request = { scope: { exact: hexToBytes(b.current) }, label: shortBranch(b.name) }
    }
    const same = todo.find((t) => sameScope(t.request.scope, request.scope))
    if (same !== undefined) same.old.push(g)
    else todo.push({ request, old: [g] })
  }
  return todo
}

/**
 * Renew `about.bot`'s push access until `until` (forge-core `dg bot renew`): a new grant per branch
 * or prefix (a stale exact grant written again under the branch's current key), the signer's own
 * old grants over them deleted (best effort: they end anyway), and the notice listing the new ones.
 * Refused before signing in a private repo, and for a prefix that now names a members-only branch.
 * A suspended bot stays suspended: renewing gives time, not the push back, and writes no notice.
 */
export async function renewPush(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, about: PushAbout, until: number, intent: string): Promise<{ readonly renewed: number; readonly stillSuspended: boolean }> {
  const a = await openChange(sdk, auth, repo, about)
  requirePublic(repo, about)
  requireGranter(a, auth)
  if (a.botRowAt === null) throw new BotAccessError(`${about.name} isn't a bot of ${about.display}: push access is for bots. Nothing was written.`)
  const end = pushUntil(a.now, until)
  if (typeof end !== 'number') throw new BotAccessError(`${end.error} Nothing was written.`)
  const branches = await branchesFor(sdk, repo, a)
  const plan = renewPlan(a, branches)
  if (plan.length === 0) throw new BotAccessError(`${about.name} has no push access to ${about.display} to renew. Nothing was written.`, 'give it push access instead')
  await refuseMembersNames(
    sdk,
    repo,
    plan.map((t) => t.request),
  )
  const replaced = new Set(plan.flatMap((t) => t.old.map((g) => idHex(g.id))))
  const entries = liveEntries(a, branches).filter((e) => !replaced.has(bytesToHex(e.grant)))
  for (const [i, t] of plan.entries()) {
    const id = await writePushGrant(sdk, auth, repo, about.bot, t.request.scope, end, `${intent}:renew:${i}`)
    entries.push(entryOf(id, t.request.scope))
    for (const g of t.old.filter((o) => o.granter === auth.identityId)) await deletePushGrant(sdk, auth, repo, g.id).catch(() => undefined)
  }
  if (suspended(a)) return { renewed: plan.length, stillSuspended: true }
  const base = nextNotice(a)
  await writeNoticeAfter(sdk, auth, repo, setPush(base, entries, pushPolicy(base)), about)
  return { renewed: plan.length, stillSuspended: false }
}

/**
 * Suspend `about.bot`'s pushes (any maintainer; forge-core `dg bot suspend`): a newer notice without
 * `push`. The runner stops at once; only the granter or the owner can remove the grants.
 */
export async function suspendPush(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, about: PushAbout): Promise<void> {
  const a = await openChange(sdk, auth, repo, about)
  if (suspended(a) || liveGrants(a).length === 0) throw new BotAccessError(`${about.name} doesn't push to ${about.display} now. Nothing was written.`)
  const base = nextNotice(a)
  await writeAccessNotice(sdk, auth, repo, setPush(base, [], pushPolicy(base)), { name: about.name, display: about.display })
}

/** Let a suspended bot push again under the grants it still has (forge-core `dg bot resume`). */
export async function resumePush(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, about: PushAbout): Promise<void> {
  const a = await openChange(sdk, auth, repo, about)
  const entries = liveEntries(a, await branchesFor(sdk, repo, a))
  if (entries.length === 0) throw new BotAccessError(`${about.name} has no push access to ${about.display} to resume. Nothing was written.`, 'give it push access instead')
  const base = nextNotice(a)
  await writeAccessNotice(sdk, auth, repo, setPush(base, entries, pushPolicy(base)), { name: about.name, display: about.display })
}

/**
 * Delete every live grant this signer wrote for `bot` (only a grant's writer can); how many. Nothing
 * where the contract has no grants. forge-core `dg bot`'s `delete_own_grants`.
 */
export async function deleteOwnGrants(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, bot: string): Promise<number> {
  if (!(await pushGrantsSupported(sdk, repo))) return 0
  const now = Date.now()
  const mine = (await readPushGrants(sdk, repo, bot)).filter((g) => g.granter === auth.identityId && g.until > now)
  for (const g of mine) await deletePushGrant(sdk, auth, repo, g.id)
  return mine.length
}

/**
 * Remove the push access this maintainer gave `about.bot` (forge-core `dg bot revoke --push`): their
 * grants are deleted, and the notice lists what other maintainers gave (or no push at all). What it
 * pushed stays. A suspended bot stays suspended: its notice already lists no push, and none is
 * written (writing the others' grants back would lift another maintainer's suspension).
 */
export async function removeMyPush(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, about: PushAbout): Promise<void> {
  const a = await openChange(sdk, auth, repo, about)
  if (!a.grants.some((g) => g.granter === auth.identityId)) throw new BotAccessError(`You gave ${about.name} no push access to ${about.display}. Nothing was written.`, 'to stop it pushing at once, suspend its pushes')
  const base = nextNotice(a)
  const rest = liveEntries({ ...a, grants: a.grants.filter((g) => g.granter !== auth.identityId) }, await branchesFor(sdk, repo, a))
  await deleteOwnGrants(sdk, auth, repo, about.bot)
  if (base.may.includes('push') && !suspended(a)) await writeNoticeAfter(sdk, auth, repo, setPush(base, rest, pushPolicy(base)), about)
}

/** Whether `r` covers the default branch `defaultBranch` (the dialog warns when that branch is unprotected). */
export function coversBranch(r: GrantRequest, branch: string): boolean {
  return 'prefix' in r.scope && covers({ id: '', granter: '', bot: '', prefix: r.scope.prefix, until: 1, createdAt: 0 }, { public: `refs/heads/${branch}` })
}

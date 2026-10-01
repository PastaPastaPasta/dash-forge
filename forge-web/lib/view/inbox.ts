/**
 * The local notifications inbox (`ux-dx-spec.md` §5.10). Computed in this browser from the
 * chain; nothing is sent anywhere, and there is no email, push or cross-device sync.
 *
 * **Subscriptions** (recomputed every {@link SUBS_TTL_MS}): repos I own or belong to (`repo` by
 * `$ownerId`, `maintainer`/`writer` by `memberId`), repos I starred (opt-in, `star.byOwner`),
 * and the issues and PRs I opened (`issue`/`patch` `author`), commented on (`comment.author`
 * → `targetId`), was assigned to or asked to review (`event.addressee`, QW2-009), and those this
 * browser saw me review or be mentioned in (`./participation`: neither has an index). Both sets
 * are capped ({@link MAX_REPOS}, {@link MAX_THREADS}), newest first.
 *
 * **Reasons** (QW2-056): each item says why it reached me when that is more than following the
 * thread (assigned me, requested my review, mentioned me), and each thread why I follow it, so
 * the inbox filters by Assigned, Participating, Mentioned and Review requested, as GitHub's.
 *
 * **Feeds**, one proof-checked query each, `$createdAt > cursor` ascending, {@link PAGE} rows:
 *   - my repos: new issues and PRs (`issue`/`patch` `created`), pushes (opt-in, the reflogs);
 *   - repos holding my threads: what happened on those threads (`event` `feed`: labels, assignees)
 *     and their state changes (`transition` `feed`);
 *   - each thread: comments (`comment.target`); each PR I opened: reviews (`review.patch`).
 * A poll runs at most {@link ROUND_BUDGET} feeds, round-robin, so a big watch list is spread
 * over several minutes instead of bursting DAPI. My own documents never become items.
 *
 * State (items, per-feed cursors, subscriptions, prefs) lives in the IndexedDB `inbox` store,
 * keyed `<network>:<identity>:…`, so two identities on one device never mix.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { z } from 'zod'

import type { Network } from '../constants'
import type { ForgeIds } from '../deployments'
import { idbBatch, idbDelete, idbEntries, idbGet, idbPut } from '../idb'
import { DOC } from '../repo/contract'
import { contractOf } from '../repo/source'
import { queryDocumentsWithProof, type DocumentQuery, type PlainDocument } from '../sdk'
import { listReposByOwner } from './discovery'
import { listParticipation, noteParticipation } from './participation'
import {
  baseDoc,
  eventDoc,
  ident,
  int,
  listAddressedTargets,
  listMyCommentTargets,
  listMyTargets,
  listStarredRepoIds,
  listWatchedRepoIds,
  mentions,
  parseDocs,
  readReposByIds,
  readTargetsByIds,
  repoLite,
  targetDoc,
  titleOf,
  type RepoLite,
  type TargetRow,
} from './mine'

/** The empty-state sentence (spec §5.10, verbatim). */
export const INBOX_EMPTY = 'Notifications are computed in this browser from the chain. Nothing is sent to you; nothing leaves your device.'

/** Poll interval while a tab is open and visible. */
export const POLL_MS = 60_000
/** How long a computed subscription set is reused. */
export const SUBS_TTL_MS = 15 * 60_000
export const MAX_REPOS = 20
export const MAX_THREADS = 30
/** Feeds read per poll. */
export const ROUND_BUDGET = 12
/** Rows per feed query. */
export const PAGE = 20
/**
 * Backfill queries per poll at most (L-17): a thread newly watched in a repo whose state feed
 * already read past its events costs one query per state feed, once. More wait for the next poll.
 */
export const BACKFILL_BUDGET = 4
/** On first sight a feed reaches back this far, so a new inbox is not empty for no reason. */
export const BACKFILL_MS = 7 * 24 * 60 * 60_000
/** Items kept; the oldest read ones go first. */
export const MAX_ITEMS = 300

export type RepoReason = 'owner' | 'maintainer' | 'writer' | 'watched' | 'starred'

export interface RepoSub {
  readonly repo: RepoLite
  readonly reason: RepoReason
}

/** Why I follow a thread: I opened it, commented, was assigned, was asked to review, reviewed, or was mentioned. */
export type ThreadReason = 'author' | 'commented' | 'assigned' | 'review-requested' | 'reviewed' | 'mentioned'

export interface ThreadSub {
  readonly id: string
  readonly kind: 'issue' | 'pull'
  readonly number: number
  readonly title: string
  readonly repo: RepoLite
  /** The strongest reason (author, commented, assigned, review requested, reviewed, mentioned). */
  readonly reason: ThreadReason
  /** Every reason I follow it (an earlier build stored only `reason`). */
  readonly reasons?: readonly ThreadReason[]
  /** When I joined the thread (the earliest reason): activity before it is not news to me. */
  readonly since: number
}

export interface Subscriptions {
  readonly at: number
  readonly repos: RepoSub[]
  readonly threads: ThreadSub[]
  /** How many were left out by the caps. */
  readonly droppedRepos: number
  readonly droppedThreads: number
  /**
   * Sources that could not be read (or only partly), in words, e.g. "comments you wrote".
   * What they would have added is not watched this time; the next recompute retries.
   */
  readonly incomplete?: readonly string[]
}

export interface InboxPrefs {
  /** Watch starred repos too (new issues and PRs; pushes when `pushes` is on). */
  readonly stars: boolean
  /** Report pushes to the repos I watch. */
  readonly pushes: boolean
}

export const DEFAULT_PREFS: InboxPrefs = { stars: false, pushes: false }

export type ItemKind = 'issue' | 'pull' | 'comment' | 'state' | 'review' | 'push'

/** Why an item reached me beyond following its thread or repo (QW2-056). */
export type ItemReason = 'assign' | 'review_requested' | 'mention'

/** One notification. `id` is the document it came from, so a re-read never duplicates it. */
export interface InboxItem {
  readonly id: string
  readonly kind: ItemKind
  readonly repo: RepoLite
  /** The issue or PR it is about (absent for pushes). */
  readonly target?: { readonly kind: 'issue' | 'pull'; readonly number: number; readonly title: string }
  /** What happened, in a few words ("closed", "approved", "pushed to main"). */
  readonly what: string
  readonly actor: string
  readonly at: number
  readonly read: boolean
  /** Why it reached me, when more than following (an earlier build stored none). */
  readonly reason?: ItemReason
}

// ---------------------------------------------------------------------------
// Feeds (pure)
// ---------------------------------------------------------------------------

export type Feed =
  | { readonly kind: 'new'; readonly type: 'issue' | 'patch'; readonly repo: RepoLite }
  | { readonly kind: 'push'; readonly type: 'refUpdate' | 'protectedRefUpdate'; readonly repo: RepoLite }
  | { readonly kind: 'state'; readonly type: 'event' | 'transition'; readonly repo: RepoLite; readonly threads: readonly ThreadSub[] }
  | { readonly kind: 'comments'; readonly thread: ThreadSub }
  | { readonly kind: 'reviews'; readonly thread: ThreadSub }

/** A feed's stable cursor key. */
export function feedKey(f: Feed): string {
  switch (f.kind) {
    case 'new':
    case 'push':
    case 'state':
      return `${f.kind}:${f.type}:${f.repo.id}`
    case 'comments':
    case 'reviews':
      return `${f.kind}:${f.thread.id}`
  }
}

/** Every feed a subscription set implies, threads first (they are the most personal). */
export function planFeeds(subs: Subscriptions, prefs: InboxPrefs): Feed[] {
  const feeds: Feed[] = []
  for (const t of subs.threads) {
    feeds.push({ kind: 'comments', thread: t })
    if (t.kind === 'pull' && t.reason === 'author') feeds.push({ kind: 'reviews', thread: t })
  }
  const threadsByRepo = new Map<string, ThreadSub[]>()
  for (const t of subs.threads) threadsByRepo.set(t.repo.id, [...(threadsByRepo.get(t.repo.id) ?? []), t])
  for (const [, threads] of threadsByRepo) {
    const repo = threads[0]!.repo
    feeds.push({ kind: 'state', type: 'event', repo, threads }, { kind: 'state', type: 'transition', repo, threads })
  }
  for (const { repo, reason } of subs.repos) {
    if (reason === 'starred' && !prefs.stars) continue
    feeds.push({ kind: 'new', type: 'issue', repo }, { kind: 'new', type: 'patch', repo })
    if (prefs.pushes) feeds.push({ kind: 'push', type: 'refUpdate', repo }, { kind: 'push', type: 'protectedRefUpdate', repo })
  }
  return feeds
}

/** This round's feeds: `budget` of them from `offset`, wrapping; and the next offset. */
export function pickRound<T>(feeds: readonly T[], offset: number, budget = ROUND_BUDGET): { round: T[]; next: number } {
  if (feeds.length <= budget) return { round: [...feeds], next: 0 }
  const start = offset % feeds.length
  const round = Array.from({ length: budget }, (_, i) => feeds[(start + i) % feeds.length] as T)
  return { round, next: (start + budget) % feeds.length }
}

/**
 * Where a feed has read to: every document up to `at` (ms), and, when a page ended inside one
 * block, also the documents at `at` up to and including `afterId` (index order).
 */
export interface Cursor {
  readonly at: number
  readonly afterId?: string
}

/**
 * Where a feed starts the first time it is read: a week before the feed was first watched
 * (not before the inbox started), so a repo added months later does not flood the inbox with
 * its history. Thread feeds never start before I joined the thread.
 */
export function initialCursor(f: Feed, firstSeen: number): Cursor {
  const floor = firstSeen - BACKFILL_MS
  return { at: f.kind === 'comments' || f.kind === 'reviews' ? Math.max(floor, f.thread.since) : floor }
}

/**
 * The cursor after reading a page (ascending `($createdAt, $id)`, past `prev`, `limit` rows).
 * A short page read everything so far: the cursor is its last timestamp. A full page may have
 * stopped inside a block, so the cursor keeps the last `$id` too and the next read continues
 * after it at the same timestamp: nothing of a busy block is skipped or read twice.
 */
export function advanceCursor(prev: Cursor, page: readonly { at: number; id: string }[], limit = PAGE): Cursor {
  const last = page[page.length - 1]
  if (last === undefined) return prev
  return page.length < limit ? { at: last.at } : { at: last.at, afterId: last.id }
}

/** The query for a feed after `cursor`. */
export function feedQuery(forge: ForgeIds, f: Feed, cursor: Cursor): DocumentQuery {
  const after = cursor.afterId === undefined ? (['$createdAt', '>', cursor.at] as const) : (['$createdAt', '>=', cursor.at] as const)
  const shape = { orderBy: [['$createdAt', 'asc'] as const], limit: PAGE, ...(cursor.afterId === undefined ? {} : { startAfter: cursor.afterId }) }
  switch (f.kind) {
    case 'new':
    case 'state':
    case 'push':
      return { dataContractId: contractOf(forge, f.type), documentTypeName: f.type, where: [['repoId', '==', f.repo.id], after], ...shape }
    case 'comments':
      return { dataContractId: forge.collab, documentTypeName: DOC.comment, where: [['targetId', '==', f.thread.id], after], ...shape }
    case 'reviews':
      return { dataContractId: forge.collab, documentTypeName: DOC.review, where: [['patchId', '==', f.thread.id], after], ...shape }
  }
}

/**
 * The one query that reads `thread`'s state events a repo's shared state feed already moved past
 * before the thread was watched (L-17): on the thread's own `target` index, from when I joined it
 * (or the feed's floor, whichever is later) up to where the feed has read, newest first, one page.
 * A thread with more than {@link PAGE} unseen state changes gets the newest; older ones are not
 * news. Null when the feed has not read past the thread's start: its next read covers it.
 */
export function backfillQuery(forge: ForgeIds, f: Extract<Feed, { kind: 'state' }>, thread: ThreadSub, cursor: Cursor, floor: number): DocumentQuery | null {
  const from = Math.max(thread.since, floor)
  if (cursor.at <= from) return null
  // A target's transitions are few and indexed by `targetId` alone (`perTarget`): read them all
  // and let `toItems` keep the window (`backfillWindow`).
  if (f.type === 'transition') {
    return { dataContractId: contractOf(forge, f.type), documentTypeName: f.type, where: [['targetId', '==', thread.id]], orderBy: [['targetId', 'asc']], limit: 100 }
  }
  return {
    dataContractId: contractOf(forge, f.type),
    documentTypeName: f.type,
    // `<= at`: a page that stopped inside a block at `at` read part of it; the rest comes here or
    // with the feed's next read (an item is stored once, by document id).
    where: [['targetId', '==', thread.id], ['$createdAt', '>', from], ['$createdAt', '<=', cursor.at]],
    orderBy: [['$createdAt', 'desc']],
    limit: PAGE,
  }
}

/** The backfill window of {@link backfillQuery}, for a read that cannot bound it by time. */
export function backfillWindow(thread: ThreadSub, cursor: Cursor, floor: number): (at: number) => boolean {
  const from = Math.max(thread.since, floor)
  return (at) => at > from && at <= cursor.at
}

/** Failed backfill attempts of one thread before it is given up (its future events still come). */
export const BACKFILL_TRIES = 3
/** Covered threads kept per state feed: the newest (a feed watches at most MAX_THREADS). */
const COVERED_MAX = 4 * MAX_THREADS

/**
 * A state feed's covered record, bounded: thread id → when it was covered (ms; `0` for a thread
 * covered before records existed), or a failure count below zero. Threads the feed watches now
 * are always kept; of the others (watched before), the most recently covered.
 */
function pruneCovered(covered: Record<string, number>, watched: readonly ThreadSub[]): Record<string, number> {
  const rows = Object.entries(covered)
  if (rows.length <= COVERED_MAX) return covered
  const now = new Set(watched.map((t) => t.id))
  const kept = rows.filter(([id]) => now.has(id))
  const others = rows.filter(([id]) => !now.has(id)).sort((a, b) => b[1] - a[1])
  return Object.fromEntries([...kept, ...others.slice(0, Math.max(0, COVERED_MAX - kept.length))])
}

/** A stored cursor (an earlier build stored a bare timestamp). */
function asCursor(v: unknown): Cursor | undefined {
  if (typeof v === 'number') return { at: v }
  if (typeof v === 'object' && v !== null && typeof (v as Cursor).at === 'number') {
    const afterId = (v as Cursor).afterId
    return typeof afterId === 'string' ? { at: (v as Cursor).at, afterId } : { at: (v as Cursor).at }
  }
  return undefined
}

const reviewDoc = baseDoc.extend({ verdict: int, body: z.string().optional().catch(undefined) })
/** A state event, with the identity it addresses (`refId`) when it names one. */
const addressedEventDoc = eventDoc.extend({ refId: ident.optional().catch(undefined) })
/** A comment, with its body (for a mention). */
const commentBodyDoc = baseDoc.extend({ body: z.string().optional().catch(undefined) })
const refDoc = baseDoc.extend({ refName: z.string().optional().catch(undefined) })

/** What a `transition` kind means to a reader of the inbox. */
export function transitionWhat(kind: number): string | null {
  switch (kind) {
    case 1:
    case 11:
    case 16:
      return 'closed'
    case 2:
    case 12:
    case 17:
      return 'reopened'
    case 13:
      return 'merged'
    case 14:
      return 'marked draft'
    case 15:
      return 'marked ready for review'
    default:
      return null
  }
}

/**
 * What an `event` kind means to a reader of the inbox (state kinds are transitions). `refId`: the
 * identity an assign names (also in `value`, which a private repo seals) or a review request asks.
 */
export function stateWhat(kind: number, value: string | undefined, me: string, refId?: string): string | null {
  const who = refId ?? value
  switch (kind) {
    case 4:
      return value ? `labelled ${value}` : 'labelled'
    case 5:
      return value ? `removed label ${value}` : 'removed a label'
    case 6:
      return who === me ? 'assigned you' : 'assigned someone'
    case 7:
      return who === me ? 'unassigned you' : 'unassigned someone'
    case 8:
      return 'retargeted'
    case 13:
      // A review request is news to the reviewer asked, not to everyone on the thread.
      return refId === me ? 'requested your review' : null
    default:
      return null
  }
}

/** Why a state event reached me: it assigned me, or asked me for a review. */
function stateReason(kind: number, value: string | undefined, me: string, refId: string | undefined): ItemReason | undefined {
  if (kind === 6 && (refId ?? value) === me) return 'assign'
  if (kind === 13 && refId === me) return 'review_requested'
  return undefined
}

/** Review verdicts as the inbox words them; 4/5 are a non-member's approve and request changes (RC1). */
const VERDICT_WHAT: Readonly<Record<number, string>> = { 1: 'approved', 2: 'requested changes', 3: 'reviewed', 4: 'approved', 5: 'requested changes' }

function shortRef(name: string | undefined): string {
  if (!name) return 'a branch'
  return name.replace(/^refs\/(heads|tags)\//, '')
}

/**
 * The items a feed's documents make. Never my own; never before I joined a thread. `name`: my
 * DPNS name, so an `@name` in a new issue, PR or comment is a mention (a private repo's text is
 * sealed and is never read for one).
 */
export function toItems(f: Feed, docs: readonly PlainDocument[], me: string, name: string | null = null): InboxItem[] {
  const mentioned = (repo: RepoLite, body: string | undefined): Pick<InboxItem, 'reason'> => (!repo.private && mentions(body, me, name) ? { reason: 'mention' } : {})
  const item = (d: { $id: string; $ownerId: string; $createdAt: number }, rest: Pick<InboxItem, 'kind' | 'what' | 'repo'> & Partial<InboxItem>): InboxItem => ({
    id: d.$id,
    actor: d.$ownerId,
    at: d.$createdAt,
    read: false,
    ...rest,
  })
  const notMine = <T extends { $ownerId: string }>(d: T): boolean => d.$ownerId !== me
  switch (f.kind) {
    case 'new': {
      const kind = f.type === 'issue' ? 'issue' : 'pull'
      return parseDocs(targetDoc, docs)
        .filter(notMine)
        .map((d) => item(d, { kind, repo: f.repo, what: kind === 'issue' ? 'opened an issue' : 'opened a pull request', target: { kind, number: d.number, title: titleOf(d) }, ...mentioned(f.repo, d.body) }))
    }
    case 'push':
      return parseDocs(refDoc, docs)
        .filter(notMine)
        .map((d) => item(d, { kind: 'push', repo: f.repo, what: `pushed to ${shortRef(d.refName)}` }))
    case 'state': {
      const threads = new Map(f.threads.map((t) => [t.id, t]))
      return parseDocs(addressedEventDoc, docs).flatMap((d) => {
        const t = threads.get(d.targetId)
        // A private repo's value is sealed, or (plaintext) unchecked: the feed holds no keys,
        // so it names the change without it (private-repos.md §8.1). `refId` is plaintext (the
        // addressee index reads it).
        const value = f.repo.private ? undefined : d.value
        const what = f.type === 'transition' ? transitionWhat(d.kind) : stateWhat(d.kind, value, me, d.refId)
        if (!t || what === null || !notMine(d) || d.$createdAt <= t.since) return []
        const reason = f.type === 'transition' ? undefined : stateReason(d.kind, value, me, d.refId)
        return [item(d, { kind: 'state', repo: t.repo, what, target: { kind: t.kind, number: t.number, title: t.title }, ...(reason ? { reason } : {}) })]
      })
    }
    case 'comments':
    case 'reviews': {
      const t = f.thread
      const target = { kind: t.kind, number: t.number, title: t.title }
      if (f.kind === 'comments') {
        return parseDocs(commentBodyDoc, docs)
          .filter((d) => notMine(d) && d.$createdAt > t.since)
          .map((d) => item(d, { kind: 'comment', repo: t.repo, what: 'commented', target, ...mentioned(t.repo, d.body) }))
      }
      return parseDocs(reviewDoc, docs)
        .filter(notMine)
        .map((d) => item(d, { kind: 'review', repo: t.repo, what: VERDICT_WHAT[d.verdict] ?? 'reviewed', target, ...mentioned(t.repo, d.body) }))
    }
  }
}

// ---------------------------------------------------------------------------
// Subscriptions (chain reads)
// ---------------------------------------------------------------------------

const EMPTY_PAGE: { rows: never[]; more: boolean } = { rows: [], more: false }

function threadOf(t: TargetRow, repo: RepoLite, reason: ThreadSub['reason'], since: number): ThreadSub {
  return { id: t.id, kind: t.kind, number: t.number, title: t.title, repo, reason, since }
}

/** Read what `me` is subscribed to. Each source fails alone; all failing is an error. */
export async function computeSubscriptions(
  sdk: EvoSDK,
  network: Network,
  forge: ForgeIds,
  me: string,
  prefs: InboxPrefs,
  now = Date.now(),
): Promise<Subscriptions> {
  const settled = await Promise.allSettled([
    listReposByOwner(sdk, me, { network }),
    prefs.stars ? listStarredRepoIds(sdk, forge, me) : Promise.resolve(EMPTY_PAGE),
    listMyTargets(sdk, forge, me, 'issue'),
    listMyTargets(sdk, forge, me, 'pull'),
    listMyCommentTargets(sdk, forge, me),
    listWatchedRepoIds(sdk, forge, me),
    listAddressedTargets(sdk, forge, me),
    listParticipation(network, me),
  ] as const)
  // Only chain sources actually read count: stars are skipped (not read) when the preference is
  // off, and this browser's own record is no read of the chain.
  const read = settled.filter((_, i) => (i !== 1 || prefs.stars) && i !== 7)
  if (read.every((r) => r.status === 'rejected')) throw (read[0] as PromiseRejectedResult).reason
  const [owned, starred, issues, pulls, commented, watching, addressedRes, participatedRes] = settled
  const ok = <T>(r: PromiseSettledResult<T>, fallback: T): T => (r.status === 'fulfilled' ? r.value : fallback)

  const repoSubs: RepoSub[] = []
  const seen = new Set<string>()
  const addRepo = (repo: RepoLite, reason: RepoReason): void => {
    if (seen.has(repo.id)) return
    seen.add(repo.id)
    repoSubs.push({ repo, reason })
  }
  const mine = ok(owned, { owned: [], member: [] })
  for (const r of mine.owned) addRepo(repoLite(r), 'owner')
  for (const r of mine.member) addRepo(repoLite(r), r.role ?? 'writer')
  const starIds = ok(starred, EMPTY_PAGE).rows.filter((id) => !seen.has(id))
  const watchIds = ok(watching, EMPTY_PAGE).rows.filter((id) => !seen.has(id))
  const commentedTargets = ok(commented, [])
  const myIssues = ok(issues, EMPTY_PAGE)
  const myPulls = ok(pulls, EMPTY_PAGE)
  const authored = [...myIssues.rows, ...myPulls.rows]
  const authoredIds = new Set(authored.map((t) => t.id))
  const incomplete: string[] = []
  const labels = [
    'repos you own or belong to',
    'your stars',
    'issues you opened',
    'pull requests you opened',
    'comments you wrote',
    'the repos you watch',
    'your assignments and review requests',
    "this browser's record of your reviews and mentions",
  ] as const
  settled.forEach((r, i) => {
    if (r.status === 'rejected') incomplete.push(labels[i] ?? 'a source')
  })
  if (myIssues.more) incomplete.push('issues you opened (more than the first 500)')
  if (myPulls.more) incomplete.push('pull requests you opened (more than the first 500)')
  const addressed = ok(addressedRes, [])
  const participated = ok(participatedRes, [])
  const joinedIds = [...commentedTargets.map((c) => c.targetId), ...addressed.map((a) => a.targetId), ...participated.map((p) => p.targetId)]
  const commentedRows = await readTargetsByIds(sdk, forge, joinedIds.filter((id) => !authoredIds.has(id))).catch(() => {
    incomplete.push('the threads you commented on, were assigned or reviewed')
    return new Map<string, TargetRow>()
  })

  // Repo rows for stars and for threads whose repo is not one of mine.
  const needed = [...watchIds, ...starIds, ...authored.map((t) => t.repoId), ...[...commentedRows.values()].map((t) => t.repoId)].filter((id) => !seen.has(id))
  const extra = await readReposByIds(sdk, forge, needed).catch(() => {
    incomplete.push('the repos of your threads, watches and stars')
    return new Map<string, RepoLite>()
  })
  // Watched before starred: a watch is the explicit ask, and it holds when stars are off.
  for (const id of watchIds) {
    const repo = extra.get(id)
    if (repo) addRepo(repo, 'watched')
  }
  for (const id of starIds) {
    const repo = extra.get(id)
    if (repo) addRepo(repo, 'starred')
  }
  const repoById = new Map([...repoSubs.map((s) => [s.repo.id, s.repo] as const), ...extra])

  // One sub per thread: the strongest reason (the first source that names it, in the order
  // below), every reason, and the earliest time any of them began.
  const byThread = new Map<string, ThreadSub>()
  const follow = (t: TargetRow | undefined, repo: RepoLite | null | undefined, reason: ThreadReason, since: number): void => {
    if (!t || !repo) return
    const prev = byThread.get(t.id)
    if (prev === undefined) {
      byThread.set(t.id, { ...threadOf(t, repo, reason, since), reasons: [reason] })
      return
    }
    const reasons = prev.reasons ?? [prev.reason]
    byThread.set(t.id, { ...prev, since: Math.min(prev.since, since), reasons: reasons.includes(reason) ? reasons : [...reasons, reason] })
  }
  for (const t of authored) follow(t, t.repo ?? repoById.get(t.repoId), 'author', t.createdAt)
  for (const c of commentedTargets) {
    const t = commentedRows.get(c.targetId)
    follow(t, t ? repoById.get(t.repoId) : undefined, 'commented', c.firstAt)
  }
  // Assigned, asked to review (QW2-009): the assignment or request itself is news, so the thread
  // is followed from just before it.
  const rowOf = (id: string): TargetRow | undefined => commentedRows.get(id) ?? authored.find((t) => t.id === id)
  for (const a of addressed) {
    const t = rowOf(a.targetId)
    follow(t, t ? t.repo ?? repoById.get(t.repoId) : undefined, a.reason, a.firstAt - 1)
  }
  for (const p of participated) {
    const t = rowOf(p.targetId)
    follow(t, t ? t.repo ?? repoById.get(t.repoId) : undefined, p.reason, p.at - 1)
  }
  const threads = [...byThread.values()]
  threads.sort((a, b) => b.since - a.since)
  return {
    at: now,
    repos: repoSubs.slice(0, MAX_REPOS),
    threads: threads.slice(0, MAX_THREADS),
    droppedRepos: Math.max(0, repoSubs.length - MAX_REPOS),
    droppedThreads: Math.max(0, threads.length - MAX_THREADS),
    ...(incomplete.length > 0 ? { incomplete } : {}),
  }
}

// ---------------------------------------------------------------------------
// Local state (IndexedDB `inbox` store)
// ---------------------------------------------------------------------------

function prefix(network: Network, me: string): string {
  return `${network}:${me}:`
}

/** How many times each identity's inbox was cleared this session (see {@link clearInbox}). */
const clears = new Map<string, number>()

/**
 * Delete this browser's notifications inbox for `me` (items, cursors, subscriptions, prefs):
 * "Sign out & forget key" leaves no record of the identity here (QW2-028).
 */
export async function clearInbox(network: Network, me: string): Promise<void> {
  // A poll of this identity still running (started before the clear) sees this and writes no
  // more: its cursors or items would bring the inbox back.
  const p = prefix(network, me)
  clears.set(p, (clears.get(p) ?? 0) + 1)
  const rows = await idbEntries('inbox', p)
  if (rows.length > 0) await idbBatch('inbox', rows.map(([k]) => [k, undefined] as const))
}

export async function loadItems(network: Network, me: string): Promise<InboxItem[]> {
  const rows = await idbEntries<InboxItem>('inbox', `${prefix(network, me)}item:`)
  return rows.map(([, v]) => v).sort((a, b) => b.at - a.at)
}

export async function loadPrefs(network: Network, me: string): Promise<InboxPrefs> {
  return { ...DEFAULT_PREFS, ...((await idbGet<InboxPrefs>('inbox', `${prefix(network, me)}prefs`)) ?? {}) }
}

export async function savePrefs(network: Network, me: string, prefs: InboxPrefs): Promise<void> {
  await idbPut('inbox', `${prefix(network, me)}prefs`, prefs)
  // A different watch set: recompute on the next poll.
  await idbDelete('inbox', `${prefix(network, me)}subs`)
}

export async function loadSubs(network: Network, me: string): Promise<Subscriptions | undefined> {
  return idbGet<Subscriptions>('inbox', `${prefix(network, me)}subs`)
}

/** Mark items read (all unread ones when `ids` is omitted). */
export async function markRead(network: Network, me: string, ids?: readonly string[]): Promise<void> {
  const want = ids === undefined ? null : new Set(ids)
  for (const item of await loadItems(network, me)) {
    if (!item.read && (want === null || want.has(item.id))) {
      await idbPut('inbox', `${prefix(network, me)}item:${item.id}`, { ...item, read: true })
    }
  }
}

/** Which items to drop to stay within `max`: the oldest read ones, then the oldest. */
export function itemsToDrop(items: readonly InboxItem[], max = MAX_ITEMS): string[] {
  if (items.length <= max) return []
  const oldestFirst = [...items].sort((a, b) => Number(b.read) - Number(a.read) || a.at - b.at)
  return oldestFirst.slice(0, items.length - max).map((i) => i.id)
}

/** What one poll did. */
export interface PollResult {
  readonly added: number
  readonly feedsRead: number
  readonly feedsTotal: number
  readonly failed: number
  readonly subs: Subscriptions
}

const roundOffsets = new Map<string, number>()

/**
 * One poll: (re)compute subscriptions when stale, read this round's feeds past their cursors,
 * store new items and advance the cursors. A feed that fails keeps its cursor and is retried
 * next round.
 */
export async function pollOnce(
  sdk: EvoSDK,
  network: Network,
  forge: ForgeIds,
  me: string,
  /** `name`: my DPNS name, for mentions (`@name`); an id is always matched. */
  opts: { now?: number; refreshSubs?: boolean; stop?: () => boolean; name?: string | null } = {},
): Promise<PollResult> {
  const now = opts.now ?? Date.now()
  const p = prefix(network, me)
  // The poller stopped (the session locked or signed out, maybe to forget this identity): no
  // write after that may recreate what a forget clears (QW2-028). Checked before each write.
  const epoch = clears.get(p) ?? 0
  const stopped = (): boolean => opts.stop?.() === true || (clears.get(p) ?? 0) !== epoch
  const prefs = await loadPrefs(network, me)
  let subs = await loadSubs(network, me)
  if (subs === undefined || opts.refreshSubs || now - subs.at > SUBS_TTL_MS) {
    subs = await computeSubscriptions(sdk, network, forge, me, prefs, now)
    if (stopped()) return { added: 0, feedsRead: 0, feedsTotal: 0, failed: 0, subs }
    await idbPut('inbox', `${p}subs`, subs)
  }
  const feeds = planFeeds(subs, prefs)
  // When each feed was first watched (planned, not first read: a round may reach it minutes
  // later). One record for all feeds; only feeds still watched are kept.
  const seenBefore = (await idbGet<Record<string, number>>('inbox', `${p}seen`)) ?? {}
  const seen: Record<string, number> = {}
  for (const f of feeds) seen[feedKey(f)] = seenBefore[feedKey(f)] ?? now
  if (stopped()) return { added: 0, feedsRead: 0, feedsTotal: feeds.length, failed: 0, subs }
  await idbPut('inbox', `${p}seen`, seen)
  const { round, next } = pickRound(feeds, roundOffsets.get(p) ?? 0)
  roundOffsets.set(p, next)

  const existing = new Set((await loadItems(network, me)).map((i) => i.id))
  let added = 0
  let failed = 0
  let backfills = 0
  let backfillsFailed = 0
  const joined: InboxItem[] = []
  const name = opts.name ?? null
  const store = async (items: readonly InboxItem[]): Promise<void> => {
    for (const it of items) {
      if (stopped()) return
      if (existing.has(it.id)) continue
      existing.add(it.id)
      await idbPut('inbox', `${p}item:${it.id}`, it)
      added++
      // A new issue or PR that mentions me: I follow it from then on, as GitHub subscribes a
      // mentioned user (its id is the item's: the issue or patch document).
      if (it.reason === 'mention' && (it.kind === 'issue' || it.kind === 'pull')) {
        await noteParticipation(network, me, it.id, 'mentioned', it.at)
        joined.push(it)
      }
    }
  }
  for (const f of round) {
    const fk = feedKey(f)
    const key = `${p}cursor:${fk}`
    const start = initialCursor(f, seen[fk] ?? now)
    const cursor = asCursor(await idbGet<unknown>('inbox', key)) ?? start
    // A repo's state feed is shared by its threads: a thread that joined it after the cursor
    // moved past its events is read once from its own history (L-17).
    if (f.kind === 'state') {
      const coverKey = `${p}covered:${fk}`
      // The threads this feed has answered for, kept after a thread leaves the watch set (it is
      // not re-read when it returns). A feed read by an earlier build has no record: its current
      // threads are taken as covered, so an upgrade re-reads nothing and never brings back pruned
      // notifications as unread. The price: a thread that joined just before the upgrade, after
      // the feed passed its events, is not backfilled (as before this fix).
      const record = await idbGet<Record<string, number>>('inbox', coverKey)
      const covered: Record<string, number> = record ?? (cursor === start ? {} : Object.fromEntries(f.threads.map((t) => [t.id, 0])))
      let changed = record === undefined && Object.keys(covered).length > 0
      for (const t of f.threads) {
        if (covered[t.id] === undefined || covered[t.id]! < 0) {
          // Null when the feed has not read past the thread's start (always so before its
          // first read): the read below answers for it.
          const q = backfillQuery(forge, f, t, cursor, start.at)
          if (q !== null) {
            if (backfills >= BACKFILL_BUDGET) continue
            backfills++
            try {
              const inWindow = backfillWindow(t, cursor, start.at)
              const docs = (await queryDocumentsWithProof(sdk, q)).documents.filter((d) => inWindow(typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0))
              await store(toItems({ ...f, threads: [t] }, docs, me, name))
            } catch {
              // Retried next poll; given up after BACKFILL_TRIES (a count below zero).
              backfillsFailed++
              const tries = (covered[t.id] ?? 0) - 1
              covered[t.id] = tries <= -BACKFILL_TRIES ? now : tries
              changed = true
              continue
            }
          }
          covered[t.id] = now
          changed = true
        }
      }
      if (changed && !stopped()) await idbPut('inbox', coverKey, pruneCovered(covered, f.threads))
    }
    let docs: PlainDocument[]
    try {
      docs = (await queryDocumentsWithProof(sdk, feedQuery(forge, f, cursor))).documents
    } catch {
      failed++
      continue
    }
    if (stopped()) break
    await store(toItems(f, docs, me, name))
    if (stopped()) break
    const page = parseDocs(baseDoc, docs).map((d) => ({ at: d.$createdAt, id: d.$id }))
    await idbPut('inbox', key, advanceCursor(cursor, page))
  }
  if (added > 0 && !stopped()) {
    for (const id of itemsToDrop(await loadItems(network, me))) await idbDelete('inbox', `${p}item:${id}`)
  }
  // A thread joined by a mention is followed at once (QW3-050): the stored subscriptions say so
  // now, as the Mentioned filter does, instead of after the next recompute.
  if (joined.length > 0 && !stopped()) {
    subs = followMentions(subs, joined)
    await idbPut('inbox', `${p}subs`, subs)
  }
  return { added, feedsRead: round.length - failed, feedsTotal: feeds.length, failed: failed + backfillsFailed, subs }
}

/**
 * `subs` following the issues and PRs that mentioned me (`items`, each the issue or patch
 * document): a thread already followed gains the reason, a new one is added from the item, as
 * {@link computeSubscriptions} would add it from this browser's participation record.
 */
export function followMentions(subs: Subscriptions, items: readonly InboxItem[]): Subscriptions {
  const threads = [...subs.threads]
  for (const it of items) {
    if (it.target === undefined) continue
    const i = threads.findIndex((t) => t.id === it.id)
    const prev = threads[i]
    if (prev !== undefined) {
      const reasons = prev.reasons ?? [prev.reason]
      threads[i] = { ...prev, since: Math.min(prev.since, it.at - 1), reasons: reasons.includes('mentioned') ? reasons : [...reasons, 'mentioned'] }
    } else {
      threads.push({ id: it.id, kind: it.target.kind, number: it.target.number, title: it.target.title, repo: it.repo, reason: 'mentioned', reasons: ['mentioned'], since: it.at - 1 })
    }
  }
  threads.sort((a, b) => b.since - a.since)
  return { ...subs, threads: threads.slice(0, MAX_THREADS), droppedThreads: subs.droppedThreads + Math.max(0, threads.length - MAX_THREADS) }
}

/**
 * The "What this browser watches" counts (QW3-050): each thread counted under every reason it is
 * followed for, as the inbox's reason filters match it, not only its strongest one.
 */
export function watchCounts(subs: Subscriptions): { readonly member: number; readonly watched: number; readonly starred: number; readonly joined: number; readonly addressed: number; readonly seen: number } {
  const has = (t: ThreadSub, ...rs: ThreadReason[]): boolean => (t.reasons ?? [t.reason]).some((r) => rs.includes(r))
  return {
    member: subs.repos.filter((r) => r.reason !== 'starred' && r.reason !== 'watched').length,
    watched: subs.repos.filter((r) => r.reason === 'watched').length,
    starred: subs.repos.filter((r) => r.reason === 'starred').length,
    joined: subs.threads.filter((t) => has(t, 'author', 'commented')).length,
    addressed: subs.threads.filter((t) => has(t, 'assigned', 'review-requested')).length,
    seen: subs.threads.filter((t) => has(t, 'reviewed', 'mentioned')).length,
  }
}

// ---------------------------------------------------------------------------
// Threads (QW-066): the inbox lists one row per issue, PR or repo's pushes, as GitHub does
// ---------------------------------------------------------------------------

/** The items of one thread (an issue, a PR, or a repo's pushes), newest first. */
export interface InboxThread {
  readonly key: string
  readonly repo: RepoLite
  readonly target?: InboxItem['target']
  /** Newest first; never empty. */
  readonly items: readonly InboxItem[]
  readonly unread: number
}

/** The thread an item belongs to. */
export function threadKey(item: InboxItem): string {
  return item.target ? `${item.repo.id}:${item.target.kind}:${item.target.number}` : `${item.repo.id}:push`
}

/** `items` as threads, the one with the newest item first; each thread's items newest first. */
export function groupThreads(items: readonly InboxItem[]): InboxThread[] {
  const by = new Map<string, InboxItem[]>()
  for (const i of items) {
    const k = threadKey(i)
    const list = by.get(k)
    if (list === undefined) by.set(k, [i])
    else list.push(i)
  }
  return [...by.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => b.at - a.at)
      const newest = sorted[0] as InboxItem
      // The newest item's title is the thread's (an edit renames it).
      return { key, repo: newest.repo, ...(newest.target ? { target: newest.target } : {}), items: sorted, unread: sorted.filter((i) => !i.read).length }
    })
    .sort((a, b) => (b.items[0] as InboxItem).at - (a.items[0] as InboxItem).at)
}

// What the subscriptions are read from: repos owned, stars, issues and PRs opened, comments,
// watches, and reviews (this browser's record of them).
const PARTICIPATION_TYPES: ReadonlySet<string> = new Set([DOC.repo, DOC.issue, DOC.patch, DOC.comment, DOC.watch, DOC.star, DOC.review])

/**
 * Whether a write of this kind (`create:comment`, `delete:watch`, …) changes what the writer is
 * subscribed to (a thread they took part in, a repo they watch or star), so the inbox recomputes
 * its subscriptions at once instead of on its next refresh ({@link SUBS_TTL_MS}).
 */
export function refreshesSubscriptions(kind: string): boolean {
  const [verb, type] = kind.split(':')
  return (verb === 'create' || verb === 'delete') && type !== undefined && PARTICIPATION_TYPES.has(type)
}

// ---------------------------------------------------------------------------
// Reason filters (QW2-056): Assigned, Participating, Mentioned, Review requested, as GitHub's
// ---------------------------------------------------------------------------

export type InboxFilter = 'assigned' | 'participating' | 'mentioned' | 'review-requested'

export const INBOX_FILTERS: readonly { readonly id: InboxFilter; readonly label: string; readonly none: string }[] = [
  { id: 'assigned', label: 'Assigned', none: 'Nothing assigned to you' },
  { id: 'participating', label: 'Participating', none: 'Nothing you take part in' },
  { id: 'mentioned', label: 'Mentioned', none: 'No mentions' },
  { id: 'review-requested', label: 'Review requested', none: 'No review requests' },
]

const ITEM_REASON: Readonly<Record<ItemReason, ThreadReason>> = { assign: 'assigned', review_requested: 'review-requested', mention: 'mentioned' }

/** The subscribed threads by {@link threadKey}, for {@link threadReasons}. */
export function subsByThread(subs: Subscriptions | null): Map<string, ThreadSub> {
  return new Map((subs?.threads ?? []).map((t) => [`${t.repo.id}:${t.kind}:${t.number}`, t]))
}

/** Why I get a thread's notifications: every reason I follow it, and each item's own. */
export function threadReasons(thread: InboxThread, subs: ReadonlyMap<string, ThreadSub>): Set<ThreadReason> {
  const sub = subs.get(thread.key)
  const out = new Set<ThreadReason>(sub === undefined ? [] : sub.reasons ?? [sub.reason])
  for (const i of thread.items) if (i.reason !== undefined) out.add(ITEM_REASON[i.reason])
  return out
}

/** Whether a thread passes a reason filter: Participating is any part I took (not a repo I only watch). */
export function matchesFilter(reasons: ReadonlySet<ThreadReason>, filter: InboxFilter): boolean {
  if (filter === 'participating') return reasons.size > 0
  return reasons.has(filter)
}

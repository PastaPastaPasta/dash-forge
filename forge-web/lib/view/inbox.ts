/**
 * The local notifications inbox (`ux-dx-spec.md` §5.10). Computed in this browser from the
 * chain; nothing is sent anywhere, and there is no email, push or cross-device sync.
 *
 * **Subscriptions** (recomputed every {@link SUBS_TTL_MS}): repos I own or belong to (`repo` by
 * `$ownerId`, `maintainer`/`writer` by `memberId`), repos I starred (opt-in, `star.byOwner`),
 * and the issues and PRs I opened (`issue`/`patch` `author`) or commented on (`comment.author`
 * → `targetId`). Both sets are capped ({@link MAX_REPOS}, {@link MAX_THREADS}), newest first.
 *
 * **Feeds**, one proof-checked query each, `$createdAt > cursor` ascending, {@link PAGE} rows:
 *   - my repos: new issues and PRs (`issue`/`patch` `created`), pushes (opt-in, the reflogs);
 *   - repos holding my threads: state changes on those threads (`event`/`authorEvent` `feed`);
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
import { idbDelete, idbEntries, idbGet, idbPut } from '../idb'
import { DOC } from '../repo/contract'
import { queryDocumentsWithProof, type DocumentQuery, type PlainDocument } from '../sdk'
import { listReposByOwner } from './discovery'
import {
  baseDoc,
  ident,
  listMyCommentTargets,
  listMyTargets,
  listStarredRepoIds,
  parseDocs,
  readReposByIds,
  readTargetsByIds,
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
/** On first sight a feed reaches back this far, so a new inbox is not empty for no reason. */
export const BACKFILL_MS = 7 * 24 * 60 * 60_000
/** Items kept; the oldest read ones go first. */
export const MAX_ITEMS = 300

export type RepoReason = 'owner' | 'maintainer' | 'writer' | 'starred'

export interface RepoSub {
  readonly repo: RepoLite
  readonly reason: RepoReason
}

export interface ThreadSub {
  readonly id: string
  readonly kind: 'issue' | 'pull'
  readonly number: number
  readonly title: string
  readonly repo: RepoLite
  readonly reason: 'author' | 'commented'
  /** When I joined the thread: activity before it is not news to me. */
  readonly since: number
}

export interface Subscriptions {
  readonly at: number
  readonly repos: RepoSub[]
  readonly threads: ThreadSub[]
  /** How many were left out by the caps. */
  readonly droppedRepos: number
  readonly droppedThreads: number
}

export interface InboxPrefs {
  /** Watch starred repos too (new issues and PRs; pushes when `pushes` is on). */
  readonly stars: boolean
  /** Report pushes to the repos I watch. */
  readonly pushes: boolean
}

export const DEFAULT_PREFS: InboxPrefs = { stars: false, pushes: false }

export type ItemKind = 'issue' | 'pull' | 'comment' | 'state' | 'review' | 'push'

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
}

// ---------------------------------------------------------------------------
// Feeds (pure)
// ---------------------------------------------------------------------------

export type Feed =
  | { readonly kind: 'new'; readonly type: 'issue' | 'patch'; readonly repo: RepoLite }
  | { readonly kind: 'push'; readonly type: 'refUpdate' | 'protectedRefUpdate'; readonly repo: RepoLite }
  | { readonly kind: 'state'; readonly type: 'event' | 'authorEvent'; readonly repo: RepoLite; readonly threads: readonly ThreadSub[] }
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
    feeds.push({ kind: 'state', type: 'event', repo, threads }, { kind: 'state', type: 'authorEvent', repo, threads })
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

/** Where a feed starts the first time it is read. */
export function initialCursor(f: Feed, startedAt: number): number {
  const floor = startedAt - BACKFILL_MS
  return f.kind === 'comments' || f.kind === 'reviews' ? Math.max(floor, f.thread.since) : floor
}

/**
 * The cursor after reading `docs` (ascending `$createdAt`, `> prev`, `limit` rows). A short page
 * means everything up to now was read. A full page stops one ms before its last timestamp, so
 * documents of the same block that did not fit are read next time (items dedupe by id). A
 * full page all from one block cannot make progress that way and moves past it.
 */
export function advanceCursor(prev: number, createdAts: readonly number[], limit = PAGE): number {
  const last = createdAts[createdAts.length - 1]
  if (last === undefined) return prev
  if (createdAts.length < limit) return Math.max(prev, last)
  const first = createdAts[0] as number
  return first === last ? last : Math.max(prev, last - 1)
}

/** The query for a feed after `cursor`. */
export function feedQuery(forge: ForgeIds, f: Feed, cursor: number): DocumentQuery {
  const after = ['$createdAt', '>', cursor] as const
  const asc = ['$createdAt', 'asc'] as const
  switch (f.kind) {
    case 'new':
    case 'state':
      return { dataContractId: forge.collab, documentTypeName: f.type, where: [['repoId', '==', f.repo.id], after], orderBy: [asc], limit: PAGE }
    case 'push':
      return { dataContractId: forge.core, documentTypeName: f.type, where: [['repoId', '==', f.repo.id], after], orderBy: [asc], limit: PAGE }
    case 'comments':
      return { dataContractId: forge.collab, documentTypeName: DOC.comment, where: [['targetId', '==', f.thread.id], after], orderBy: [asc], limit: PAGE }
    case 'reviews':
      return { dataContractId: forge.collab, documentTypeName: DOC.review, where: [['patchId', '==', f.thread.id], after], orderBy: [asc], limit: PAGE }
  }
}

const eventDoc = baseDoc.extend({
  targetId: ident,
  kind: z.union([z.number(), z.bigint()]).transform(Number),
  value: z.string().optional().catch(undefined),
})
const reviewDoc = baseDoc.extend({ verdict: z.union([z.number(), z.bigint()]).transform(Number) })
const refDoc = baseDoc.extend({ refName: z.string().optional().catch(undefined) })

/** What an `event` / `authorEvent` kind means to a reader of the inbox. */
export function stateWhat(kind: number, value: string | undefined, me: string): string | null {
  switch (kind) {
    case 1:
      return 'closed'
    case 2:
      return 'reopened'
    case 3:
      return 'marked merged'
    case 4:
      return value ? `labelled ${value}` : 'labelled'
    case 5:
      return value ? `removed label ${value}` : 'removed a label'
    case 6:
      return value === me ? 'assigned you' : 'assigned someone'
    case 7:
      return value === me ? 'unassigned you' : 'unassigned someone'
    case 8:
      return 'retargeted'
    case 9:
      return 'marked draft'
    case 10:
      return 'marked ready for review'
    default:
      return null
  }
}

const VERDICT_WHAT: Readonly<Record<number, string>> = { 1: 'approved', 2: 'requested changes', 3: 'reviewed' }

function shortRef(name: string | undefined): string {
  if (!name) return 'a branch'
  return name.replace(/^refs\/(heads|tags)\//, '')
}

/** The items a feed's documents make. Never my own; never before I joined a thread. */
export function toItems(f: Feed, docs: readonly PlainDocument[], me: string): InboxItem[] {
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
        .map((d) => item(d, { kind, repo: f.repo, what: kind === 'issue' ? 'opened an issue' : 'opened a pull request', target: { kind, number: d.number, title: titleOf(d) } }))
    }
    case 'push':
      return parseDocs(refDoc, docs)
        .filter(notMine)
        .map((d) => item(d, { kind: 'push', repo: f.repo, what: `pushed to ${shortRef(d.refName)}` }))
    case 'state': {
      const threads = new Map(f.threads.map((t) => [t.id, t]))
      return parseDocs(eventDoc, docs).flatMap((d) => {
        const t = threads.get(d.targetId)
        const what = stateWhat(d.kind, d.value, me)
        if (!t || what === null || !notMine(d) || d.$createdAt <= t.since) return []
        return [item(d, { kind: 'state', repo: t.repo, what, target: { kind: t.kind, number: t.number, title: t.title } })]
      })
    }
    case 'comments':
    case 'reviews': {
      const t = f.thread
      const target = { kind: t.kind, number: t.number, title: t.title }
      if (f.kind === 'comments') {
        return parseDocs(baseDoc, docs)
          .filter((d) => notMine(d) && d.$createdAt > t.since)
          .map((d) => item(d, { kind: 'comment', repo: t.repo, what: 'commented', target }))
      }
      return parseDocs(reviewDoc, docs)
        .filter(notMine)
        .map((d) => item(d, { kind: 'review', repo: t.repo, what: VERDICT_WHAT[d.verdict] ?? 'reviewed', target }))
    }
  }
}

// ---------------------------------------------------------------------------
// Subscriptions (chain reads)
// ---------------------------------------------------------------------------

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
    prefs.stars ? listStarredRepoIds(sdk, forge, me) : Promise.resolve({ rows: [], more: false }),
    listMyTargets(sdk, forge, me, 'issue'),
    listMyTargets(sdk, forge, me, 'pull'),
    listMyCommentTargets(sdk, forge, me),
  ] as const)
  if (settled.every((r) => r.status === 'rejected')) throw (settled[0] as PromiseRejectedResult).reason
  const [owned, starred, issues, pulls, commented] = settled
  const ok = <T>(r: PromiseSettledResult<T>, fallback: T): T => (r.status === 'fulfilled' ? r.value : fallback)

  const repoSubs: RepoSub[] = []
  const seen = new Set<string>()
  const addRepo = (repo: RepoLite, reason: RepoReason): void => {
    if (seen.has(repo.id)) return
    seen.add(repo.id)
    repoSubs.push({ repo, reason })
  }
  const mine = ok(owned, { owned: [], member: [] })
  for (const r of mine.owned) if (r.kind === 'v2') addRepo({ id: r.key, ownerId: r.ownerId, name: r.slug, private: r.visibility === 'private' }, 'owner')
  for (const r of mine.member) addRepo({ id: r.key, ownerId: r.ownerId, name: r.slug, private: r.visibility === 'private' }, r.role ?? 'writer')
  const starIds = ok(starred, { rows: [], more: false }).rows.filter((id) => !seen.has(id))
  const commentedTargets = ok(commented, [])
  const authored = [...ok(issues, { rows: [], more: false }).rows, ...ok(pulls, { rows: [], more: false }).rows]
  const authoredIds = new Set(authored.map((t) => t.id))
  const commentedRows = await readTargetsByIds(sdk, forge, commentedTargets.map((c) => c.targetId).filter((id) => !authoredIds.has(id))).catch(() => new Map<string, TargetRow>())

  // Repo rows for stars and for threads whose repo is not one of mine.
  const needed = [...starIds, ...authored.map((t) => t.repoId), ...[...commentedRows.values()].map((t) => t.repoId)].filter((id) => !seen.has(id))
  const extra = await readReposByIds(sdk, forge, needed).catch(() => new Map<string, RepoLite>())
  for (const id of starIds) {
    const repo = extra.get(id)
    if (repo) addRepo(repo, 'starred')
  }
  const repoById = new Map([...repoSubs.map((s) => [s.repo.id, s.repo] as const), ...extra])

  const threads: ThreadSub[] = []
  for (const t of authored) {
    const repo = t.repo ?? repoById.get(t.repoId)
    if (repo) threads.push(threadOf(t, repo, 'author', t.createdAt))
  }
  for (const c of commentedTargets) {
    const t = commentedRows.get(c.targetId)
    const repo = t ? repoById.get(t.repoId) : undefined
    if (t && repo) threads.push(threadOf(t, repo, 'commented', c.firstAt))
  }
  threads.sort((a, b) => b.since - a.since)
  return {
    at: now,
    repos: repoSubs.slice(0, MAX_REPOS),
    threads: threads.slice(0, MAX_THREADS),
    droppedRepos: Math.max(0, repoSubs.length - MAX_REPOS),
    droppedThreads: Math.max(0, threads.length - MAX_THREADS),
  }
}

// ---------------------------------------------------------------------------
// Local state (IndexedDB `inbox` store)
// ---------------------------------------------------------------------------

function prefix(network: Network, me: string): string {
  return `${network}:${me}:`
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
  opts: { now?: number; refreshSubs?: boolean } = {},
): Promise<PollResult> {
  const now = opts.now ?? Date.now()
  const p = prefix(network, me)
  const prefs = await loadPrefs(network, me)
  let startedAt = await idbGet<number>('inbox', `${p}started`)
  if (startedAt === undefined) {
    startedAt = now
    await idbPut('inbox', `${p}started`, now)
  }
  let subs = await loadSubs(network, me)
  if (subs === undefined || opts.refreshSubs || now - subs.at > SUBS_TTL_MS) {
    subs = await computeSubscriptions(sdk, network, forge, me, prefs, now)
    await idbPut('inbox', `${p}subs`, subs)
  }
  const feeds = planFeeds(subs, prefs)
  const { round, next } = pickRound(feeds, roundOffsets.get(p) ?? 0)
  roundOffsets.set(p, next)

  const existing = new Set((await loadItems(network, me)).map((i) => i.id))
  let added = 0
  let failed = 0
  for (const f of round) {
    const key = `${p}cursor:${feedKey(f)}`
    const cursor = (await idbGet<number>('inbox', key)) ?? initialCursor(f, startedAt)
    let docs: PlainDocument[]
    try {
      docs = (await queryDocumentsWithProof(sdk, feedQuery(forge, f, cursor))).documents
    } catch {
      failed++
      continue
    }
    for (const it of toItems(f, docs, me)) {
      if (existing.has(it.id)) continue
      existing.add(it.id)
      await idbPut('inbox', `${p}item:${it.id}`, it)
      added++
    }
    const times = docs.map((d) => d['$createdAt']).filter((t): t is number => typeof t === 'number')
    await idbPut('inbox', key, advanceCursor(cursor, times))
  }
  if (added > 0) {
    for (const id of itemsToDrop(await loadItems(network, me))) await idbDelete('inbox', `${p}item:${id}`)
  }
  return { added, feedsRead: round.length - failed, feedsTotal: feeds.length, failed, subs }
}

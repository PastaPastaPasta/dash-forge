/**
 * Issue / PR reads — list + state (`forge-v2.md` §3, §5, §6).
 *
 * Issue/PR *state* (open, closed, merged, draft) is the sum of the target's `transition`
 * deltas: consensus accepts a transition only as a legal move, so the proved sum is the state
 * (`./transitions`). A list page reads it with one sum query for all its rows. Labels,
 * assignees and a PR's base ref are still a fold of the member `event` log
 * (`issueStateV2` / `prStateV2`); lists read the repo's `event` feed (`(repoId, $createdAt)`)
 * once and fold every row from it, rather than a query per row. Documents that are not
 * well-formed for the repo's visibility (`isWellFormed`: plaintext xor `enc`) are skipped
 * everywhere.
 */

import { originOf, type Origin } from './provenance'
import type { EvoSDK } from '@dashevo/evo-sdk'

import {
  compareKey,
  mergeBaseTips,
  prBaseTips,
  type ConfigDoc,
  type Event,
  type IsAncestor,
  type IssueState,
  type PrState,
  type RefUpdate,
} from '../rules'
import {
  IncompleteReadError,
  queryAllDocuments,
  type DocumentQuery,
  type PlainDocument,
} from '../sdk'
import { foldPrReviewV2, issueStateV2, mergeTransition, prMergeBase, prStateV2, stateCode, statusOfCode, type PrReviewState } from '../rules/v2'
import {
  asIdentifierString,
  byteFieldToHex,
  DOC,
  num,
  str,
  toEvent,
  type RepoRef,
  repoKey,
} from './contract'
import { repoChromeTimelines, type ChromeTimelines } from './chrome'
import { configBundleOf, readConfigHistory } from './config'
import { publicRefKey, readRefUpdates, refUpdatesFromRows } from './refs'
import { HiddenTally, SEALED_EPOCH, admitAll, gateFor, readableEvents } from './private-content'
import { onPrivateSessionEnded } from './private-session'
import { repoSource } from './source'
import { base64ToHex, hexToBase64 } from '../sdk'
import { readRepoCounts, readStateCodes, readTransitions, transitionOf, type TransitionView } from './transitions'
import { ISSUE_CLOSE } from '../rules/transition'

/** A row's title; ciphertext (a private repo's, which this client cannot decrypt) says so. */
export function titleOf(doc: PlainDocument): string {
  const title = str(doc, 'title')
  if (title !== '') return title
  return byteFieldToHex(doc, 'enc') !== '' ? 'Encrypted (not readable here)' : ''
}

/** An issue with its folded state. */
export interface IssueView {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly author: string
  readonly createdAt: number
  /**
   * The last edit's consensus time (`$updatedAt`); equal to {@link createdAt} for a document
   * never edited ("edited" = `updatedAt > createdAt`, review-parity spec §3).
   */
  readonly updatedAt: number
  /** The document revision (1 = never edited): an edit names it to refuse a concurrent one. */
  readonly revision: number
  /** Archived from another forge (`imported` provenance present) rather than opened here. */
  readonly imported: boolean
  /** The original issue's URL when the import recorded one, else `''`. */
  readonly importedUrl: string
  /** The `imported` provenance object as read, for re-sealing an edit. */
  readonly importedRaw?: Readonly<Record<string, unknown>> | null
  /**
   * The source forge's number (`upstreamNumber`) as stored, or null. Shown ("#12 · upstream
   * #7761") only when its writer is trusted: see `trustedUpstreamNumber`.
   */
  readonly upstreamNumber: number | null
  /**
   * The original author and time an import recorded (`imported`), or null. Shown only when the
   * signer is trusted to mirror ({@link trustedOrigin}).
   */
  readonly origin?: Origin | null
  readonly state: IssueState
  /**
   * False when the event log could not be read to completion, so `state` is a fold over a
   * partial history and must not be presented as authoritative. Only list surfaces can
   * produce this — a detail read throws instead, because there a wrong state is worse than
   * an error (the list indexes, `./issue-index`, `./pull-index`).
   */
  readonly stateComplete: boolean
}

/** A document's `$updatedAt` (its `$createdAt` when never edited or not recorded). */
export function updatedAtOf(doc: PlainDocument): number {
  const u = doc['$updatedAt']
  return typeof u === 'number' && u > 0 ? u : num(doc, '$createdAt')
}

/** A document's `$revision` (1 when not recorded). */
export function revisionOf(doc: PlainDocument): number {
  const r = doc['$revision']
  return typeof r === 'number' && r > 0 ? r : typeof r === 'bigint' ? Number(r) : 1
}

/** An issue document, its state code and its target log (no reads). */
export function issueViewOf(issueDoc: PlainDocument, log: TargetLog, code: number): IssueView {
  const author = str(issueDoc, '$ownerId')
  return {
    id: str(issueDoc, '$id'),
    number: num(issueDoc, 'number'),
    title: titleOf(issueDoc),
    body: str(issueDoc, 'body'),
    author,
    createdAt: num(issueDoc, '$createdAt'),
    updatedAt: updatedAtOf(issueDoc),
    revision: revisionOf(issueDoc),
    ...readImported(issueDoc),
    state: issueStateV2(code, log.events),
    stateComplete: true,
  }
}

/** A PR (patch) with its folded state. */
export interface PullView {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly author: string
  readonly createdAt: number
  /** The base the PR was opened against (`patch.baseRefName`, immutable). */
  readonly baseRefName: string
  /**
   * The base the PR merges into now: the newest retarget's (event kind 8), else
   * {@link baseRefName} (`prMergeBase`). The base tips, `baseOidAtOpen` / `baseOidAtMerge` and
   * {@link headOnBase} are this ref's.
   */
  readonly mergeBaseRefName: string
  /**
   * The base ref's newest non-deleted `newOid`, or `''` when it has none. This is the tip the
   * merge fold uses (parity with forge-core); it is taken from the raw update history, so a
   * view that has the ref resolved through `resolveRef` should prefer that tip.
   */
  readonly baseTipOid: string
  /**
   * The base ref's tip when the PR was opened (the newest update at or before the patch's
   * `$createdAt`), else its current tip; `''` when it had none. The diff falls back to this
   * once the PR is merged: the current tip then contains the head, so a merge base computed
   * from it is the head itself — an empty diff.
   */
  readonly baseOidAtOpen: string
  /**
   * A merged PR's base tip just before its merge (the tip the merge moved the base from), when
   * the merge's commit is a valid tip of the base's history; else `''` or absent. The diff of a
   * merged PR starts from here, as GitHub's diffs against the merge base at merge time: the tip
   * at open would count base commits a later "Update branch" merged in as the PR's own (QW3-014).
   */
  readonly baseOidAtMerge?: string
  /**
   * The PR's CURRENT head, hex: the newest `headUpdate` (author or member), else
   * {@link initialHeadOid}. Approvals, staleness, the diff and merges use this.
   */
  readonly headOid: string
  /** The head the PR was opened with (`patch.headOid`, immutable). */
  readonly initialHeadOid: string
  /**
   * The review fold (`foldPrReviewV2`) without thread roots: head updates, requested reviewers,
   * dismissed reviews, milestone. `resolvedThreads` is empty here; a view that has the PR's
   * comments folds them in (`foldPrReviewV2` with the root comment ids).
   */
  readonly review: PrReviewState
  /**
   * Where the PR's objects actually live: the **source** `repo` document id
   * (`sourceRepoId`), base58.
   *
   * Surfaced because a reviewer cannot fetch a PR without it: a PR's head commit usually
   * sits in a different repo (a fork) from the one it targets, and this is the only pointer
   * the patch document carries to it. Empty for a malformed document.
   */
  readonly sourceId: string
  /** The branch the PR was opened from, in the source repo, when recorded. */
  readonly sourceRefName: string | null
  /**
   * Whether {@link headOid} has been a tip of the base ref — the exact test the fold applies
   * to a `merge` event naming the head, so a merge mark will count iff this is true (and the
   * marker is a writer or maintainer). False when the base history or head is unknown.
   */
  readonly headOnBase: boolean
  /** Archived from another forge (`imported` provenance present) rather than opened here. */
  readonly imported: boolean
  /** The original PR's URL when the import recorded one, else `''`. */
  readonly importedUrl: string
  /** The `imported` provenance object as read (a private repo's decrypted), for re-sealing an edit. */
  readonly importedRaw?: Readonly<Record<string, unknown>> | null
  /** See {@link IssueView.upstreamNumber}. */
  readonly upstreamNumber: number | null
  /** See {@link IssueView.origin}. */
  readonly origin?: Origin | null
  readonly state: PrState
  /** See {@link IssueView.stateComplete}. */
  readonly stateComplete: boolean
  /** The last edit's time (`$updatedAt`); equal to {@link createdAt} when never edited. */
  readonly updatedAt: number
  /** The document revision (an edit names it to refuse a concurrent one). */
  readonly revision: number
  /** A private PR's key epoch (`epoch`): an edit re-seals under it (private-repos.md §4.5). */
  readonly epoch: number | null
}

/** A review verdict, as recorded on-chain. Parity with forge-core `Verdict`. */
export type VerdictName = 'approve' | 'requestChanges' | 'comment' | 'approveNonMember' | 'requestChangesNonMember' | 'unknown'

const VERDICT_BY_INT: Readonly<Record<number, VerdictName>> = {
  1: 'approve',
  2: 'requestChanges',
  3: 'comment',
  // A non-member's approve and request changes (RC1 R-16): shown as such, never counted.
  4: 'approveNonMember',
  5: 'requestChangesNonMember',
}

/** Short label for a verdict, matching `dg pr view`. */
export const VERDICT_LABEL: Readonly<Record<VerdictName, string>> = {
  approve: 'approved',
  requestChanges: 'changes requested',
  comment: 'commented',
  approveNonMember: 'approved (not a member)',
  requestChangesNonMember: 'changes requested (not a member)',
  unknown: 'unknown verdict',
}

/**
 * Decode an on-chain verdict code.
 *
 * Keeps the raw `code` alongside the name so an unrecognized verdict retains its identity
 * instead of collapsing into an untyped "unknown" — a review written by a newer client
 * still belongs in a PR's history, and forge-core's `Verdict::Unknown(n)` keeps the same
 * information. Pinned by the shared `verdict__*` conformance vectors.
 */
export function verdictFromCode(code: number): { verdict: VerdictName; code: number } {
  return { verdict: VERDICT_BY_INT[code] ?? 'unknown', code }
}

/** A `review` document, flattened. */
export interface ReviewView {
  readonly id: string
  readonly reviewer: string
  readonly verdict: VerdictName
  /** The raw on-chain code, retained even when `verdict` is `unknown`. */
  readonly verdictCode: number
  readonly commitOid: string
  readonly body: string
  /** How many `reviewId` comments the review announced (`commentCount`), or null. */
  readonly commentCount: number | null
  readonly createdAt: number
  /** See {@link IssueView.origin}. */
  readonly origin?: Origin | null
}


/**
 * Fetch a target's **complete** event log (ascending), converted to rules {@link Event}s.
 *
 * COMPLETENESS IS LOAD-BEARING, not a nicety. The label and assignee folds are folds over the
 * whole log: a label removed at row 101 that never arrives stays on forever.
 * It pages to exhaustion, and
 * {@link queryAllDocuments} throws rather than returning a short answer if it cannot
 * prove it reached the end. Parity: forge-core `CollabEngine::fetch_events` uses
 * `query_all_documents` for exactly this reason. The log is `event` and `authorEvent` merged
 * in `($createdAt, $id)` order ({@link readTargetLog} keeps them apart).
 */
export async function readEvents(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<Event[]> {
  const log = await readTargetLog(sdk, repo, targetId)
  return [...log.events, ...log.authorEvents].sort(compareKey)
}

/**
 * A target's event documents, by the type that admitted them: member events (`event`) and
 * the author's own review kinds (`authorEvent`, `forge-v2.md` §3). The review fold needs to
 * know which is which. State is not here: it is the target's `transition` sum.
 */
export interface TargetLog {
  readonly events: Event[]
  readonly authorEvents: Event[]
  /** Private repos: member events whose sealed value is not readable here (kept, without it). */
  readonly hiddenValues?: number
  /** Private repos: member events whose value an older client wrote in plaintext. */
  readonly plaintextValues?: number
}

/** A target with no state documents. */
export const EMPTY_LOG: TargetLog = { events: [], authorEvents: [] }

/**
 * Pages of the repo's member-event feed read before it is declared too large to fold (the issue
 * and pull indexes' labels and assignees are then unverified).
 */
const FEED_MAX_PAGES = 30
/** How long a settled repo feed serves later reads. */
const FEED_TTL_MS = 30_000

/** A cached read: `at` is when it settled (null while in flight). */
type Cache<T> = Map<string, { at: number | null; promise: Promise<T> }>

/** Whether a cached read still answers: in flight, or settled within {@link FEED_TTL_MS}. */
function live(hit: { at: number | null } | undefined): boolean {
  return hit !== undefined && (hit.at === null || Date.now() - hit.at < FEED_TTL_MS)
}

/**
 * One in-flight or settled read per key, joined while in flight and for {@link FEED_TTL_MS} after
 * it settles (a 30-page feed on a slow node outlives the TTL while it reads), dropped when it
 * rejects.
 */
function ttlCached<T>(cache: Cache<T>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit !== undefined && live(hit)) return hit.promise
  const entry: { at: number | null; promise: Promise<T> } = { at: null, promise: load() }
  cache.set(key, entry)
  entry.promise.then(
    () => {
      entry.at = Date.now()
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key)
    },
  )
  return entry.promise
}

const feedCache: Cache<Map<string, TargetLog> | null> = new Map()
/** {@link sharedRepoCounts}' reads, by `feedKey@write generation`. */
const countsCache: Cache<Awaited<ReturnType<typeof readRepoCounts>>> = new Map()
/** An issue close, with the number of the issue it closed. */
export type IssueClose = TransitionView & { readonly targetNumber: number }
const closesCache: Cache<readonly IssueClose[] | null> = new Map()
/** Per repo: bumped by every {@link invalidateRepoFeed}, so a read started before a write can tell. */
const epochs = new Map<string, number>()
/** Per repo: bumped when a write that can change an open count drops its caches. */
const writes = new Map<string, number>()
/** Per repo: when this browser last made such a write. */
const countWrites = new Map<string, number>()
const listeners = new Set<() => void>()

const feedKey = (repo: RepoRef): string => `${repo.forge.collab}:${repo.repoId}`
/**
 * The key of a repo's cached pages: a private repo's hold decrypted titles and bodies, so they are
 * keyed by the reader's session too (`repoKey`) and go with it (below).
 */
const pageKey = (repo: RepoRef): string => `${repo.forge.collab}:${repoKey(repo)}`

onPrivateSessionEnded((id) => {
  for (const k of [...feedCache.keys()]) if (k.includes(`#${id}`)) feedCache.delete(k)
})

/**
 * The repo's write epoch. A reader captures it before its first request; a feed it derives is
 * shared only while the epoch is unchanged, so a read in flight across a write never refills the
 * cache the write just dropped (L-77 review).
 */
export function repoEpoch(repo: RepoRef): number {
  return epochs.get(feedKey(repo)) ?? 0
}

function changed(repo: RepoRef, counters: readonly Map<string, number>[]): void {
  const key = feedKey(repo)
  for (const counter of counters) counter.set(key, (counter.get(key) ?? 0) + 1)
  for (const listener of listeners) listener()
}

/** Group a repo feed's events by target. */
export function groupFeed(events: readonly Event[], authorEvents: readonly Event[]): Map<string, TargetLog> {
  const byTarget = new Map<string, TargetLog>()
  const slot = (targetId: string): TargetLog => {
    let entry = byTarget.get(targetId)
    if (entry === undefined) {
      entry = { events: [], authorEvents: [] }
      byTarget.set(targetId, entry)
    }
    return entry
  }
  for (const e of events) slot(e.targetId ?? '').events.push(e)
  for (const e of authorEvents) slot(e.targetId ?? '').authorEvents.push(e)
  return byTarget
}

/**
 * Drop a repo's cached feed and indexes (tests; and after a write lands). With `counts` (the
 * default) the write can change a count — an issue, patch or transition write — so the
 * subscribers ({@link subscribeRepoLists}) are told, and the lists and the repo header re-read.
 */
export function invalidateRepoFeed(repo: RepoRef, { counts = true }: { counts?: boolean } = {}): void {
  // Every session's pages of this repo (a write is visible to all of them).
  const prefix = `${repo.forge.collab}:${repo.repoId}`
  const ofRepo = (k: string): boolean => k === prefix || k.startsWith(`${prefix}:`) || k.startsWith(`${prefix}#`)
  epochs.set(feedKey(repo), repoEpoch(repo) + 1)
  for (const k of [...feedCache.keys()]) if (ofRepo(k)) feedCache.delete(k)
  for (const drop of invalidationHooks) drop(repo)
  if (!counts) return
  for (const k of [...countsCache.keys()]) if (k.startsWith(`${prefix}@`)) countsCache.delete(k)
  for (const k of [...closesCache.keys()]) if (k.startsWith(`${prefix}@`)) closesCache.delete(k)
  countWrites.set(feedKey(repo), Date.now())
  changed(repo, [writes])
}

/**
 * Whether the repo's proved counts can be taken to include this browser's own latest write: not
 * within {@link FEED_TTL_MS} of a write that changes a count, when a node a block behind may still
 * answer without it (L-37). A list stops walking at a tab's proved count only then; a count that
 * lags a reopen would otherwise leave that row out.
 */
export function countsSettled(repo: RepoRef): boolean {
  return Date.now() - (countWrites.get(feedKey(repo)) ?? -Infinity) >= FEED_TTL_MS
}

/** Other per-repo caches a write drops along with the feed (the issue index, `./issue-index`). */
const invalidationHooks = new Set<(repo: RepoRef) => void>()

/** Run `drop` whenever {@link invalidateRepoFeed} drops a repo's caches. */
export function onRepoInvalidated(drop: (repo: RepoRef) => void): void {
  invalidationHooks.add(drop)
}


/** How many writes to `repo` dropped its caches this session: a cache key for reads a write changes. */
export function repoWriteGeneration(repo: RepoRef): number {
  return writes.get(feedKey(repo)) ?? 0
}

/**
 * The repo's proved issue and PR totals by state ({@link readRepoCounts}: the issue and PR totals
 * and one count of transitions by kind), read once for every reader on the page: the header's
 * open-count tabs, the list's total and the issue or pull index all ask for the same three
 * counts on the same load, and each used to read its own (the Issues list read them three
 * times). Joined in flight and for {@link FEED_TTL_MS} after; a write that can change a count
 * moves to a new write generation, so a read issued before it never answers after it.
 */
export function sharedRepoCounts(sdk: EvoSDK, repo: RepoRef): Promise<Awaited<ReturnType<typeof readRepoCounts>>> {
  return ttlCached(countsCache, `${feedKey(repo)}@${repoWriteGeneration(repo)}`, () => readRepoCounts(sdk, repo))
}

/**
 * Every issue close of the repo (`transition.perRepoKind`, `kind == 1`), read at most `maxPages`
 * pages, once per write generation for every issue page of the session (null: more than that).
 */
export function sharedIssueCloses(sdk: EvoSDK, repo: RepoRef, maxPages: number): Promise<readonly IssueClose[] | null> {
  return ttlCached(closesCache, `${feedKey(repo)}@${repoWriteGeneration(repo)}:${maxPages}`, async () => {
    try {
      const docs = await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.transition, { where: [['kind', '==', ISSUE_CLOSE]], orderBy: [['kind', 'asc']] }), { maxPages })
      return docs.map((d) => ({ ...transitionOf(d), targetNumber: num(d, 'targetNumber') }))
    } catch (e) {
      if (e instanceof IncompleteReadError) return null
      throw e
    }
  })
}

/** Be told whenever any repo's list pages change; returns the unsubscribe. */
export function subscribeRepoLists(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function toEvents(documents: readonly PlainDocument[]): Event[] {
  return documents.map(toEvent).filter((e): e is Event => e !== null)
}

/**
 * A target's member `event` and `authorEvent` documents as a {@link TargetLog}: a private
 * repo's member events read through {@link readableEvents} (their values opened, and counted).
 */
export async function toLog(repo: RepoRef, events: readonly PlainDocument[], authorEvents: readonly PlainDocument[]): Promise<TargetLog> {
  const r = await readableEvents(repo, events)
  return { events: toEvents(r.docs), authorEvents: toEvents(authorEvents), hiddenValues: r.hiddenValues, plaintextValues: r.plaintextValues }
}

/** One target's complete {@link TargetLog} (see {@link readEvents} on completeness). */
export async function readTargetLog(
  sdk: EvoSDK,
  repo: RepoRef,
  targetId: string,
): Promise<TargetLog> {
  const source = repoSource(repo)
  const read = (type: string): Promise<PlainDocument[]> =>
    queryAllDocuments(
      sdk,
      source.targetQuery(type, {
        where: [['targetId', '==', targetId]],
        orderBy: [
          ['targetId', 'asc'],
          ['$createdAt', 'asc'],
        ],
      }),
    )
  const [events, authorEvents] = await Promise.all([read(DOC.event), read(DOC.authorEvent)])
  return toLog(repo, events, authorEvents)
}

/** The repo's member-event feed query (`(repoId, $createdAt)`, oldest first). */
export function feedQuery(repo: RepoRef): DocumentQuery {
  return repoSource(repo).repoQuery(DOC.event, { orderBy: [['$createdAt', 'asc']] })
}

/**
 * The repo's member events, grouped by target: what the issue and pull indexes fold every row's
 * labels and assignees from (state is the rows' transition sums; `event` is member-gated at
 * consensus, so the feed is bounded by real activity). Read once per repo through a short
 * cache: a read another reader has in flight or settled is joined, else this one starts,
 * continued past `first` when given (an index's composite sibling page), and is shared the moment
 * it starts, so the two indexes page the feed once between them (L-77). `epoch` is the
 * {@link repoEpoch} `first` was read at: a first page from before a write is not shared. Null
 * when the feed is too large to fold ({@link FEED_MAX_PAGES}).
 */
export function readRepoFeedFrom(
  sdk: EvoSDK,
  repo: RepoRef,
  first: readonly PlainDocument[] | undefined,
  epoch: number,
): Promise<Map<string, TargetLog> | null> {
  if (epoch !== repoEpoch(repo)) return readRepoFeed(sdk, repo, first)
  return ttlCached(feedCache, pageKey(repo), () => readRepoFeed(sdk, repo, first))
}

/** The feed another reader is reading, or read within {@link FEED_TTL_MS}, if any. */
export function sharedRepoFeed(repo: RepoRef): Promise<Map<string, TargetLog> | null> | undefined {
  const hit = feedCache.get(pageKey(repo))
  return live(hit) ? hit!.promise : undefined
}

/**
 * Feed pages (after the first, which rides the issue index's first composite) an issue list's page
 * 1 reads for its pinned issues before it leaves them to be asked for (QW3-003: the dash mirror's
 * import grew its feed to 9 pages, read on every cold load).
 */
export const PIN_FEED_PAGES = 2

/**
 * The repo's feed when it ends within `maxPages` pages (`first`, the composite's first page, is
 * page 1), shared as {@link readRepoFeedFrom}'s would be; `'long'` when it runs longer, with
 * nothing cached (a full read later still reads it). A feed another reader has is joined.
 */
export async function readShortRepoFeed(
  sdk: EvoSDK,
  repo: RepoRef,
  first: readonly PlainDocument[] | undefined,
  epoch: number,
  maxPages: number,
): Promise<Map<string, TargetLog> | null | 'long'> {
  const shared = sharedRepoFeed(repo)
  if (shared !== undefined) return shared
  let docs: PlainDocument[]
  try {
    docs = await queryAllDocuments(sdk, feedQuery(repo), { maxPages, firstPage: first })
  } catch (e) {
    if (e instanceof IncompleteReadError) return 'long'
    throw e
  }
  const log = await toLog(repo, docs, [])
  const feed = groupFeed(log.events, [])
  // Shared like a full read's, unless a write landed meanwhile.
  if (epoch === repoEpoch(repo)) return ttlCached(feedCache, pageKey(repo), () => Promise.resolve(feed))
  return feed
}

async function readRepoFeed(sdk: EvoSDK, repo: RepoRef, first: readonly PlainDocument[] | undefined): Promise<Map<string, TargetLog> | null> {
  try {
    const docs = await queryAllDocuments(sdk, feedQuery(repo), { maxPages: FEED_MAX_PAGES, firstPage: first })
    // A private repo's member events are read through `readableEvents` (values opened).
    const log = await toLog(repo, docs, [])
    return groupFeed(log.events, [])
  } catch (e) {
    if (e instanceof IncompleteReadError) return null
    throw e
  }
}

/**
 * Read **every** `review` on a patch, oldest first.
 *
 * Reviews were write-only across the whole codebase until this existed: the CLI could post
 * "changes requested" and no reader, view or command ever queried it back, so the verdict
 * was a paid-for record invisible to everyone — including the contributor it was addressed
 * to. Complete, for the same reason the event log is: a verdict buried past row 100 is
 * exactly the one that matters.
 * Parity: forge-core `PullRequestService::list_reviews`.
 */
export async function readReviews(
  sdk: EvoSDK,
  repo: RepoRef,
  patchId: string,
  tally: HiddenTally = new HiddenTally(),
): Promise<ReviewView[]> {
  const raw = await queryAllDocuments(
    sdk,
    repoSource(repo).targetQuery(DOC.review, {
      where: [['patchId', '==', patchId]],
      orderBy: [
        ['patchId', 'asc'],
        ['$createdAt', 'asc'],
      ],
    }),
  )
  // A private review whose `enc` does not open is left out entirely: its plaintext verdict is
  // never counted as an approval (`private-repos.md` §8.1).
  const { docs } = await admitAll(gateFor(repo), 'review', raw, tally)
  return docs.map(reviewViewOf)
}

/** An (admitted) `review` document as a {@link ReviewView}. */
export function reviewViewOf(d: PlainDocument): ReviewView {
  const { verdict, code } = verdictFromCode(num(d, 'verdict'))
  return {
    id: str(d, '$id'),
    reviewer: str(d, '$ownerId'),
    verdict,
    verdictCode: code,
    commitOid: byteFieldToHex(d, 'commitOid'),
    body: str(d, 'body'),
    commentCount: typeof d['commentCount'] === 'number' ? d['commentCount'] : null,
    createdAt: num(d, '$createdAt'),
    origin: originOf(d),
  }
}

/**
 * Read one issue and its state (`log`, when given, is the target's slice of the repo feed;
 * `code`, its state code from the page's sum query).
 */
export async function readIssue(
  sdk: EvoSDK,
  repo: RepoRef,
  issueDoc: PlainDocument,
  log?: TargetLog,
  code?: number,
): Promise<IssueView> {
  const id = str(issueDoc, '$id')
  const [l, c] = await Promise.all([
    log ?? readTargetLog(sdk, repo, id),
    code ?? readStateCodes(sdk, repo, [id]).then((m) => m.get(id) ?? 0),
  ])
  return issueViewOf(issueDoc, l, c)
}

/**
 * A historical-tips merge predicate for `prStateV2`'s on-base label: a merge oid stays valid once
 * the base ref advances past it, so the predicate tests membership in the set of every tip
 * the base ref has EVER had — not reflexive equality (the BLOCKER-1 fix). Built from the
 * base ref's full `refUpdate`/`protectedRefUpdate` history.
 */
export function historicalTipsPredicate(baseRefNewOidsHex: readonly string[]): IsAncestor {
  const tips = new Set(baseRefNewOidsHex)
  return (oid) => tips.has(oid)
}

/** An issue's or patch's `imported` provenance and `upstreamNumber` (items archived from another forge). */
function readImported(doc: PlainDocument): {
  imported: boolean
  importedUrl: string
  importedRaw: Readonly<Record<string, unknown>> | null
  upstreamNumber: number | null
  origin: Origin | null
} {
  const up = doc['upstreamNumber']
  const upstreamNumber = typeof up === 'number' && Number.isInteger(up) && up > 0 ? up : null
  const value = doc['imported']
  if (typeof value !== 'object' || value === null) return { imported: false, importedUrl: '', importedRaw: null, upstreamNumber, origin: null }
  const url = (value as PlainDocument)['url']
  return {
    imported: true,
    importedUrl: typeof url === 'string' ? url : '',
    importedRaw: value as Readonly<Record<string, unknown>>,
    upstreamNumber,
    origin: originOf(doc),
  }
}

/** A patch's source pointer (`sourceRepoId`). */
function sourceIdOf(doc: PlainDocument): string {
  return asIdentifierString(doc['sourceRepoId'])
}

/** A base ref's tips, as a PR read needs them. */
export interface BaseRefTips {
  /**
   * Every oid a VALID update set the ref to (deletions excluded), oldest first, each once:
   * the merge-reachability set. A plain `refUpdate` on a protected ref is inert (§4) and not
   * in it ({@link mergeBaseTips}). Empty when the base was no branch when the PR was opened
   * ({@link prBaseTips}, D-501).
   */
  readonly historical: readonly string[]
  /** The newest of those: the fold's base tip. */
  readonly tip: string | undefined
  /**
   * Where the ref pointed at `openedAt`: `''` when it was deleted then, `undefined` when it
   * had no valid update yet. Only a diff baseline, never a trust input.
   */
  readonly atOpen: string | undefined
}

/**
 * Derive {@link BaseRefTips} from a ref's full update history and the repo's config
 * timeline: `historical` and `tip` are the shared {@link prBaseTips} rule (parity with
 * forge-core `read_merge_base`; a base that was no branch when the PR was opened has none,
 * D-501), `atOpen` is where the valid history pointed when the PR was opened.
 */
export function baseRefTips(
  updates: readonly RefUpdate[],
  configHistory: readonly ConfigDoc[],
  refNameHashHex: string,
  openedAt: number,
): BaseRefTips {
  const tips = prBaseTips(updates, configHistory, refNameHashHex, openedAt)
  const before = mergeBaseTips(
    updates.filter((u) => u.createdAt <= openedAt),
    configHistory,
    refNameHashHex,
  )
  return {
    historical: tips.historical,
    tip: tips.tip ?? undefined,
    atOpen: before.tip === null ? undefined : before.current ?? '',
  }
}

/**
 * The base tip a merge moved the base branch from: the valid tip recorded just before `mergeOid`
 * first became one (`historical` is oldest first, each tip once), or `''` when the merge's commit
 * was never a tip of the base (a mark recorded for a commit only an ancestor of a tip) or was its
 * first tip.
 */
export function tipBeforeMerge(historical: readonly string[], mergeOid: string): string {
  const at = historical.indexOf(mergeOid.toLowerCase())
  return at > 0 ? (historical[at - 1] as string) : ''
}

/**
 * Read one PR (patch) and its state. `transitions`, when given, are the PR's own (a detail
 * view: the merge oid is then known and labelled against the base's VALID history through the
 * historical-tips predicate); else `code` is its state code from a list page's sum query.
 * `configHistory` yields the repo's config timeline and `refUpdates` a base ref's update
 * history (each read here when not given; a list shares one read of each across its rows).
 */
export async function readPull(
  sdk: EvoSDK,
  repo: RepoRef,
  patchDoc: PlainDocument,
  log?: TargetLog,
  configHistory?: () => Promise<readonly ConfigDoc[]>,
  refUpdates?: (refNameHashB64: string) => Promise<RefUpdate[]>,
  state?: { readonly code: number } | { readonly transitions: readonly TransitionView[] },
): Promise<PullView> {
  const id = str(patchDoc, '$id')
  const author = str(patchDoc, '$ownerId')
  const createdAt = num(patchDoc, '$createdAt')
  const baseHeadOidRaw = patchDoc['headOid']

  const [l, s] = await Promise.all([
    log ?? readTargetLog(sdk, repo, id),
    state ?? readTransitions(sdk, repo, id).then((transitions) => ({ transitions })),
  ])
  const code = 'code' in s ? s.code : stateCode(s.transitions)
  const merge = 'transitions' in s ? mergeTransition(s.transitions) : null
  const mergeOid = merge?.oid ?? null
  // The base the PR merges into: the newest retarget's (kind 8, before the merge), else the
  // one it was opened with (`prMergeBase`, parity with forge-core `pr_merge_base`).
  const base = prMergeBase(str(patchDoc, 'baseRefName'), createdAt, l.events, merge?.createdAt ?? null)
  // A private patch indexes its base under an HMAC; once opened, its ref is keyed like every
  // decrypted ref, by `sha256(baseRefName)` (`refs.ts`). A retarget names its base in plain
  // (opened) text, keyed the same way.
  let baseKeyHex = byteFieldToHex(patchDoc, 'baseRefNameHash')
  if (repo.visibility === 'private' || base.retargeted) baseKeyHex = base.refName === '' ? '' : publicRefKey(base.refName)
  const baseRefNameHashRaw = /^[0-9a-f]{64}$/.test(baseKeyHex) ? hexToBase64(baseKeyHex) : ''

  // Build the base ref's historical-tips set for the merge-reachability predicate.
  let isAncestor: IsAncestor = () => false
  let tips: BaseRefTips = { historical: [], tip: undefined, atOpen: undefined }
  if (baseRefNameHashRaw.length > 0) {
    const [updates, configs] = await Promise.all([
      refUpdates ? refUpdates(baseRefNameHashRaw) : readRefUpdates(sdk, repo, baseRefNameHashRaw),
      configHistory ? configHistory() : readConfigHistory(sdk, repo),
    ])
    tips = baseRefTips(updates, configs, baseKeyHex, base.since)
    isAncestor = historicalTipsPredicate(tips.historical)
  }
  const baseTip = tips.tip
  const prState: PrState = prStateV2(code, mergeOid, l.events, baseTip, isAncestor)
  let initialHeadOid = ''
  if (typeof baseHeadOidRaw === 'string' && baseHeadOidRaw.length > 0) {
    try {
      initialHeadOid = base64ToHex(baseHeadOidRaw)
    } catch {
      initialHeadOid = baseHeadOidRaw
    }
  }
  // The PR follows its branch through `headUpdate` events (review-parity spec §4.6).
  const review = foldPrReviewV2(l.events, l.authorEvents, author, initialHeadOid, new Set())
  const headOid = review.head

  return {
    id,
    number: num(patchDoc, 'number'),
    title: titleOf(patchDoc),
    body: str(patchDoc, 'body'),
    author,
    createdAt,
    baseRefName: str(patchDoc, 'baseRefName'),
    mergeBaseRefName: base.refName,
    baseTipOid: baseTip ?? '',
    baseOidAtOpen: tips.atOpen ?? baseTip ?? '',
    baseOidAtMerge: mergeOid === null ? '' : tipBeforeMerge(tips.historical, mergeOid),
    headOid,
    initialHeadOid,
    review,
    sourceId: sourceIdOf(patchDoc),
    sourceRefName: typeof patchDoc['sourceRefName'] === 'string' ? patchDoc['sourceRefName'] : null,
    headOnBase: headOid !== '' && baseTip !== undefined && isAncestor(headOid, baseTip),
    ...readImported(patchDoc),
    state: prState,
    stateComplete: true,
    ...editMeta(patchDoc),
  }
}

/** A patch's edit bookkeeping: `$updatedAt`, `$revision` and (a private PR's) `epoch`. */
function editMeta(doc: PlainDocument): { updatedAt: number; revision: number; epoch: number | null } {
  const epoch = doc[SEALED_EPOCH]
  return {
    updatedAt: updatedAtOf(doc),
    revision: revisionOf(doc),
    epoch: typeof epoch === 'number' ? epoch : typeof epoch === 'bigint' ? Number(epoch) : null,
  }
}

/** How {@link readPull} reads a repo's config timeline and a base ref's update history. */
export interface BaseRefReaders {
  readonly configHistory: () => Promise<readonly ConfigDoc[]>
  readonly refUpdates: (refNameHashB64: string) => Promise<RefUpdate[]>
}

/**
 * The config and base-ref histories PR reads share, each read at most once per reader set. A
 * public repo's come from the repo chrome store (`repoChromeTimelines`): the page's own chrome
 * read of up to `maxAgeMs` ago, else one delta request for what is new. From it, the config
 * timeline and each base ref's own history, never every ref's: no request when the composite held
 * them whole or the page's home already read that ref (a list's base is usually the default
 * branch), else one equality read per ref-update type (QW3: a PR list no longer waits for the dash
 * mirror's ~700 ref updates). A private repo's (no store) are read here: one config read, one
 * update-history read per base ref, so a list costs O(base refs), not O(PRs).
 */
export function baseRefReaders(sdk: EvoSDK, repo: RepoRef, { maxAgeMs = FEED_TTL_MS }: { readonly maxAgeMs?: number } = {}): BaseRefReaders {
  // Each read is kept for the reader set's life, unless it fails transiently: then the next caller
  // reads again (a node down must not stick to an index that lives for the session). A history too
  // large to read (`IncompleteReadError`) would fail the same way again: that answer is kept.
  const held = new Map<string, Promise<unknown>>()
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    let hit = held.get(key) as Promise<T> | undefined
    if (hit === undefined) {
      hit = read()
      held.set(key, hit)
      const mine = hit
      hit.catch((e: unknown) => {
        if (!(e instanceof IncompleteReadError) && held.get(key) === mine) held.delete(key)
      })
    }
    return hit
  }
  const stored = (): Promise<ChromeTimelines | null> => once('timelines', () => repoChromeTimelines(sdk, repo, { maxAgeMs }))
  return {
    configHistory: () =>
      once('config', async () => {
        const t = await stored()
        return t === null ? readConfigHistory(sdk, repo) : configBundleOf(repo, await t.config()).history
      }),
    refUpdates: (hash) =>
      once(`ref:${hash}`, async () => {
        const t = await stored()
        if (t === null) return readRefUpdates(sdk, repo, hash)
        const rows = await t.ref(hash)
        return refUpdatesFromRows(repo, rows.refUpdate, rows.protectedRefUpdate, hash)
      }),
  }
}

/** A PR row whose base history could not be read completely: its proved state, no labels or head updates. */
export function incompletePullView(doc: PlainDocument, code: number): PullView {
  let headOid = ''
  const raw = doc['headOid']
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      headOid = base64ToHex(raw)
    } catch {
      headOid = raw
    }
  }
  return {
    id: str(doc, '$id'),
    number: num(doc, 'number'),
    title: titleOf(doc),
    body: str(doc, 'body'),
    author: str(doc, '$ownerId'),
    createdAt: num(doc, '$createdAt'),
    baseRefName: str(doc, 'baseRefName'),
    mergeBaseRefName: str(doc, 'baseRefName'),
    // No ref history was read for this row, so there is no baseline to diff against.
    baseTipOid: '',
    baseOidAtOpen: '',
    // The log was not read, so the head cannot be folded: the opened head, marked incomplete.
    headOid,
    initialHeadOid: headOid,
    review: { head: headOid, headUpdates: [], requestedReviewers: [], resolvedThreads: [], dismissedReviews: [], milestone: null },
    // The source pointer is plain document content, not a fold — it is readable even when
    // the event log is not, and it is what a reviewer needs to fetch the PR at all.
    sourceId: sourceIdOf(doc),
    sourceRefName: typeof doc['sourceRefName'] === 'string' ? doc['sourceRefName'] : null,
    headOnBase: false,
    ...readImported(doc),
    state: { ...statusOfCode(code), baseRef: null, labels: [], assignees: [], mergeOnBase: null },
    stateComplete: false,
    ...editMeta(doc),
  }
}

/** A repo's OPEN issue and PR counts for the tabs (null: not read). */
export interface TargetTotals {
  readonly issues: number | null
  readonly pulls: number | null
}

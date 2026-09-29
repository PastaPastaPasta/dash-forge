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
  queryDocumentsWithProof,
  type PlainDocument,
} from '../sdk'
import { foldPrReviewV2, issueStateV2, mergeTransition, prStateV2, stateCode, statusOfCode, type PrReviewState } from '../rules/v2'
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
import { repoTimelines, type RepoTimelines } from './chrome'
import { configBundleOf, readConfigHistory } from './config'
import { publicRefKey, readRefUpdates, refUpdatesFromRows } from './refs'
import { HiddenTally, SEALED_EPOCH, admitAll, gateFor, readableEvents, type HiddenCounts } from './private-content'
import { onPrivateSessionEnded } from './private-session'
import { repoSource } from './source'
import { base64ToHex, hexToBase64 } from '../sdk'
import { readStateCodes, readTransitions, type TransitionView } from './transitions'

/** A row's title; ciphertext (a private repo's, which this client cannot decrypt) says so. */
export function titleOf(doc: PlainDocument): string {
  const title = str(doc, 'title')
  if (title !== '') return title
  return byteFieldToHex(doc, 'enc') !== '' ? 'Encrypted (not readable here)' : ''
}

/**
 * A list page: the rows, and how many newer documents were skipped as not well-formed (or, in
 * a private repo, as unreadable: `hiddenBy` splits them by reason) — shown as "N hidden",
 * never silently. `complete` is true when the read reached the end of the list, so the rows
 * are every shown document of the repo, not just its newest page (an open count needs that).
 */
export type Listed<T> = T[] & { readonly hidden: number; readonly hiddenBy: HiddenCounts; readonly complete: boolean }

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
   * an error. See {@link listIssues}.
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
  readonly baseRefName: string
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
export type VerdictName = 'approve' | 'requestChanges' | 'comment' | 'unknown'

const VERDICT_BY_INT: Readonly<Record<number, VerdictName>> = {
  1: 'approve',
  2: 'requestChanges',
  3: 'comment',
  // A non-member's approve and request changes (RC1 R-16): shown as such, never counted.
  4: 'approve',
  5: 'requestChanges',
}

/** Short label for a verdict, matching `dg pr view`. */
export const VERDICT_LABEL: Readonly<Record<VerdictName, string>> = {
  approve: 'approved',
  requestChanges: 'changes requested',
  comment: 'commented',
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

const EMPTY_LOG: TargetLog = { events: [], authorEvents: [] }

/**
 * The repo feed is read up front only while it is small: past this many pages per type (and
 * `authorEvent` can be written by any issue author), a list page folds each row from its own
 * target log instead, so its cost is O(page), not O(repo activity).
 */
const FEED_MAX_PAGES = 5
/** How long a repo feed, and the lists folded from it, serve later reads. */
const FEED_TTL_MS = 30_000

type Cache<T> = Map<string, { at: number; promise: Promise<T> }>

/** One in-flight or settled read per key for {@link FEED_TTL_MS}, dropped when it rejects. */
function ttlCached<T>(cache: Cache<T>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < FEED_TTL_MS) return hit.promise
  const entry = { at: Date.now(), promise: load() }
  cache.set(key, entry)
  entry.promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key)
  })
  return entry.promise
}

const feedCache: Cache<Map<string, TargetLog> | null> = new Map()
/** The in-flight or fresh issue / PR list page per repo and type. */
const listCache: Cache<Listed<IssueView> | Listed<PullView>> = new Map()
/** Per repo: bumped when a write that can change an open count drops its caches. */
const writes = new Map<string, number>()
const listeners = new Set<() => void>()

const feedKey = (repo: RepoRef): string => `${repo.forge.collab}:${repo.repoId}`
/**
 * The key of a repo's cached pages: a private repo's hold decrypted titles and bodies, so they are
 * keyed by the reader's session too (`repoKey`) and go with it (below).
 */
const pageKey = (repo: RepoRef): string => `${repo.forge.collab}:${repoKey(repo)}`
const listKey = (repo: RepoRef, type: 'issue' | 'patch'): string => `${pageKey(repo)}:${type}`

onPrivateSessionEnded((id) => {
  for (const m of [feedCache, listCache] as Map<string, unknown>[]) {
    for (const k of [...m.keys()]) if (k.includes(`#${id}`)) m.delete(k)
  }
})

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

/** {@link readRepoFeed} through a short per-repo cache (issues and pulls pages share it). */
function readRepoFeedCached(sdk: EvoSDK, repo: RepoRef): Promise<Map<string, TargetLog> | null> {
  return ttlCached(feedCache, pageKey(repo), () => readRepoFeed(sdk, repo))
}

/**
 * Drop a repo's cached feed and list pages (tests; and after a write lands). With `counts`
 * (the default) the write can change a count — an issue, patch or transition write — so the
 * settled lists go stale and the subscribers ({@link subscribeRepoLists}) are told, and the
 * repo header re-reads its counts.
 */
export function invalidateRepoFeed(repo: RepoRef, { counts = true }: { counts?: boolean } = {}): void {
  // Every session's pages of this repo (a write is visible to all of them).
  const prefix = `${repo.forge.collab}:${repo.repoId}`
  const ofRepo = (k: string): boolean => k === prefix || k.startsWith(`${prefix}:`) || k.startsWith(`${prefix}#`)
  for (const k of [...feedCache.keys()]) if (ofRepo(k)) feedCache.delete(k)
  for (const k of [...listCache.keys()]) if (ofRepo(k)) listCache.delete(k)
  for (const drop of invalidationHooks) drop(repo)
  if (!counts) return
  changed(repo, [writes])
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

/**
 * Every `event` and `authorEvent` of a repo, grouped by target — the repo feed
 * (`(repoId, $createdAt)` on both types), read to completion once so a list page folds all of
 * its rows without a query per row. `event` is member-gated and `authorEvent` author-gated at
 * consensus, so the feed is bounded by real activity, not by what strangers post.
 */
async function readRepoFeed(sdk: EvoSDK, repo: RepoRef): Promise<Map<string, TargetLog> | null> {
  const source = repoSource(repo)
  const read = (type: string): Promise<PlainDocument[]> =>
    queryAllDocuments(sdk, source.repoQuery(type, { orderBy: [['$createdAt', 'asc']] }), {
      maxPages: FEED_MAX_PAGES,
    })
  let events: Event[]
  let authorEvents: Event[]
  try {
    const [e, a] = await Promise.all([read(DOC.event), read(DOC.authorEvent)])
    ;({ events, authorEvents } = await toLog(repo, e, a))
  } catch (e) {
    // Too much activity to read up front: the caller folds rows one target at a time.
    if (e instanceof IncompleteReadError) return null
    throw e
  }
  return groupFeed(events, authorEvents)
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

/** Pages a list read may take to fill `limit` shown rows past hidden ones. */
const LIST_MAX_PAGES = 5

/**
 * The newest `limit` issues or patches of a repo, `$createdAt` descending, and how many were
 * skipped on the way. It skips documents that are not well-formed for the repo's
 * visibility (`forge-v2.md` §5), and in a private repo every document that does not open with
 * the reader's keys (`docs/security/private-repos.md` §8). Skipped rows do
 * not shorten the page: the read continues (newest-first, by a `$createdAt <` bound, so no
 * cursor) until `limit` rows are found, the list ends, or {@link LIST_MAX_PAGES} pages.
 */
async function newestTargets(
  sdk: EvoSDK,
  repo: RepoRef,
  type: 'issue' | 'patch',
  limit: number,
): Promise<{ documents: PlainDocument[]; hidden: HiddenTally; complete: boolean }> {
  // Public: well-formed documents. Private: the ones that open with the reader's keys
  // (`open_content`), decrypted; without a session, none.
  const gate = gateFor(repo)
  const out: PlainDocument[] = []
  const seen = new Set<string>()
  const hidden = new HiddenTally()
  let complete = false
  let before: number | null = null
  for (let page = 0; page < LIST_MAX_PAGES && out.length < limit; page++) {
    const { documents } = await queryDocumentsWithProof(
      sdk,
      repoSource(repo).repoQuery(DOC[type], {
        // `<=`, not `<`: rows sharing the boundary's timestamp may not all have fit the page.
        ...(before === null ? {} : { where: [['$createdAt', '<=', before]] }),
        orderBy: [['$createdAt', 'desc']],
        limit,
      }),
    )
    let cut = false
    for (const d of documents) {
      if (out.length >= limit) {
        cut = true
        break
      }
      const id = str(d, '$id')
      if (seen.has(id)) continue
      seen.add(id)
      const a = await gate.admit(type, d)
      if (a.ok) out.push(a.doc)
      else hidden.add(a.reason)
    }
    // A short page is the end of the list: complete, unless the page was cut to fit `limit`.
    if (documents.length < limit) {
      complete = !cut
      break
    }
    const oldest = documents[documents.length - 1]?.['$createdAt']
    if (typeof oldest !== 'number' || oldest === before) break
    before = oldest
  }
  return { documents: out, hidden, complete }
}

/**
 * Fold a page of issue or patch rows from the repo feed, read once for the whole page — or,
 * when the feed is too large, one row at a time, keeping a row (labels unverified) whose event
 * log cannot be read to completion.
 */
async function foldRows<T>(
  sdk: EvoSDK,
  repo: RepoRef,
  documents: readonly PlainDocument[],
  foldOne: (doc: PlainDocument, log: TargetLog | undefined, code: number) => Promise<T>,
  incomplete: (doc: PlainDocument, code: number) => T,
): Promise<T[]> {
  // State: one proved sum query for the page. Labels and assignees: fold from the repo feed
  // while it is small; otherwise (feed = null) each row reads its own target log.
  const [feed, codes] =
    documents.length > 0
      ? await Promise.all([readRepoFeedCached(sdk, repo), readStateCodes(sdk, repo, documents.map((d) => str(d, '$id')))])
      : [null, new Map<string, number>()]
  // Per-row tolerance. One target padded past the reader's completeness bound must not take
  // down a whole page of issues, and dropping the row silently would be the same class of bug.
  // The row keeps its proved state (the sum) with `stateComplete: false`: its labels and
  // assignees are unverified. (A PR row also reads its base ref's history, which can fail the
  // same way.)
  return Promise.all(
    documents.map((doc) => {
      const code = codes.get(str(doc, '$id')) ?? 0
      return foldOne(doc, feed === null ? undefined : feed.get(str(doc, '$id')) ?? EMPTY_LOG, code).catch((e: unknown) => {
        if (!(e instanceof IncompleteReadError)) throw e
        return incomplete(doc, code)
      })
    }),
  )
}

/** List issues (newest first) with folded state. */
export async function listIssues(
  sdk: EvoSDK,
  repo: RepoRef,
  limit = 50,
): Promise<Listed<IssueView>> {
  const { documents, hidden, complete } = await newestTargets(sdk, repo, 'issue', limit)
  const rows = await foldRows(
    sdk,
    repo,
    documents,
    (doc, log, code) => readIssue(sdk, repo, doc, log, code),
    incompleteIssueView,
  )
  return Object.assign(rows, { hidden: hidden.total, hiddenBy: hidden.value, complete })
}

/** An issue row whose event log could not be read completely: its proved state, no labels or assignees. */
function incompleteIssueView(doc: PlainDocument, code: number): IssueView {
  return {
    id: str(doc, '$id'),
    number: num(doc, 'number'),
    title: titleOf(doc),
    body: str(doc, 'body'),
    author: str(doc, '$ownerId'),
    createdAt: num(doc, '$createdAt'),
    updatedAt: updatedAtOf(doc),
    revision: revisionOf(doc),
    ...readImported(doc),
    state: { open: statusOfCode(code).open, labels: [], assignees: [] },
    stateComplete: false,
  }
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
  // A private patch indexes its base under an HMAC; once opened, its ref is keyed like every
  // decrypted ref, by `sha256(baseRefName)` (`refs.ts`).
  const baseName = str(patchDoc, 'baseRefName')
  let baseKeyHex = byteFieldToHex(patchDoc, 'baseRefNameHash')
  if (repo.visibility === 'private') baseKeyHex = baseName === '' ? '' : publicRefKey(baseName)
  const baseRefNameHashRaw = /^[0-9a-f]{64}$/.test(baseKeyHex) ? hexToBase64(baseKeyHex) : ''
  const baseHeadOidRaw = patchDoc['headOid']

  // Build the base ref's historical-tips set for the merge-reachability predicate.
  let isAncestor: IsAncestor = () => false
  let tips: BaseRefTips = { historical: [], tip: undefined, atOpen: undefined }
  if (typeof baseRefNameHashRaw === 'string' && baseRefNameHashRaw.length > 0) {
    const [updates, configs] = await Promise.all([
      refUpdates ? refUpdates(baseRefNameHashRaw) : readRefUpdates(sdk, repo, baseRefNameHashRaw),
      configHistory ? configHistory() : readConfigHistory(sdk, repo),
    ])
    tips = baseRefTips(updates, configs, baseKeyHex, createdAt)
    isAncestor = historicalTipsPredicate(tips.historical)
  }
  const baseTip = tips.tip

  const [l, s] = await Promise.all([
    log ?? readTargetLog(sdk, repo, id),
    state ?? readTransitions(sdk, repo, id).then((transitions) => ({ transitions })),
  ])
  const code = 'code' in s ? s.code : stateCode(s.transitions)
  const mergeOid = 'transitions' in s ? mergeTransition(s.transitions)?.oid ?? null : null
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
    baseTipOid: baseTip ?? '',
    baseOidAtOpen: tips.atOpen ?? baseTip ?? '',
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

/** List PRs (patches, newest first) with folded state. */
export async function listPulls(
  sdk: EvoSDK,
  repo: RepoRef,
  limit = 50,
): Promise<Listed<PullView>> {
  const { documents, hidden, complete } = await newestTargets(sdk, repo, 'patch', limit)
  // A public repo's base refs and config come from the repo chrome store: the page's own chrome
  // read of a moment ago (no request), else one request for what is new. The ref histories are
  // the complete timelines the Code tab folds, so a PR folds against the same ones.
  let timelines: Promise<RepoTimelines | null> | undefined
  const stored = (): Promise<RepoTimelines | null> => (timelines ??= repoTimelines(sdk, repo, { maxAgeMs: FEED_TTL_MS }))
  // One config read for the whole page, made by the first row that has a base ref.
  let configs: Promise<readonly ConfigDoc[]> | undefined
  const configHistory = () =>
    (configs ??= stored().then((t) => (t === null ? readConfigHistory(sdk, repo) : configBundleOf(repo, t.config).history)))
  // One update-history read per base ref for the whole page: most PRs target the same few
  // refs (usually just main), so this is O(base refs), not O(PRs).
  const updates = new Map<string, Promise<RefUpdate[]>>()
  const refUpdates = (hash: string): Promise<RefUpdate[]> => {
    let read = updates.get(hash)
    if (read === undefined) {
      read = stored().then((t) =>
        t === null ? readRefUpdates(sdk, repo, hash) : refUpdatesFromRows(repo, t.refUpdate, t.protectedRefUpdate, hash),
      )
      updates.set(hash, read)
    }
    return read
  }
  const rows = await foldRows(
    sdk,
    repo,
    documents,
    (doc, log, code) => readPull(sdk, repo, doc, log, configHistory, refUpdates, { code }),
    incompletePullView,
  )
  return Object.assign(rows, { hidden: hidden.total, hiddenBy: hidden.value, complete })
}

/** A PR row whose event log could not be read completely: its proved state, no labels or head updates. */
function incompletePullView(doc: PlainDocument, code: number): PullView {
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

/** How many rows a list page reads (the issues and pulls pages). */
export const LIST_PAGE = 100

/** Read a list page through the session cache ({@link FEED_TTL_MS}; a write drops it). */
function listCached<T extends Listed<IssueView> | Listed<PullView>>(repo: RepoRef, type: 'issue' | 'patch', load: () => Promise<T>): Promise<T> {
  return ttlCached(listCache, listKey(repo, type), load) as Promise<T>
}

/** {@link listIssues} of one {@link LIST_PAGE}, cached per repo (see {@link invalidateRepoFeed}). */
export function listIssuesCached(sdk: EvoSDK, repo: RepoRef): Promise<Listed<IssueView>> {
  return listCached(repo, 'issue', () => listIssues(sdk, repo, LIST_PAGE))
}

/** {@link listPulls} of one {@link LIST_PAGE}, cached like {@link listIssuesCached}. */
export function listPullsCached(sdk: EvoSDK, repo: RepoRef): Promise<Listed<PullView>> {
  return listCached(repo, 'patch', () => listPulls(sdk, repo, LIST_PAGE))
}

/** A repo's OPEN issue and PR counts for the tabs (null: not read). */
export interface TargetTotals {
  readonly issues: number | null
  readonly pulls: number | null
}

/**
 * Issue / PR reads — list + fold (data-contracts §2.3, §4; `forge-v2.md` §3, §5, §6).
 *
 * forge-v2 repos fold `event` + `authorEvent` through FORGE_RULES_V2 (`foldIssueStateV2` /
 * `foldPrStateV2`): an event's existence is its authorization, so no ACL history is read.
 * Lists read the repo's two feeds (`(repoId, $createdAt)`) once and fold every row from them,
 * rather than two queries per row. Documents that are not well-formed for the repo's
 * visibility (`isWellFormed`: plaintext xor `enc`) are skipped everywhere. The rest of this
 * note describes v1.
 *
 * Issue/PR *state* is not an on-chain field (mutation ownership forbids a maintainer
 * editing an author-owned doc); it is a deterministic fold of the append-only `event` log
 * via {@link foldIssueState} / {@link foldPrState}. Spam events from non-holders exist but
 * are inert. Actor authorization is evaluated **as-of** each event's `$createdAt` from the
 * token-history — supplied here as an {@link AuthzResolver}.
 *
 * TOKEN-HISTORY WIRING: the as-of WRITE/MAINTAIN holdings come from the system token-history
 * contract (mint/freeze/unfreeze/destroy), reconstructed by {@link resolveAuthz} /
 * {@link readTokenHistory}. Each read below resolves that history once (when the caller does
 * not supply an {@link AuthzResolver}) so holder-gated actions — a non-author maintainer's
 * close / label / merge — fold correctly. If the history read fails the resolver is empty and
 * the fold still honors the target author's own close/reopen (graceful degradation).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import {
  AuthzResolver,
  compareKey,
  foldIssueState,
  foldPrState,
  isNullOid,
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
import { foldIssueStateV2, foldPrStateV2 } from '../rules/v2'
import {
  asIdentifierString,
  byteFieldToHex,
  DOC,
  num,
  str,
  toEvent,
  V2_DOC,
  wellFormed,
  type RepoRef,
  type V2RepoRef,
} from './contract'
import { readRefUpdates } from './refs'
import { readRoleOracle } from './members'
import { repoSource } from './source'
import { resolveAuthz } from './tokens'
import { base64ToHex } from '../sdk'

/** An empty authorization resolver (target-author actions only; token history unavailable). */
export function emptyAuthz(): AuthzResolver {
  return new AuthzResolver([])
}

/** A row's title; ciphertext (a private repo's, which this client cannot decrypt) says so. */
function titleOf(doc: PlainDocument): string {
  const title = str(doc, 'title')
  if (title !== '') return title
  return byteFieldToHex(doc, 'enc') !== '' ? 'Encrypted (not readable here)' : ''
}

/**
 * A list page: the rows, and how many newer documents were skipped as not well-formed (or,
 * in a private repo, as a stranger's ciphertext) — shown as "N hidden", never silently.
 */
export type Listed<T> = T[] & { readonly hidden: number }

/** An issue with its folded state. */
export interface IssueView {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly author: string
  readonly createdAt: number
  readonly state: IssueState
  /**
   * False when the event log could not be read to completion, so `state` is a fold over a
   * partial history and must not be presented as authoritative. Only list surfaces can
   * produce this — a detail read throws instead, because there a wrong state is worse than
   * an error. See {@link listIssues}.
   */
  readonly stateComplete: boolean
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
  readonly headOid: string
  /**
   * Where the PR's objects actually live: the **source** repo contract id (v1) or `repo`
   * document id (v2 `sourceRepoId`), base58.
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
   * marker holds WRITE or MAINTAIN). False when the base history or head is unknown.
   */
  readonly headOnBase: boolean
  /** Archived from another forge (`imported` provenance present) rather than opened here. */
  readonly imported: boolean
  /** The original PR's URL when the import recorded one, else `''`. */
  readonly importedUrl: string
  readonly state: PrState
  /** See {@link IssueView.stateComplete}. */
  readonly stateComplete: boolean
}

/** A review verdict, as recorded on-chain. Parity with forge-core `Verdict`. */
export type VerdictName = 'approve' | 'requestChanges' | 'comment' | 'unknown'

const VERDICT_BY_INT: Readonly<Record<number, VerdictName>> = {
  1: 'approve',
  2: 'requestChanges',
  3: 'comment',
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
  readonly createdAt: number
}


/**
 * Fetch a target's **complete** event log (ascending), converted to rules {@link Event}s.
 *
 * COMPLETENESS IS LOAD-BEARING, not a nicety. `foldIssueState` / `foldPrState` are folds
 * over the whole log: a close at row 101 that never arrives leaves the issue open forever.
 * `event` carries no `tokenCost` in the repo contract template, so anyone can append —
 * a stranger padding a fresh issue with 100 inert events would permanently freeze its
 * displayed state if this read stopped at one page. It pages to exhaustion, and
 * {@link queryAllDocuments} throws rather than returning a short answer if it cannot
 * prove it reached the end. Parity: forge-core `CollabEngine::fetch_events` uses
 * `query_all_documents` for exactly this reason. On forge-v2 the log is `event` and
 * `authorEvent` merged in `($createdAt, $id)` order ({@link readTargetLog} keeps them apart).
 */
export async function readEvents(sdk: EvoSDK, repo: RepoRef, targetId: string): Promise<Event[]> {
  const log = await readTargetLog(sdk, repo, targetId)
  return [...log.events, ...log.authorEvents].sort(compareKey)
}

/**
 * A target's state documents, by the type that admitted them. v1 has only `event`; forge-v2
 * splits member events (`event`) from the author's own close/reopen (`authorEvent`,
 * `forge-v2.md` §3), and the v2 fold needs to know which is which.
 */
export interface TargetLog {
  readonly events: Event[]
  readonly authorEvents: Event[]
}

const EMPTY_LOG: TargetLog = { events: [], authorEvents: [] }

/**
 * The repo feed is read up front only while it is small: past this many pages per type (and
 * `authorEvent` can be written by any issue author), a list page folds each row from its own
 * target log instead, so its cost is O(page), not O(repo activity).
 */
const FEED_MAX_PAGES = 5
/** How long a repo feed serves list pages (issues and pulls share it). */
const FEED_TTL_MS = 30_000
const feedCache = new Map<string, { at: number; promise: Promise<Map<string, TargetLog> | null> }>()

/** {@link readRepoFeed} through a short per-repo cache (issues and pulls pages share it). */
function readRepoFeedCached(sdk: EvoSDK, repo: V2RepoRef): Promise<Map<string, TargetLog> | null> {
  const key = `${repo.forge.collab}:${repo.repoId}`
  const hit = feedCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < FEED_TTL_MS) return hit.promise
  const promise = readRepoFeed(sdk, repo)
  feedCache.set(key, { at: Date.now(), promise })
  promise.catch(() => {
    if (feedCache.get(key)?.promise === promise) feedCache.delete(key)
  })
  return promise
}

/** Drop a repo's cached feed (tests; and after a write lands, with v2 writes). */
export function invalidateRepoFeed(repo: V2RepoRef): void {
  feedCache.delete(`${repo.forge.collab}:${repo.repoId}`)
}

function toEvents(documents: readonly PlainDocument[]): Event[] {
  return documents.map(toEvent).filter((e): e is Event => e !== null)
}

/** One target's complete {@link TargetLog} (see {@link readEvents} on completeness). */
export async function readTargetLog(
  sdk: EvoSDK,
  repo: RepoRef,
  targetId: string,
): Promise<TargetLog> {
  const source = repoSource(repo)
  const read = async (type: string): Promise<Event[]> =>
    toEvents(
      await queryAllDocuments(
        sdk,
        source.targetQuery(type, {
          where: [['targetId', '==', targetId]],
          orderBy: [
            ['targetId', 'asc'],
            ['$createdAt', 'asc'],
          ],
        }),
      ),
    )
  if (repo.kind === 'v1') return { events: await read(DOC.event), authorEvents: [] }
  const [events, authorEvents] = await Promise.all([read(DOC.event), read(V2_DOC.authorEvent)])
  return { events, authorEvents }
}

/**
 * forge-v2: every `event` and `authorEvent` of a repo, grouped by target — the repo feed
 * (`(repoId, $createdAt)` on both types), read to completion once so a list page folds all of
 * its rows without a query per row. `event` is member-gated and `authorEvent` author-gated at
 * consensus, so the feed is bounded by real activity, not by what strangers post.
 */
async function readRepoFeed(sdk: EvoSDK, repo: V2RepoRef): Promise<Map<string, TargetLog> | null> {
  const source = repoSource(repo)
  const read = async (type: string): Promise<Event[]> =>
    toEvents(
      await queryAllDocuments(sdk, source.repoQuery(type, { orderBy: [['$createdAt', 'asc']] }), {
        maxPages: FEED_MAX_PAGES,
      }),
    )
  let events: Event[]
  let authorEvents: Event[]
  try {
    ;[events, authorEvents] = await Promise.all([read(DOC.event), read(V2_DOC.authorEvent)])
  } catch (e) {
    // Too much activity to read up front: the caller folds rows one target at a time.
    if (e instanceof IncompleteReadError) return null
    throw e
  }
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
 * Read **every** `review` on a patch, oldest first.
 *
 * Reviews were write-only across the whole codebase until this existed: the CLI could post
 * "changes requested" and no reader, view or command ever queried it back, so the verdict
 * was a paid-for record invisible to everyone — including the contributor it was addressed
 * to. Complete, for the same reason the event log is: `review` is un-gated, so anyone may
 * append, and a verdict buried past row 100 is exactly the one that matters.
 * Parity: forge-core `PullRequestService::list_reviews`.
 */
export async function readReviews(sdk: EvoSDK, repo: RepoRef, patchId: string): Promise<ReviewView[]> {
  const documents = await queryAllDocuments(
    sdk,
    repoSource(repo).targetQuery(DOC.review, {
      where: [['patchId', '==', patchId]],
      orderBy: [
        ['patchId', 'asc'],
        ['$createdAt', 'asc'],
      ],
    }),
  )
  return documents.filter((d) => wellFormed(repo, 'review', d)).map((d) => {
    const { verdict, code } = verdictFromCode(num(d, 'verdict'))
    return {
      id: str(d, '$id'),
      reviewer: str(d, '$ownerId'),
      verdict,
      verdictCode: code,
      commitOid: byteFieldToHex(d, 'commitOid'),
      body: str(d, 'body'),
      createdAt: num(d, '$createdAt'),
    }
  })
}

/**
 * Read one issue and fold its state. v1 resolves the token-history authz when not supplied;
 * forge-v2 needs no ACL (`log`, when given, is the target's slice of the repo feed).
 */
export async function readIssue(
  sdk: EvoSDK,
  repo: RepoRef,
  issueDoc: PlainDocument,
  authz?: AuthzResolver,
  log?: TargetLog,
): Promise<IssueView> {
  const id = str(issueDoc, '$id')
  const author = str(issueDoc, '$ownerId')
  let state: IssueState
  if (repo.kind === 'v1') {
    const resolver = authz ?? (await resolveAuthz(sdk, repo))
    state = foldIssueState(await readEvents(sdk, repo, id), author, resolver)
  } else {
    const l = log ?? (await readTargetLog(sdk, repo, id))
    state = foldIssueStateV2(l.events, l.authorEvents, author)
  }
  return {
    id,
    number: num(issueDoc, 'number'),
    title: titleOf(issueDoc),
    body: str(issueDoc, 'body'),
    author,
    createdAt: num(issueDoc, '$createdAt'),
    state,
    stateComplete: true,
  }
}

/** Pages a list read may take to fill `limit` shown rows past hidden ones. */
const LIST_MAX_PAGES = 5

/**
 * The newest `limit` issues or patches of a repo, `$createdAt` descending, and how many were
 * skipped on the way. forge-v2 skips documents that are not well-formed for the repo's
 * visibility (`forge-v2.md` §5), and in a private repo also ciphertext from non-members: this
 * client decrypts nothing yet, and §5 shows a stranger's ciphertext to no one. Skipped rows do
 * not shorten the page: the read continues (newest-first, by a `$createdAt <` bound, so no
 * cursor) until `limit` rows are found, the list ends, or {@link LIST_MAX_PAGES} pages.
 */
async function newestTargets(
  sdk: EvoSDK,
  repo: RepoRef,
  type: 'issue' | 'patch',
  limit: number,
): Promise<{ documents: PlainDocument[]; hidden: number }> {
  const oracle = repo.kind === 'v2' && repo.visibility === 'private' ? await readRoleOracle(sdk, repo) : null
  const shown = (d: PlainDocument): boolean => {
    if (!wellFormed(repo, type, d)) return false
    // Private: only members' ciphertext is shown (as encrypted); strangers' is hidden.
    return oracle === null || oracle.currentRole(str(d, '$ownerId')) !== null
  }
  const out: PlainDocument[] = []
  const seen = new Set<string>()
  let hidden = 0
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
    for (const d of documents) {
      if (out.length >= limit) break
      const id = str(d, '$id')
      if (seen.has(id)) continue
      seen.add(id)
      if (shown(d)) out.push(d)
      else hidden++
    }
    // v1 has no hidden rows, so one page answers; a short page is the end of the list.
    if (repo.kind === 'v1' || documents.length < limit) break
    const oldest = documents[documents.length - 1]?.['$createdAt']
    if (typeof oldest !== 'number' || oldest === before) break
    before = oldest
  }
  return { documents: out, hidden }
}

/**
 * Fold a page of issue or patch rows. forge-v2: from the repo feed, read once for the whole
 * page. v1: one row at a time, keeping a row (state unverified) whose event log cannot be read
 * to completion.
 */
async function foldRows<T>(
  sdk: EvoSDK,
  repo: RepoRef,
  documents: readonly PlainDocument[],
  foldOne: (doc: PlainDocument, log: TargetLog | undefined) => Promise<T>,
  incomplete: (doc: PlainDocument) => T,
): Promise<T[]> {
  // forge-v2: fold from the repo feed while it is small; otherwise (feed = null) each row
  // reads its own target log, as v1 does.
  const feed = repo.kind === 'v2' && documents.length > 0 ? await readRepoFeedCached(sdk, repo) : null
  // Per-row tolerance. `issue`, `event` and `comment` are un-gated, so one target padded
  // past the reader's completeness bound must not take down a whole page of issues — and
  // dropping the row silently would be the same class of bug this all fixes. The row is
  // kept with `stateComplete: false`; callers render the state as unverified. (A PR row also
  // reads its base ref's history, which can fail the same way, on either model.)
  return Promise.all(
    documents.map((doc) =>
      foldOne(doc, feed === null ? undefined : feed.get(str(doc, '$id')) ?? EMPTY_LOG).catch((e: unknown) => {
        if (!(e instanceof IncompleteReadError)) throw e
        return incomplete(doc)
      }),
    ),
  )
}

/** List issues (newest first) with folded state. Resolves the v1 authz once for the page. */
export async function listIssues(
  sdk: EvoSDK,
  repo: RepoRef,
  authz?: AuthzResolver,
  limit = 50,
): Promise<Listed<IssueView>> {
  const resolver = repo.kind === 'v1' ? authz ?? (await resolveAuthz(sdk, repo)) : undefined
  const { documents, hidden } = await newestTargets(sdk, repo, 'issue', limit)
  const rows = await foldRows(
    sdk,
    repo,
    documents,
    (doc, log) => readIssue(sdk, repo, doc, resolver, log),
    incompleteIssueView,
  )
  return Object.assign(rows, { hidden })
}

/** An issue row whose event log could not be read completely: identity only, no folded state. */
function incompleteIssueView(doc: PlainDocument): IssueView {
  return {
    id: str(doc, '$id'),
    number: num(doc, 'number'),
    title: titleOf(doc),
    body: str(doc, 'body'),
    author: str(doc, '$ownerId'),
    createdAt: num(doc, '$createdAt'),
    state: { open: true, labels: [], assignees: [] },
    stateComplete: false,
  }
}

/**
 * A historical-tips merge predicate for {@link foldPrState}: a merge oid stays valid once
 * the base ref advances past it, so the predicate tests membership in the set of every tip
 * the base ref has EVER had — not reflexive equality (the BLOCKER-1 fix). Built from the
 * base ref's full `refUpdate`/`protectedRefUpdate` history.
 */
export function historicalTipsPredicate(baseRefNewOidsHex: readonly string[]): IsAncestor {
  const tips = new Set(baseRefNewOidsHex)
  return (oid) => tips.has(oid)
}

/** A patch's `imported` provenance (present on PRs archived from another forge). */
function readImported(doc: PlainDocument): { imported: boolean; importedUrl: string } {
  const value = doc['imported']
  if (typeof value !== 'object' || value === null) return { imported: false, importedUrl: '' }
  const url = (value as PlainDocument)['url']
  return { imported: true, importedUrl: typeof url === 'string' ? url : '' }
}

/** A patch's source pointer: v1 `sourceContractId`, forge-v2 `sourceRepoId`. */
function sourceIdOf(repo: RepoRef, doc: PlainDocument): string {
  return asIdentifierString(doc[repo.kind === 'v1' ? 'sourceContractId' : 'sourceRepoId'])
}

/** A base ref's tips, as a PR read needs them. */
export interface BaseRefTips {
  /** Every oid the ref has ever pointed at (deletions excluded), oldest first. */
  readonly historical: string[]
  /** The newest of those — the ref's current tip. */
  readonly tip: string | undefined
  /**
   * Where the ref pointed at `openedAt`: `''` when it was deleted then, `undefined` when it
   * had no update yet. Raw history, like `tip`: only a diff baseline, never a trust input.
   */
  readonly atOpen: string | undefined
}

/**
 * Derive {@link BaseRefTips} from a ref's full update history, on the `(createdAt, id)` total
 * order. A null `newOid` is a deletion, never a reachable tip, so the current tip is the
 * newest NON-null one — parity with forge-core `base_ref_tips`, where taking the last element
 * of the plain-then-protected concatenation was neither the newest update nor deletion-aware.
 */
export function baseRefTips(updates: readonly RefUpdate[], openedAt: number): BaseRefTips {
  const ordered = [...updates].sort(compareKey)
  const historical = ordered.map((u) => u.newOid).filter((o) => !isNullOid(o))
  const openOid = ordered.filter((u) => u.createdAt <= openedAt).at(-1)?.newOid
  return {
    historical,
    tip: historical[historical.length - 1],
    atOpen: openOid === undefined ? undefined : isNullOid(openOid) ? '' : openOid,
  }
}

/** Read one PR (patch) and fold its state, using the historical-tips merge predicate. */
export async function readPull(
  sdk: EvoSDK,
  repo: RepoRef,
  patchDoc: PlainDocument,
  authz?: AuthzResolver,
  log?: TargetLog,
): Promise<PullView> {
  const id = str(patchDoc, '$id')
  const author = str(patchDoc, '$ownerId')
  const createdAt = num(patchDoc, '$createdAt')
  const baseRefNameHashRaw = patchDoc['baseRefNameHash']
  const baseHeadOidRaw = patchDoc['headOid']

  // Build the base ref's historical-tips set for the merge-reachability predicate.
  let isAncestor: IsAncestor = () => false
  let tips: BaseRefTips = { historical: [], tip: undefined, atOpen: undefined }
  if (typeof baseRefNameHashRaw === 'string' && baseRefNameHashRaw.length > 0) {
    tips = baseRefTips(await readRefUpdates(sdk, repo, baseRefNameHashRaw), createdAt)
    isAncestor = historicalTipsPredicate(tips.historical)
  }
  const baseTip = tips.tip

  let state: PrState
  if (repo.kind === 'v1') {
    const resolver = authz ?? (await resolveAuthz(sdk, repo))
    state = foldPrState(await readEvents(sdk, repo, id), author, resolver, baseTip, isAncestor)
  } else {
    const l = log ?? (await readTargetLog(sdk, repo, id))
    state = foldPrStateV2(l.events, l.authorEvents, author, baseTip, isAncestor)
  }
  let headOid = ''
  if (typeof baseHeadOidRaw === 'string' && baseHeadOidRaw.length > 0) {
    try {
      headOid = base64ToHex(baseHeadOidRaw)
    } catch {
      headOid = baseHeadOidRaw
    }
  }

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
    sourceId: sourceIdOf(repo, patchDoc),
    sourceRefName: typeof patchDoc['sourceRefName'] === 'string' ? patchDoc['sourceRefName'] : null,
    headOnBase: headOid !== '' && baseTip !== undefined && isAncestor(headOid, baseTip),
    ...readImported(patchDoc),
    state,
    stateComplete: true,
  }
}

/** List PRs (patches, newest first) with folded state. Resolves the v1 authz once for the page. */
export async function listPulls(
  sdk: EvoSDK,
  repo: RepoRef,
  authz?: AuthzResolver,
  limit = 50,
): Promise<Listed<PullView>> {
  const resolver = repo.kind === 'v1' ? authz ?? (await resolveAuthz(sdk, repo)) : undefined
  const { documents, hidden } = await newestTargets(sdk, repo, 'patch', limit)
  const rows = await foldRows(
    sdk,
    repo,
    documents,
    (doc, log) => readPull(sdk, repo, doc, resolver, log),
    (doc) => incompletePullView(repo, doc),
  )
  return Object.assign(rows, { hidden })
}

/** A PR row whose event log could not be read completely: identity only, no folded state. */
function incompletePullView(repo: RepoRef, doc: PlainDocument): PullView {
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
    headOid,
    // The source pointer is plain document content, not a fold — it is readable even when
    // the event log is not, and it is what a reviewer needs to fetch the PR at all.
    sourceId: sourceIdOf(repo, doc),
    sourceRefName: typeof doc['sourceRefName'] === 'string' ? doc['sourceRefName'] : null,
    headOnBase: false,
    ...readImported(doc),
    state: { open: true, merged: false, draft: false, baseRef: null, labels: [], assignees: [] },
    stateComplete: false,
  }
}

/**
 * The pull index: what the Pull requests tab lists, filters, sorts, pages and counts (L-44), on
 * the engine it shares with the issue index (`./target-index`; L-77). Per repo, cached for the
 * session and dropped by any write ({@link invalidateRepoFeed}):
 *
 * 1. **One composite** (the first request): the newest 100 patches, their comment counts
 *    (`comment.target` count tree), their authors' DPNS names, their member events (the `event`
 *    `target` lookup: their labels and assignees) and the label definitions; and beside it one
 *    proved sum query for those PRs' state codes (`transition.perTarget`), and the three proved
 *    counts.
 * 2. **More PRs on demand**: a keyset composite per 100 (`$createdAt <=` the oldest loaded; `>=`
 *    for the oldest-first sort), each with its sum query, and `$id in` composites for PRs a tab or
 *    filter names but no loaded chunk holds. An unfiltered tab stops walking once it holds the
 *    page (or every PR its proved count says there is), and reads at most `PAGE_CHUNKS` chunks
 *    per load (QW2-002): the dash mirror's 1,766 PRs cost what a 200-PR repo does.
 * 3. **The Merged and Closed tabs' candidates**: the targets of the repo's merge (`kind 13`) or
 *    close (`kinds 11, 16`) transitions, read on first use when the proved counts say that is
 *    cheaper than walking (`candidatesCheaper`: a sparse tab); a candidate's row says whether it
 *    still is (a closed PR can have been reopened).
 * 4. **The repo's member-event feed**, only for a label, assignee, milestone or review-request
 *    filter (shared with the issue index).
 *
 * State: the index's view step (`indexOf`) is the one step that turns patch documents into their state, the proved
 * sum of each PR's transitions (open / merged / closed / draft; `rules/transition.ts`
 * `statusOfCode`). The base refs' histories label a merge "on the base" or not; they come from
 * the repo chrome store (`baseRefReaders`: no request for a public repo whose page just read its
 * chrome; one read per base ref, not per PR, otherwise).
 *
 * Counts: Open / Merged / Closed are the proved totals (`./transitions` `readRepoCounts`: the PR
 * total and the transition counts by kind), never a fold.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, type Network } from '../constants'
import { IncompleteReadError } from '../sdk'
import type { RepoRef } from './contract'
import { compareRows, eventFiltered, rowMatches, selectionFiltered, type RowFilters } from './issue-index'
import { baseRefReaders, countsSettled, incompletePullView, readPull, type BaseRefReaders, type PullView } from './issues'
import { PR_CLOSE, PR_DRAFT_CLOSE, PR_MERGE } from '../rules/transition'
import { linkedIssues } from '../rules/review'
import type { LabelDef } from './labels'
import type { HiddenCounts } from './private-content'
import {
  authorCandidates,
  candidatesCheaper,
  feedOf,
  indexCache,
  intersect,
  logsVerified,
  matchingOf,
  metaCandidates,
  pageOf,
  pageWalk,
  repoCountsOf,
  rowsInAnyState,
  rowsWithEvent,
  searchedOfPage,
  selectRows,
  shownRows,
  transitionTargets,
  type ListIndex,
  type ListOptions,
  type RepoCounts,
  type SearchedOf,
} from './target-index'

/**
 * A PR row: the PR with its state and its comment count (null: not counted). The list reads the
 * repo's member events only, so a row's `headOid`, `headOnBase` and `review` do not follow an
 * author's own head updates: read the PR (`loadPullThread`) for those.
 */
export interface PullRow extends PullView {
  readonly comments: number | null
}

/** The Pull requests tabs. Closed means closed without merging; a draft is open. */
export type PullStateFilter = 'open' | 'merged' | 'closed' | 'all'

type PullIndex = ListIndex<PullRow>

/** Each index's base-ref readers: one read of each history per index, however many chunks. */
const readers = new WeakMap<PullIndex, BaseRefReaders>()

function readersOf(sdk: EvoSDK, index: PullIndex): BaseRefReaders {
  let base = readers.get(index)
  if (base === undefined) {
    base = baseRefReaders(sdk, index.repo)
    readers.set(index, base)
  }
  return base
}

/**
 * The index, loading it on first use (one per repo and network, until a write drops it). A PR's
 * view: its state code (the chunk's proved sum), its labels and assignees from the feed, and its
 * merge labelled against the base ref's history; a PR whose base history cannot be read completely
 * keeps its proved state, unverified.
 */
const indexOf = indexCache<PullRow>('patch', async (sdk, index, doc, log, code) => {
  const base = readersOf(sdk, index)
  return readPull(sdk, index.repo, doc, log, base.configHistory, base.refUpdates, { code }).catch((e: unknown) => {
    if (!(e instanceof IncompleteReadError)) throw e
    return incompletePullView(doc, code)
  })
})

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** What the list asks for (`me` already replaced by the viewer's id). */
export interface PullSelection extends RowFilters {
  readonly state: PullStateFilter
  readonly labels: readonly string[]
  /** An identity id, or null. */
  readonly author: string | null
  /** An identity id, `none` (no assignee), or null. */
  readonly assignee: string | null
  readonly sort: 'newest' | 'oldest' | 'comments'
  readonly text: string
  readonly page: number
  readonly pageSize: number
  /** `draft:true` / `draft:false` (`is:draft`): only drafts, or none; null either. */
  readonly draft?: boolean | null
  /** `review-requested:x`: an identity with a standing review request. */
  readonly reviewRequested?: string | null
}

/** Open / Merged / Closed counts (null: not proven). */
export interface PullCounts {
  readonly open: number | null
  readonly merged: number | null
  readonly closed: number | null
}

/** The answer for one list page. */
export interface PullListPage {
  readonly rows: readonly PullRow[]
  /** Matching rows in the whole repo, or null when that needs more reading than was done. */
  readonly matching: number | null
  readonly hasNext: boolean
  /** The tabs' counts under the current filters. */
  readonly counts: PullCounts
  /** When the answer covers only part of the repo (a search, a comment sort, or a page that read its chunk budget): how far it read. */
  readonly searchedOf: SearchedOf | null
  /** False when a shown PR's member events could not be read completely: its labels and assignees are unverified (states are proved). */
  readonly stateComplete: boolean
  readonly labels: readonly LabelDef[]
  readonly hidden: number
  readonly hiddenBy: HiddenCounts
}

const NO_COUNTS: PullCounts = { open: null, merged: null, closed: null }

/** Whether a row's state passes the state tab. */
function pullStateMatches(row: Pick<PullView, 'state'>, tab: PullStateFilter): boolean {
  if (tab === 'all') return true
  if (tab === 'merged') return row.state.merged
  if (tab === 'closed') return !row.state.open && !row.state.merged
  return row.state.open
}

/**
 * Whether a row passes every filter but the state tab: the issue list's rule (labels, author,
 * assignee, milestone, comments, text / `#n`), plus the PR-only draft and review-request filters.
 */
function filtersMatch(row: PullRow, q: PullSelection): boolean {
  if (q.draft != null && row.state.draft !== q.draft) return false
  if (q.reviewRequested != null && !row.review.requestedReviewers.some((r) => r.identity === q.reviewRequested)) return false
  return rowMatches({ ...row, milestone: row.review.milestone }, { ...q, mentions: null })
}

/** Whether a selection narrows the list beyond its state tab. */
function pullFiltered(q: PullSelection): boolean {
  return selectionFiltered(q) || q.draft != null || q.reviewRequested != null
}

/** Open / Merged / Closed of `rows`. */
function countRows(rows: readonly PullRow[]): { open: number; merged: number; closed: number } {
  const merged = rows.filter((r) => pullStateMatches(r, 'merged')).length
  const closed = rows.filter((r) => pullStateMatches(r, 'closed')).length
  return { open: rows.length - merged - closed, merged, closed }
}

/** Every PR ever merged (`PR_MERGE`), or ever closed (`PR_CLOSE`, `PR_DRAFT_CLOSE`): a tab's candidates. */
function stateCandidates(sdk: EvoSDK, index: PullIndex, tab: PullStateFilter): Promise<Set<string> | null> {
  if (tab === 'merged') return transitionTargets(sdk, index, [PR_MERGE])
  if (tab === 'closed') return transitionTargets(sdk, index, [PR_CLOSE, PR_DRAFT_CLOSE])
  return Promise.resolve(null)
}

/**
 * Every PR that can match `q`, when an index names them (the transitions, the feed, the `author`
 * index); null when none applies. `byState`: whether the state tab's transitions may name them
 * when nothing else does (read only when that is cheaper than walking; with another candidate
 * set they would only narrow what `matches` checks anyway).
 */
async function candidatesFor(sdk: EvoSDK, index: PullIndex, q: PullSelection, byState = true): Promise<Set<string> | null> {
  const named = intersect([
    metaCandidates(index, q, (row) => filtersMatch(row, { ...q, author: null, text: '' })),
    q.author === null ? null : await authorCandidates(sdk, index, q.author),
  ])
  return named ?? (byState ? stateCandidates(sdk, index, q.state) : null)
}

/** Whether `q` matches on what a PR's member events decide (labels, assignees, milestone, review requests). */
function needsEvents(q: PullSelection): boolean {
  return eventFiltered(q) || q.reviewRequested != null
}

/**
 * The repo's Open / Merged / Closed totals: the proved counts, less (from Open) the open PRs this
 * reader skipped as not shown (their state is read with their chunk's). In a private repo
 * anyone's ciphertext counts in the totals and cannot be told apart until read, so only a full
 * read gives counts there, as on the Issues list. None when the counts could not be read.
 */
async function exactCounts(sdk: EvoSDK, index: PullIndex): Promise<PullCounts> {
  const counts = await repoCountsOf(sdk, index)
  if (counts === null || (index.repo.visibility === 'private' && !index.all)) return NO_COUNTS
  return provedCounts(counts, index)
}

/** The proved Open / Merged / Closed totals, less (from Open) the open PRs this reader skipped as not shown. */
function provedCounts(counts: RepoCounts, index: PullIndex): { open: number; merged: number; closed: number } {
  return { open: Math.max(0, counts.prsOpen - index.hiddenOpen), merged: counts.prsMerged, closed: counts.prsClosed }
}

/**
 * At most how many PRs can be in `tab`, by the proved counts (every reader, a private repo's
 * too: a row this reader cannot open is in the count, never out of it), or null when unknown.
 */
function tabBound(counts: RepoCounts | null, index: PullIndex, tab: PullStateFilter): number | null {
  if (counts === null) return null
  return tab === 'all' ? counts.patches : provedCounts(counts, index)[tab]
}

/** Every PR shown (open + merged + closed), or null when a count is not proven. */
function sum(c: PullCounts): number | null {
  return c.open === null || c.merged === null || c.closed === null ? null : c.open + c.merged + c.closed
}

/**
 * One page of the PR list for `q`, reading only what it needs: the first chunk (with the proved
 * counts beside it), then, unfiltered, keyset chunks until the page is full or every PR the tab's
 * count allows is held (at most `PAGE_CHUNKS` per load), or the tab's transitions when that is
 * cheaper; filtered, a filter's candidates by id or up to 30 chunks (a search, reported through
 * `onProgress`); a sort by comments reads every chunk up to 30. The member-event feed is read only
 * for a filter on what it decides. `total` is the repo's PR count (the countable index), or null
 * when it is not known.
 */
export async function queryPulls(
  sdk: EvoSDK,
  repo: RepoRef,
  q: PullSelection,
  total: number | null,
  network: Network = DEFAULT_NETWORK,
  { onProgress }: ListOptions = {},
): Promise<PullListPage> {
  const index = await indexOf(sdk, repo, network, { withCounts: true })
  const filtered = pullFiltered(q)
  const needLogs = needsEvents(q)
  if (needLogs) await feedOf(sdk, index)
  const bound = await repoCountsOf(sdk, index)
  const walk = pageWalk(q, filtered)
  const byState = candidatesCheaper(index, walk, tabBound(bound, index, q.state), bound?.patches ?? null)
  const selected = await selectRows(sdk, index, {
    ...walk,
    candidates: await candidatesFor(sdk, index, q, byState),
    matches: (r) => pullStateMatches(r, q.state) && filtersMatch(r, q),
    cmp: compareRows(q.sort),
    // The walk stops at the tab's proved count (never a filter's), once it includes this browser's own writes.
    known: () => (filtered || !countsSettled(repo) ? null : tabBound(bound, index, q.state)),
    needLogs,
    onProgress,
  })

  let counts = NO_COUNTS
  if (!filtered) {
    counts = await exactCounts(sdk, index)
  } else {
    // Every tab's count needs every candidate in any state: an index names them, or every PR is loaded.
    const all = await rowsInAnyState(sdk, index, await candidatesFor(sdk, index, { ...q, state: 'all' }), (r) => filtersMatch(r, q), needLogs)
    if (all !== null) counts = countRows(all)
  }

  const tabCount = q.state === 'all' ? sum(counts) : counts[q.state]
  const page = pageOf(selected.rows, q.page, q.pageSize)
  const rows = await shownRows(sdk, index, page.rows)
  return {
    rows,
    matching: matchingOf(selected, filtered, tabCount),
    hasNext: page.hasNext,
    counts,
    searchedOf: searchedOfPage(selected, total),
    stateComplete: logsVerified(index, rows),
    labels: index.labels,
    hidden: index.hidden.total,
    hiddenBy: index.hidden.value,
  }
}

/** The PRs whose description links an issue ({@link pullsLinking}). */
export interface LinkingPulls {
  /** Newest first. */
  readonly pulls: readonly PullRow[]
  /** How many PRs were looked at when not all of them were, else null. */
  readonly searched: number | null
}

/** How many chunks of PRs (100 each, newest first) a backlink read looks through at most. */
const LINKING_CHUNKS = 3

/**
 * The PRs whose description says they close an issue ("Fixes #12", `linkedIssues`): the issue
 * page's backlinks (review-parity P8, QW-015). `issue.number` is its native number;
 * `issue.upstream` the source forge's number a trusted mirror recorded, or null. A description
 * whose `#N` is the source's (`refsUpstream`: imported text, as the page renders it) links the
 * issue through `upstream` only, never through the native number. Read from the pull index the PR
 * list shares (cached for the session), through the newest {@link LINKING_CHUNKS} chunks at most,
 * so an issue page on a repo with thousands of PRs stays cheap; `searched` says when the answer
 * covers only those.
 */
export async function pullsLinking(
  sdk: EvoSDK,
  repo: RepoRef,
  issue: { readonly number: number; readonly upstream: number | null },
  refsUpstream: (r: PullRow) => boolean,
  network: Network = DEFAULT_NETWORK,
): Promise<LinkingPulls> {
  const index = await indexOf(sdk, repo, network)
  // The window is the newest LINKING_CHUNKS + 1 chunks (the first load's included), whatever the
  // session has walked already: a later issue page reads no further (the rows loaded past it, by
  // the PR list, are matched too, at no cost).
  const walked = Math.ceil(index.walks.desc.ids.length / 100)
  const selected = await selectRows(sdk, index, {
    candidates: null,
    matches: (r) => {
      const n = refsUpstream(r) ? issue.upstream : issue.number
      return n !== null && linkedIssues(r.body).includes(n)
    },
    cmp: compareRows('newest'),
    direction: 'desc',
    want: 20,
    walkAll: true,
    partial: true,
    maxChunks: Math.max(0, LINKING_CHUNKS + 1 - walked),
  })
  return { pulls: selected.rows.slice(0, 20), searched: selected.searched }
}

/** Each PR a milestone event names, with its open state and milestone (see `issueMilestoneItems`); null when the feed is partial. */
export async function pullMilestoneItems(sdk: EvoSDK, repo: RepoRef, network: Network = DEFAULT_NETWORK): Promise<{ open: boolean; milestone: string | null }[] | null> {
  const rows = await rowsWithEvent(sdk, await indexOf(sdk, repo, network), 'milestoneSet')
  return rows?.map((r) => ({ open: r.state.open, milestone: r.review.milestone })) ?? null
}

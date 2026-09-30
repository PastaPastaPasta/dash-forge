/**
 * The pull index: what the Pull requests tab lists, filters, sorts, pages and counts (L-44), on
 * the engine it shares with the issue index (`./target-index`; L-77). Per repo, cached for the
 * session and dropped by any write ({@link invalidateRepoFeed}):
 *
 * 1. **One composite** (the first request): the newest 100 patches, their comment counts
 *    (`comment.target` count tree), their authors' DPNS names, the label definitions and, unless
 *    the issue index has it already, the first page of the repo's member `event` feed; and beside
 *    it one proved sum query for those PRs' state codes (`transition.perTarget`).
 * 2. **The rest of the event feed**, only when its first page was full, read once per repo and
 *    shared with the issue index. It decides every row's labels and assignees.
 * 3. **More PRs on demand**: a keyset composite per 100 (`$createdAt <=` the oldest loaded; `>=`
 *    for the oldest-first sort), each with its sum query, and `$id in` composites for PRs a tab or
 *    filter names but no loaded chunk holds.
 * 4. **The Merged and Closed tabs' candidates**: the targets of the repo's merge (`kind 13`) or
 *    close (`kinds 11, 16`) transitions, read on first use; a candidate's row says whether it
 *    still is (a closed PR can have been reopened).
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
import { compareRows, rowMatches, selectionFiltered, type RowFilters } from './issue-index'
import { baseRefReaders, incompletePullView, readPull, type BaseRefReaders, type PullView } from './issues'
import { PR_CLOSE, PR_DRAFT_CLOSE, PR_MERGE } from '../rules/transition'
import { linkedIssues } from '../rules/review'
import { referencedNumbers } from '../view/cross-refs'
import type { LabelDef } from './labels'
import type { HiddenCounts } from './private-content'
import {
  authorCandidates,
  indexCache,
  intersect,
  metaCandidates,
  pageOf,
  repoCountsOf,
  rowsInAnyState,
  rowsWithEvent,
  selectRows,
  transitionTargets,
  type ListIndex,
} from './target-index'

/**
 * A PR row: the PR with its state and its comment count (null: not counted). The list reads the
 * repo's member events only, so a row's `headOid`, `headOnBase` and `review` do not follow an
 * author's own head updates: read the PR (`loadPullThread`) for those.
 */
export interface PullRow extends PullView {
  readonly comments: number | null
}

/**
 * The Pull requests tabs. Closed means closed without merging; a draft is open. `unmerged` (the
 * search box's `is:unmerged`, QW2-055) is open or closed without merging, as on GitHub.
 */
export type PullStateFilter = 'open' | 'merged' | 'closed' | 'unmerged' | 'all'

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
  /** When a text search or a comment sort covered only part of the repo: how many PRs it looked at. */
  readonly searchedOf: { readonly searched: number; readonly total: number | null } | null
  /** False when the feed was too large to fold: labels and assignees are unverified (states are proved). */
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
  if (tab === 'unmerged') return !row.state.merged
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

/** Every PR that can match `q`, when an index names them (the transitions, the feed, the `author` index); null when none applies. */
async function candidatesFor(sdk: EvoSDK, index: PullIndex, q: PullSelection): Promise<Set<string> | null> {
  return intersect([
    await stateCandidates(sdk, index, q.state),
    metaCandidates(index, q, (row) => filtersMatch(row, { ...q, author: null, text: '' })),
    q.author === null ? null : await authorCandidates(sdk, index, q.author),
  ])
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
  return { open: Math.max(0, counts.prsOpen - index.hiddenOpen), merged: counts.prsMerged, closed: counts.prsClosed }
}

/** Every PR shown (open + merged + closed), or null when a count is not proven. */
function sum(c: PullCounts): number | null {
  return c.open === null || c.merged === null || c.closed === null ? null : c.open + c.merged + c.closed
}

/**
 * One page of the PR list for `q`, reading only what it needs: the first chunk and the feed
 * (once), a tab's or filter's candidates by id, more keyset chunks while the page is not full, or
 * every chunk (up to 30) for a sort by comments. `total` is the repo's PR count (the countable
 * index), or null when it is not known.
 */
export async function queryPulls(
  sdk: EvoSDK,
  repo: RepoRef,
  q: PullSelection,
  total: number | null,
  network: Network = DEFAULT_NETWORK,
): Promise<PullListPage> {
  const index = await indexOf(sdk, repo, network)
  const filtered = pullFiltered(q)
  const selected = await selectRows(sdk, index, {
    candidates: await candidatesFor(sdk, index, q),
    matches: (r) => pullStateMatches(r, q.state) && filtersMatch(r, q),
    cmp: compareRows(q.sort),
    direction: q.sort === 'oldest' ? 'asc' : 'desc',
    want: q.page * q.pageSize,
    walkAll: q.sort === 'comments',
    partial: filtered || q.sort === 'comments',
  })

  let counts = NO_COUNTS
  if (!filtered) {
    counts = await exactCounts(sdk, index)
  } else {
    // Every tab's count needs every candidate in any state: an index names them, or every PR is loaded.
    const all = await rowsInAnyState(sdk, index, await candidatesFor(sdk, index, { ...q, state: 'all' }), (r) => filtersMatch(r, q))
    if (all !== null) counts = countRows(all)
  }

  // Unfiltered, the tab's proved count is how many rows match, before the walk reaches them all
  // (not when the walk stopped short of the repo's end: then the page count is unknown).
  const tabCount =
    q.state === 'all' ? sum(counts) : q.state === 'unmerged' ? (counts.open === null || counts.closed === null ? null : counts.open + counts.closed) : counts[q.state]
  const page = pageOf(selected.rows, q.page, q.pageSize)
  return {
    rows: page.rows,
    matching: selected.complete ? selected.rows.length : filtered || selected.short ? null : tabCount,
    hasNext: page.hasNext,
    counts,
    searchedOf: selected.searched === null ? null : { searched: selected.searched, total },
    stateComplete: index.feed !== null,
    labels: index.labels,
    hidden: index.hidden.total,
    hiddenBy: index.hidden.value,
  }
}

/** The PRs whose description links an issue ({@link pullsLinking}). */
export interface LinkingPulls {
  /** The PRs that close it ("Fixes #12"), newest first. */
  readonly pulls: readonly PullRow[]
  /** The PRs that only mention it ("Refs #12"), newest first (QW2-048). */
  readonly mentioning: readonly PullRow[]
  /** How many PRs were looked at when not all of them were, else null. */
  readonly searched: number | null
}

/** How many chunks of PRs (100 each, newest first) a backlink read looks through at most. */
const LINKING_CHUNKS = 3

/**
 * The PRs whose description says they close an issue ("Fixes #12", `linkedIssues`), and those
 * that only mention it ("Refs #12", QW2-048): the issue page's backlinks (review-parity P8, QW-015). `issue.number` is its native number;
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
      return n !== null && (linkedIssues(r.body).includes(n) || referencedNumbers(r.body).includes(n))
    },
    cmp: compareRows('newest'),
    direction: 'desc',
    want: 20,
    walkAll: true,
    partial: true,
    maxChunks: Math.max(0, LINKING_CHUNKS + 1 - walked),
  })
  // Every match in the window (`walkAll`), so the closers are capped apart from the mentions: many
  // newer "see #12" never crowd out the PR that closes it.
  const closes = (r: PullRow): boolean => linkedIssues(r.body).includes((refsUpstream(r) ? issue.upstream : issue.number) ?? -1)
  return { pulls: selected.rows.filter(closes).slice(0, 20), mentioning: selected.rows.filter((r) => !closes(r)).slice(0, 20), searched: selected.searched }
}

/** Each PR a milestone event names, with its open state and milestone (see `issueMilestoneItems`); null when the feed is partial. */
export async function pullMilestoneItems(sdk: EvoSDK, repo: RepoRef, network: Network = DEFAULT_NETWORK): Promise<{ open: boolean; milestone: string | null }[] | null> {
  const rows = await rowsWithEvent(sdk, await indexOf(sdk, repo, network), 'milestoneSet')
  return rows?.map((r) => ({ open: r.state.open, milestone: r.review.milestone })) ?? null
}

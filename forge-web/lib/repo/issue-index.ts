/**
 * The issue index: what the Issues tab lists, filters, sorts and counts, read with composite
 * queries and keyset paging (`platform-parity-spec.md` §1.2, §3.3; D-217, D-904, SR-03), on the
 * engine it shares with the pull index (`./target-index`).
 *
 * Reads, per repo, cached for the session and dropped by any write ({@link invalidateRepoFeed}):
 *
 * 1. **One composite** (the first request): the newest 100 issues, their comment counts
 *    (`comment.target` count tree), their authors' DPNS names, and as siblings under the same
 *    proof the label definitions and the first 100 rows of the repo's member `event` feed; and
 *    beside it one proved sum query for those issues' state codes (`transition.perTarget`).
 * 2. **The rest of the event feed**, only when its first page was full, read once per repo and
 *    shared with the pull index (`readRepoFeedFrom`). The feed decides every row's labels and
 *    assignees, so it is read to completion.
 * 3. **More issues on demand**: a keyset composite per 100 (`$createdAt <=` the oldest loaded,
 *    newest first; `>=` the newest loaded for the oldest-first sort), each with its sum query,
 *    and `$id in` composites for issues the feed names but no loaded chunk holds.
 * 4. **The Closed tab's candidates**: the targets of the repo's issue-close transitions
 *    (`transition.perRepoKind`, `kind == 1`), read on first use; every closed issue has one.
 *
 * Counts: Open / Closed are the proved totals (`./transitions` `readRepoCounts`: the issue total
 * and the close / reopen counts), never a fold.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, type Network } from '../constants'
import type { RepoRef } from './contract'
import { issueViewOf, type IssueView } from './issues'
import { ISSUE_CLOSE } from '../rules/transition'
import type { LabelDef } from './labels'
import { pinnedTargets } from '../rules/parity'
import type { HiddenCounts } from './private-content'
import {
  authorCandidates,
  indexCache,
  intersect,
  metaCandidates,
  pageOf,
  repoCountsOf,
  resolveIds,
  rowsInAnyState,
  rowsOf,
  selectRows,
  transitionTargets,
  type ListIndex,
} from './target-index'

/** An issue row: the folded issue and its comment count (null: not counted). */
export interface IssueRow extends IssueView {
  readonly comments: number | null
}

type IssueIndex = ListIndex<IssueRow>

/**
 * The index, loading it on first use (one per repo and network, until a write drops it). An
 * issue's view: its state code (the chunk's proved sum) and its labels and assignees from the feed.
 */
const indexOf = indexCache<IssueRow>('issue', async (_sdk, _index, doc, log, code) => issueViewOf(doc, log, code))

function sortRowsNewest(a: IssueRow, b: IssueRow): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** What the list asks for (resolved: `me` is replaced by the viewer's id by the caller). */
export interface IssueSelection {
  readonly state: 'open' | 'closed' | 'all'
  readonly labels: readonly string[]
  /** An identity id, or null. */
  readonly author: string | null
  /** An identity id, `none` (no assignee), or null. */
  readonly assignee: string | null
  /** The viewer's id and DPNS name when "mentions me" is on. */
  readonly mentions: { readonly id: string; readonly name: string | null } | null
  readonly sort: 'newest' | 'oldest' | 'comments'
  readonly text: string
  readonly page: number
  readonly pageSize: number
}

/** The answer for one list page. */
export interface IssueListPage {
  readonly rows: readonly IssueRow[]
  /** Matching rows in the whole repo, or null when that needs more reading than was done. */
  readonly matching: number | null
  /** Whether a next page exists (known even when `matching` is not). */
  readonly hasNext: boolean
  /** Open / closed counts for the tabs, under the current filters (null: not proven). */
  readonly openCount: number | null
  readonly closedCount: number | null
  /**
   * When the answer covers only part of the repo (a text or mention search looks at loaded
   * issues; a comment sort at most 30 chunks): how many issues it looked at.
   */
  readonly searchedOf: { readonly searched: number; readonly total: number | null } | null
  /** False when the feed was too large to fold: states, labels and assignees are unverified. */
  readonly stateComplete: boolean
  /**
   * The repo's pinned issues (member pin events, kinds 19/20, from the complete feed), newest
   * pin first: page 1 shows them above the list. Empty past page 1 or when the feed is partial.
   */
  readonly pinned: readonly IssueRow[]
  readonly labels: readonly LabelDef[]
  readonly hidden: number
  /** `hidden` by reason (private repos: shown to maintainers). */
  readonly hiddenBy: HiddenCounts
}

/** Whether a row's folded state passes the state tab. */
function stateMatches(row: IssueRow, state: IssueSelection['state']): boolean {
  return state === 'all' || (state === 'open' ? row.state.open : !row.state.open)
}

/** Whether a row passes every filter but the state tab. */
export function rowMatches(row: IssueRow, q: IssueSelection): boolean {
  if (q.labels.some((l) => !row.state.labels.includes(l))) return false
  if (q.author !== null && row.author !== q.author) return false
  if (q.assignee === 'none' && row.state.assignees.length > 0) return false
  if (q.assignee !== null && q.assignee !== 'none' && !row.state.assignees.includes(q.assignee)) return false
  if (q.mentions !== null && !mentions(row.body, q.mentions.id, q.mentions.name)) return false
  return matchesText(q.text, row)
}

/**
 * Whether `body` mentions the identity: `@name` (its DPNS label, word-bounded,
 * case-insensitive) or the raw identity id. The one mention rule: the issue list's "mentions
 * me" and the inbox / Explore scan both use it.
 */
export function mentions(body: string | undefined, id: string, name: string | null): boolean {
  if (!body) return false
  if (body.includes(id)) return true
  const label = (name ?? '').split('.')[0] ?? ''
  if (label === '') return false
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w@])@${escaped}(?![\\w-])`, 'i').test(body)
}

/**
 * Whether `row`'s title holds every word of `text`, case-insensitively; a word that is all
 * digits (with or without a leading `#`) also matches the issue number directly (L-43: a title
 * substring check alone missed a bare `7512`, even though `#7512` matched by number — a word
 * checks both, so neither form of the same search regresses the other).
 */
export function matchesText(text: string, row: { readonly title: string; readonly number: number }): boolean {
  const words = text.trim().toLowerCase().split(/\s+/).filter((w) => w !== '')
  const title = row.title.toLowerCase()
  return words.every((w) => {
    // `#n` (review L-43) is a number-only match: it never falls back to a title substring, even
    // when the digits happen to appear in the title of a different-numbered row.
    const hash = /^#(\d+)$/.exec(w)
    if (hash) return Number(hash[1]) === row.number
    // A bare number matches the number OR (additively) a title substring.
    const bare = /^(\d+)$/.exec(w)
    if (bare && Number(bare[1]) === row.number) return true
    return title.includes(w)
  })
}

/** The sort order of the list. */
export function compareRows(sort: IssueSelection['sort']): (a: IssueRow, b: IssueRow) => number {
  if (sort === 'oldest') return (a, b) => -sortRowsNewest(a, b)
  if (sort === 'comments') return (a, b) => (b.comments ?? -1) - (a.comments ?? -1) || sortRowsNewest(a, b)
  return sortRowsNewest
}

/**
 * The repo's Open / Closed issue totals: the proved counts (read once per index, dropped with it
 * by a write), less the open issues this reader skipped as not shown (not well-formed, or a
 * stranger's; their state is read with their chunk's). In a private repo anyone's ciphertext
 * counts in the total and cannot be told apart until read, so only a full read gives counts
 * there. Null when the counts could not be read.
 */
async function exactCounts(sdk: EvoSDK, index: IssueIndex): Promise<{ open: number; closed: number } | null> {
  const counts = await repoCountsOf(sdk, index)
  if (counts === null) return null
  if (index.repo.visibility === 'private' && !index.all) return null
  return { open: Math.max(0, counts.issuesOpen - index.hiddenOpen), closed: counts.issuesClosed }
}

/**
 * One page of the issue list for `q`, reading only what it needs: the first chunk and the feed
 * (once), feed-named candidates by id, more keyset chunks while the page is not full, or every
 * chunk (up to 30) for a sort by comments. `total` is the repo's issue count
 * (the countable index), or null when it is not known.
 */
export async function queryIssues(
  sdk: EvoSDK,
  repo: RepoRef,
  q: IssueSelection,
  total: number | null,
  network: Network = DEFAULT_NETWORK,
): Promise<IssueListPage> {
  const index = await indexOf(sdk, repo, network)
  const filtered = q.labels.length > 0 || q.author !== null || q.assignee !== null || q.mentions !== null || q.text.trim() !== ''
  const matches = (r: IssueRow): boolean => stateMatches(r, q.state) && rowMatches(r, q)
  const selected = await selectRows(sdk, index, {
    candidates: await candidatesFor(sdk, index, q),
    matches,
    cmp: compareRows(q.sort),
    direction: q.sort === 'oldest' ? 'asc' : 'desc',
    want: q.page * q.pageSize,
    walkAll: q.sort === 'comments',
    partial: q.text.trim() !== '' || q.mentions !== null || q.sort === 'comments',
  })

  // Tab counts under the current filters: exact when the whole candidate set is known.
  let openCount: number | null = null
  let closedCount: number | null = null
  if (!filtered) {
    const exact = await exactCounts(sdk, index)
    openCount = exact?.open ?? null
    closedCount = exact?.closed ?? null
  } else {
    // Both tabs' counts need every candidate in either state: an index names them, or every issue is loaded.
    const all = await rowsInAnyState(sdk, index, await candidatesFor(sdk, index, { ...q, state: 'all' }), (r) => rowMatches(r, q))
    if (all !== null) {
      openCount = all.filter((r) => r.state.open).length
      closedCount = all.length - openCount
    }
  }

  const page = pageOf(selected.rows, q.page, q.pageSize)
  return {
    rows: page.rows,
    pinned: q.page === 1 ? await pinnedRows(sdk, index) : [],
    matching: selected.complete ? selected.rows.length : null,
    hasNext: page.hasNext,
    openCount,
    closedCount,
    searchedOf: selected.searched === null ? null : { searched: selected.searched, total },
    stateComplete: index.feed !== null,
    labels: index.labels,
    hidden: index.hidden.total,
    hiddenBy: index.hidden.value,
  }
}

/**
 * Every issue that can match `q`, when an index names them: the feed (labels, assignee), the
 * `author` index and (the Closed tab) the issue-close transitions, intersected. Null when none
 * applies (the list walks chunks).
 */
async function candidatesFor(sdk: EvoSDK, index: IssueIndex, q: IssueSelection): Promise<Set<string> | null> {
  return intersect([
    metaCandidates(index, q, (row) => rowMatches(row, { ...q, author: null, mentions: null, text: '' })),
    q.author === null ? null : await authorCandidates(sdk, index, q.author),
    // Every issue ever closed (the targets of issue-close transitions); its row says whether it still is.
    q.state === 'closed' ? await transitionTargets(sdk, index, [ISSUE_CLOSE]) : null,
  ])
}

/** The repo's pinned issues, newest pin first (one `$id in` read for any not loaded yet). */
async function pinnedRows(sdk: EvoSDK, index: IssueIndex): Promise<IssueRow[]> {
  if (index.feed === null) return []
  const ids = pinnedTargets([...index.feed.values()].flatMap((log) => log.events)).map((p) => p.targetId)
  if (ids.length === 0) return []
  await resolveIds(sdk, index, ids)
  return rowsOf(index, ids)
}

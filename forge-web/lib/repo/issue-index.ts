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
import type { PlainDocument } from '../sdk'
import { str, type RepoRef } from './contract'
import { EMPTY_LOG, issueViewOf, type IssueView } from './issues'
import { ISSUE_CLOSE } from '../rules/transition'
import { readStateCodes } from './transitions'
import type { LabelDef } from './labels'
import { pinnedTargets } from '../rules/parity'
import type { HiddenCounts } from './private-content'
import {
  authorCandidates,
  indexCache,
  intersect,
  loadListIndex,
  loadedIds,
  metaCandidates,
  repoCountsOf,
  resolveIds,
  rowsOf,
  transitionTargets,
  walkWhile,
  type ListIndex,
  type RowBuilder,
} from './target-index'

/** An issue row: the folded issue and its comment count (null: not counted). */
export interface IssueRow extends IssueView {
  readonly comments: number | null
}

type IssueIndex = ListIndex<IssueRow>

/**
 * THE state step: a chunk's issues with their state codes (one proved sum query,
 * `targetId in [chunk]`) and their labels and assignees from the feed (unverified, and said so,
 * when the feed is too large to read completely).
 */
const issueRows: RowBuilder<IssueRow> = async (sdk, index, docs, counts) => {
  const codes = docs.length === 0 ? new Map<string, number>() : await readStateCodes(sdk, index.repo, docs.map((d: PlainDocument) => str(d, '$id')))
  return docs.map((doc) => {
    const id = str(doc, '$id')
    const view = issueViewOf(doc, index.feed?.get(id) ?? EMPTY_LOG, codes.get(id) ?? 0)
    return { ...view, stateComplete: index.feed !== null, comments: counts === null ? null : counts.get(id) ?? 0 }
  })
}

const cached = indexCache<IssueRow>()

/** The index, loading it on first use (one per repo and network, until a write drops it). */
function indexOf(sdk: EvoSDK, repo: RepoRef, network: Network): Promise<IssueIndex> {
  return cached(sdk, repo, network, () => loadListIndex(sdk, repo, network, 'issue', issueRows))
}

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
   * issues; a comment sort at most {@link MAX_CHUNKS} chunks): how many issues it looked at.
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
 * by a write), less the issues this reader skipped as not shown. A skipped issue (not
 * well-formed, or a stranger's) is never closed, so it sits in Open; once every issue is
 * loaded it is subtracted exactly. In a private repo anyone's ciphertext counts in the total
 * and cannot be told apart until read, so only a full read gives an open count there. Null
 * when the counts could not be read.
 */
async function exactCounts(sdk: EvoSDK, index: IssueIndex): Promise<{ open: number; closed: number } | null> {
  const counts = await repoCountsOf(sdk, index)
  if (counts === null) return null
  if (index.repo.visibility === 'private' && !index.all) return null
  return { open: Math.max(0, counts.issuesOpen - index.hidden.total), closed: counts.issuesClosed }
}

/**
 * One page of the issue list for `q`, reading only what it needs: the first chunk and the feed
 * (once), feed-named candidates by id, more keyset chunks while the page is not full, or every
 * chunk (up to {@link MAX_CHUNKS}) for a sort by comments. `total` is the repo's issue count
 * (the countable index), or null when it is not known.
 */
export async function queryIssues(
  sdk: EvoSDK,
  repo: RepoRef,
  q: IssueSelection,
  total: number | null,
  network: Network = DEFAULT_NETWORK,
): Promise<IssueListPage> {
  const state = await indexOf(sdk, repo, network)
  const want = q.page * q.pageSize
  const cmp = compareRows(q.sort)
  const direction = q.sort === 'oldest' ? 'asc' : 'desc'

  let rows: IssueRow[]
  let complete: boolean
  let searched: number | null = null
  const candidates = await candidatesFor(sdk, state, q)
  if (candidates !== null) {
    // The feed names every issue that can match: resolve them, then filter exactly.
    await resolveIds(sdk, state, candidates)
    rows = rowsOf(state, candidates).filter((r) => stateMatches(r, q.state) && rowMatches(r, q)).sort(cmp)
    complete = true
  } else {
    // Once every issue is loaded, the walk's own order does not matter: sort the whole set.
    const matching = (): IssueRow[] => rowsOf(state, loadedIds(state, direction)).filter((r) => stateMatches(r, q.state) && rowMatches(r, q))
    // Keep reading chunks until the page is full and one more row shows a next page exists (every
    // chunk, for a sort by comments).
    complete = await walkWhile(sdk, state, direction, () => q.sort === 'comments' || matching().length <= want)
    rows = matching().sort(cmp)
    if (!complete && (q.text.trim() !== '' || q.mentions !== null || q.sort === 'comments')) searched = [...loadedIds(state, direction)].length
  }

  // Tab counts under the current filters: exact when the whole candidate set is known.
  let openCount: number | null = null
  let closedCount: number | null = null
  const filtered = q.labels.length > 0 || q.author !== null || q.assignee !== null || q.mentions !== null || q.text.trim() !== ''
  if (!filtered) {
    const exact = await exactCounts(sdk, state)
    openCount = exact?.open ?? null
    closedCount = exact?.closed ?? null
  } else {
    // Both tabs' counts need every candidate in either state: the feed or author index names
    // them, or a finished walk has loaded every issue.
    const both = await withBothStates(sdk, state, q)
    const all = both ?? (state.all ? rowsOf(state, state.rows.keys()).filter((r) => rowMatches(r, q)) : null)
    if (all !== null) {
      openCount = all.filter((r) => r.state.open).length
      closedCount = all.length - openCount
    }
  }

  const start = (q.page - 1) * q.pageSize
  return {
    rows: rows.slice(start, start + q.pageSize),
    pinned: q.page === 1 ? await pinnedRows(sdk, state) : [],
    matching: complete ? rows.length : null,
    hasNext: rows.length > start + q.pageSize,
    openCount,
    closedCount,
    searchedOf: searched === null ? null : { searched, total },
    stateComplete: state.feed !== null,
    labels: state.labels,
    hidden: state.hidden.total,
    hiddenBy: state.hidden.value,
  }
}

/**
 * The rows matching `q`'s filters in either state (for both tabs' counts), when the feed or the
 * author index names every candidate; null when only a chunk walk could.
 */
async function withBothStates(sdk: EvoSDK, state: IssueIndex, q: IssueSelection): Promise<IssueRow[] | null> {
  const cands = await candidatesFor(sdk, state, { ...q, state: 'all' })
  if (cands === null) return null
  await resolveIds(sdk, state, cands)
  return rowsOf(state, cands).filter((r) => rowMatches(r, q))
}

/**
 * Every issue that can match `q`, when an index names them: the feed (state, labels, assignee)
 * and the `author` index, intersected. Null when neither applies (the list walks chunks).
 */
async function candidatesFor(sdk: EvoSDK, state: IssueIndex, q: IssueSelection): Promise<Set<string> | null> {
  return intersect([
    metaCandidates(state, q, (row) => rowMatches(row, { ...q, author: null, mentions: null, text: '' })),
    q.author === null ? null : await authorCandidates(sdk, state, q.author),
    // Every issue ever closed (the targets of issue-close transitions); its row says whether it still is.
    q.state === 'closed' ? await transitionTargets(sdk, state, [ISSUE_CLOSE]) : null,
  ])
}

/** The repo's pinned issues, newest pin first (one `$id in` read for any not loaded yet). */
async function pinnedRows(sdk: EvoSDK, state: IssueIndex): Promise<IssueRow[]> {
  if (state.feed === null) return []
  const ids = pinnedTargets([...state.feed.values()].flatMap((log) => log.events)).map((p) => p.targetId)
  if (ids.length === 0) return []
  await resolveIds(sdk, state, ids)
  return rowsOf(state, ids)
}

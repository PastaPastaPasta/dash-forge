/**
 * The issue index: what the Issues tab lists, filters, sorts and counts, read with composite
 * queries and keyset paging (`platform-parity-spec.md` §1.2, §3.3; D-217, D-904, SR-03), on the
 * engine it shares with the pull index (`./target-index`).
 *
 * Reads, per repo, cached for the session and dropped by any write ({@link invalidateRepoFeed}):
 *
 * 1. **One composite** (the first request): the newest 100 issues, their comment counts
 *    (`comment.target` count tree), their authors' DPNS names, their member events (the `event`
 *    `target` lookup: labels, assignees, milestone), and as siblings under the same proof the
 *    label definitions and the first 100 rows of the repo's member `event` feed; and beside it
 *    one proved sum query for those issues' state codes (`transition.perTarget`), and the three
 *    proved counts.
 * 2. **The rest of the event feed**, for a label, assignee or milestone filter, read once per repo
 *    and shared with the pull index (`readRepoFeedFrom`); and for page 1's pinned issues (a pin
 *    can be on any issue, and only the feed finds it) when it is short (`PIN_FEED_PAGES`) or
 *    asked for (`pins`): a mirror's feed runs to thousands of label events (QW3-003). A row's own
 *    labels never wait for it.
 * 3. **More issues on demand**: a keyset composite per 100 (`$createdAt <=` the oldest loaded,
 *    newest first; `>=` the newest loaded for the oldest-first sort), each with its sum query,
 *    and `$id in` composites for issues the feed names but no loaded chunk holds. An unfiltered
 *    tab stops once it holds the page or every issue its proved count allows, and reads at most
 *    `PAGE_CHUNKS` chunks per load (QW2-002).
 * 4. **The Closed tab's candidates**: the targets of the repo's issue-close transitions
 *    (`transition.perRepoKind`, `kind == 1`), read on first use when the proved counts say that
 *    is cheaper than walking; every closed issue has one.
 *
 * Counts: Open / Closed are the proved totals (`./transitions` `readRepoCounts`: the issue total
 * and the close / reopen counts), never a fold.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, type Network } from '../constants'
import type { RepoRef } from './contract'
import { PIN_FEED_PAGES, countsSettled, issueViewOf, readShortRepoFeed, type IssueView } from './issues'
import { ISSUE_CLOSE, statusOfCode, type CloseReason } from '../rules/transition'
import type { LabelDef } from './labels'
import { foldThreadMetaV2, pinnedTargets } from '../rules/parity'
import type { Event } from '../rules'
import { threadHidesOf } from './moderation-fold'
import { searchableBody, trustedOrigin } from './provenance'
import { commentRange, searchTerms, type CountRange, type ExtraFilters, type TextScope } from '../view/issue-query'
import type { HiddenCounts } from './private-content'
import {
  authorCandidates,
  candidatesCheaper,
  closedWithReason,
  feedOf,
  hydrate,
  indexCache,
  intersect,
  logsVerified,
  matchingOf,
  metaCandidates,
  openShare,
  pageOf,
  pageWalk,
  repoCountsOf,
  resolveIds,
  rowsInAnyState,
  rowsOf,
  rowsWithEvent,
  scanCheaper,
  scanSelect,
  searchedOfPage,
  selectRows,
  shownRows,
  transitionTargets,
  type ListIndex,
  type ListOptions,
  type RepoCounts,
  type SearchedOf,
} from './target-index'

/** An issue row: the folded issue, its comment count (null: not counted) and its milestone. */
export interface IssueRow extends IssueView {
  readonly comments: number | null
  /** The milestone title its member events leave it in (`foldThreadMetaV2`), or null. */
  readonly milestone?: string | null
  /** Its hides and unhides of the whole issue (RC2 MOD): `hiddenThreadIds` judges them. */
  readonly threadHides?: readonly Event[]
}

type IssueIndex = ListIndex<IssueRow>

/**
 * The index, loading it on first use (one per repo and network, until a write drops it). An
 * issue's view: its state code (the chunk's proved sum), its labels and assignees, and its
 * milestone from the feed.
 */
const indexOf = indexCache<IssueRow>(
  'issue',
  async (_sdk, _index, doc, log, code) => ({
    ...issueViewOf(doc, log, code),
    milestone: foldThreadMetaV2(log.events).milestone,
    threadHides: threadHidesOf(log.events),
  }),
  // Page 1 shows the pinned issues, which only the whole feed names: its first page rides the first composite.
  { withFeed: true },
)

function sortRowsNewest(a: IssueRow, b: IssueRow): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The filters the Issues and Pull requests lists share beyond labels, author and assignee (the
 * search box's `ExtraFilters`, resolved: `comments` as a range). Each is optional: absent, it
 * does not narrow.
 */
export interface RowFilters {
  readonly notLabels?: readonly string[]
  readonly noLabel?: boolean
  readonly milestone?: string | null
  readonly noMilestone?: boolean
  /** A source forge's login: an item whose trusted import recorded it as the author. */
  readonly authorLogin?: string | null
  /** Who may mirror (`useMirrorTrust`): only their items' recorded author matches `authorLogin`. */
  readonly mirrorTrust?: ReadonlySet<string> | null
  /** Where `text` is looked for (default: titles and bodies). */
  readonly scope?: TextScope
  readonly comments?: CountRange | null
  /** `reason:` (QW4-028): closed issues whose current close gives this reason (an issue filter). */
  readonly reason?: CloseReason | null
}

/** A list query's {@link ExtraFilters} as the {@link RowFilters} a selection carries. */
export function rowFiltersOf(q: ExtraFilters, mirrorTrust: ReadonlySet<string> | null): RowFilters {
  return {
    notLabels: q.notLabels,
    noLabel: q.noLabel,
    milestone: q.milestone,
    noMilestone: q.noMilestone,
    authorLogin: q.authorLogin,
    mirrorTrust,
    scope: q.scope,
    comments: commentRange(q.comments),
    reason: q.reason,
  }
}

/** What the list asks for (resolved: `me` is replaced by the viewer's id by the caller). */
export interface IssueSelection extends RowFilters {
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

/** Whether a selection narrows the list beyond its state tab. */
export function selectionFiltered(q: Omit<IssueSelection, 'mentions' | 'state' | 'sort' | 'page' | 'pageSize'> & { readonly mentions?: IssueSelection['mentions'] }): boolean {
  return (
    q.labels.length > 0 ||
    q.author !== null ||
    q.assignee !== null ||
    (q.mentions ?? null) !== null ||
    q.text.trim() !== '' ||
    (q.notLabels?.length ?? 0) > 0 ||
    q.noLabel === true ||
    (q.milestone ?? null) !== null ||
    q.noMilestone === true ||
    (q.authorLogin ?? null) !== null ||
    (q.comments ?? null) !== null ||
    (q.reason ?? null) !== null
  )
}

/**
 * Whether a selection matches on what a row's member events decide (labels, assignees,
 * milestone): every row it matches needs its events first, and the feed may name candidates.
 */
export function eventFiltered(q: Pick<IssueSelection, 'labels' | 'assignee' | 'notLabels' | 'noLabel' | 'milestone' | 'noMilestone'>): boolean {
  return q.labels.length > 0 || q.assignee !== null || (q.notLabels?.length ?? 0) > 0 || q.noLabel === true || (q.milestone ?? null) !== null || q.noMilestone === true
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
   * When the answer covers only part of the repo (a text or mention search, a comment sort at
   * most 30 chunks, or a page that read its chunk budget): how far it read.
   */
  readonly searchedOf: SearchedOf | null
  /** False when a shown issue's member events could not be read completely: its labels and assignees are unverified (states are proved). */
  readonly stateComplete: boolean
  /**
   * The repo's pinned issues (member pin events, kinds 19/20, from the complete feed), newest
   * pin first: page 1 shows them above the list. Empty past page 1 or when the feed is too large.
   */
  readonly pinned: readonly IssueRow[]
  /**
   * Page 1 did not read its pinned issues: the repo's member-event feed (the only place a pin is
   * found) is longer than a page load reads for them (`PIN_FEED_PAGES`). Query again with `pins`
   * to read it.
   */
  readonly pinsUnread: boolean
  readonly labels: readonly LabelDef[]
  readonly hidden: number
  /** `hidden` by reason (private repos: shown to maintainers). */
  readonly hiddenBy: HiddenCounts
}

/** Whether a row's folded state passes the state tab. */
function stateMatches(row: IssueRow, state: IssueSelection['state']): boolean {
  return state === 'all' || (state === 'open' ? row.state.open : !row.state.open)
}

/** What {@link rowMatches} reads of a row: an issue row, or a PR row with its milestone passed in. */
export type MatchRow = Pick<IssueRow, 'title' | 'number' | 'body' | 'author' | 'origin' | 'comments' | 'milestone'> & {
  readonly state: { readonly labels: readonly string[]; readonly assignees: readonly string[] }
}

/** Whether a row passes every filter but the state tab. */
export function rowMatches(row: MatchRow, q: Omit<IssueSelection, 'state' | 'sort' | 'page' | 'pageSize'>): boolean {
  const labels = row.state.labels
  if (q.labels.some((l) => !labels.includes(l))) return false
  if (q.notLabels?.some((l) => labels.includes(l))) return false
  if (q.noLabel && labels.length > 0) return false
  const milestone = row.milestone ?? null
  if (q.milestone != null && milestone !== q.milestone) return false
  if (q.noMilestone && milestone !== null) return false
  if (q.author !== null && row.author !== q.author) return false
  if (q.authorLogin != null && trustedOrigin(row.origin, row.author, q.mirrorTrust ?? null)?.author.toLowerCase() !== q.authorLogin.toLowerCase()) return false
  if (q.assignee === 'none' && row.state.assignees.length > 0) return false
  if (q.assignee !== null && q.assignee !== 'none' && !row.state.assignees.includes(q.assignee)) return false
  if (q.comments != null && (row.comments === null || row.comments < q.comments.min || row.comments > q.comments.max)) return false
  if (q.mentions !== null && !mentions(row.body, q.mentions.id, q.mentions.name)) return false
  return matchesText(q.text, row, q.scope)
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
 * A body as a text search reads it (lowercased, without a mirrored provenance quote), kept per
 * body: a walk re-matches every loaded row after each chunk it reads.
 */
const searchBodies = new Map<string, string>()
function searchBody(body: string): string {
  let hit = searchBodies.get(body)
  if (hit === undefined) {
    if (searchBodies.size >= 4096) searchBodies.clear()
    hit = searchableBody(body).toLowerCase()
    searchBodies.set(body, hit)
  }
  return hit
}

/**
 * Whether `row` holds every term of `text` ({@link searchTerms}: a word, or a `"quoted phrase"`
 * as a whole, QW-021), case-insensitively, in its title or body (GitHub's default; `scope`
 * `title` / `body` is `in:`). A mirrored body's provenance quote is not searched: it names the
 * source repo and author on every row. A word that is all digits (with or without a leading
 * `#`) also matches the issue number directly (L-43: a title substring check alone missed a bare
 * `7512`, even though `#7512` matched by number — a word checks both, so neither form of the
 * same search regresses the other). A term with a leading `-` (`-word`, `-"a phrase"`) is one the
 * row must not hold (QW3-018).
 */
export function matchesText(text: string, row: { readonly title: string; readonly number: number; readonly body?: string }, scope: TextScope = 'any'): boolean {
  const terms = searchTerms(text)
  if (terms.length === 0) return true
  const fields: string[] = []
  if (scope !== 'body') fields.push(row.title.toLowerCase())
  if (scope !== 'title' && row.body) fields.push(searchBody(row.body))
  const holds = (w: string): boolean => {
    // `#n` (review L-43) is a number-only match: it never falls back to a text substring, even
    // when the digits happen to appear in the title of a different-numbered row.
    const hash = /^#(\d+)$/.exec(w)
    if (hash) return Number(hash[1]) === row.number
    // A bare number matches the number OR (additively) a text substring.
    const bare = /^(\d+)$/.exec(w)
    if (bare && Number(bare[1]) === row.number) return true
    return fields.some((f) => f.includes(w))
  }
  // `-word` and `-"a phrase"` exclude (QW3-018, GitHub's NOT).
  return terms.every((t) => holds(t.text) !== t.not)
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
  return provedCounts(counts, index)
}

/** The proved Open / Closed issue totals, less (from Open) the open issues this reader skipped as not shown. */
function provedCounts(counts: RepoCounts, index: IssueIndex): { open: number; closed: number } {
  return { open: Math.max(0, counts.issuesOpen - index.hiddenOpen), closed: counts.issuesClosed }
}

/**
 * At most how many issues can be in `state`, by the proved counts (every reader's: a row this
 * reader cannot open is in the count, never out of it), or null when unknown.
 */
function tabBound(counts: RepoCounts | null, index: IssueIndex, state: IssueSelection['state']): number | null {
  if (counts === null) return null
  return state === 'all' ? counts.issues : provedCounts(counts, index)[state]
}

/** The `state` tab's count: Open, Closed, or both (null when either is unknown). */
function stateCount(state: IssueSelection['state'], open: number | null, closed: number | null): number | null {
  if (state === 'open') return open
  if (state === 'closed') return closed
  return open === null || closed === null ? null : open + closed
}

/**
 * One page of the issue list for `q`, reading only what it needs: the first chunk (with the
 * proved counts beside it), then, unfiltered, keyset chunks until the page is full or every issue
 * the tab's count allows is held (at most `PAGE_CHUNKS` per load), or a sparse tab's rows through
 * the state scan or the Closed tab's transitions when that is cheaper; filtered, feed-named
 * candidates by id or up to `PAGE_CHUNKS` chunks per load (a search, reported through
 * `onProgress`, read on when asked); a sort by comments the same. Page 1 reads its pinned issues
 * beside the list when the feed is short, or when asked (`pins`). `total` is the repo's issue
 * count (the countable index), or null for the proved count this call reads.
 */
export async function queryIssues(
  sdk: EvoSDK,
  repo: RepoRef,
  q: IssueSelection,
  total: number | null,
  network: Network = DEFAULT_NETWORK,
  { onProgress, pins = false }: ListOptions & { readonly pins?: boolean } = {},
): Promise<IssueListPage> {
  const index = await indexOf(sdk, repo, network, { withCounts: true })
  const pinned = q.page === 1 ? pinnedRows(sdk, index, pins) : Promise.resolve([])
  pinned.catch(() => undefined)
  const filtered = selectionFiltered(q)
  const needLogs = eventFiltered(q)
  if (needLogs) await feedOf(sdk, index)
  // `reason:` (QW4-028): the issues whose newest close says so, and only while they are closed.
  const reasoned = q.reason == null ? null : await closedWithReason(sdk, index, q.reason)
  if (q.reason != null && reasoned === null) throw new Error('This repository has too many closed issues to search them by close reason.')
  const reasonOk = (r: IssueRow): boolean => reasoned === null || (!r.state.open && reasoned.has(r.id))
  const bound = await repoCountsOf(sdk, index)
  const walk = pageWalk(q, filtered)
  const tab = tabBound(bound, index, q.state)
  // A sparse tab through the state scan when the proved counts say that is cheaper than walking
  // (QW3-002; the PR list's Open tab is the usual one).
  const byScan = !filtered && bound !== null && tab !== null && countsSettled(repo) && scanCheaper(index, walk, tab, bound, q.state === 'open')
  const byState = q.state === 'closed' && candidatesCheaper(index, walk, tabBound(bound, index, 'closed'), bound?.issues ?? null)
  const selected = byScan
    ? await scanSelect(sdk, index, {
        inTab: (code) => q.state === 'all' || statusOfCode(code).open === (q.state === 'open'),
        matches: (r) => stateMatches(r, q.state),
        cmp: compareRows(q.sort),
        direction: walk.direction,
        want: walk.want + 1,
        known: tab,
        max: bound.issues + bound.patches,
        typeTotal: bound.issues,
        openShare: openShare(bound, bound.issuesOpen),
        onProgress,
      })
    : await selectRows(sdk, index, {
        ...walk,
        candidates: await candidatesFor(sdk, index, q, byState, reasoned),
        matches: (r) => stateMatches(r, q.state) && rowMatches(r, q) && reasonOk(r),
        cmp: compareRows(q.sort),
        // The walk stops at the tab's proved count (never a filter's), once it includes this browser's own writes.
        known: () => (filtered || !countsSettled(repo) ? null : tabBound(bound, index, q.state)),
        needLogs,
        onProgress,
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
    const all = await rowsInAnyState(sdk, index, await candidatesFor(sdk, index, { ...q, state: 'all' }, false, reasoned), (r) => rowMatches(r, q) && reasonOk(r), needLogs)
    if (all !== null) {
      openCount = all.filter((r) => r.state.open).length
      closedCount = all.length - openCount
    }
  }

  const page = pageOf(selected.rows, q.page, q.pageSize)
  // Page 1 reads the feed for its pins when it is short: the shown rows then take their events from it.
  const pinnedNow = await pinned
  const rows = await shownRows(sdk, index, page.rows)
  return {
    rows,
    pinned: pinnedNow ?? [],
    pinsUnread: pinnedNow === null,
    matching: matchingOf(selected, filtered, stateCount(q.state, openCount, closedCount)),
    hasNext: page.hasNext,
    openCount,
    closedCount,
    searchedOf: searchedOfPage(selected, total ?? bound?.issues ?? null),
    stateComplete: logsVerified(index, [...rows, ...(pinnedNow ?? [])]),
    labels: index.labels,
    hidden: index.hidden.total,
    hiddenBy: index.hidden.value,
  }
}

/**
 * Every issue that can match `q`, when an index names them: the feed (labels, assignee), the
 * `author` index and the closes giving a `reason:` (`reasoned`), intersected; else, for the Closed tab when that is cheaper than walking
 * (`byState`), the issue-close transitions. Null when none applies (the list walks chunks).
 */
async function candidatesFor(
  sdk: EvoSDK,
  index: IssueIndex,
  q: IssueSelection,
  byState = q.state === 'closed',
  reasoned: Set<string> | null = null,
): Promise<Set<string> | null> {
  const named = intersect([
    metaCandidates(index, q, (row) => rowMatches(row, { ...q, author: null, mentions: null, text: '' })),
    q.author === null ? null : await authorCandidates(sdk, index, q.author),
    reasoned,
  ])
  // Else every issue ever closed (the targets of issue-close transitions); its row says whether it still is.
  return named ?? (byState ? transitionTargets(sdk, index, [ISSUE_CLOSE]) : null)
}

/**
 * The repo's pinned issues, newest pin first (from the feed; one `$id in` read for any not loaded
 * yet), or null when they were not read: no index finds a pin but the whole member-event feed, so
 * a page reads it for them only when it is short ({@link PIN_FEED_PAGES}), already read, or asked
 * for (`full`). A feed too large to read completely at all leaves them unread too.
 */
async function pinnedRows(sdk: EvoSDK, index: IssueIndex, full: boolean): Promise<IssueRow[] | null> {
  if (!full && index.feedRead === undefined) {
    // Known long already (a write drops the index; events are never deleted, so it stays long).
    if (index.feedLong) return null
    const short = await readShortRepoFeed(sdk, index.repo, index.feedFirst, index.epoch, 1 + PIN_FEED_PAGES)
    if (short === 'long') {
      index.feedLong = true
      return null
    }
  }
  // Shared by now (or asked for): no second read of a feed the short read just read.
  const feed = await feedOf(sdk, index)
  if (feed === null) return null
  const ids = pinnedTargets([...feed.values()].flatMap((log) => log.events)).map((p) => p.targetId)
  if (ids.length === 0) return []
  await resolveIds(sdk, index, ids)
  await hydrate(sdk, index, ids)
  return rowsOf(index, ids)
}

/**
 * Each issue a milestone event names, with its open state and milestone: the milestones page's
 * progress (`foldMilestonesV2`'s items). Read from the feed the list shares (the targets with a
 * `milestoneSet` event, resolved by id); null when the feed was too large to read, so the
 * progress is unknown rather than wrong.
 */
export async function issueMilestoneItems(sdk: EvoSDK, repo: RepoRef, network: Network = DEFAULT_NETWORK): Promise<{ open: boolean; milestone: string | null }[] | null> {
  const rows = await rowsWithEvent(sdk, await indexOf(sdk, repo, network), 'milestoneSet')
  return rows?.map((r) => ({ open: r.state.open, milestone: r.milestone ?? null })) ?? null
}

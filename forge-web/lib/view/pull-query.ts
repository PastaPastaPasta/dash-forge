/**
 * The PR list's query (L-44): the Issues list's URL and search grammar (`./issue-query`), with
 * the PR states. Everything the list shows is in the URL, so a reload or a shared link shows the
 * same list.
 *
 * URL parameters (all optional; a default is never written):
 *   state=open|merged|closed|unmerged|all (default open; closed = closed without merging;
 *   unmerged = open or closed without merging)
 *   label, author, assignee, sort, q, page — as on the Issues list; `q` also carries the PR-only
 *   `draft:` and `review-requested:` qualifiers
 *
 * The search box takes the same qualifiers as the Issues list, plus `is:merged`, `is:unmerged`,
 * `is:draft`, `draft:true|false` and `review-requested:<id|name|@me>` (and `is:pr`, which every PR
 * matches). `mentions:` and `reason:` are not PR filters here, and are reported as not applied, as
 * are `review:` (a PR's reviews are read on its page, not by the list) and `is:issue` (QW2-055: the
 * Issues tab lists issues). Several state qualifiers narrow one another, as on GitHub (QW4-007):
 * `is:closed is:unmerged` is the closed-without-merging PRs.
 */

import type { PullStateFilter } from '../repo'
import {
  DEFAULT_ISSUE_QUERY,
  STATE_CONFLICT,
  droppedQualifiersReason,
  hasFilters,
  isStateConflict,
  issueQueryParams,
  linkedAllStates,
  parseIssueQuery,
  parseSearchText,
  personValue,
  Q_MAX,
  searchText,
  searchTokens,
  submitState,
  unresolvedQualifiers,
  type IssueListQuery,
} from './issue-query'
import { displayDpnsName } from './dpns'
import { plural } from './format'

/** The structured PR list query. */
export type PullListQuery = Omit<IssueListQuery, 'state' | 'mentions'> & {
  readonly state: PullStateFilter
  /** `draft:true` / `is:draft` (only drafts), `draft:false` (none), or null. */
  readonly draft: boolean | null
  /** `review-requested:`: an identity id or `me`, or null. */
  readonly reviewRequested: string | null
}

export const DEFAULT_PULL_QUERY: PullListQuery = toPull(DEFAULT_ISSUE_QUERY, 'open')

/** Rows per displayed page. */
export const PULL_PAGE_SIZE = 25

/**
 * What a search-box submit of `text` keeps of the current query: the state tab, or every state when
 * `text` took its state qualifier out (QW4-023); every other filter is what the box says.
 */
export function pullSubmitBase(q: PullListQuery, text = ''): PullListQuery {
  return { ...DEFAULT_PULL_QUERY, state: submitState(q.state, text, STATES) }
}

const STATES: readonly PullStateFilter[] = ['open', 'merged', 'closed', 'unmerged', 'all']

function toPull(q: IssueListQuery, state: PullStateFilter, pr: Pick<PullListQuery, 'draft' | 'reviewRequested'> = { draft: null, reviewRequested: null }): PullListQuery {
  const { mentions: _mentions, state: _state, ...rest } = q
  return { ...rest, state, ...pr }
}

function toIssue(q: PullListQuery): IssueListQuery {
  const { draft: _draft, reviewRequested: _rr, ...rest } = q
  return { ...rest, state: 'open', mentions: false }
}

/** The PR-only filters as qualifiers (what `q` carries for them in the URL). */
function pullQualifiers(q: Pick<PullListQuery, 'draft' | 'reviewRequested'>): string[] {
  const parts: string[] = []
  if (q.draft !== null) parts.push(`draft:${q.draft}`)
  if (q.reviewRequested !== null) parts.push(`review-requested:${q.reviewRequested === 'me' ? '@me' : q.reviewRequested}`)
  return parts
}

type PrState = 'open' | 'merged' | 'closed'
/**
 * The PRs each state qualifier admits, with GitHub's meanings so that several intersect as there
 * (QW4-007): `is:closed` is merged or closed (alone it still selects the Closed tab, closed
 * without merging).
 */
const PR_STATE_SETS: Readonly<Record<PullStateFilter, readonly PrState[]>> = {
  open: ['open'],
  merged: ['merged'],
  closed: ['merged', 'closed'],
  unmerged: ['open', 'closed'],
  all: ['open', 'merged', 'closed'],
}

/** The list state for the PRs a run of state qualifiers admits. */
function stateOfSet(set: readonly PrState[]): PullStateFilter {
  const has = (s: PrState): boolean => set.includes(s)
  if (set.length === 3) return 'all'
  if (has('open')) return has('closed') ? 'unmerged' : 'open'
  // Merged and closed (`is:closed` alone) is the Closed tab, as before; merged alone is Merged.
  return has('closed') ? 'closed' : 'merged'
}

interface PullOnly {
  readonly rest: string
  /** The state every state qualifier together selects; null for none. */
  readonly state: PullStateFilter | null
  readonly draft: boolean | null
  readonly reviewRequested: string | null
  /** PR-only tokens whose value could not be used, a contradicting state, and the Issues filters (`mentions:`, `reason:`). */
  readonly unresolved: readonly string[]
}

/**
 * Lift the PR-only qualifiers out of `text`, token by token as the Issues grammar reads it (a
 * `"quoted phrase"` or `label:"two words"` stays whole, so a qualifier inside quotes is text): every
 * state qualifier (the key in any case; `open` / `closed` / `all` too, since several intersect),
 * `is:pr`, `is:draft`, `draft:`, `review-requested:`, and the Issues filters it reports. What is
 * left is Issues grammar.
 */
function liftPullOnly(text: string): PullOnly {
  let admitted: readonly PrState[] | null = null
  let draft: boolean | null = null
  let reviewRequested: string | null = null
  const unresolved: string[] = []
  const rest: string[] = []
  for (const tok of searchTokens(text)) {
    const at = tok.indexOf(':')
    const key = at > 0 ? tok.slice(0, at).toLowerCase() : ''
    const value = at > 0 ? tok.slice(at + 1).replace(/"/g, '') : ''
    if (key === 'is' || key === 'state') {
      if (value === 'draft') draft = true
      else if (value.toLowerCase() === 'issue') unresolved.push(tok)
      else if (STATES.includes(value as PullStateFilter)) {
        const wanted = PR_STATE_SETS[value as PullStateFilter]
        const next: readonly PrState[] = admitted === null ? wanted : admitted.filter((st) => wanted.includes(st))
        // No PR is in both (`is:open is:merged`): said under the box, the first one kept.
        if (next.length === 0) unresolved.push(tok)
        else admitted = next
      } else if (value !== 'pr') rest.push(tok)
    } else if (key === 'mentions' || (key === 'reason' && value !== '')) unresolved.push(tok)
    else if (key === 'draft') {
      const flag = value.toLowerCase()
      if (flag === 'true' || flag === 'false') draft = flag === 'true'
      else unresolved.push(tok)
    } else if (key === 'review-requested') {
      const who = personValue(value)
      if (who !== null) reviewRequested = who
      else unresolved.push(tok)
    } else rest.push(tok)
  }
  const set = admitted as readonly PrState[] | null
  return { rest: rest.join(' '), state: set === null ? null : stateOfSet(set), draft, reviewRequested, unresolved }
}

/** Lift the search box's qualifiers into `base` (the inverse of {@link pullSearchText}). */
export function parsePullSearch(text: string, base: PullListQuery = DEFAULT_PULL_QUERY): PullListQuery {
  const only = liftPullOnly(text)
  const parsed = parseSearchText(only.rest, toIssue(base))
  return toPull(parsed, only.state ?? base.state, { draft: only.draft ?? base.draft, reviewRequested: only.reviewRequested ?? base.reviewRequested })
}

/** The qualifiers in `text` that could not be used (for a note under the box). */
export function unresolvedPullQualifiers(text: string): string[] {
  const only = liftPullOnly(text)
  return [...unresolvedQualifiers(only.rest), ...only.unresolved]
}

/**
 * Why each qualifier in `dropped` was not applied, for the note under the box: the Issues list's
 * reasons, with the PR states for `is:` / `state:`, `mentions:` named as an Issues filter, and
 * the PR-only qualifiers' own values.
 */
export function pullDroppedReason(dropped: readonly string[], notFound: readonly string[] = []): string {
  const isIssue = (t: string): boolean => /^(is|state):issue$/i.test(t)
  const isConflict = (t: string): boolean => isStateConflict(t, STATES)
  const isState = (t: string): boolean => /^(is|state):/i.test(t) && !isIssue(t) && !isConflict(t)
  const isMentions = (t: string): boolean => /^mentions:/i.test(t)
  const isReason = (t: string): boolean => /^reason:/i.test(t)
  const isDraft = (t: string): boolean => /^draft:/i.test(t)
  const isRequested = (t: string): boolean => /^review-requested:/i.test(t)
  const lost = new Set(notFound.map((n) => n.toLowerCase()))
  const requested = dropped.filter(isRequested).map((t) => t.slice(t.indexOf(':') + 1).replace(/"/g, '').replace(/^@/, ''))
  return [
    droppedQualifiersReason(dropped.filter((t) => !isIssue(t) && !isState(t) && !isConflict(t) && !isMentions(t) && !isReason(t) && !isDraft(t) && !isRequested(t)), notFound),
    dropped.some(isIssue) ? 'is:issue is not a filter here — open the Issues tab to search issues.' : '',
    dropped.some(isState) ? 'is: and state: take open, closed, merged, unmerged, draft or all.' : '',
    dropped.some(isConflict) ? STATE_CONFLICT : '',
    dropped.some(isMentions) ? 'mentions: is an Issues filter.' : '',
    dropped.some(isReason) ? "reason: is an Issues filter (only an issue's close has a reason)." : '',
    dropped.some(isDraft) ? 'draft: takes true or false.' : '',
    ...requested.filter((v) => lost.has(v.toLowerCase())).map((v) => `No DPNS name \`${displayDpnsName(v)}\` was found.`),
    requested.some((v) => !lost.has(v.toLowerCase())) ? 'review-requested: takes an identity id, a DPNS name, or @me.' : '',
  ]
    .filter((r) => r !== '')
    .join(' ')
}

/** Parse the list query from URL search params; anything invalid falls back to its default. */
export function parsePullQuery(params: { get(name: string): string | null; getAll(name: string): string[] }): PullListQuery {
  const raw = params.get('state')
  const state = STATES.includes(raw as PullStateFilter) ? (raw as PullStateFilter) : 'open'
  const q = (params.get('q') ?? '').slice(0, Q_MAX)
  // The rest as the Issues list reads it; `q`'s qualifiers (a GitHub link) are lifted below.
  const issue = parseIssueQuery({ get: (n) => (n === 'state' || n === 'q' ? null : params.get(n)), getAll: (n) => params.getAll(n) })
  // `?q=is:pr` with no state lists every state, as GitHub does (QW4-023); the app never writes `is:pr`.
  const linkedAll = raw === null && linkedAllStates(q, 'pr', STATES)
  const base = { ...toPull(issue, linkedAll ? 'all' : state), q }
  return q.includes(':') ? { ...parsePullSearch(q, { ...base, q: '' }), page: issue.page } : base
}

/** The URL params of a query, defaults omitted, in a stable order. */
export function pullQueryParams(q: PullListQuery): [string, string][] {
  const rest = issueQueryParams(toIssue({ ...q, q: [...pullQualifiers(q), q.q.trim()].filter((t) => t !== '').join(' ') }))
  return q.state === 'open' ? rest : [['state', q.state], ...rest]
}

/** The query as search-box text, qualifiers first. */
export function pullSearchText(q: PullListQuery): string {
  const text = searchText(toIssue({ ...q, q: '' })).replace(/^is:open/, `is:${q.state}`)
  return [text, ...pullQualifiers(q), q.q.trim()].filter((t) => t !== '').join(' ')
}

/** Whether any filter narrows the list beyond the state tab. */
export function hasPullFilters(q: PullListQuery): boolean {
  return hasFilters(toIssue(q)) || q.draft !== null || q.reviewRequested !== null
}

/** The empty PR list's line: never "open the first one" while some are merged or closed; a search names every state (QW3-051). */
export function emptyPullsBody(filtered: boolean, state: PullStateFilter, settled: number | null): string {
  if (filtered) return state === 'all' ? 'Try fewer filters.' : 'Try fewer filters, or search every state.'
  if (state === 'merged') return 'Nothing has been merged yet.'
  if (state === 'closed') return 'Nothing has been closed without merging.'
  const open = 'Push a branch with the git-remote-dash helper (to this repo, or to your fork), then open a PR here or with dg pr create.'
  // Nothing open or closed without merging: every PR there is was merged (none at all: how to open one).
  if (state === 'unmerged') return settled === 0 ? open : settled === null ? 'No pull request is open or closed without merging.' : 'Every pull request here has been merged.'
  if (state === 'all' || settled === 0) return open
  if (settled === null) return 'No pull request is open right now.'
  return `No pull request is open right now; ${plural(settled, 'pull request')} ${settled === 1 ? 'is' : 'are'} merged or closed.`
}

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
 * matches). `mentions:` is not a PR filter here, and is reported as not applied, as are `review:`
 * (a PR's reviews are read on its page, not by the list) and `is:issue` (QW2-055: the Issues tab
 * lists issues).
 */

import type { PullStateFilter } from '../repo'
import {
  DEFAULT_ISSUE_QUERY,
  droppedQualifiersReason,
  hasFilters,
  issueQueryParams,
  parseIssueQuery,
  parseSearchText,
  personValue,
  Q_MAX,
  searchText,
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

/** What a search-box submit keeps of the current query: the state tab (every other filter is what the box says). */
export function pullSubmitBase(q: PullListQuery): PullListQuery {
  return { ...DEFAULT_PULL_QUERY, state: q.state }
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

/** `is:merged` / `is:unmerged` / `is:pr` / `is:draft` (or `state:`), which the Issues grammar does not have: the key in any case, the value exact. */
const PR_STATE_TOKEN = /(^|\s)(?:[iI][sS]|[sS][tT][aA][tT][eE]):(merged|unmerged|pr|draft)(?=\s|$)/g
/** `is:issue` (or `state:`): the Issues grammar's, which lists issues; on this list it is not applied. */
const ISSUE_TOKEN = /(^|\s)((?:is|state):issue)(?=\s|$)/gi
/** Whether `text` sets a state the Issues grammar knows (its key in any case, its value exactly, as it parses them). */
function setsIssueState(text: string): boolean {
  return [...text.matchAll(/(?:^|\s)(?:is|state):(\S+)/gi)].some((m) => m[1] === 'open' || m[1] === 'closed' || m[1] === 'all')
}
/** `mentions:` — an Issues filter, not a PR one. */
const MENTIONS_TOKEN = /(^|\s)(mentions:\S*)/gi
/** `draft:` and `review-requested:`, the PR-only qualifiers with a value. */
const PR_VALUE_TOKEN = /(^|\s)((draft|review-requested):("[^"]*"|\S*))/gi

interface PullOnly {
  readonly rest: string
  /** `is:merged` or `is:unmerged`, whichever came last; null for neither. */
  readonly merged: 'merged' | 'unmerged' | null
  readonly draft: boolean | null
  readonly reviewRequested: string | null
  /** PR-only tokens whose value could not be used, and `mentions:` (an Issues filter). */
  readonly unresolved: readonly string[]
}

/** Lift the PR-only qualifiers out of `text`; what is left is Issues grammar. */
function liftPullOnly(text: string): PullOnly {
  let merged: 'merged' | 'unmerged' | null = null
  let draft: boolean | null = null
  let reviewRequested: string | null = null
  const unresolved: string[] = []
  const rest = text
    .replace(PR_STATE_TOKEN, (_m, lead: string, value: string) => {
      if (value === 'merged' || value === 'unmerged') merged = value
      if (value === 'draft') draft = true
      return lead
    })
    .replace(ISSUE_TOKEN, (_m, lead: string, token: string) => {
      unresolved.push(token)
      return lead
    })
    .replace(MENTIONS_TOKEN, (_m, lead: string, token: string) => {
      unresolved.push(token)
      return lead
    })
    .replace(PR_VALUE_TOKEN, (_m, lead: string, token: string, key: string, raw: string) => {
      const value = raw.replace(/"/g, '')
      if (key.toLowerCase() === 'draft') {
        const flag = value.toLowerCase()
        if (flag === 'true' || flag === 'false') draft = flag === 'true'
        else unresolved.push(token)
      } else {
        const who = personValue(value)
        if (who !== null) reviewRequested = who
        else unresolved.push(token)
      }
      return lead
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { rest, merged, draft, reviewRequested, unresolved }
}

/** Lift the search box's qualifiers into `base` (the inverse of {@link pullSearchText}). */
export function parsePullSearch(text: string, base: PullListQuery = DEFAULT_PULL_QUERY): PullListQuery {
  const only = liftPullOnly(text)
  const parsed = parseSearchText(only.rest, toIssue(base))
  let state: PullStateFilter = base.state
  if (only.merged !== null) state = only.merged
  else if (setsIssueState(only.rest)) state = parsed.state
  return toPull(parsed, state, { draft: only.draft ?? base.draft, reviewRequested: only.reviewRequested ?? base.reviewRequested })
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
  const isState = (t: string): boolean => /^(is|state):/i.test(t) && !isIssue(t)
  const isMentions = (t: string): boolean => /^mentions:/i.test(t)
  const isDraft = (t: string): boolean => /^draft:/i.test(t)
  const isRequested = (t: string): boolean => /^review-requested:/i.test(t)
  const lost = new Set(notFound.map((n) => n.toLowerCase()))
  const requested = dropped.filter(isRequested).map((t) => t.slice(t.indexOf(':') + 1).replace(/"/g, '').replace(/^@/, ''))
  return [
    droppedQualifiersReason(dropped.filter((t) => !isIssue(t) && !isState(t) && !isMentions(t) && !isDraft(t) && !isRequested(t)), notFound),
    dropped.some(isIssue) ? 'is:issue is not a filter here — open the Issues tab to search issues.' : '',
    dropped.some(isState) ? 'is: and state: take open, closed, merged, unmerged, draft or all.' : '',
    dropped.some(isMentions) ? 'mentions: is an Issues filter.' : '',
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
  const base = { ...toPull(issue, state), q }
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

/** The empty PR list's line: never "open the first one" while some are merged or closed. */
export function emptyPullsBody(filtered: boolean, state: PullStateFilter, settled: number | null): string {
  if (filtered) return 'Try fewer filters.'
  if (state === 'merged') return 'Nothing has been merged yet.'
  if (state === 'closed') return 'Nothing has been closed without merging.'
  if (state === 'unmerged') return 'Every pull request here has been merged.'
  const open = 'Push a branch with the git-remote-dash helper (to this repo, or to your fork), then open a PR here or with dg pr create.'
  if (state === 'all' || settled === 0) return open
  if (settled === null) return 'No pull request is open right now.'
  return `No pull request is open right now; ${plural(settled, 'pull request')} ${settled === 1 ? 'is' : 'are'} merged or closed.`
}

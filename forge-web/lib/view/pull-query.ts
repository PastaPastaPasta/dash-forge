/**
 * The PR list's query (L-44): the Issues list's URL and search grammar (`./issue-query`), with
 * the PR states. Everything the list shows is in the URL, so a reload or a shared link shows the
 * same list.
 *
 * URL parameters (all optional; a default is never written):
 *   state=open|merged|closed|all (default open; closed = closed without merging)
 *   label, author, assignee, sort, q, page — as on the Issues list
 *
 * The search box takes the same qualifiers as the Issues list, plus `is:merged` (and `is:pr`,
 * which every PR matches). `mentions:` is not a PR filter here, and is reported as not applied.
 */

import {
  DEFAULT_ISSUE_QUERY,
  issueQueryParams,
  parseIssueQuery,
  parseSearchText,
  searchText,
  unresolvedQualifiers,
  type IssueListQuery,
} from './issue-query'
import { plural } from './format'

export type PullStateFilter = 'open' | 'merged' | 'closed' | 'all'

/** The structured PR list query. */
export type PullListQuery = Omit<IssueListQuery, 'state' | 'mentions'> & { readonly state: PullStateFilter }

export const DEFAULT_PULL_QUERY: PullListQuery = toPull(DEFAULT_ISSUE_QUERY, 'open')

/** Rows per displayed page. */
export const PULL_PAGE_SIZE = 25

const STATES: readonly PullStateFilter[] = ['open', 'merged', 'closed', 'all']

function toPull(q: IssueListQuery, state: PullStateFilter): PullListQuery {
  const { mentions: _mentions, state: _state, ...rest } = q
  return { ...rest, state }
}

function toIssue(q: PullListQuery): IssueListQuery {
  return { ...q, state: 'open', mentions: false }
}

/** `is:merged` / `is:pr` (or `state:`), which the Issues grammar does not have. */
const PR_STATE_TOKEN = /(^|\s)(?:is|state):(merged|pr)(?=\s|$)/gi
/** A state the Issues grammar sets. */
const ISSUE_STATE_TOKEN = /(^|\s)(?:is|state):(?:open|closed|all)(?=\s|$)/i
/** `mentions:` — an Issues filter, not a PR one. */
const MENTIONS_TOKEN = /(^|\s)(mentions:\S*)/gi

/** Lift the PR-only qualifiers out of `text`; what is left is Issues grammar. */
function liftPullOnly(text: string): { rest: string; merged: boolean; mentions: string[] } {
  let merged = false
  const mentions: string[] = []
  const rest = text
    .replace(PR_STATE_TOKEN, (_m, lead: string, value: string) => {
      if (value.toLowerCase() === 'merged') merged = true
      return lead
    })
    .replace(MENTIONS_TOKEN, (_m, lead: string, token: string) => {
      mentions.push(token)
      return lead
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { rest, merged, mentions }
}

/** Lift the search box's qualifiers into `base` (the inverse of {@link pullSearchText}). */
export function parsePullSearch(text: string, base: PullListQuery = DEFAULT_PULL_QUERY): PullListQuery {
  const { rest, merged } = liftPullOnly(text)
  const parsed = parseSearchText(rest, toIssue(base))
  const state: PullStateFilter = merged ? 'merged' : ISSUE_STATE_TOKEN.test(rest) ? parsed.state : base.state
  return toPull(parsed, state)
}

/** The qualifiers in `text` that could not be used (for a note under the box). */
export function unresolvedPullQualifiers(text: string): string[] {
  const { rest, mentions } = liftPullOnly(text)
  return [...unresolvedQualifiers(rest), ...mentions]
}

/** Parse the list query from URL search params; anything invalid falls back to its default. */
export function parsePullQuery(params: { get(name: string): string | null; getAll(name: string): string[] }): PullListQuery {
  const raw = params.get('state')
  const state = STATES.includes(raw as PullStateFilter) ? (raw as PullStateFilter) : 'open'
  const q = (params.get('q') ?? '').slice(0, 200)
  // The rest as the Issues list reads it; `q`'s qualifiers (a GitHub link) are lifted below.
  const issue = parseIssueQuery({ get: (n) => (n === 'state' ? null : n === 'q' ? null : params.get(n)), getAll: (n) => params.getAll(n) })
  const base = { ...toPull(issue, state), q }
  return q.includes(':') ? { ...parsePullSearch(q, { ...base, q: '' }), page: issue.page } : base
}

/** The URL params of a query, defaults omitted, in a stable order. */
export function pullQueryParams(q: PullListQuery): [string, string][] {
  return [...(q.state !== 'open' ? [['state', q.state] as [string, string]] : []), ...issueQueryParams(toIssue(q))]
}

/** The query as search-box text, qualifiers first. */
export function pullSearchText(q: PullListQuery): string {
  return searchText(toIssue(q)).replace(/^is:open/, `is:${q.state}`)
}

/** A change to the query; any change but a page move returns to page 1. */
export function withPullQuery(q: PullListQuery, change: Partial<PullListQuery>): PullListQuery {
  const next = { ...q, ...change }
  return 'page' in change ? next : { ...next, page: 1 }
}

/** Whether any filter narrows the list beyond the state tab. */
export function hasPullFilters(q: PullListQuery): boolean {
  return q.labels.length > 0 || q.author !== null || q.assignee !== null || q.q.trim() !== ''
}

/** The empty PR list's line: never "open the first one" while some are merged or closed. */
export function emptyPullsBody(filtered: boolean, state: PullStateFilter, settled: number | null): string {
  if (filtered) return 'Try fewer filters.'
  if (state === 'merged') return 'Nothing has been merged yet.'
  if (state === 'closed') return 'Nothing has been closed without merging.'
  const open = 'Push a branch with the git-remote-dash helper (to this repo, or to your fork), then open a PR here or with dg pr create.'
  if (state === 'all' || settled === 0) return open
  if (settled === null) return 'No pull request is open right now.'
  return `No pull request is open right now; ${plural(settled, 'pull request')} ${settled === 1 ? 'is' : 'are'} merged or closed.`
}

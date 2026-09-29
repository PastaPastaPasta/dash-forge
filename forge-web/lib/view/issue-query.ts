/**
 * The issue list's query: what the URL says to show (`platform-parity-spec.md` §1.2, D-217,
 * D-913), parsed and written back so every filter survives a reload and can be shared.
 *
 * URL parameters (all optional; a default is never written):
 *   state=open|closed|all       (default open)
 *   label=<name>                (repeatable: every one must be on the issue)
 *   author=<identity id|me>
 *   assignee=<identity id|me|none>
 *   mentions=me
 *   sort=newest|oldest|comments (default newest)
 *   q=<text>                    (matches titles; `#12` matches the number)
 *   page=<n>                    (1-based, default 1)
 *
 * The search box also takes GitHub's qualifiers (`is:closed label:bug author:@me
 * assignee:@me no:assignee mentions:@me sort:comments-desc`), which {@link parseSearchText}
 * lifts into the structured query; what is left is the free text.
 */

import { plural } from './format'
import { isIdentityId } from '../utils'

export type IssueStateFilter = 'open' | 'closed' | 'all'
export type IssueSort = 'newest' | 'oldest' | 'comments'

/** The structured list query. `author` / `assignee` hold an identity id, `me`, or (assignee) `none`. */
export interface IssueListQuery {
  readonly state: IssueStateFilter
  readonly labels: readonly string[]
  readonly author: string | null
  readonly assignee: string | null
  readonly mentions: boolean
  readonly sort: IssueSort
  readonly q: string
  readonly page: number
}

export const DEFAULT_ISSUE_QUERY: IssueListQuery = {
  state: 'open',
  labels: [],
  author: null,
  assignee: null,
  mentions: false,
  sort: 'newest',
  q: '',
  page: 1,
}

/** Rows per displayed page. */
export const ISSUE_PAGE_SIZE = 50

const STATES: readonly IssueStateFilter[] = ['open', 'closed', 'all']
const SORTS: readonly IssueSort[] = ['newest', 'oldest', 'comments']
/** A label is 1-30 characters (the `label.name` schema); a longer value cannot match one. */
const LABEL_MAX = 30

/** The bytes an issue, PR or comment `body` may hold (the contract's `maxBytes`). */
export const BODY_MAX = 5120

/** `s`'s length in UTF-8 bytes (what the contract's `maxBytes` counts). */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

function identityParam(v: string | null, extra: readonly string[]): string | null {
  if (v === null) return null
  const t = v.trim()
  if (extra.includes(t) || isIdentityId(t)) return t
  return null
}

/** Parse the list query from URL search params; anything invalid falls back to its default. */
export function parseIssueQuery(params: { get(name: string): string | null; getAll(name: string): string[] }): IssueListQuery {
  const state = params.get('state')
  const sort = params.get('sort')
  const page = Number.parseInt(params.get('page') ?? '', 10)
  const labels = [...new Set(params.getAll('label').map((l) => l.trim()).filter((l) => l !== '' && [...l].length <= LABEL_MAX))]
  const parsed: IssueListQuery = {
    state: STATES.includes(state as IssueStateFilter) ? (state as IssueStateFilter) : 'open',
    labels,
    author: identityParam(params.get('author'), ['me']),
    assignee: identityParam(params.get('assignee'), ['me', 'none']),
    mentions: params.get('mentions') === 'me',
    sort: SORTS.includes(sort as IssueSort) ? (sort as IssueSort) : 'newest',
    q: (params.get('q') ?? '').slice(0, 200),
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  }
  // A GitHub link carries its qualifiers inside `q` (`/issues?q=is:closed+label:bug`): lift
  // them out. The app writes only free text to `q`, so this leaves its own URLs as they are.
  return parsed.q.includes(':') ? { ...parseSearchText(parsed.q, parsed), page: parsed.page } : parsed
}

/** The URL params of a query, defaults omitted, in a stable order (so equal queries share a URL). */
export function issueQueryParams(q: IssueListQuery): [string, string][] {
  const out: [string, string][] = []
  if (q.state !== 'open') out.push(['state', q.state])
  for (const l of q.labels) out.push(['label', l])
  if (q.author) out.push(['author', q.author])
  if (q.assignee) out.push(['assignee', q.assignee])
  if (q.mentions) out.push(['mentions', 'me'])
  if (q.sort !== 'newest') out.push(['sort', q.sort])
  if (q.q.trim() !== '') out.push(['q', q.q.trim()])
  if (q.page > 1) out.push(['page', String(q.page)])
  return out
}

/** A change to the query; any change but a page move returns to page 1. */
export function withQuery(q: IssueListQuery, change: Partial<IssueListQuery>): IssueListQuery {
  const next = { ...q, ...change }
  return 'page' in change ? next : { ...next, page: 1 }
}

/** Whether any filter narrows the list beyond the state tab. */
export function hasFilters(q: IssueListQuery): boolean {
  return q.labels.length > 0 || q.author !== null || q.assignee !== null || q.mentions || q.q.trim() !== ''
}

/**
 * The empty issue list's line. "Open the first issue" only when the repo has none at all: when
 * the open list is empty but issues were closed (or the closed count is unknown), it says so
 * rather than inviting the first issue (L-37).
 */
export function emptyIssuesBody(filtered: boolean, state: IssueStateFilter, closedCount: number | null): string {
  if (filtered) return 'Try fewer filters.'
  if (state === 'closed') return 'Nothing has been closed yet.'
  if (state === 'all' || closedCount === 0) return 'Everything is quiet. Open the first issue to start the conversation.'
  if (closedCount === null) return 'No issue is open right now.'
  return `No issue is open right now; ${plural(closedCount, 'issue')} ${closedCount === 1 ? 'is' : 'are'} closed.`
}

/** Split `text` into tokens, keeping `"quoted phrases"` (and `label:"two words"`) whole. */
function tokens(text: string): string[] {
  const out: string[] = []
  const re = /(\S*?"[^"]*"\S*|\S+)/g
  for (const m of text.matchAll(re)) out.push(m[0])
  return out
}

const unquote = (s: string): string => s.replace(/"/g, '')

/** A qualifier this parser knows: a known key whose value is (or is not) one it can use. */
const KNOWN_KEYS = new Set(['is', 'state', 'label', 'author', 'assignee', 'no', 'mentions', 'sort'])

/**
 * Lift GitHub-style qualifiers out of search-box text into `base` (the rest of the query is
 * kept): `is:open|closed`, `state:…`, `label:x` (repeatable, quotes for spaces), `author:x`,
 * `assignee:x`, `no:assignee`, `mentions:@me`, `sort:created-desc|created-asc|comments-desc`.
 * `@me` means the viewer. A qualifier with a known key overrides `base` only when its value
 * resolves; one that does not (`author:` and `assignee:` only take an identity id, `@me`, or a
 * value already rewritten to an id by {@link withResolvedNames} — a DPNS name this function is
 * handed as-is does not resolve here) is dropped from the free text and reported by
 * {@link unresolvedQualifiers}. An unknown key stays free text.
 */
export function parseSearchText(text: string, base: IssueListQuery = DEFAULT_ISSUE_QUERY): IssueListQuery {
  return liftQualifiers(text, base).query
}

/** The known qualifiers in `text` whose values could not be used (for a note under the box). */
export function unresolvedQualifiers(text: string): string[] {
  return liftQualifiers(text, DEFAULT_ISSUE_QUERY).unresolved
}

/**
 * The `author:`/`assignee:` values in `text` that are not an id, `@me`/`me` or `none` — every
 * other qualifier value is a literal (a label, a sort spelling, …), never a name to resolve.
 * Each is a DPNS-name candidate for {@link withResolvedNames} (L-43: `author:` previously only
 * accepted a base58 id or `@me`, so a typed or linked DPNS name like
 * `author:unofficial-dashpay-dash-mirror.dash` silently matched nothing).
 */
export function dpnsAuthorCandidates(text: string): string[] {
  const out = new Set<string>()
  for (const tok of tokens(text)) {
    const value = personQualifier(tok)?.value
    if (value === undefined || value === '' || value === 'me' || value === 'none' || isIdentityId(value)) continue
    out.add(value)
  }
  return [...out]
}

/**
 * `text` with every `author:`/`assignee:` value that has an entry in `resolved` (a DPNS name ->
 * id map, from {@link dpnsAuthorCandidates} + a lookup) rewritten to that id; every other token,
 * including an author/assignee value with no entry, is left exactly as typed so
 * {@link unresolvedQualifiers} still reports a name that failed to resolve.
 */
export function withResolvedNames(text: string, resolved: ReadonlyMap<string, string>): string {
  return tokens(text)
    .map((tok) => {
      const person = personQualifier(tok)
      const id = person ? resolved.get(person.value) : undefined
      return person && id ? `${person.key}:${id}` : tok
    })
    .join(' ')
}

/** An `author:`/`assignee:` token's lowercased key and its value (quotes and a leading `@` stripped); null for any other token. */
function personQualifier(tok: string): { key: string; value: string } | null {
  const at = tok.indexOf(':')
  if (at <= 0) return null
  const key = tok.slice(0, at).toLowerCase()
  if (key !== 'author' && key !== 'assignee') return null
  return { key, value: unquote(tok.slice(at + 1)).replace(/^@/, '') }
}

/** Why a known qualifier's value could not be used, by key (see {@link droppedQualifiersReason}). */
const QUALIFIER_REASON: Readonly<Record<string, string>> = {
  is: 'is: and state: take open, closed, all or issue.',
  state: 'is: and state: take open, closed, all or issue.',
  author: 'Authors and assignees take an identity id, a DPNS name, or @me.',
  assignee: 'Authors and assignees take an identity id, a DPNS name, or @me.',
  label: `A label is 1-${LABEL_MAX} characters.`,
  no: 'no: only takes assignee.',
  mentions: 'mentions: only takes @me.',
  sort: 'sort: takes created-desc, created-asc or comments-desc.',
}

/**
 * The reason to show under the search box for `dropped` (as {@link unresolvedQualifiers} returns
 * it), one sentence per distinct cause. `is:pr`/`state:pr` (L-43) is not a filter this list has
 * at all — issues and pull requests are separate lists here — so it gets its own explanation
 * instead of sharing the generic `is:`/`state:` one, which would wrongly suggest `pr` is close to
 * a valid value.
 */
export function droppedQualifiersReason(dropped: readonly string[]): string {
  const reasons = new Set<string>()
  for (const tok of dropped) {
    if (/^(is|state):pr$/i.test(tok)) {
      reasons.add('is:pr is not a filter here — open Pull requests to search pull requests.')
      continue
    }
    const key = tok.slice(0, tok.indexOf(':')).toLowerCase()
    const reason = QUALIFIER_REASON[key]
    if (reason) reasons.add(reason)
  }
  return [...reasons].join(' ')
}

function liftQualifiers(text: string, base: IssueListQuery): { query: IssueListQuery; unresolved: string[] } {
  let state = base.state
  const labels = [...base.labels]
  let author = base.author
  let assignee = base.assignee
  let mentions = base.mentions
  let sort = base.sort
  const free: string[] = []
  const unresolved: string[] = []
  const who = (v: string, extra: readonly string[] = []): string | null => identityParam(v === '@me' ? 'me' : v.replace(/^@/, ''), ['me', ...extra])
  for (const tok of tokens(text)) {
    const at = tok.indexOf(':')
    const key = at > 0 ? tok.slice(0, at).toLowerCase() : ''
    const value = at > 0 ? unquote(tok.slice(at + 1)) : ''
    let used = true
    switch (key) {
      case 'is':
      case 'state':
        if (value === 'open' || value === 'closed' || value === 'all') state = value
        else if (value !== 'issue') used = false
        break
      case 'label':
        if (value !== '' && [...value].length <= LABEL_MAX) {
          if (!labels.includes(value)) labels.push(value)
        } else used = false
        break
      case 'author': {
        const id = who(value)
        if (id !== null) author = id
        else used = false
        break
      }
      case 'assignee': {
        const id = who(value)
        if (id !== null) assignee = id
        else used = false
        break
      }
      case 'no':
        if (value === 'assignee') assignee = 'none'
        else used = false
        break
      case 'mentions':
        if (value === '@me' || value === 'me') mentions = true
        else used = false
        break
      case 'sort':
        if (value === 'created-desc') sort = 'newest'
        else if (value === 'created-asc') sort = 'oldest'
        else if (value === 'comments-desc' || value === 'comments') sort = 'comments'
        else used = false
        break
      default:
        used = false
    }
    if (used) continue
    if (KNOWN_KEYS.has(key)) unresolved.push(tok)
    else free.push(tok)
  }
  return { query: { ...base, state, labels, author, assignee, mentions, sort, q: free.join(' '), page: 1 }, unresolved }
}

/** The query as search-box text, qualifiers first (the inverse of {@link parseSearchText}). */
export function searchText(q: IssueListQuery): string {
  const parts: string[] = [`is:${q.state}`]
  for (const l of q.labels) parts.push(/\s/.test(l) ? `label:"${l}"` : `label:${l}`)
  if (q.author) parts.push(`author:${q.author === 'me' ? '@me' : q.author}`)
  if (q.assignee === 'none') parts.push('no:assignee')
  else if (q.assignee) parts.push(`assignee:${q.assignee === 'me' ? '@me' : q.assignee}`)
  if (q.mentions) parts.push('mentions:@me')
  if (q.sort === 'oldest') parts.push('sort:created-asc')
  if (q.sort === 'comments') parts.push('sort:comments-desc')
  if (q.q.trim() !== '') parts.push(q.q.trim())
  return parts.join(' ')
}

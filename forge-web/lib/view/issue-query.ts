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
/** A base58 identity id (32 bytes: 42-44 characters). */
const IDENTITY = /^[1-9A-HJ-NP-Za-km-z]{42,44}$/

/** Whether `s` is shaped like a base58 identity id. */
export function isIdentityId(s: string): boolean {
  return IDENTITY.test(s)
}

/** The bytes an issue, PR or comment `body` may hold (the contract's `maxBytes`). */
export const BODY_MAX = 5120

/** `s`'s length in UTF-8 bytes (what the contract's `maxBytes` counts). */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

function identityParam(v: string | null, extra: readonly string[]): string | null {
  if (v === null) return null
  const t = v.trim()
  if (extra.includes(t) || IDENTITY.test(t)) return t
  return null
}

/** Parse the list query from URL search params; anything invalid falls back to its default. */
export function parseIssueQuery(params: { get(name: string): string | null; getAll(name: string): string[] }): IssueListQuery {
  const state = params.get('state')
  const sort = params.get('sort')
  const page = Number.parseInt(params.get('page') ?? '', 10)
  const labels = [...new Set(params.getAll('label').map((l) => l.trim()).filter((l) => l !== '' && [...l].length <= LABEL_MAX))]
  return {
    state: STATES.includes(state as IssueStateFilter) ? (state as IssueStateFilter) : 'open',
    labels,
    author: identityParam(params.get('author'), ['me']),
    assignee: identityParam(params.get('assignee'), ['me', 'none']),
    mentions: params.get('mentions') === 'me',
    sort: SORTS.includes(sort as IssueSort) ? (sort as IssueSort) : 'newest',
    q: (params.get('q') ?? '').slice(0, 200),
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  }
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

/** Split `text` into tokens, keeping `"quoted phrases"` (and `label:"two words"`) whole. */
function tokens(text: string): string[] {
  const out: string[] = []
  const re = /(\S*?"[^"]*"\S*|\S+)/g
  for (const m of text.matchAll(re)) out.push(m[0])
  return out
}

const unquote = (s: string): string => s.replace(/"/g, '')

/**
 * Lift GitHub-style qualifiers out of search-box text into `base` (the rest of the query is
 * kept): `is:open|closed`, `state:…`, `label:x` (repeatable, quotes for spaces), `author:x`,
 * `assignee:x`, `no:assignee`, `mentions:@me`, `sort:created-desc|created-asc|comments-desc`.
 * `@me` means the viewer. An unknown or malformed qualifier stays in the free text.
 */
export function parseSearchText(text: string, base: IssueListQuery = DEFAULT_ISSUE_QUERY): IssueListQuery {
  let state = base.state
  const labels = [...base.labels]
  let author = base.author
  let assignee = base.assignee
  let mentions = base.mentions
  let sort = base.sort
  const free: string[] = []
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
        if (value !== '' && [...value].length <= LABEL_MAX && !labels.includes(value)) labels.push(value)
        else used = value !== '' && labels.includes(value)
        break
      case 'author':
        author = who(value)
        used = author !== null
        break
      case 'assignee':
        assignee = who(value)
        used = assignee !== null
        break
      case 'no':
        if (value === 'assignee') assignee = 'none'
        else used = false
        break
      case 'mentions':
        mentions = value === '@me' || value === 'me'
        used = mentions
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
    if (!used) free.push(tok)
  }
  return { ...base, state, labels, author, assignee, mentions, sort, q: free.join(' '), page: 1 }
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

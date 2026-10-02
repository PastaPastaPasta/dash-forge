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
 *   q=<text>                    (free text, matched in titles and bodies; `#12` matches the
 *                               number and `"a phrase"` matches as a whole. It also carries the
 *                               qualifiers that have no parameter of their own, as GitHub's
 *                               `?q=` does: `-label:`, `no:label`, `milestone:`,
 *                               `no:milestone`, a mirrored `author:` login, `in:`, `comments:`,
 *                               `reason:`)
 *   page=<n>                    (1-based, default 1)
 *
 * The search box also takes GitHub's qualifiers (`is:closed label:bug -label:wontfix
 * author:@me assignee:@me no:assignee no:label milestone:"v1.0" no:milestone mentions:@me
 * in:title comments:>2 sort:comments-desc`), which {@link parseSearchText} lifts into the
 * structured query; what is left is the free text. A qualifier the list cannot apply is reported
 * under the box ({@link unresolvedQualifiers}), never searched for as text (QW-020).
 */

import type { CloseReason } from '../rules/transition'
import { displayDpnsName, looksLikeDpnsName } from './dpns'
import { plural } from './format'
import { isIdentityId } from '../utils'

export type IssueStateFilter = 'open' | 'closed' | 'all'
export type IssueSort = 'newest' | 'oldest' | 'comments'
/** Where free text is looked for (`in:`): titles and bodies (GitHub's default), or one of them. */
export type TextScope = 'any' | 'title' | 'body'

/**
 * The qualifiers with no URL parameter of their own (they travel in `q` as text, as on GitHub),
 * shared by the Issues and Pull requests lists.
 */
export interface ExtraFilters {
  /** `-label:x`: none of these may be on the row. */
  readonly notLabels: readonly string[]
  /** `no:label`: the row has no label. */
  readonly noLabel: boolean
  /** `milestone:"v1.0"`: the row's milestone title. */
  readonly milestone: string | null
  /** `no:milestone`. */
  readonly noMilestone: boolean
  /**
   * `author:login` for a name that is not an identity: the source forge's login an import
   * recorded (a mirror's `@thephez`), matched only on items a trusted mirror signed (QW-062).
   */
  readonly authorLogin: string | null
  /** `in:title` / `in:body`. */
  readonly scope: TextScope
  /** `comments:>2` and the like, as typed (a value {@link commentRange} reads). */
  readonly comments: string | null
  /**
   * `reason:completed`, `reason:"not planned"`, `reason:duplicate` (QW4-028): closed issues whose
   * current close says so. An Issues filter: the PR list reports it as not applied.
   */
  readonly reason: CloseReason | null
}

/** The structured list query. `author` / `assignee` hold an identity id, `me`, or (assignee) `none`. */
export interface IssueListQuery extends ExtraFilters {
  readonly state: IssueStateFilter
  readonly labels: readonly string[]
  readonly author: string | null
  readonly assignee: string | null
  readonly mentions: boolean
  readonly sort: IssueSort
  readonly q: string
  readonly page: number
}

export const NO_EXTRA_FILTERS: ExtraFilters = {
  notLabels: [],
  noLabel: false,
  milestone: null,
  noMilestone: false,
  authorLogin: null,
  scope: 'any',
  comments: null,
  reason: null,
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
  ...NO_EXTRA_FILTERS,
}

/** Rows per displayed page. */
export const ISSUE_PAGE_SIZE = 50

const STATES: readonly IssueStateFilter[] = ['open', 'closed', 'all']
const SORTS: readonly IssueSort[] = ['newest', 'oldest', 'comments']
/** A label is 1-30 characters (the `label.name` schema); a longer value cannot match one. */
const LABEL_MAX = 30
/** A milestone title is 1-63 characters (the `milestone.title` schema). */
const MILESTONE_MAX = 63
/** A source forge's login (GitHub's shape: letters, digits and inner hyphens, at most 39). */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/**
 * The longest `?q=` read (a crafted link cannot force unbounded parsing or DPNS reads). `q` also
 * carries the qualifiers with no parameter of their own (a 63-character milestone, several
 * `-label:`s, `comments:`, `in:`, a PR's `draft:` and `review-requested:`), so this leaves room
 * for them beside the free text: a cut mid-qualifier would read back as a different filter.
 */
export const Q_MAX = 512

/** The bytes an issue, PR or comment `body` may hold (the contract's `maxBytes`). */
export const BODY_MAX = 5120

/** `s`'s length in UTF-8 bytes (what the contract's `maxBytes` counts). */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

/** `me`/`none` (and any other keyword in `extra`) match case-insensitively; a real id does not. */
function identityParam(v: string | null, extra: readonly string[]): string | null {
  if (v === null) return null
  const t = v.trim()
  const low = t.toLowerCase()
  if (extra.includes(low)) return low
  return isIdentityId(t) ? t : null
}

/** Parse the list query from URL search params; anything invalid falls back to its default. */
export function parseIssueQuery(params: { get(name: string): string | null; getAll(name: string): string[] }): IssueListQuery {
  const state = params.get('state')
  const sort = params.get('sort')
  const page = Number.parseInt(params.get('page') ?? '', 10)
  const labels = [...new Set(params.getAll('label').map((l) => l.trim()).filter((l) => l !== '' && [...l].length <= LABEL_MAX))]
  const parsed: IssueListQuery = {
    ...NO_EXTRA_FILTERS,
    state: STATES.includes(state as IssueStateFilter) ? (state as IssueStateFilter) : 'open',
    labels,
    author: identityParam(params.get('author'), ['me']),
    assignee: identityParam(params.get('assignee'), ['me', 'none']),
    mentions: params.get('mentions') === 'me',
    sort: SORTS.includes(sort as IssueSort) ? (sort as IssueSort) : 'newest',
    q: (params.get('q') ?? '').slice(0, Q_MAX),
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  }
  // A GitHub link carries its qualifiers inside `q` (`/issues?q=is:closed+label:bug`): lift
  // them out. The app writes to `q` only free text and the qualifiers with no parameter of
  // their own ({@link extraQualifiers}), which read back to the same query.
  if (!parsed.q.includes(':')) return parsed
  // `?q=is:issue` with no state lists every state, as GitHub does (QW4-023). The app never writes
  // `is:issue` into `q`, so its own URLs (which omit `state=open`) still read back as Open.
  const base = params.get('state') === null && linkedAllStates(parsed.q, 'issue', STATES) ? { ...parsed, state: 'all' as const } : parsed
  return { ...parseSearchText(parsed.q, base), page: parsed.page }
}

/** The `is:`/`state:` values in `text` (the key in any case, the value as typed). */
function stateValues(text: string): string[] {
  return tokens(text).flatMap((tok) => {
    const key = keyOf(tok)
    return key === 'is' || key === 'state' ? [unquote(tok.slice(tok.indexOf(':') + 1))] : []
  })
}

/** Whether `text` holds a state qualifier with one of `states` (the box's text names a state tab). */
export function namesState(text: string, states: readonly string[] = STATES): boolean {
  return stateValues(text).some((v) => states.includes(v))
}

/**
 * Whether a linked `?q=` (no `state=` beside it) asks for every state: GitHub's `is:issue` /
 * `is:pr` with no state qualifier (QW4-023).
 */
export function linkedAllStates(q: string, type: 'issue' | 'pr', states: readonly string[]): boolean {
  return stateValues(q).includes(type) && !namesState(q, states)
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
  const text = [...extraQualifiers(q), q.q.trim()].filter((t) => t !== '').join(' ')
  if (text !== '') out.push(['q', text])
  if (q.page > 1) out.push(['page', String(q.page)])
  return out
}

/** A change to the query; any change but a page move returns to page 1. */
export function withQuery<Q extends { readonly page: number }>(q: Q, change: Partial<Q>): Q {
  const next = { ...q, ...change }
  return 'page' in change ? next : { ...next, page: 1 }
}

/**
 * The `base` for a plain search-box submit (typed text + Enter, or a fresh submit of the box's
 * current text): at most the state tab survives from the current query — every other filter
 * (label/author/assignee/mentions/sort) is exactly what the submitted text's qualifiers say,
 * because {@link searchText} always writes the *whole* current query back into the box as text
 * when it is not being actively edited. So if the viewer deletes `label:bug` from the box before
 * hitting Enter, that filter must actually go away, not silently survive because `base` still
 * carried it. This is different from the once-per-load resolution of a *linked* `?q=` (a shared
 * URL carries only its own free text, never the other params' filters), which correctly uses the
 * full `query` as `base` to keep `label=`/`sort=`/etc that its own separate URL params set.
 */
export function searchSubmitBase(q: IssueListQuery, text = ''): IssueListQuery {
  return { ...DEFAULT_ISSUE_QUERY, state: submitState(q.state, text, STATES) }
}

/**
 * The state a submit starts from (QW4-023). The box always shows the current state as `is:<state>`
 * ({@link searchText}), so submitted text without any state qualifier had it taken out: as on
 * GitHub, that searches every state rather than staying on the tab and hiding the other state's
 * matches. An empty box keeps the tab (it clears the filters, not the tab).
 */
export function submitState<S extends string>(tab: S, text: string, states: readonly string[]): S | 'all' {
  return text.trim() === '' || namesState(text, states) ? tab : 'all'
}

/** Whether any filter narrows the list beyond the state tab. */
export function hasFilters(q: IssueListQuery): boolean {
  return q.labels.length > 0 || q.author !== null || q.assignee !== null || q.mentions || q.q.trim() !== '' || hasExtraFilters(q)
}

/** Whether any {@link ExtraFilters} narrows the list (`in:` alone does not: it only scopes free text). */
export function hasExtraFilters(q: ExtraFilters): boolean {
  return q.notLabels.length > 0 || q.noLabel || q.milestone !== null || q.noMilestone || q.authorLogin !== null || q.comments !== null || q.reason !== null
}

/** The {@link ExtraFilters} as search-box qualifiers (what `q` carries for them in the URL). */
export function extraQualifiers(q: ExtraFilters): string[] {
  const parts: string[] = []
  for (const l of q.notLabels) parts.push(`-label:${quoted(l)}`)
  if (q.noLabel) parts.push('no:label')
  if (q.milestone !== null) parts.push(`milestone:${quoted(q.milestone)}`)
  if (q.noMilestone) parts.push('no:milestone')
  if (q.authorLogin !== null) parts.push(`author:${q.authorLogin}`)
  if (q.scope !== 'any') parts.push(`in:${q.scope}`)
  if (q.comments !== null) parts.push(`comments:${q.comments}`)
  if (q.reason !== null) parts.push(`reason:${quoted(REASON_WORDS[q.reason])}`)
  return parts
}

/** A close reason as `reason:` spells it (GitHub's `reason:"not planned"`). */
const REASON_WORDS: Readonly<Record<CloseReason, string>> = { completed: 'completed', not_planned: 'not planned', duplicate: 'duplicate' }

/** A `reason:` value (quotes already stripped), in GitHub's spellings and the stored one; null for anything else. */
export function closeReasonValue(v: string): CloseReason | null {
  const low = v.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  if (low === 'completed') return 'completed'
  if (low === 'not planned') return 'not_planned'
  if (low === 'duplicate') return 'duplicate'
  return null
}

/** A qualifier value, quoted when it holds whitespace. */
function quoted(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v
}

/** An inclusive comment-count range, from a `comments:` value. */
export interface CountRange {
  readonly min: number
  readonly max: number
}

/**
 * The range a `comments:` value names (GitHub's forms: `5`, `>2`, `>=2`, `<5`, `<=5`, `1..3`,
 * `2..*`, `*..3`), or null for anything else.
 */
export function commentRange(v: string | null): CountRange | null {
  if (v === null) return null
  const int = (s: string): number => Number.parseInt(s, 10)
  const single = /^(>=|<=|>|<)?(\d{1,9})$/.exec(v)
  if (single) {
    const k = int(single[2] ?? '0')
    switch (single[1]) {
      case '>':
        return { min: k + 1, max: Infinity }
      case '>=':
        return { min: k, max: Infinity }
      case '<':
        return k === 0 ? null : { min: 0, max: k - 1 }
      case '<=':
        return { min: 0, max: k }
      default:
        return { min: k, max: k }
    }
  }
  const range = /^(\d{1,9}|\*)\.\.(\d{1,9}|\*)$/.exec(v)
  if (!range || (range[1] === '*' && range[2] === '*')) return null
  const min = range[1] === '*' ? 0 : int(range[1] ?? '0')
  const max = range[2] === '*' ? Infinity : int(range[2] ?? '0')
  return min <= max ? { min, max } : null
}

/**
 * The empty issue list's line. "Open the first issue" only when the repo has none at all: when
 * the open list is empty but issues were closed (or the closed count is unknown), it says so
 * rather than inviting the first issue (L-37). A search that matches none in its tab says how
 * many match in the other, when that is proved, or that every state can be searched (QW3-051).
 */
export function emptyIssuesBody(filtered: boolean, state: IssueStateFilter, closedCount: number | null, openCount: number | null = null): string {
  if (filtered) {
    const other = state === 'open' ? closedCount : state === 'closed' ? openCount : null
    if (other !== null && other > 0) {
      const there = state === 'open' ? 'closed' : 'open'
      return `None ${state === 'open' ? 'is open' : 'is closed'}; ${plural(other, `${there} issue`)} ${other === 1 ? 'matches' : 'match'}.`
    }
    return state === 'all' ? 'Try fewer filters.' : 'Try fewer filters, or search every state.'
  }
  if (state === 'closed') return 'Nothing has been closed yet.'
  if (state === 'all' || closedCount === 0) return 'Everything is quiet. Open the first issue to start the conversation.'
  if (closedCount === null) return 'No issue is open right now.'
  return `No issue is open right now; ${plural(closedCount, 'issue')} ${closedCount === 1 ? 'is' : 'are'} closed.`
}

/**
 * The last page of a list with `matching` rows, when `page` lies past it (a hand-edited or stale
 * `?page=`, QW-068); null when the page is in range or the total is not known.
 */
export function pastLastPage(page: number, matching: number | null, pageSize: number): number | null {
  if (matching === null || page <= 1) return null
  const last = Math.max(1, Math.ceil(matching / pageSize))
  return page > last ? last : null
}

/** Split `text` into tokens, keeping `"quoted phrases"` (and `label:"two words"`) whole. */
function tokens(text: string): string[] {
  const out: string[] = []
  const re = /(\S*?"[^"]*"\S*|\S+)/g
  for (const m of text.matchAll(re)) out.push(m[0])
  return out
}

const unquote = (s: string): string => s.replace(/"/g, '')

/** The search box's tokens, as every qualifier parser reads them (quoted phrases whole). */
export const searchTokens = tokens

/**
 * The qualifiers this parser applies (the rest of GitHub's are known by name below and
 * reported, never searched for as text). `-label` is the one negation it applies.
 */
const APPLIED_KEYS = new Set(['is', 'state', 'label', '-label', 'author', 'assignee', 'no', 'mentions', 'sort', 'milestone', 'in', 'comments', 'reason'])

/**
 * GitHub's issue and PR search qualifiers this list does not apply (QW-020): a token with one of
 * these keys (or any negated `-key:`) is reported as not applied rather than kept as free text,
 * which could never match and read as "nothing matches".
 */
const OTHER_GITHUB_KEYS = new Set([
  'archived', 'base', 'closed', 'commenter', 'created', 'draft', 'head', 'interactions', 'involves', 'language', 'linked', 'merged',
  'org', 'project', 'reactions', 'repo', 'review', 'review-requested', 'reviewed-by', 'status', 'team',
  'team-review-requested', 'type', 'updated', 'user', 'user-review-requested',
])

/** Whether `key` (lowercased, a leading `-` kept) is a qualifier: applied, or one of GitHub's that is reported. */
function isQualifierKey(key: string): boolean {
  if (APPLIED_KEYS.has(key) || OTHER_GITHUB_KEYS.has(key)) return true
  return key.startsWith('-') && (APPLIED_KEYS.has(key.slice(1)) || OTHER_GITHUB_KEYS.has(key.slice(1)))
}

/**
 * Lift GitHub-style qualifiers out of search-box text into `base` (the rest of the query is
 * kept): `is:open|closed`, `state:…`, `label:x` (repeatable, quotes for spaces), `-label:x`,
 * `author:x`, `assignee:x`, `no:assignee|label|milestone`, `milestone:x`, `mentions:@me`,
 * `in:title|body`, `comments:>n`, `sort:created-desc|created-asc|comments-desc`. `@me` means
 * the viewer. A qualifier with a known key overrides `base` only when its value resolves; one
 * that does not (`author:` and `assignee:` take an identity id, `@me`, or a value already
 * rewritten to an id by {@link withResolvedNames}; `author:` also takes a source forge's login,
 * matched against mirrored items; a DPNS name this function is handed as-is does not resolve
 * here) is dropped from the free text and reported by {@link unresolvedQualifiers}, as is any
 * other GitHub qualifier. An unknown key stays free text.
 */
export function parseSearchText(text: string, base: IssueListQuery = DEFAULT_ISSUE_QUERY): IssueListQuery {
  return liftQualifiers(text, base).query
}

/** The known qualifiers in `text` whose values could not be used (for a note under the box). */
export function unresolvedQualifiers(text: string): string[] {
  return liftQualifiers(text, DEFAULT_ISSUE_QUERY).unresolved
}

/**
 * The `author:`/`assignee:` values in `text` that are not an id, `me`/`none` (either case, with
 * or without a leading `@`) and are shaped like a DPNS label ({@link looksLikeDpnsName}) —
 * anything else is a literal (a label, a sort spelling, …) or could not be a name at all, and is
 * never worth a lookup. Each is a candidate for {@link withResolvedNames} (L-43: `author:`
 * previously only accepted a base58 id or `@me`, so a typed or linked DPNS name like
 * `author:unofficial-dashpay-dash-mirror.dash` silently matched nothing).
 */
export function dpnsAuthorCandidates(text: string): string[] {
  const out = new Set<string>()
  for (const tok of tokens(text)) {
    const value = personQualifier(tok)?.value
    if (value === undefined || value === '') continue
    const low = value.toLowerCase()
    if (low === 'me' || low === 'none' || isIdentityId(value) || !looksLikeDpnsName(value)) continue
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

/**
 * Resolve every DPNS-name candidate in `text` through the injected `resolveId`. It holds no
 * shared state, so overlapping calls (an out-of-order submit) never interfere; the caller decides
 * which result is still wanted. Returns `text` with every found name rewritten to its id, and the
 * candidates that were not found (for a "no such name" note, distinct from a non-candidate).
 */
export async function resolveSearchNames(
  text: string,
  resolveId: (name: string) => Promise<string | null>,
): Promise<{ readonly text: string; readonly notFound: readonly string[] }> {
  const candidates = dpnsAuthorCandidates(text)
  if (candidates.length === 0) return { text, notFound: [] }
  const resolved = new Map<string, string>()
  const notFound: string[] = []
  await Promise.all(
    candidates.map(async (name) => {
      const id = await resolveId(name)
      if (id) resolved.set(name, id)
      else notFound.push(name)
    }),
  )
  return { text: resolved.size > 0 ? withResolvedNames(text, resolved) : text, notFound }
}

/** The qualifiers whose value names a person (an id, `@me`, or a DPNS name to look up first). */
const PERSON_KEYS: ReadonlySet<string> = new Set(['author', 'assignee', 'review-requested'])

/** A person qualifier's lowercased key and its value (quotes and a leading `@` stripped); null for any other token. */
function personQualifier(tok: string): { key: string; value: string } | null {
  const at = tok.indexOf(':')
  if (at <= 0) return null
  const key = tok.slice(0, at).toLowerCase()
  if (!PERSON_KEYS.has(key)) return null
  return { key, value: unquote(tok.slice(at + 1)).replace(/^@/, '') }
}

/** A person qualifier's value as an identity: an id, or `me` (either case, `@` or not); null otherwise. */
export function personValue(v: string): string | null {
  return identityParam(v.replace(/^@/, ''), ['me'])
}

/** Why a known qualifier's value could not be used, by key (see {@link droppedQualifiersReason}). */
const QUALIFIER_REASON: Readonly<Record<string, string>> = {
  is: 'is: and state: take open, closed, all or issue.',
  state: 'is: and state: take open, closed, all or issue.',
  author: 'Authors and assignees take an identity id, a DPNS name, or @me (an author also a mirrored login).',
  assignee: 'Authors and assignees take an identity id, a DPNS name, or @me (an author also a mirrored login).',
  label: `A label is 1-${LABEL_MAX} characters.`,
  '-label': `A label is 1-${LABEL_MAX} characters.`,
  no: 'no: takes label, milestone or assignee.',
  mentions: 'mentions: only takes @me.',
  sort: 'sort: takes created-desc, created-asc or comments-desc.',
  milestone: `milestone: takes a milestone title (1-${MILESTONE_MAX} characters; quote one with spaces).`,
  in: 'in: takes title or body (comment text is not searched from the list).',
  comments: 'comments: takes a count: 3, >2, >=2, <5, <=5 or 1..3.',
  reason: 'reason: takes completed, "not planned" or duplicate.',
  review: "review: is not a list filter: a PR's reviews are read on its page.",
  'reviewed-by': "reviewed-by: is not a list filter: a PR's reviews are read on its page.",
  'review-requested': 'review-requested: and draft: are pull request filters.',
  draft: 'review-requested: and draft: are pull request filters.',
}

/** Why a second state qualifier no item can match together with the first was not applied (QW4-007). */
export const STATE_CONFLICT = 'No item can be in both of those states, so only the first state qualifier is applied.'

/** Whether a dropped `is:`/`state:` token names a valid state: it was dropped as contradicting an earlier one. */
export function isStateConflict(tok: string, states: readonly string[] = STATES): boolean {
  const key = keyOf(tok)
  return (key === 'is' || key === 'state') && states.includes(unquote(tok.slice(tok.indexOf(':') + 1)))
}

/** The key of a qualifier token, lowercased, a leading `-` kept (`''` for a token that is not one). */
function keyOf(tok: string): string {
  const at = tok.indexOf(':')
  return at > 0 ? tok.slice(0, at).toLowerCase() : ''
}

/**
 * The reason to show under the search box for `dropped` (as {@link unresolvedQualifiers} returns
 * it), one sentence per distinct cause. `is:pr`/`state:pr` (L-43) is not a filter this list has
 * at all — issues and pull requests are separate lists here — so it gets its own explanation
 * instead of sharing the generic `is:`/`state:` one, which would wrongly suggest `pr` is close to
 * a valid value. An `author:`/`assignee:` value in `notFound` (a {@link resolveSearchNames}
 * candidate DPNS actually looked up and could not find) names the specific name that was not
 * found, rather than the generic "take an id, a name, or @me" reason, which would wrongly
 * suggest the value's shape (not its non-existence) was the problem. A GitHub qualifier the list
 * does not apply at all says so by name.
 */
export function droppedQualifiersReason(dropped: readonly string[], notFound: readonly string[] = []): string {
  const notFoundLower = new Set(notFound.map((n) => n.toLowerCase()))
  const reasons = new Set<string>()
  const unsupported = new Set<string>()
  for (const tok of dropped) {
    if (/^(is|state):pr$/i.test(tok)) {
      reasons.add('is:pr is not a filter here — open the Pull requests tab to search pull requests.')
      continue
    }
    if (isStateConflict(tok)) {
      reasons.add(STATE_CONFLICT)
      continue
    }
    const person = personQualifier(tok)
    if (person && notFoundLower.has(person.value.toLowerCase())) {
      reasons.add(`No DPNS name \`${displayDpnsName(person.value)}\` was found.`)
      continue
    }
    const key = keyOf(tok)
    const reason = QUALIFIER_REASON[key]
    if (reason) reasons.add(reason)
    else if (key.startsWith('-')) reasons.add('Only -label: can be negated here.')
    else unsupported.add(`${key}:`)
  }
  if (unsupported.size > 0) reasons.add(`${[...unsupported].join(', ')} ${unsupported.size === 1 ? 'is not a filter' : 'are not filters'} here.`)
  return [...reasons].join(' ')
}

/** The states an issue state qualifier admits, to intersect several of them (GitHub ANDs qualifiers, QW4-007). */
const ISSUE_STATE_SETS: Readonly<Record<IssueStateFilter, readonly ('open' | 'closed')[]>> = { open: ['open'], closed: ['closed'], all: ['open', 'closed'] }

function liftQualifiers(text: string, base: IssueListQuery): { query: IssueListQuery; unresolved: string[] } {
  let state = base.state
  // The states every state qualifier so far admits (null: none seen yet): a later one narrows them,
  // and one that admits none of them (`is:open is:closed`) is reported rather than silently winning.
  let admitted: readonly ('open' | 'closed')[] | null = null
  const labels = [...base.labels]
  const notLabels = [...base.notLabels]
  let { author, assignee, mentions, sort, noLabel, milestone, noMilestone, authorLogin, scope, comments, reason } = base
  const free: string[] = []
  const unresolved: string[] = []
  // identityParam already matches 'me'/'none' case-insensitively, so stripping a leading `@`
  // (never mind its case) is all this needs — `@me`, `@ME`, `me` and `ME` all land on 'me'.
  const who = (v: string, extra: readonly string[] = []): string | null => identityParam(v.replace(/^@/, ''), ['me', ...extra])
  const labelOk = (v: string): boolean => v !== '' && [...v].length <= LABEL_MAX
  for (const tok of tokens(text)) {
    const at = tok.indexOf(':')
    const key = keyOf(tok)
    const value = at > 0 ? unquote(tok.slice(at + 1)) : ''
    let used = true
    switch (key) {
      case 'is':
      case 'state':
        if (value === 'open' || value === 'closed' || value === 'all') {
          const next: readonly ('open' | 'closed')[] = admitted === null ? ISSUE_STATE_SETS[value] : admitted.filter((s) => ISSUE_STATE_SETS[value].includes(s))
          if (next.length === 0) used = false
          else {
            admitted = next
            state = next.length === 2 ? 'all' : next[0]!
          }
        } else if (value !== 'issue') used = false
        break
      case 'label':
        if (labelOk(value)) {
          if (!labels.includes(value)) labels.push(value)
        } else used = false
        break
      case '-label':
        if (labelOk(value)) {
          if (!notLabels.includes(value)) notLabels.push(value)
        } else used = false
        break
      case 'author': {
        const id = who(value)
        const login = value.replace(/^@/, '')
        if (id !== null) {
          author = id
          authorLogin = null
        } else if (LOGIN.test(login)) {
          // Not an identity (a DPNS name DPNS knows was rewritten to its id before this): the
          // login an import recorded, as the mirror shows it (`@thephez on github.com`).
          authorLogin = login
          author = null
        } else used = false
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
        else if (value === 'label') noLabel = true
        else if (value === 'milestone') noMilestone = true
        else used = false
        break
      case 'milestone':
        if (value !== '' && [...value].length <= MILESTONE_MAX) milestone = value
        else used = false
        break
      case 'mentions':
        if (value === '@me' || value === 'me') mentions = true
        else used = false
        break
      case 'in': {
        // `in:title,body` is both (the default), as on GitHub.
        const parts = new Set(value.toLowerCase().split(','))
        if ([...parts].some((p) => p !== 'title' && p !== 'body')) used = false
        else scope = parts.size === 2 ? 'any' : parts.has('title') ? 'title' : 'body'
        break
      }
      case 'comments':
        if (commentRange(value) !== null) comments = value
        else used = false
        break
      case 'reason': {
        const r = closeReasonValue(value)
        if (r !== null) reason = r
        else used = false
        break
      }
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
    // A GitHub key with nothing after its colon (`status: broken`, `type: error`) is prose, not a
    // qualifier: it stays free text, as it does on GitHub. An applied key's empty value is reported.
    // `reason:` was prose before it was a filter (`reason: timeout`), and stays so with no value.
    if (isQualifierKey(key) && (value !== '' || (APPLIED_KEYS.has(key) && key !== 'reason'))) unresolved.push(tok)
    else free.push(tok)
  }
  return {
    query: { ...base, state, labels, notLabels, author, assignee, mentions, sort, noLabel, milestone, noMilestone, authorLogin, scope, comments, reason, q: free.join(' '), page: 1 },
    unresolved,
  }
}

/** The query as search-box text, qualifiers first (the inverse of {@link parseSearchText}). */
export function searchText(q: IssueListQuery): string {
  const parts: string[] = [`is:${q.state}`]
  for (const l of q.labels) parts.push(`label:${quoted(l)}`)
  if (q.author) parts.push(`author:${q.author === 'me' ? '@me' : q.author}`)
  if (q.assignee === 'none') parts.push('no:assignee')
  else if (q.assignee) parts.push(`assignee:${q.assignee === 'me' ? '@me' : q.assignee}`)
  if (q.mentions) parts.push('mentions:@me')
  parts.push(...extraQualifiers(q))
  if (q.sort === 'oldest') parts.push('sort:created-asc')
  if (q.sort === 'comments') parts.push('sort:comments-desc')
  if (q.q.trim() !== '') parts.push(q.q.trim())
  return parts.join(' ')
}

/** One free-text search term: a word or a phrase, and whether a row must not hold it. */
export interface SearchTerm {
  readonly text: string
  /** `-word` or `-"a phrase"` (QW3-018); a `-` inside quotes (`"-x"`) is literal. */
  readonly not: boolean
}

/**
 * The free text's search terms (QW-021): a `"quoted phrase"` is one term, spaces and all, and
 * any other word is one term; lowercased, quotes never part of a term. A leading `-` outside
 * quotes negates the term (QW3-018); a lone `-` is a word.
 */
export function searchTerms(text: string): SearchTerm[] {
  const out: SearchTerm[] = []
  for (const m of text.toLowerCase().matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
    if (m[2] !== undefined) {
      const phrase = m[2].trim()
      if (phrase !== '') out.push({ text: phrase, not: m[1] === '-' })
      continue
    }
    const word = (m[3] ?? '').replace(/"/g, '').trim()
    if (word === '') continue
    const not = word.length > 1 && word.startsWith('-')
    out.push({ text: not ? word.slice(1) : word, not })
  }
  return out
}

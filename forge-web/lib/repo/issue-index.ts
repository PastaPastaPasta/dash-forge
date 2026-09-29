/**
 * The issue index: what the Issues tab lists, filters, sorts and counts, read with composite
 * queries and keyset paging (`platform-parity-spec.md` §1.2, §3.3; D-217, D-904, SR-03).
 *
 * Reads, per repo, cached for the session and dropped by any write ({@link invalidateRepoFeed}):
 *
 * 1. **One composite** (the first request): the newest 100 issues, their comment counts
 *    (`comment.target` count tree), their authors' DPNS names, and as siblings under the same
 *    proof the first 100 rows of the repo feed (`event`, `authorEvent`) and of the label
 *    definitions. A small repo is fully read by it.
 * 2. **The rest of the feed**, only when a sibling page was full (`queryAllDocuments`
 *    continuing from that page). The feed decides every row's state, labels and assignees
 *    (`foldIssueStateV2`), so it is read to completion.
 * 3. **More issues on demand**: a keyset composite per 100 (`$createdAt <=` the oldest loaded,
 *    newest first; `>=` the newest loaded for the oldest-first sort), and `$id in` composites
 *    for issues the feed names but no loaded chunk holds (a closed or labelled issue past the
 *    loaded pages).
 *
 * Counts: the repo's issue total is the countable `issue.number` index (the header already
 * reads it); what is closed is a fold over the complete feed. So Open / Closed are exact
 * without reading every issue: closed = the feed's closed targets that are issues, open =
 * total − closed − hidden. (A target's type is not in the event, so each closed target is
 * resolved once, by `$id in` on `issue`; a patch id finds nothing and is remembered as such.)
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, NETWORKS, type Network } from '../constants'
import { compositeOf, countsAt, docsAt, queryComposite, siblingOf, type CompositeSub } from '../sdk/composite'
import { IncompleteReadError, queryAllDocuments, type DocumentQuery, type PlainDocument } from '../sdk'
import { DOC, asIdentifierString, repoKey, str, type RepoRef } from './contract'
import {
  groupFeed,
  issueViewOf,
  onRepoInvalidated,
  seedRepoFeed,
  settleIssueCount,
  toLog,
  type IssueView,
  type TargetLog,
} from './issues'
import { newestLabels, type LabelDef } from './labels'
import { pinnedTargets } from '../rules/parity'
import { HiddenTally, gateFor, type ContentGate, type HiddenCounts } from './private-content'
import { onPrivateSessionEnded } from './private-session'
import { repoSource } from './source'

/** An issue row: the folded issue and its comment count (null: not counted). */
export interface IssueRow extends IssueView {
  readonly comments: number | null
}

/** Issues per keyset chunk (the page limit of one composite). */
const CHUNK = 100
/** Pages of each feed type read before the fold is declared incomplete. */
const FEED_MAX_PAGES = 30
/** Chunks one call may read to satisfy a query (a sort by comments reads every chunk up to this). */
const MAX_CHUNKS = 30

const EMPTY_LOG: TargetLog = { events: [], authorEvents: [] }

/** One keyset walk over the repo's issues, in one direction. */
interface Walk {
  /** Loaded ids, in walk order. */
  readonly ids: string[]
  /** The `$createdAt` bound of the next chunk (`<=` newest-first, `>=` oldest-first). */
  bound: number | null
  done: boolean
  /** False when the walk stopped on a timestamp shared by 100+ issues (it did not reach the end). */
  complete: boolean
}

/** A repo's issue index (mutable while it loads; readers use {@link IssueIndexView}). */
interface IndexState {
  readonly repo: RepoRef
  readonly network: Network
  /** Every target's log; null when the feed is too large to read completely. */
  feed: Map<string, TargetLog> | null
  labels: LabelDef[]
  /** The label read was complete (short page). */
  labelsComplete: boolean
  readonly rows: Map<string, IssueRow>
  /** Ids proven not to be (well-formed, shown) issues of this repo: patches, malformed, hidden. */
  readonly notIssues: Set<string>
  /** Issues left out: not well-formed for the repo, or (private) not readable with the session keys. */
  readonly hidden: HiddenTally
  readonly desc: Walk
  readonly asc: Walk
  /**
   * Every index read (keyset chunks, `$id in` resolutions, author reads) runs one at a time on
   * this queue: concurrent readers of one bound would otherwise see "nothing new" and end a walk
   * early, and an id admitted by two reads at once would be listed twice.
   */
  queue: Promise<void>
  /** Every issue of the repo is loaded (a walk from the newest or oldest reached the end). */
  all: boolean
  /** Issues per author, once read from the `author` index. */
  readonly byAuthor: Map<string, Set<string>>
  /** The repo's content gate: well-formedness, and for a private repo decryption with the session keys. */
  readonly gate: ContentGate
}

const indexes = new Map<string, Promise<IndexState>>()
/** Per network, repo and (private) reader session: a private index holds decrypted titles and bodies. */
const indexKey = (repo: RepoRef, network: Network): string => `${network}:${repo.forge.collab}:${repoKey(repo)}`

onRepoInvalidated((repo) => {
  const at = `:${repo.forge.collab}:${repo.repoId}`
  for (const key of [...indexes.keys()]) if (key.endsWith(at) || key.includes(`${at}#`)) indexes.delete(key)
})
onPrivateSessionEnded((id) => {
  for (const key of [...indexes.keys()]) if (key.endsWith(`#${id}`)) indexes.delete(key)
})

function sortRowsNewest(a: IssueRow, b: IssueRow): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)
}

/** The sub-queries every issue chunk carries: comment counts and the authors' DPNS names. */
function chunkSubs(network: Network): CompositeSub[] {
  return [
    { documentType: DOC.comment, kind: 'counts', bind: { sourceProperty: '$id', field: 'targetId' } },
    {
      dataContractId: NETWORKS[network].dpnsContractId,
      documentType: 'domain',
      bind: { sourceProperty: '$ownerId', field: 'records.identity' },
      limit: 100,
    },
  ]
}

/** Record a chunk's issue documents (and what its sub-queries said about them). */
async function addDocs(state: IndexState, docs: readonly PlainDocument[], counts: ReadonlyMap<string, number> | null, walk: Walk | null): Promise<void> {
  for (const raw of docs) {
    const id = str(raw, '$id')
    if (id === '' || state.rows.has(id) || state.notIssues.has(id)) {
      if (walk !== null && state.rows.has(id) && !walk.ids.includes(id)) walk.ids.push(id)
      continue
    }
    const admitted = await state.gate.admit('issue', raw)
    if (!admitted.ok) {
      state.notIssues.add(id)
      state.hidden.add(admitted.reason)
      continue
    }
    const view = issueViewOf(admitted.doc, state.feed?.get(id) ?? EMPTY_LOG)
    state.rows.set(id, {
      ...view,
      stateComplete: state.feed !== null,
      comments: counts === null ? null : counts.get(id) ?? 0,
    })
    walk?.ids.push(id)
  }
}

/** Seed the DPNS cache with a composite's bound name lookup (a proven absence is recorded too). */
async function seedNames(network: Network, docs: readonly PlainDocument[], domains: readonly PlainDocument[] | undefined): Promise<void> {
  if (domains === undefined) return
  const { seedFromDomains } = await import('../view/dpns')
  seedFromDomains(network, docs.map((d) => str(d, '$ownerId')), domains)
}

/**
 * Read one chunk of issues (`page`, up to `limit`) with their comment counts and authors'
 * names, and record it: keyset chunks record into `walk`; `keep` filters rows (the `$id in`
 * read keeps only this repo's). Returns the chunk's documents.
 */
async function readChunk(
  sdk: EvoSDK,
  state: IndexState,
  page: DocumentQuery,
  limit: number,
  { walk = null, keep }: { walk?: Walk | null; keep?: (d: PlainDocument) => boolean } = {},
): Promise<PlainDocument[]> {
  const res = await queryComposite(sdk, compositeOf(page, limit, chunkSubs(state.network)))
  const docs = keep ? res.page.filter(keep) : res.page
  if (walk === null) await addDocs(state, docs, countsAt(res, 0), null)
  else await addChunk(state, walk, docs, countsAt(res, 0))
  await seedNames(state.network, docs, docsAt(res, 1))
  return docs
}

/** Read the rest of a sibling-started query, when its first page was full. */
async function rest(sdk: EvoSDK, query: Parameters<typeof queryAllDocuments>[1], first: PlainDocument[], maxPages: number): Promise<PlainDocument[]> {
  if (first.length < CHUNK) return first
  return queryAllDocuments(sdk, query, { firstPage: first, maxPages })
}

/** First load: one composite, then the rest of the feed and labels when their pages were full. */
async function loadIndex(sdk: EvoSDK, repo: RepoRef, network: Network): Promise<IndexState> {
  const source = repoSource(repo)
  const feedQuery = (type: string) => source.repoQuery(type, { orderBy: [['$createdAt', 'asc']] })
  const labelQuery = source.repoQuery(DOC.label, { orderBy: [['name', 'asc'], ['$createdAt', 'asc']] })
  const page = source.repoQuery(DOC.issue, { orderBy: [['$createdAt', 'desc']] })
  const res = await queryComposite(
    sdk,
    compositeOf(page, CHUNK, [...chunkSubs(network), siblingOf(feedQuery(DOC.event), CHUNK), siblingOf(feedQuery(DOC.authorEvent), CHUNK), siblingOf(labelQuery, CHUNK)]),
  )

  let feed: Map<string, TargetLog> | null
  try {
    const [allEvents, allAuthorEvents] = await Promise.all([
      rest(sdk, feedQuery(DOC.event), docsAt(res, 2), FEED_MAX_PAGES),
      rest(sdk, feedQuery(DOC.authorEvent), docsAt(res, 3), FEED_MAX_PAGES),
    ])
    // A private repo's member events are read through `readableEvents` (values opened).
    const log = await toLog(repo, allEvents, allAuthorEvents)
    feed = groupFeed(log.events, log.authorEvents)
    // The pulls page and the header's PR count fold from the same feed.
    seedRepoFeed(repo, feed)
  } catch (e) {
    if (!(e instanceof IncompleteReadError)) throw e
    feed = null
  }
  let labelDocs = docsAt(res, 4)
  let labelsComplete = true
  try {
    labelDocs = await rest(sdk, labelQuery, labelDocs, 10)
  } catch (e) {
    if (!(e instanceof IncompleteReadError)) throw e
    labelsComplete = false
  }

  const state: IndexState = {
    repo,
    network,
    feed,
    labels: newestLabels(labelDocs),
    labelsComplete,
    rows: new Map(),
    notIssues: new Set(),
    hidden: new HiddenTally(),
    desc: { ids: [], bound: null, done: false, complete: true },
    asc: { ids: [], bound: null, done: false, complete: true },
    byAuthor: new Map(),
    queue: Promise.resolve(),
    all: false,
    gate: gateFor(repo),
  }
  await addChunk(state, state.desc, res.page, countsAt(res, 0))
  await seedNames(network, res.page, docsAt(res, 1))
  return state
}

/** Record one keyset chunk and move its walk's bound. */
async function addChunk(state: IndexState, walk: Walk, docs: readonly PlainDocument[], counts: ReadonlyMap<string, number> | null): Promise<void> {
  const before = walk.ids.length
  await addDocs(state, docs, counts, walk)
  if (docs.length < CHUNK) {
    walk.done = true
  } else {
    const last = docs[docs.length - 1]?.['$createdAt']
    // A full chunk that added nothing new sits on one timestamp shared by 100+ issues:
    // stop rather than loop (the walk is then incomplete, and says so).
    if (typeof last !== 'number' || (walk.ids.length === before && walk.bound === last)) {
      walk.done = true
      walk.complete = false
    }
    walk.bound = typeof last === 'number' ? last : walk.bound
  }
  // A walk from the start that reached the end has read every issue.
  if (walk.done && walk.complete) state.all = true
}

/** Run `task` on the index's read queue ({@link IndexState.queue}). */
function serial<T>(state: IndexState, task: () => Promise<T>): Promise<T> {
  const run = state.queue.then(task)
  state.queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Read the next keyset chunk of `walk` (`<=` / `>=` its bound; the boundary row is skipped as seen). */
function loadChunk(sdk: EvoSDK, state: IndexState, direction: 'desc' | 'asc'): Promise<void> {
  return serial(state, async () => {
    const walk = direction === 'desc' ? state.desc : state.asc
    if (walk.done || state.all) return
    const source = repoSource(state.repo)
    const bound: [string, '<=' | '>=', number][] = walk.bound === null ? [] : [['$createdAt', direction === 'desc' ? '<=' : '>=', walk.bound]]
    const page = source.repoQuery(DOC.issue, { where: bound, orderBy: [['$createdAt', direction]] })
    await readChunk(sdk, state, page, CHUNK, { walk })
  })
}

/** Resolve ids the feed names but no loaded chunk holds: `$id in` composites of up to 100. */
function resolveIds(sdk: EvoSDK, state: IndexState, ids: Iterable<string>): Promise<void> {
  // Serialized per index: the header's count and the list resolve the same closed targets at
  // once, and each must see what the other already read (one `$id in` composite, not two).
  const wanted = [...ids]
  return serial(state, () => resolveNow(sdk, state, wanted))
}

async function resolveNow(sdk: EvoSDK, state: IndexState, ids: readonly string[]): Promise<void> {
  const todo = [...new Set(ids)].filter((id) => !state.rows.has(id) && !state.notIssues.has(id))
  // Every issue is loaded: an id the rows do not hold is a patch (or not shown), no read needed.
  if (state.all) {
    for (const id of todo) state.notIssues.add(id)
    return
  }
  const byId = repoSource(state.repo).targetQuery(DOC.issue)
  for (let i = 0; i < todo.length; i += CHUNK) {
    const batch = todo.slice(i, i + CHUNK)
    // Only this repo's issues: the ids come from its feed (consensus ties an event's target to
    // the event's repo), but the read is by id, so check.
    await readChunk(sdk, state, { ...byId, where: [['$id', 'in', batch]], orderBy: [['$id', 'asc']] }, batch.length, {
      keep: (d) => asIdentifierString(d['repoId']) === state.repo.repoId,
    })
    for (const id of batch) if (!state.rows.has(id)) state.notIssues.add(id)
  }
}

/** The index, loading it on first use (one per repo and network, until a write drops it). */
function indexOf(sdk: EvoSDK, repo: RepoRef, network: Network): Promise<IndexState> {
  const key = indexKey(repo, network)
  let hit = indexes.get(key)
  if (hit === undefined) {
    hit = loadIndex(sdk, repo, network)
    indexes.set(key, hit)
    hit.catch(() => {
      if (indexes.get(key) === hit) indexes.delete(key)
    })
  }
  return hit
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

/** Feed targets whose fold passes the feed-decided filters (state, labels, assignee), or null when none applies. */
function feedCandidates(state: IndexState, q: IssueSelection): Set<string> | null {
  const byFeed = q.state === 'closed' || q.labels.length > 0 || (q.assignee !== null && q.assignee !== 'none')
  if (!byFeed || state.feed === null) return null
  const out = new Set<string>()
  for (const [id, log] of state.feed) {
    if (id === '' || state.notIssues.has(id)) continue
    // The fold needs the target's author (an authorEvent counts only from them); a row not
    // loaded yet is folded after it is resolved, so admit it here on member events alone.
    const row = state.rows.get(id)
    if (row !== undefined) {
      if (stateMatches(row, q.state) && rowMatches(row, { ...q, author: null, mentions: null, text: '' })) out.add(id)
      continue
    }
    const kinds = new Set(log.events.map((e) => e.kind))
    const couldBeClosed = kinds.has('close') || log.authorEvents.some((e) => e.kind === 'close')
    if (q.state === 'closed' && !couldBeClosed) continue
    if (q.labels.length > 0 && !kinds.has('labelAdd')) continue
    if (q.assignee !== null && q.assignee !== 'none' && !log.events.some((e) => e.kind === 'assign' && e.value === q.assignee)) continue
    out.add(id)
  }
  return out
}

/**
 * Every issue by `author` in the repo, from the `author` index (`($ownerId, repoId, number)`):
 * keyset composites of 100 by number, newest first. Null when there are more than
 * {@link MAX_CHUNKS} × 100 (the list then walks chunks instead).
 */
function authorCandidates(sdk: EvoSDK, state: IndexState, author: string): Promise<Set<string> | null> {
  return serial(state, () => readAuthor(sdk, state, author))
}

async function readAuthor(sdk: EvoSDK, state: IndexState, author: string): Promise<Set<string> | null> {
  const cached = state.byAuthor.get(author)
  if (cached !== undefined) return cached
  const out = new Set<string>()
  let below: number | null = null
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const where: [string, '==' | '<', string | number][] = [['$ownerId', '==', author], ['repoId', '==', state.repo.repoId]]
    if (below !== null) where.push(['number', '<', below])
    const page = { ...repoSource(state.repo).targetQuery(DOC.issue), where, orderBy: [['number', 'desc']] as const }
    const docs = await readChunk(sdk, state, page, CHUNK)
    for (const d of docs) if (state.rows.has(str(d, '$id'))) out.add(str(d, '$id'))
    const last = docs[docs.length - 1]?.['number']
    if (docs.length < CHUNK || typeof last !== 'number') {
      state.byAuthor.set(author, out)
      return out
    }
    below = last
  }
  return null
}

/** The feed's closed targets (issues or patches: resolve to tell). */
function closedTargets(state: IndexState): string[] {
  if (state.feed === null) return []
  const out: string[] = []
  for (const [id, log] of state.feed) {
    if (id === '' || state.notIssues.has(id)) continue
    const row = state.rows.get(id)
    if (row !== undefined) {
      if (!row.state.open) out.push(id)
    } else if (log.events.some((e) => e.kind === 'close') || log.authorEvents.some((e) => e.kind === 'close')) {
      out.push(id)
    }
  }
  return out
}

/**
 * The repo's exact Open / Closed issue counts: closed from the complete feed (its closed
 * targets resolved to issues), open = total − closed − hidden. Null when the feed is too large
 * to fold, or the total is unknown.
 */
async function exactCounts(sdk: EvoSDK, state: IndexState, total: number | null): Promise<{ open: number; closed: number } | null> {
  if (state.feed === null || total === null) return null
  await resolveIds(sdk, state, closedTargets(state))
  const closed = [...state.rows.values()].filter((r) => !r.state.open).length
  // Every issue is loaded: count directly (no reliance on the total), unless the index holds
  // fewer issues than the total proves (it was read from a node without a newer issue).
  if (state.all) {
    if (state.rows.size + state.hidden.total < total) return null
    return { open: state.rows.size - closed, closed }
  }
  // Not every issue is loaded: open = the countable total less the closed and the hidden seen so
  // far. In a private repo anyone's ciphertext counts in the total but is not shown, so only a
  // full read proves the open count there.
  if (state.repo.visibility === 'private') return null
  const open = total - closed - state.hidden.total
  return open >= 0 ? { open, closed } : null
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
  const walk = direction === 'asc' ? state.asc : state.desc

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
    const loaded = (): Iterable<string> => (state.all ? state.rows.keys() : walk.ids)
    const matching = (): IssueRow[] => rowsOf(state, loaded()).filter((r) => stateMatches(r, q.state) && rowMatches(r, q))
    let chunks = 0
    if (q.sort === 'comments') {
      while (!walk.done && !state.all && chunks < MAX_CHUNKS) {
        await loadChunk(sdk, state, direction)
        chunks++
      }
    } else {
      // Keep reading chunks until the page is full and one more row shows a next page exists.
      while (!walk.done && !state.all && matching().length <= want && chunks < MAX_CHUNKS) {
        await loadChunk(sdk, state, direction)
        chunks++
      }
    }
    rows = matching().sort(cmp)
    complete = state.all || (walk.done && walk.complete)
    if (!complete && (q.text.trim() !== '' || q.mentions !== null || q.sort === 'comments')) searched = walk.ids.length
  }

  // Tab counts under the current filters: exact when the whole candidate set is known.
  let openCount: number | null = null
  let closedCount: number | null = null
  const filtered = q.labels.length > 0 || q.author !== null || q.assignee !== null || q.mentions !== null || q.text.trim() !== ''
  if (!filtered) {
    const exact = await exactCounts(sdk, state, total)
    openCount = exact?.open ?? null
    closedCount = exact?.closed ?? null
    if (exact !== null && state.feed !== null) settleIssueCount(repo, exact.open, total)
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
async function withBothStates(sdk: EvoSDK, state: IndexState, q: IssueSelection): Promise<IssueRow[] | null> {
  const cands = await candidatesFor(sdk, state, { ...q, state: 'all' })
  if (cands === null) return null
  await resolveIds(sdk, state, cands)
  return rowsOf(state, cands).filter((r) => rowMatches(r, q))
}

/**
 * Every issue that can match `q`, when an index names them: the feed (state, labels, assignee)
 * and the `author` index, intersected. Null when neither applies (the list walks chunks).
 */
async function candidatesFor(sdk: EvoSDK, state: IndexState, q: IssueSelection): Promise<Set<string> | null> {
  const fromFeed = feedCandidates(state, q)
  const mine = q.author === null ? null : await authorCandidates(sdk, state, q.author)
  if (mine === null) return fromFeed
  return fromFeed === null ? mine : new Set([...fromFeed].filter((id) => mine.has(id)))
}

/** The repo's pinned issues, newest pin first (one `$id in` read for any not loaded yet). */
async function pinnedRows(sdk: EvoSDK, state: IndexState): Promise<IssueRow[]> {
  if (state.feed === null) return []
  const ids = pinnedTargets([...state.feed.values()].flatMap((log) => log.events)).map((p) => p.targetId)
  if (ids.length === 0) return []
  await resolveIds(sdk, state, ids)
  return rowsOf(state, ids)
}

/** The loaded rows of `ids`, in order (ids not loaded are skipped). */
function rowsOf(state: IndexState, ids: Iterable<string>): IssueRow[] {
  return [...ids].map((id) => state.rows.get(id)).filter((r): r is IssueRow => r !== undefined)
}

/**
 * The exact open issue count for the repo header (null when not provable). Reads the index
 * (one composite and the feed, shared with the Issues tab) and resolves the closed targets.
 */
export async function foldIssueOpenCount(sdk: EvoSDK, repo: RepoRef, total: number | null, network: Network = DEFAULT_NETWORK): Promise<number | null> {
  if (total === 0) return 0
  // The header of every repo page asks: read the index for it only when one composite is likely
  // to hold the whole repo, or when the Issues tab has read it already.
  if (!indexes.has(indexKey(repo, network)) && !(total !== null && total < CHUNK)) return null
  const state = await indexOf(sdk, repo, network)
  const exact = await exactCounts(sdk, state, total)
  if (exact !== null) settleIssueCount(repo, exact.open, total)
  return exact?.open ?? null
}

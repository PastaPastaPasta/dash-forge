/**
 * The pull index: what the Pull requests tab lists, filters, sorts, pages and counts (L-44), read
 * with composite queries and keyset paging, the issue index's architecture (`./issue-index`)
 * for patches (L-77). Per repo, cached for the session and dropped by any write
 * ({@link invalidateRepoFeed}):
 *
 * 1. **One composite** (the first request): the newest 100 patches, their comment counts
 *    (`comment.target` count tree), their authors' DPNS names, the label definitions and — unless
 *    another reader has the feed already — the first 100 rows of the repo feed (`event`,
 *    `authorEvent`), as siblings under the same proof.
 * 2. **The rest of the feed**, only when a first page was full, read ONCE per repo: the issue
 *    index and the header's counts share it (`readRepoFeedFrom`).
 * 3. **More patches on demand**: a keyset composite per 100 (`$createdAt <=` the oldest loaded,
 *    newest first; `>=` for the oldest-first sort), and `$id in` composites for patches the feed
 *    names but no loaded chunk holds (a merged, closed or labelled PR past the loaded pages).
 *
 * State: {@link pullStates} is the ONE step that turns patch documents into their state, today
 * the FORGE_RULES fold of each patch's slice of the feed against its base ref's history. The
 * base refs' histories come from the repo chrome store (`baseRefReaders`: no request for a public
 * repo whose page just read its chrome; one read per base ref, not per PR, otherwise), which is
 * what "merged" needs. The on-chain transition reader (wipe/beta7, #158) replaces that one step.
 *
 * Counts: the repo's PR total is the countable `patch.number` index; what is merged or closed is
 * a fold over the complete feed. So Open / Merged / Closed are exact without reading every PR:
 * the feed's close and merge targets are resolved to patches (`$id in`), folded, and counted;
 * open = total − merged − closed − hidden.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, NETWORKS, type Network } from '../constants'
import { compositeOf, countsAt, docsAt, queryComposite, siblingOf, type CompositeSub } from '../sdk/composite'
import { IncompleteReadError, queryAllDocuments, type DocumentQuery, type PlainDocument } from '../sdk'
import { DOC, asIdentifierString, repoKey, str, type RepoRef } from './contract'
import { compareRows, rowMatches, type IssueSelection } from './issue-index'
import {
  baseRefReaders,
  feedQuery,
  incompletePullView,
  onRepoInvalidated,
  readPull,
  readRepoFeedFrom,
  settlePullCount,
  sharedRepoFeed,
  type BaseRefReaders,
  type PullView,
  type TargetLog,
} from './issues'
import { newestLabels, type LabelDef } from './labels'
import { HiddenTally, gateFor, type ContentGate, type HiddenCounts } from './private-content'
import { onPrivateSessionEnded } from './private-session'
import { repoSource } from './source'

/** A PR row: the PR with its state and its comment count (null: not counted). */
export interface PullRow extends PullView {
  readonly comments: number | null
}

/** The Pull requests tabs. Closed means closed without merging; a draft is open. */
export type PullStateFilter = 'open' | 'merged' | 'closed' | 'all'

/** Patches per keyset chunk (the page limit of one composite). */
const CHUNK = 100
/** Chunks one call may read to satisfy a query (a sort by comments reads every chunk up to this). */
const MAX_CHUNKS = 30

const EMPTY_LOG: TargetLog = { events: [], authorEvents: [] }

/** One keyset walk over the repo's patches, in one direction. */
interface Walk {
  /** Loaded ids, in walk order. */
  readonly ids: string[]
  /** The `$createdAt` bound of the next chunk (`<=` newest-first, `>=` oldest-first). */
  bound: number | null
  done: boolean
  /** False when the walk stopped on a timestamp shared by 100+ patches (it did not reach the end). */
  complete: boolean
}

/** A repo's pull index (mutable while it loads). */
interface IndexState {
  readonly repo: RepoRef
  readonly network: Network
  /** Every target's log; null when the feed is too large to read completely. */
  readonly feed: Map<string, TargetLog> | null
  /** The config and base-ref histories every row's state is folded against. */
  readonly base: BaseRefReaders
  readonly labels: LabelDef[]
  readonly rows: Map<string, PullRow>
  /** Ids proven not to be (well-formed, shown) patches of this repo: issues, malformed, hidden. */
  readonly notPulls: Set<string>
  /** Patches left out: not well-formed for the repo, or (private) not readable with the session keys. */
  readonly hidden: HiddenTally
  readonly desc: Walk
  readonly asc: Walk
  /** Every read runs one at a time on this queue (see the issue index's `queue`). */
  queue: Promise<void>
  /** Every patch of the repo is loaded (a walk from the newest or oldest reached the end). */
  all: boolean
  /** Patches per author, once read from the `author` index. */
  readonly byAuthor: Map<string, Set<string>>
  readonly gate: ContentGate
}

const indexes = new Map<string, Promise<IndexState>>()
const indexKey = (repo: RepoRef, network: Network): string => `${network}:${repo.forge.collab}:${repoKey(repo)}`

onRepoInvalidated((repo) => {
  const at = `:${repo.forge.collab}:${repo.repoId}`
  for (const key of [...indexes.keys()]) if (key.endsWith(at) || key.includes(`${at}#`)) indexes.delete(key)
})
onPrivateSessionEnded((id) => {
  for (const key of [...indexes.keys()]) if (key.endsWith(`#${id}`)) indexes.delete(key)
})

/** The sub-queries every patch chunk carries: comment counts and the authors' DPNS names. */
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

/**
 * THE state step: each patch's {@link PullView}, today the FORGE_RULES fold of its slice of the
 * repo feed against its base ref's history (`readPull`). A row whose base history cannot be read
 * completely is kept, unverified; with no complete feed every row is unverified. The transition
 * reader (#158) replaces this function: a proved state sum per chunk instead of the fold.
 */
async function pullStates(state: IndexState, sdk: EvoSDK, docs: readonly PlainDocument[]): Promise<PullView[]> {
  return Promise.all(
    docs.map((doc) =>
      readPull(sdk, state.repo, doc, state.feed?.get(str(doc, '$id')) ?? EMPTY_LOG, state.base.configHistory, state.base.refUpdates).then(
        (view) => (state.feed === null ? { ...view, stateComplete: false } : view),
        (e: unknown) => {
          if (!(e instanceof IncompleteReadError)) throw e
          return incompletePullView(doc)
        },
      ),
    ),
  )
}

/** Record a chunk's patch documents (and their comment counts); `walk` also records their order. */
async function addDocs(sdk: EvoSDK, state: IndexState, docs: readonly PlainDocument[], counts: ReadonlyMap<string, number> | null, walk: Walk | null): Promise<void> {
  const fresh: PlainDocument[] = []
  for (const raw of docs) {
    const id = str(raw, '$id')
    if (id === '' || state.notPulls.has(id)) continue
    if (state.rows.has(id) || fresh.some((d) => str(d, '$id') === id)) {
      if (walk !== null && !walk.ids.includes(id)) walk.ids.push(id)
      continue
    }
    const admitted = await state.gate.admit('patch', raw)
    if (!admitted.ok) {
      state.notPulls.add(id)
      state.hidden.add(admitted.reason)
      continue
    }
    fresh.push(admitted.doc)
    walk?.ids.push(id)
  }
  const views = await pullStates(state, sdk, fresh)
  for (const view of views) state.rows.set(view.id, { ...view, comments: counts === null ? null : counts.get(view.id) ?? 0 })
}

/** Seed the DPNS cache with a composite's bound name lookup. */
async function seedNames(network: Network, docs: readonly PlainDocument[], domains: readonly PlainDocument[] | undefined): Promise<void> {
  if (domains === undefined) return
  const { seedFromDomains } = await import('../view/dpns')
  seedFromDomains(network, docs.map((d) => str(d, '$ownerId')), domains)
}

/** Record one keyset chunk and move its walk's bound. */
async function addChunk(sdk: EvoSDK, state: IndexState, walk: Walk, docs: readonly PlainDocument[], counts: ReadonlyMap<string, number> | null): Promise<void> {
  const before = walk.ids.length
  await addDocs(sdk, state, docs, counts, walk)
  if (docs.length < CHUNK) {
    walk.done = true
  } else {
    const last = docs[docs.length - 1]?.['$createdAt']
    // A full chunk that added nothing new sits on one timestamp shared by 100+ patches: stop.
    if (typeof last !== 'number' || (walk.ids.length === before && walk.bound === last)) {
      walk.done = true
      walk.complete = false
    }
    walk.bound = typeof last === 'number' ? last : walk.bound
  }
  if (walk.done && walk.complete) state.all = true
}

/** Read one chunk of patches with their comment counts and authors' names, and record it. */
async function readChunk(
  sdk: EvoSDK,
  state: IndexState,
  page: DocumentQuery,
  limit: number,
  { walk = null, keep }: { walk?: Walk | null; keep?: (d: PlainDocument) => boolean } = {},
): Promise<PlainDocument[]> {
  const res = await queryComposite(sdk, compositeOf(page, limit, chunkSubs(state.network)))
  const docs = keep ? res.page.filter(keep) : res.page
  if (walk === null) await addDocs(sdk, state, docs, countsAt(res, 0), null)
  else await addChunk(sdk, state, walk, docs, countsAt(res, 0))
  await seedNames(state.network, docs, docsAt(res, 1))
  return docs
}

/** First load: one composite; then the rest of the feed (shared) and labels when their pages were full. */
async function loadIndex(sdk: EvoSDK, repo: RepoRef, network: Network): Promise<IndexState> {
  const source = repoSource(repo)
  const labelQuery = source.repoQuery(DOC.label, { orderBy: [['name', 'asc'], ['$createdAt', 'asc']] })
  const page = source.repoQuery(DOC.patch, { orderBy: [['$createdAt', 'desc']] })
  // A feed another reader (the issue index, the header) already has is joined, not re-proved.
  const shared = sharedRepoFeed(repo)
  const feedSubs = shared === undefined ? [siblingOf(feedQuery(repo, 'event'), CHUNK), siblingOf(feedQuery(repo, 'authorEvent'), CHUNK)] : []
  const subs = [...chunkSubs(network), ...feedSubs, siblingOf(labelQuery, CHUNK)]
  const res = await queryComposite(sdk, compositeOf(page, CHUNK, subs))
  const feed = await (shared ?? readRepoFeedFrom(sdk, repo, { event: docsAt(res, 2), authorEvent: docsAt(res, 3) }))
  let labelDocs = docsAt(res, subs.length - 1)
  if (labelDocs.length >= CHUNK) {
    labelDocs = await queryAllDocuments(sdk, labelQuery, { firstPage: labelDocs, maxPages: 10 }).catch((e: unknown) => {
      if (e instanceof IncompleteReadError) return labelDocs
      throw e
    })
  }
  const state: IndexState = {
    repo,
    network,
    feed,
    base: baseRefReaders(sdk, repo),
    labels: newestLabels(labelDocs),
    rows: new Map(),
    notPulls: new Set(),
    hidden: new HiddenTally(),
    desc: { ids: [], bound: null, done: false, complete: true },
    asc: { ids: [], bound: null, done: false, complete: true },
    queue: Promise.resolve(),
    all: false,
    byAuthor: new Map(),
    gate: gateFor(repo),
  }
  await addChunk(sdk, state, state.desc, res.page, countsAt(res, 0))
  await seedNames(network, res.page, docsAt(res, 1))
  return state
}

/** Run `task` on the index's read queue. */
function serial<T>(state: IndexState, task: () => Promise<T>): Promise<T> {
  const run = state.queue.then(task)
  state.queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Read the next keyset chunk of the walk in `direction`. */
function loadChunk(sdk: EvoSDK, state: IndexState, direction: 'desc' | 'asc'): Promise<void> {
  return serial(state, async () => {
    const walk = direction === 'desc' ? state.desc : state.asc
    if (walk.done || state.all) return
    const bound: [string, '<=' | '>=', number][] = walk.bound === null ? [] : [['$createdAt', direction === 'desc' ? '<=' : '>=', walk.bound]]
    await readChunk(sdk, state, repoSource(state.repo).repoQuery(DOC.patch, { where: bound, orderBy: [['$createdAt', direction]] }), CHUNK, { walk })
  })
}

/** Resolve ids the feed names but no loaded chunk holds: `$id in` composites of up to 100. */
function resolveIds(sdk: EvoSDK, state: IndexState, ids: Iterable<string>): Promise<void> {
  const wanted = [...ids]
  return serial(state, async () => {
    const todo = [...new Set(wanted)].filter((id) => !state.rows.has(id) && !state.notPulls.has(id))
    // Every patch is loaded: an id the rows do not hold is an issue (or not shown).
    if (state.all) {
      for (const id of todo) state.notPulls.add(id)
      return
    }
    const byId = repoSource(state.repo).targetQuery(DOC.patch)
    for (let i = 0; i < todo.length; i += CHUNK) {
      const batch = todo.slice(i, i + CHUNK)
      await readChunk(sdk, state, { ...byId, where: [['$id', 'in', batch]], orderBy: [['$id', 'asc']] }, batch.length, {
        keep: (d) => asIdentifierString(d['repoId']) === state.repo.repoId,
      })
      for (const id of batch) if (!state.rows.has(id)) state.notPulls.add(id)
    }
  })
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

/** What the list asks for (`me` already replaced by the viewer's id). */
export interface PullSelection {
  readonly state: PullStateFilter
  readonly labels: readonly string[]
  /** An identity id, or null. */
  readonly author: string | null
  /** An identity id, `none` (no assignee), or null. */
  readonly assignee: string | null
  readonly sort: 'newest' | 'oldest' | 'comments'
  readonly text: string
  readonly page: number
  readonly pageSize: number
}

/** Open / Merged / Closed counts (null: not proven). */
export interface PullCounts {
  readonly open: number | null
  readonly merged: number | null
  readonly closed: number | null
}

/** The answer for one list page. */
export interface PullListPage {
  readonly rows: readonly PullRow[]
  /** Matching rows in the whole repo, or null when that needs more reading than was done. */
  readonly matching: number | null
  readonly hasNext: boolean
  /** The tabs' counts under the current filters. */
  readonly counts: PullCounts
  /** When a text search or a comment sort covered only part of the repo: how many PRs it looked at. */
  readonly searchedOf: { readonly searched: number; readonly total: number | null } | null
  /** False when the feed was too large to fold: states, labels and assignees are unverified. */
  readonly stateComplete: boolean
  readonly labels: readonly LabelDef[]
  readonly hidden: number
  readonly hiddenBy: HiddenCounts
}

const NO_COUNTS: PullCounts = { open: null, merged: null, closed: null }

/** Whether a row's state passes the state tab. */
export function pullStateMatches(row: Pick<PullView, 'state'>, tab: PullStateFilter): boolean {
  if (tab === 'all') return true
  if (tab === 'merged') return row.state.merged
  if (tab === 'closed') return !row.state.open && !row.state.merged
  return row.state.open
}

/** The issue index's filter and sort rules take a PR row as they take an issue row. */
function asIssueSelection(q: PullSelection): IssueSelection {
  return { ...q, state: 'all', mentions: null }
}

/** Whether a row passes every filter but the state tab (labels, author, assignee, title / `#n`). */
function filtersMatch(row: PullRow, q: PullSelection): boolean {
  return rowMatches(row, asIssueSelection(q))
}

/** Feed targets that have a close or merge (a member's, or the author's close). */
function settledTargets(state: IndexState, kinds: 'merge' | 'close' | 'either'): string[] {
  if (state.feed === null) return []
  const out: string[] = []
  for (const [id, log] of state.feed) {
    if (id === '' || state.notPulls.has(id)) continue
    const merge = kinds !== 'close' && log.events.some((e) => e.kind === 'merge')
    const close = kinds !== 'merge' && (log.events.some((e) => e.kind === 'close') || log.authorEvents.some((e) => e.kind === 'close'))
    if (merge || close) out.push(id)
  }
  return out
}

/** Feed targets that can pass the feed-decided filters (merged / closed tab, labels, assignee), or null when none applies. */
function feedCandidates(state: IndexState, q: PullSelection): Set<string> | null {
  const byState = q.state === 'merged' || q.state === 'closed'
  const byMeta = q.labels.length > 0 || (q.assignee !== null && q.assignee !== 'none')
  if ((!byState && !byMeta) || state.feed === null) return null
  const settled = byState ? new Set(settledTargets(state, q.state === 'merged' ? 'merge' : 'close')) : null
  const out = new Set<string>()
  for (const [id, log] of state.feed) {
    if (id === '' || state.notPulls.has(id)) continue
    if (settled !== null && !settled.has(id)) continue
    // Not loaded yet: admitted on its events alone, filtered exactly once resolved.
    if (q.labels.length > 0 && !log.events.some((e) => e.kind === 'labelAdd')) continue
    if (q.assignee !== null && q.assignee !== 'none' && !log.events.some((e) => e.kind === 'assign' && e.value === q.assignee)) continue
    out.add(id)
  }
  return out
}

/** Every patch by `author` from the `author` index (`($ownerId, repoId, number)`); null past {@link MAX_CHUNKS} chunks. */
function authorCandidates(sdk: EvoSDK, state: IndexState, author: string): Promise<Set<string> | null> {
  return serial(state, async () => {
    const cached = state.byAuthor.get(author)
    if (cached !== undefined) return cached
    const out = new Set<string>()
    let below: number | null = null
    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      const where: [string, '==' | '<', string | number][] = [['$ownerId', '==', author], ['repoId', '==', state.repo.repoId]]
      if (below !== null) where.push(['number', '<', below])
      const docs = await readChunk(sdk, state, { ...repoSource(state.repo).targetQuery(DOC.patch), where, orderBy: [['number', 'desc']] }, CHUNK)
      for (const d of docs) if (state.rows.has(str(d, '$id'))) out.add(str(d, '$id'))
      const last = docs[docs.length - 1]?.['number']
      if (docs.length < CHUNK || typeof last !== 'number') {
        state.byAuthor.set(author, out)
        return out
      }
      below = last
    }
    return null
  })
}

/** Every PR that can match `q`, when an index names them (the feed, the `author` index); null when neither applies. */
async function candidatesFor(sdk: EvoSDK, state: IndexState, q: PullSelection): Promise<Set<string> | null> {
  const fromFeed = feedCandidates(state, q)
  const mine = q.author === null ? null : await authorCandidates(sdk, state, q.author)
  if (mine === null) return fromFeed
  return fromFeed === null ? mine : new Set([...fromFeed].filter((id) => mine.has(id)))
}

/** The loaded rows of `ids`, in order. */
function rowsOf(state: IndexState, ids: Iterable<string>): PullRow[] {
  return [...ids].map((id) => state.rows.get(id)).filter((r): r is PullRow => r !== undefined)
}

/** Open / Merged / Closed of `rows`. */
function countRows(rows: readonly PullRow[]): { open: number; merged: number; closed: number } {
  const merged = rows.filter((r) => r.state.merged).length
  const closed = rows.filter((r) => !r.state.open && !r.state.merged).length
  return { open: rows.length - merged - closed, merged, closed }
}

/**
 * The repo's exact Open / Merged / Closed counts: every close and merge target of the complete
 * feed resolved to a patch and folded; open = total − merged − closed − hidden. Null when the
 * feed is too large to fold, the total is unknown, or a settled PR's state is unverified.
 */
async function exactCounts(sdk: EvoSDK, state: IndexState, total: number | null): Promise<{ open: number; merged: number; closed: number } | null> {
  if (state.feed === null || total === null) return null
  const settled = settledTargets(state, 'either')
  await resolveIds(sdk, state, settled)
  if (rowsOf(state, settled).some((r) => !r.stateComplete)) return null
  const rows = [...state.rows.values()]
  const { merged, closed } = countRows(rows)
  // Every patch is loaded: count directly, unless the total proves a newer one this read missed.
  if (state.all) return rows.length + state.hidden.total < total ? null : countRows(rows)
  // A private repo's total counts ciphertext this reader cannot tell apart until read.
  if (state.repo.visibility === 'private') return null
  const open = total - merged - closed - state.hidden.total
  return open >= 0 ? { open, merged, closed } : null
}

/**
 * One page of the PR list for `q`, reading only what it needs: the first chunk and the feed
 * (once), feed-named candidates by id, more keyset chunks while the page is not full, or every
 * chunk (up to {@link MAX_CHUNKS}) for a sort by comments. `total` is the repo's PR count (the
 * countable index), or null when it is not known.
 */
export async function queryPulls(
  sdk: EvoSDK,
  repo: RepoRef,
  q: PullSelection,
  total: number | null,
  network: Network = DEFAULT_NETWORK,
): Promise<PullListPage> {
  const state = await indexOf(sdk, repo, network)
  const want = q.page * q.pageSize
  const cmp = compareRows(q.sort)
  const direction = q.sort === 'oldest' ? 'asc' : 'desc'
  const walk = direction === 'asc' ? state.asc : state.desc
  const matches = (r: PullRow): boolean => pullStateMatches(r, q.state) && filtersMatch(r, q)

  let rows: PullRow[]
  let complete: boolean
  let searched: number | null = null
  const candidates = await candidatesFor(sdk, state, q)
  if (candidates !== null) {
    await resolveIds(sdk, state, candidates)
    rows = rowsOf(state, candidates).filter(matches).sort(cmp)
    complete = true
  } else {
    const loaded = (): Iterable<string> => (state.all ? state.rows.keys() : walk.ids)
    const matching = (): PullRow[] => rowsOf(state, loaded()).filter(matches)
    let chunks = 0
    // Read chunks until the page is full and one more row shows a next page (every chunk, for a
    // sort by comments).
    while (!walk.done && !state.all && chunks < MAX_CHUNKS && (q.sort === 'comments' || matching().length <= want)) {
      await loadChunk(sdk, state, direction)
      chunks++
    }
    rows = matching().sort(cmp)
    complete = state.all || (walk.done && walk.complete)
    if (!complete && (q.text.trim() !== '' || q.sort === 'comments')) searched = walk.ids.length
  }

  const filtered = q.labels.length > 0 || q.author !== null || q.assignee !== null || q.text.trim() !== ''
  let counts: PullCounts = NO_COUNTS
  if (!filtered) {
    const exact = await exactCounts(sdk, state, total)
    if (exact !== null) {
      counts = exact
      settlePullCount(repo, exact.open, total)
    }
  } else {
    // Every tab's count needs every candidate in any state: the feed or author index names them,
    // or every patch is loaded.
    const any = await candidatesFor(sdk, state, { ...q, state: 'all' })
    if (any !== null) await resolveIds(sdk, state, any)
    const all = any !== null ? rowsOf(state, any) : state.all ? [...state.rows.values()] : null
    if (all !== null) counts = countRows(all.filter((r) => filtersMatch(r, q)))
  }

  const start = (q.page - 1) * q.pageSize
  return {
    rows: rows.slice(start, start + q.pageSize),
    matching: complete ? rows.length : null,
    hasNext: rows.length > start + q.pageSize,
    counts,
    searchedOf: searched === null ? null : { searched, total },
    stateComplete: state.feed !== null,
    labels: state.labels,
    hidden: state.hidden.total,
    hiddenBy: state.hidden.value,
  }
}

/**
 * The exact open PR count for the repo header (null when not provable). Reads the index only
 * when one composite is likely to hold the whole repo, or when the Pull requests tab has read it.
 */
export async function foldPullOpenCount(sdk: EvoSDK, repo: RepoRef, total: number | null, network: Network = DEFAULT_NETWORK): Promise<number | null> {
  if (total === 0) return 0
  if (!indexes.has(indexKey(repo, network)) && !(total !== null && total < CHUNK)) return null
  const state = await indexOf(sdk, repo, network)
  const exact = await exactCounts(sdk, state, total)
  if (exact !== null) settlePullCount(repo, exact.open, total)
  return exact?.open ?? null
}

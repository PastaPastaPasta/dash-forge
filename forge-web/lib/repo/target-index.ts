/**
 * What the issue index (`./issue-index`) and the pull index (`./pull-index`) share: a keyset walk
 * over one document type read in composites of 100 (with comment counts and author names), each
 * chunk's states from one proved sum of its transitions (`./transitions` `readStateCodes`), the
 * repo's member-event feed and label definitions read once, `$id in` resolution of ids an index
 * names but has not loaded, the `author` index, the targets of a transition kind, the proved
 * counts, and the per-repo cache a write drops (`platform-parity-spec.md` §1.2, §3.3; L-44, L-77).
 *
 * Each index supplies its views through a {@link ViewBuilder} (an admitted document, its feed
 * slice and its state code in; the issue or PR view out); the engine adds the comment counts.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { compositeOf, countsAt, docsAt, queryComposite, siblingOf, type CompositeResult, type CompositeSub } from '../sdk/composite'
import { IncompleteReadError, queryAllDocuments, type DocumentQuery, type PlainDocument } from '../sdk'
import { statusOfCode } from '../rules/transition'
import { DOC, asIdentifierString, repoKey, str, type RepoRef } from './contract'
import { EMPTY_LOG, feedQuery, onRepoInvalidated, readRepoFeedFrom, repoEpoch, sharedRepoCounts, sharedRepoFeed, type TargetLog } from './issues'
import { newestLabels, type LabelDef } from './labels'
import { HiddenTally, gateFor, type ContentGate } from './private-content'
import { onPrivateSessionEnded } from './private-session'
import { repoSource } from './source'
import { readStateCodes, type readRepoCounts } from './transitions'

type RepoCounts = Awaited<ReturnType<typeof readRepoCounts>>
type Direction = 'desc' | 'asc'

/** Rows per keyset chunk (the page limit of one composite). */
const CHUNK = 100
/** Chunks one call may read to satisfy a query (a sort by comments reads every chunk up to this). */
const MAX_CHUNKS = 30
/** Pages of one transition kind read for a tab's candidates before the tab walks chunks instead. */
const KIND_MAX_PAGES = 30

/** One keyset walk over the repo's rows, in one direction. */
interface Walk {
  /** Loaded ids, in walk order. */
  readonly ids: string[]
  /** The `$createdAt` bound of the next chunk (`<=` newest-first, `>=` oldest-first). */
  bound: number | null
  done: boolean
  /** False when the walk stopped on a timestamp shared by 100+ rows (it did not reach the end). */
  complete: boolean
}

/** What every row carries besides its view: its comment count (null: not counted), whether its labels are verified. */
export interface RowExtras {
  readonly id: string
  readonly comments: number | null
  /** False when the feed was too large to read: the row's labels and assignees are unverified. */
  readonly stateComplete: boolean
}

/**
 * An index's one view step: an admitted document, its slice of the member-event feed and its
 * state code (the proved sum of its transitions) in; the issue or PR view out.
 */
export type ViewBuilder<Row extends RowExtras> = (
  sdk: EvoSDK,
  index: ListIndex<Row>,
  doc: PlainDocument,
  log: TargetLog,
  code: number,
) => Promise<Omit<Row, 'comments' | 'stateComplete'> & { readonly stateComplete?: boolean }>

/** A repo's list index of one type (mutable while it loads). */
export interface ListIndex<Row extends RowExtras> {
  readonly type: 'issue' | 'patch'
  readonly repo: RepoRef
  readonly network: Network
  /** Every target's member events; null when the feed is too large to read completely. */
  readonly feed: Map<string, TargetLog> | null
  readonly labels: LabelDef[]
  readonly rows: Map<string, Row>
  /** Ids proven not to be (well-formed, shown) rows of this type: the other type, malformed, hidden. */
  readonly notRows: Set<string>
  /** Rows left out: not well-formed for the repo, or (private) not readable with the session keys. */
  readonly hidden: HiddenTally
  /** How many of the hidden rows are open (their state code): the Open count leaves them out. */
  hiddenOpen: number
  readonly walks: Record<Direction, Walk>
  /**
   * Every index read (keyset chunks, `$id in` resolutions, author and kind reads) runs one at a
   * time on this queue: concurrent readers of one bound would otherwise see "nothing new" and
   * end a walk early, and an id admitted by two reads at once would be listed twice.
   */
  queue: Promise<void>
  /** Every row of the repo is loaded (a walk from the newest or oldest reached the end). */
  all: boolean
  /** Rows per author, once read from the `author` index. */
  readonly byAuthor: Map<string, Set<string>>
  /** Targets per transition kind set, once read. */
  readonly byKinds: Map<string, Set<string> | null>
  /** The repo's proved counts, read once per index (a write drops the index). */
  counts?: Promise<RepoCounts>
  readonly gate: ContentGate
  readonly view: ViewBuilder<Row>
}

const newWalk = (): Walk => ({ ids: [], bound: null, done: false, complete: true })

/** The sub-queries every chunk carries: comment counts and the authors' DPNS names. */
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

/** Seed the DPNS cache with a composite's bound name lookup (a proven absence is recorded too). */
async function seedNames(network: Network, docs: readonly PlainDocument[], domains: readonly PlainDocument[] | undefined): Promise<void> {
  if (domains === undefined) return
  const { seedFromDomains } = await import('../view/dpns')
  seedFromDomains(network, docs.map((d) => str(d, '$ownerId')), domains)
}

/** Run `task` on the index's read queue ({@link ListIndex.queue}). */
function serial<T>(index: { queue: Promise<void> }, task: () => Promise<T>): Promise<T> {
  const run = index.queue.then(task)
  index.queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** The state codes of a chunk's documents (one proved sum, `targetId in [chunk]`). */
function codesOf(sdk: EvoSDK, repo: RepoRef, docs: readonly PlainDocument[]): Promise<Map<string, number>> {
  return readStateCodes(sdk, repo, docs.map((d) => str(d, '$id')))
}

/**
 * Record a composite's page (`docs`): admit each document and build its row, and only then write
 * the rows, the hidden ones and (a keyset chunk) the walk, so a read that fails part-way leaves
 * the index as it was and a retry reads the chunk afresh (never twice over). `codes` is the
 * chunk's state read, when it was started beside another read.
 */
async function recordChunk<Row extends RowExtras>(
  sdk: EvoSDK,
  index: ListIndex<Row>,
  res: CompositeResult,
  docs: readonly PlainDocument[],
  walk: Walk | null,
  codes: Promise<Map<string, number>> = codesOf(sdk, index.repo, docs),
): Promise<void> {
  // Awaited after admission (a private repo's decrypts): handled now, so a failure is never unhandled meanwhile.
  codes.catch(() => undefined)
  const counts = countsAt(res, 0)
  const fresh = new Map<string, PlainDocument>()
  const hidden: { id: string; reason: Parameters<HiddenTally['add']>[0] }[] = []
  for (const raw of docs) {
    const id = str(raw, '$id')
    if (id === '' || index.notRows.has(id) || index.rows.has(id) || fresh.has(id) || hidden.some((h) => h.id === id)) continue
    const admitted = await index.gate.admit(index.type, raw)
    if (admitted.ok) fresh.set(id, admitted.doc)
    else hidden.push({ id, reason: admitted.reason })
  }
  const code = await codes
  const rows = await Promise.all(
    [...fresh].map(async ([id, doc]) => {
      const view = await index.view(sdk, index, doc, index.feed?.get(id) ?? EMPTY_LOG, code.get(id) ?? 0)
      // A view the builder could not complete (a PR's base history) stays unverified too.
      return { ...view, stateComplete: index.feed !== null && view.stateComplete !== false, comments: counts === null ? null : counts.get(id) ?? 0 } as Row
    }),
  )
  // Every read is done: record.
  for (const row of rows) index.rows.set(row.id, row)
  for (const { id, reason } of hidden) {
    index.notRows.add(id)
    index.hidden.add(reason)
    if (statusOfCode(code.get(id) ?? 0).open) index.hiddenOpen++
  }
  if (walk !== null) advance(index, walk, docs)
  await seedNames(index.network, docs, docsAt(res, 1))
}

/** Add a keyset chunk's rows to its walk, in order, and move the walk's bound. */
function advance<Row extends RowExtras>(index: ListIndex<Row>, walk: Walk, docs: readonly PlainDocument[]): void {
  const before = walk.ids.length
  for (const d of docs) {
    const id = str(d, '$id')
    if (index.rows.has(id) && !walk.ids.includes(id)) walk.ids.push(id)
  }
  if (docs.length < CHUNK) {
    walk.done = true
  } else {
    const last = docs[docs.length - 1]?.['$createdAt']
    // A full chunk that added nothing new sits on one timestamp shared by 100+ rows: stop rather
    // than loop (the walk is then incomplete, and says so).
    if (typeof last !== 'number' || (walk.ids.length === before && walk.bound === last)) {
      walk.done = true
      walk.complete = false
    }
    walk.bound = typeof last === 'number' ? last : walk.bound
  }
  // A walk from the start that reached the end has read every row.
  if (walk.done && walk.complete) index.all = true
}

/** Read one chunk (`page`, up to `limit`) with its comment counts and names, and record it. */
async function readChunk<Row extends RowExtras>(
  sdk: EvoSDK,
  index: ListIndex<Row>,
  page: DocumentQuery,
  limit: number,
  { walk = null, keep }: { walk?: Walk | null; keep?: (d: PlainDocument) => boolean } = {},
): Promise<PlainDocument[]> {
  const res = await queryComposite(sdk, compositeOf(page, limit, chunkSubs(index.network)))
  const docs = keep ? res.page.filter(keep) : res.page
  await recordChunk(sdk, index, res, docs, walk)
  return docs
}

/**
 * First load, ONE composite: the newest 100 rows with their comment counts and author names, and
 * as siblings the label definitions and (unless another reader has the feed already) the feed's
 * first page. Beside it the rows' state sum; then the rest of the feed, shared with the other
 * index (`readRepoFeedFrom`), and of the labels when their first pages were full.
 */
async function loadListIndex<Row extends RowExtras>(sdk: EvoSDK, repo: RepoRef, network: Network, type: 'issue' | 'patch', view: ListIndex<Row>['view']): Promise<ListIndex<Row>> {
  const source = repoSource(repo)
  const labelQuery = source.repoQuery(DOC.label, { orderBy: [['name', 'asc'], ['$createdAt', 'asc']] })
  const page = source.repoQuery(DOC[type], { orderBy: [['$createdAt', 'desc']] })
  const epoch = repoEpoch(repo)
  const shared = sharedRepoFeed(repo)
  const subs = [...chunkSubs(network), siblingOf(labelQuery, CHUNK), ...(shared === undefined ? [siblingOf(feedQuery(repo), CHUNK)] : [])]
  const res = await queryComposite(sdk, compositeOf(page, CHUNK, subs))
  // The first chunk's states are read beside the feed, not after it.
  const codes = codesOf(sdk, repo, res.page)
  codes.catch(() => undefined)
  const feed = await (shared ?? readRepoFeedFrom(sdk, repo, docsAt(res, 3), epoch))
  let labelDocs = docsAt(res, 2)
  if (labelDocs.length >= CHUNK) {
    labelDocs = await queryAllDocuments(sdk, labelQuery, { firstPage: labelDocs, maxPages: 10 }).catch((e: unknown) => {
      if (e instanceof IncompleteReadError) return labelDocs
      throw e
    })
  }
  const index: ListIndex<Row> = {
    type,
    repo,
    network,
    feed,
    labels: newestLabels(labelDocs),
    rows: new Map(),
    notRows: new Set(),
    hidden: new HiddenTally(),
    hiddenOpen: 0,
    walks: { desc: newWalk(), asc: newWalk() },
    queue: Promise.resolve(),
    all: false,
    byAuthor: new Map(),
    byKinds: new Map(),
    gate: gateFor(repo),
    view,
  }
  await recordChunk(sdk, index, res, res.page, index.walks.desc, codes)
  return index
}

/**
 * A per-repo cache of one kind of index, returning its loader: one load per network, repo and
 * (private) reader session (a private index holds decrypted titles and bodies), dropped by any
 * write to the repo and when the session ends.
 */
export function indexCache<Row extends RowExtras>(type: 'issue' | 'patch', view: ListIndex<Row>['view']): (sdk: EvoSDK, repo: RepoRef, network: Network) => Promise<ListIndex<Row>> {
  const indexes = new Map<string, Promise<ListIndex<Row>>>()
  onRepoInvalidated((repo) => {
    const at = `:${repo.forge.collab}:${repo.repoId}`
    for (const key of [...indexes.keys()]) if (key.endsWith(at) || key.includes(`${at}#`)) indexes.delete(key)
  })
  onPrivateSessionEnded((id) => {
    for (const key of [...indexes.keys()]) if (key.endsWith(`#${id}`)) indexes.delete(key)
  })
  return (sdk, repo, network) => {
    const key = `${network}:${repo.forge.collab}:${repoKey(repo)}`
    let hit = indexes.get(key)
    if (hit === undefined) {
      hit = loadListIndex(sdk, repo, network, type, view)
      indexes.set(key, hit)
      hit.catch(() => {
        if (indexes.get(key) === hit) indexes.delete(key)
      })
    }
    return hit
  }
}

/** Resolve ids an index names but no loaded chunk holds: `$id in` composites of up to 100. */
export function resolveIds<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, ids: Iterable<string>): Promise<void> {
  // Serialized per index: two readers resolving the same ids at once each see what the other read.
  const wanted = [...ids]
  return serial(index, async () => {
    const todo = [...new Set(wanted)].filter((id) => !index.rows.has(id) && !index.notRows.has(id))
    // Every row is loaded: an id the rows do not hold is of the other type (or not shown).
    if (index.all) {
      for (const id of todo) index.notRows.add(id)
      return
    }
    const byId = repoSource(index.repo).targetQuery(DOC[index.type])
    for (let i = 0; i < todo.length; i += CHUNK) {
      const batch = todo.slice(i, i + CHUNK)
      // Only this repo's rows: the ids come from its own feed or transitions, but the read is by id, so check.
      await readChunk(sdk, index, { ...byId, where: [['$id', 'in', batch]], orderBy: [['$id', 'asc']] }, batch.length, {
        keep: (d) => asIdentifierString(d['repoId']) === index.repo.repoId,
      })
      for (const id of batch) if (!index.rows.has(id)) index.notRows.add(id)
    }
  })
}

/**
 * Every row by `author`, from the `author` index (`($ownerId, repoId, number)`): keyset
 * composites of 100 by number, newest first. Null past {@link MAX_CHUNKS} chunks (the list then
 * walks chunks instead).
 */
export function authorCandidates<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, author: string): Promise<Set<string> | null> {
  return serial(index, async () => {
    const cached = index.byAuthor.get(author)
    if (cached !== undefined) return cached
    const out = new Set<string>()
    let below: number | null = null
    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      const where: [string, '==' | '<', string | number][] = [['$ownerId', '==', author], ['repoId', '==', index.repo.repoId]]
      if (below !== null) where.push(['number', '<', below])
      const docs = await readChunk(sdk, index, { ...repoSource(index.repo).targetQuery(DOC[index.type]), where, orderBy: [['number', 'desc']] }, CHUNK)
      for (const d of docs) if (index.rows.has(str(d, '$id'))) out.add(str(d, '$id'))
      const last = docs[docs.length - 1]?.['number']
      if (docs.length < CHUNK || typeof last !== 'number') {
        index.byAuthor.set(author, out)
        return out
      }
      below = last
    }
    return null
  })
}

/**
 * Every target of the repo's transitions of `kinds` (`perRepoKind`), read once per index: a tab's
 * candidates (the Closed issues, the Merged or Closed PRs; a candidate's current state is its
 * row's). Null when there are too many to read.
 */
export function transitionTargets<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, kinds: readonly number[]): Promise<Set<string> | null> {
  const key = [...kinds].sort().join(',')
  return serial(index, async () => {
    const cached = index.byKinds.get(key)
    if (cached !== undefined) return cached
    let out: Set<string> | null = new Set()
    try {
      for (const kind of kinds) {
        const docs = await queryAllDocuments(
          sdk,
          repoSource(index.repo).repoQuery(DOC.transition, { where: [['kind', '==', kind]], orderBy: [['kind', 'asc']] }),
          { maxPages: KIND_MAX_PAGES },
        )
        for (const d of docs) {
          const id = asIdentifierString(d['targetId'])
          if (id !== '') out.add(id)
        }
      }
    } catch (e) {
      if (!(e instanceof IncompleteReadError)) throw e
      out = null
    }
    index.byKinds.set(key, out)
    return out
  })
}

/**
 * Feed targets whose member events can pass the label, assignee and milestone filters, or null when none
 * applies. A loaded row is checked exactly (`loaded`); one not loaded yet is admitted on its
 * events and filtered once resolved.
 */
export function metaCandidates<Row extends RowExtras>(
  index: ListIndex<Row>,
  q: { readonly labels: readonly string[]; readonly assignee: string | null; readonly milestone?: string | null },
  loaded: (row: Row) => boolean,
): Set<string> | null {
  const assignee = q.assignee !== null && q.assignee !== 'none' ? q.assignee : null
  const milestone = q.milestone ?? null
  if ((q.labels.length === 0 && assignee === null && milestone === null) || index.feed === null) return null
  const out = new Set<string>()
  for (const [id, log] of index.feed) {
    if (id === '' || index.notRows.has(id)) continue
    const row = index.rows.get(id)
    if (row !== undefined) {
      if (loaded(row)) out.add(id)
      continue
    }
    if (q.labels.length > 0 && !log.events.some((e) => e.kind === 'labelAdd')) continue
    if (assignee !== null && !log.events.some((e) => e.kind === 'assign' && e.value === assignee)) continue
    if (milestone !== null && !log.events.some((e) => e.kind === 'milestoneSet' && e.value === milestone)) continue
    out.add(id)
  }
  return out
}

/** The intersection of the candidate sets that apply, or null when none does (the list walks chunks). */
export function intersect(sets: readonly (Set<string> | null)[]): Set<string> | null {
  const [first, ...others] = sets.filter((c): c is Set<string> => c !== null)
  if (first === undefined) return null
  return new Set([...first].filter((id) => others.every((o) => o.has(id))))
}

/**
 * The repo's proved issue and PR totals by state (`readRepoCounts`: the totals and one count of
 * transitions by kind), read once per index and shared with the header's tab counts and the
 * list's total (`sharedRepoCounts`); null when they could not be read (tried again next
 * time).
 */
export async function repoCountsOf<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>): Promise<RepoCounts | null> {
  index.counts ??= sharedRepoCounts(sdk, index.repo)
  return index.counts.catch(() => {
    index.counts = undefined
    return null
  })
}

/**
 * The rows of every feed target with a member event of `kind` (resolved by id; the other type's
 * targets are skipped), or null when the feed was too large to read, so a caller's answer is
 * unknown rather than wrong.
 */
export async function rowsWithEvent<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, kind: TargetLog['events'][number]['kind']): Promise<Row[] | null> {
  if (index.feed === null) return null
  const ids = [...index.feed].filter(([id, log]) => id !== '' && log.events.some((e) => e.kind === kind)).map(([id]) => id)
  await resolveIds(sdk, index, ids)
  return rowsOf(index, ids)
}

/** The loaded rows of `ids`, in order (ids not loaded are skipped). */
export function rowsOf<Row extends RowExtras>(index: ListIndex<Row>, ids: Iterable<string>): Row[] {
  return [...ids].map((id) => index.rows.get(id)).filter((r): r is Row => r !== undefined)
}

/** The rows one list page draws from, and how far they reach. */
export interface Selected<Row> {
  /** Every loaded row that matches, sorted. */
  readonly rows: Row[]
  /** The rows are every match in the repo. */
  readonly complete: boolean
  /** The walk ended short of the repo's end (a timestamp shared by 100+ rows, or the chunk cap). */
  readonly short: boolean
  /** When a walk covered only part of the repo: how many rows it looked at. */
  readonly searched: number | null
}

/**
 * The matching rows for a page: an index-named candidate set resolved by id, or else a keyset walk
 * in `direction` until `want` rows (and one more, for a next page) match, or every chunk for a
 * sort by comments (`walkAll`). `partial` says whether a short walk should report how much it
 * searched (a text search or a comment sort).
 */
export async function selectRows<Row extends RowExtras>(
  sdk: EvoSDK,
  index: ListIndex<Row>,
  {
    candidates,
    matches,
    cmp,
    direction,
    want,
    walkAll,
    partial,
    maxChunks = MAX_CHUNKS,
  }: {
    candidates: Set<string> | null
    matches: (r: Row) => boolean
    cmp: (a: Row, b: Row) => number
    direction: Direction
    want: number
    walkAll: boolean
    partial: boolean
    /** At most this many chunks more (default {@link MAX_CHUNKS}): a side read bounds its cost. */
    maxChunks?: number
  },
): Promise<Selected<Row>> {
  if (candidates !== null) {
    await resolveIds(sdk, index, candidates)
    return { rows: rowsOf(index, candidates).filter(matches).sort(cmp), complete: true, short: false, searched: null }
  }
  const walk = index.walks[direction]
  // Once every row is loaded, the walk's own order does not matter: sort the whole set.
  const loaded = (): string[] => (index.all ? [...index.rows.keys()] : walk.ids)
  const matching = (): Row[] => rowsOf(index, loaded()).filter(matches)
  let chunks = 0
  for (; !walk.done && !index.all && chunks < maxChunks && (walkAll || matching().length <= want); chunks++) {
    await serial(index, async () => {
      if (walk.done || index.all) return
      const bound: [string, '<=' | '>=', number][] = walk.bound === null ? [] : [['$createdAt', direction === 'desc' ? '<=' : '>=', walk.bound]]
      await readChunk(sdk, index, repoSource(index.repo).repoQuery(DOC[index.type], { where: bound, orderBy: [['$createdAt', direction]] }), CHUNK, { walk })
    })
  }
  const complete = index.all || (walk.done && walk.complete)
  const short = !complete && (walk.done || chunks >= maxChunks)
  return { rows: matching().sort(cmp), complete, short, searched: !complete && partial ? loaded().length : null }
}

/**
 * The rows matching a filter in any state (a filtered list's tab counts): every candidate an index
 * names, resolved, or every row once all are loaded; null when only a chunk walk could tell.
 */
export async function rowsInAnyState<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, candidates: Set<string> | null, matches: (r: Row) => boolean): Promise<Row[] | null> {
  if (candidates !== null) {
    await resolveIds(sdk, index, candidates)
    return rowsOf(index, candidates).filter(matches)
  }
  return index.all ? [...index.rows.values()].filter(matches) : null
}

/** The rows of page `page` (1-based) of `pageSize`, and whether a next page exists. */
export function pageOf<Row>(rows: readonly Row[], page: number, pageSize: number): { rows: Row[]; hasNext: boolean } {
  const start = (page - 1) * pageSize
  return { rows: rows.slice(start, start + pageSize), hasNext: rows.length > start + pageSize }
}

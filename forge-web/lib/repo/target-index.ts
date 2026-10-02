/**
 * What the issue index (`./issue-index`) and the pull index (`./pull-index`) share: a keyset walk
 * over one document type read in composites of 100 (with comment counts, author names and the
 * rows' member events), each chunk's states from one proved sum of its transitions
 * (`./transitions` `readStateCodes`), the label definitions read once, `$id in` resolution of ids
 * an index names but has not loaded, the `author` index, the targets of a transition kind, the
 * proved counts, and the per-repo cache a write drops (`platform-parity-spec.md` §1.2, §3.3;
 * L-44, L-77).
 *
 * An unfiltered page's rows cost what the page needs, not what the repo holds (QW2-002):
 * - a row's labels and assignees come from its own member events, the `event` `target` lookup
 *   each chunk composite carries (complete when it comes back short of its limit; else read for
 *   the rows a page shows, `targetId in`). The `target` index is repo-scoped in effect: an event's
 *   `targetId` must name an issue or PR of the event's own `repoId` (`refersTo`), which only that
 *   repo's members may write. The repo's whole member-event feed is read only for what needs
 *   every target's events: a label, assignee or milestone filter, a milestone's progress, and the
 *   issue list's pinned issues (no index finds a pin without it, so page 1 of the issue list still
 *   reads the feed, up to its page cap);
 * - an unfiltered walk stops reading once it holds every row the tab's proved count allows, and
 *   reads at most {@link PAGE_CHUNKS} chunks per page load once the page has a row to show (the
 *   page then says how far it read and offers to read on); a page with nothing to show yet reads
 *   on as a search does, with its progress reported;
 * - a state tab reads its transitions' targets only when the proved counts say that is cheaper
 *   than walking ({@link candidatesCheaper}).
 *
 * Each index supplies its views through a {@link ViewBuilder} (an admitted document, its member
 * events and its state code in; the issue or PR view out); the engine adds the comment counts.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { compositeOf, countsAt, docsAt, queryComposite, siblingOf, type CompositeResult, type CompositeSub } from '../sdk/composite'
import { IncompleteReadError, queryAllDocuments, queryDocumentsWithProof, type DocumentQuery, type PlainDocument } from '../sdk'
import { ISSUE_CLOSE, closeReasonOf, statusOfCode, type CloseReason } from '../rules/transition'
import { compareKey } from '../rules/oid'
import { DOC, asIdentifierString, num, repoKey, str, type RepoRef } from './contract'
import { EMPTY_LOG, feedQuery, groupFeed, onRepoInvalidated, readRepoFeedFrom, repoEpoch, sharedRepoCounts, sharedRepoFeed, toLog, type TargetLog } from './issues'
import { newestLabels, type LabelDef } from './labels'
import { HiddenTally, gateFor, type ContentGate } from './private-content'
import { onPrivateSessionEnded } from './private-session'
import { repoSource } from './source'
import { newScan, readScanPage, scanCodes, scanFloor, settledCode, type StateScan } from './state-scan'
import { readStateCodes, transitionOf, type readRepoCounts, type TransitionView } from './transitions'

/** The repo's proved issue and PR totals by state ({@link repoCountsOf}). */
export type RepoCounts = Awaited<ReturnType<typeof readRepoCounts>>
type Direction = 'desc' | 'asc'

/** Rows per keyset chunk (the page limit of one composite). */
const CHUNK = 100
/** Chunks one call may read to satisfy a filtered query (a sort by comments reads every chunk up to this). */
const MAX_CHUNKS = 30
/**
 * Chunks an unfiltered page load reads beyond what the index holds (two requests each: the
 * composite and its state sum), so a page costs the same on a repo of 200 rows or 20,000.
 */
export const PAGE_CHUNKS = 3
/** Pages of one transition kind read for a tab's candidates before the tab walks chunks instead. */
const KIND_MAX_PAGES = 30
/** The chunk composite's member-event lookup limit: fewer rows back means every row's events are in it. */
const EVENT_LOOKUP = 100
/** Where that lookup sits among a chunk composite's sub-queries ({@link chunkSubs}). */
const EVENT_SUB = 2
/** Pages of one target's member events read before its labels and assignees are declared unverified. */
const LOG_MAX_PAGES = 10

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
  /** Its dense number (issues and PRs share one sequence, in creation order). */
  readonly number: number
  readonly createdAt: number
  readonly comments: number | null
  /** False when the row's member events were not read completely: its labels and assignees are unverified. */
  readonly stateComplete: boolean
}

/** What a row is built from, kept so it can be built again once its member events are read. */
interface RowSource {
  readonly doc: PlainDocument
  readonly code: number
  readonly comments: number | null
}

/**
 * An index's one view step: an admitted document, its member events and its state code (the
 * proved sum of its transitions) in; the issue or PR view out.
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
  /**
   * The repo's member-event feed by target, once a reader needed it ({@link feedOf}); null when
   * it is too large to read completely; undefined until then (rows carry their own events).
   */
  feed?: Map<string, TargetLog> | null
  /** The feed's first page, when the first composite carried it (the issue index: pinned issues read the feed). */
  readonly feedFirst?: readonly PlainDocument[]
  /** The repo's write epoch when the index was read (`repoEpoch`): a feed from before a write is not shared. */
  readonly epoch: number
  /** The feed read, once started. */
  feedRead?: Promise<Map<string, TargetLog> | null>
  /** The feed ran past a bounded read (the issue list's pinned issues): not read again for them. */
  feedLong?: boolean
  readonly labels: LabelDef[]
  readonly rows: Map<string, Row>
  /** What each row was built from. */
  readonly sources: Map<string, RowSource>
  /** Rows built before their member events were read (no labels or assignees yet): {@link hydrate} reads them. */
  readonly unhydrated: Set<string>
  /** Rows whose member events are not known complete: the unhydrated, and those whose events outgrew the read. */
  readonly unverified: Set<string>
  /** Ids proven not to be (well-formed, shown) rows of this type: the other type, malformed, hidden. */
  readonly notRows: Set<string>
  /** The loaded rows' ids by number. */
  readonly byNumber: Map<number, string>
  /** Numbers proven not to be (shown) rows of this type: the other type's, or hidden rows'. */
  readonly notNumbers: Set<number>
  /** The repo's state scan, once a sparse tab used it (`./state-scan`). */
  scan?: StateScan
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
  /** The repo's transitions of one kind, once read (null: too many). */
  readonly byKind: Map<number, readonly TransitionView[] | null>
  /** The repo's proved counts, read once per index (a write drops the index). */
  counts?: Promise<RepoCounts>
  readonly gate: ContentGate
  readonly view: ViewBuilder<Row>
}

const newWalk = (): Walk => ({ ids: [], bound: null, done: false, complete: true })

/**
 * The sub-queries every chunk carries: comment counts, the authors' DPNS names, and the rows'
 * member events (the `event` `target` index, `targetId in` the chunk's ids; at
 * {@link EVENT_SUB}).
 */
function chunkSubs(repo: RepoRef, network: Network): CompositeSub[] {
  return [
    { documentType: DOC.comment, kind: 'counts', bind: { sourceProperty: '$id', field: 'targetId' } },
    {
      dataContractId: NETWORKS[network].dpnsContractId,
      documentType: 'domain',
      bind: { sourceProperty: '$ownerId', field: 'records.identity' },
      limit: 100,
    },
    { dataContractId: repoSource(repo).targetQuery(DOC.event).dataContractId, documentType: DOC.event, bind: { sourceProperty: '$id', field: 'targetId' }, limit: EVENT_LOOKUP },
  ]
}

/**
 * `ids`' member-event logs from `docs` (every event of those targets): only the repo's own
 * events count (the `target` index is not scoped to a repo, and the feed only holds the repo's),
 * a private repo's values opened (`toLog`). A target with none has the empty log.
 */
async function logsOf(repo: RepoRef, docs: readonly PlainDocument[], ids: readonly string[]): Promise<Map<string, TargetLog>> {
  const own = docs.filter((d) => asIdentifierString(d['repoId']) === repo.repoId)
  const log = await toLog(repo, own, [])
  const byTarget = groupFeed(log.events, [])
  return new Map(ids.map((id) => [id, byTarget.get(id) ?? EMPTY_LOG]))
}

/** The logs a chunk composite's event lookup proves complete (it came back short of its limit), or null. */
function lookupLogs(repo: RepoRef, res: CompositeResult, ids: readonly string[]): Promise<Map<string, TargetLog>> | null {
  const sub = res.subs[EVENT_SUB]
  if (sub?.kind !== 'documents' || sub.documents.length >= EVENT_LOOKUP) return null
  return logsOf(repo, sub.documents, ids)
}

/** `ids`' member-event logs from the repo's feed. A target with none has the empty log. */
function feedLogs(feed: Map<string, TargetLog>, ids: readonly string[]): Map<string, TargetLog> {
  return new Map(ids.map((id) => [id, feed.get(id) ?? EMPTY_LOG]))
}

/**
 * The complete member-event logs of `ids` (null for a target whose events outgrow
 * {@link LOG_MAX_PAGES}): `targetId in` reads of up to 100 targets; a read that comes back full
 * is split in two until it does not (one target is paged on its own).
 */
async function readLogs(sdk: EvoSDK, repo: RepoRef, ids: readonly string[]): Promise<Map<string, TargetLog | null>> {
  const out = new Map<string, TargetLog | null>()
  const source = repoSource(repo)
  const read = async (batch: readonly string[]): Promise<void> => {
    if (batch.length === 1) {
      const id = batch[0] as string
      const docs = await queryAllDocuments(
        sdk,
        source.targetQuery(DOC.event, { where: [['targetId', '==', id]], orderBy: [['targetId', 'asc'], ['$createdAt', 'asc']] }),
        { maxPages: LOG_MAX_PAGES },
      ).catch((e: unknown) => {
        if (e instanceof IncompleteReadError) return null
        throw e
      })
      out.set(id, docs === null ? null : ((await logsOf(repo, docs, batch)).get(id) ?? EMPTY_LOG))
      return
    }
    const { documents } = await queryDocumentsWithProof(sdk, {
      ...source.targetQuery(DOC.event, { where: [['targetId', 'in', [...batch].sort()]], orderBy: [['targetId', 'asc']] }),
      limit: EVENT_LOOKUP,
    })
    if (documents.length < EVENT_LOOKUP) {
      for (const [id, log] of await logsOf(repo, documents, batch)) out.set(id, log)
      return
    }
    const half = Math.ceil(batch.length / 2)
    await Promise.all([read(batch.slice(0, half)), read(batch.slice(half))])
  }
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += CHUNK) batches.push(ids.slice(i, i + CHUNK))
  await Promise.all(batches.map(read))
  return out
}

/** Build a row from its source and its member events (null: not read completely, so unverified). */
async function buildRow<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, src: RowSource, log: TargetLog | null): Promise<Row> {
  const view = await index.view(sdk, index, src.doc, log ?? EMPTY_LOG, src.code)
  // A view the builder could not complete (a PR's base history) stays unverified too.
  return { ...view, stateComplete: log !== null && view.stateComplete !== false, comments: src.comments } as Row
}

/**
 * Give the rows of `ids` built without their member events their labels and assignees: from the
 * feed when a reader has read it, else from their own events ({@link readLogs}).
 */
export function hydrate<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, ids: Iterable<string>): Promise<void> {
  // Copied now: `ids` may be `index.unhydrated` itself, which this read empties.
  const wanted = new Set(ids)
  return serial(index, async () => {
    // Rows not read yet; and, once the complete feed is read, rows whose own read fell short.
    const todo = [...wanted].filter((id) => index.unhydrated.has(id) || (index.feed != null && index.unverified.has(id)))
    if (todo.length === 0) return
    const logs = index.feed != null ? feedLogs(index.feed, todo) : await readLogs(sdk, index.repo, todo)
    const rows = await Promise.all(todo.map((id) => buildRow(sdk, index, index.sources.get(id) as RowSource, logs.get(id) ?? null)))
    for (const row of rows) {
      index.rows.set(row.id, row)
      index.unhydrated.delete(row.id)
      if (logs.get(row.id) != null) index.unverified.delete(row.id)
    }
  })
}

/** Whether every one of `rows` has its complete member events (its labels and assignees are verified). */
export function logsVerified<Row extends RowExtras>(index: ListIndex<Row>, rows: readonly Row[]): boolean {
  return rows.every((r) => !index.unverified.has(r.id))
}

/**
 * The repo's member-event feed, read once per index (joined with the other index's read) for
 * what needs every target's events; every row built so far without its events takes them from
 * it. Null when the feed is too large to read completely.
 */
export function feedOf<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>): Promise<Map<string, TargetLog> | null> {
  if (index.feedRead === undefined) {
    const read = (async () => {
      const feed = await (sharedRepoFeed(index.repo) ?? readRepoFeedFrom(sdk, index.repo, index.feedFirst, index.epoch))
      await serial(index, async () => {
        index.feed = feed
      })
      if (feed !== null) await hydrate(sdk, index, [...index.unhydrated, ...index.unverified])
      return feed
    })()
    index.feedRead = read
    read.catch(() => {
      if (index.feedRead === read) index.feedRead = undefined
    })
  }
  return index.feedRead
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
  const hidden: { id: string; reason: Parameters<HiddenTally['add']>[0]; number: number }[] = []
  for (const raw of docs) {
    const id = str(raw, '$id')
    if (id === '' || index.notRows.has(id) || index.rows.has(id) || fresh.has(id) || hidden.some((h) => h.id === id)) continue
    const admitted = await index.gate.admit(index.type, raw)
    if (admitted.ok) fresh.set(id, admitted.doc)
    else hidden.push({ id, reason: admitted.reason, number: num(raw, 'number') })
  }
  const code = await codes
  // The rows' member events: the feed's, once read; else the chunk's own lookup when it is
  // complete; else read later, for the rows a page shows ({@link hydrate}).
  const ids = [...fresh.keys()]
  const logs = index.feed != null ? feedLogs(index.feed, ids) : await lookupLogs(index.repo, res, ids)
  const built = await Promise.all(
    [...fresh].map(async ([id, doc]) => {
      const src: RowSource = { doc, code: code.get(id) ?? 0, comments: counts === null ? null : counts.get(id) ?? 0 }
      return { src, row: await buildRow(sdk, index, src, logs?.get(id) ?? null) }
    }),
  )
  // Every read is done: record.
  for (const { src, row } of built) {
    index.rows.set(row.id, row)
    index.byNumber.set(row.number, row.id)
    index.sources.set(row.id, src)
    if (logs === null) {
      index.unhydrated.add(row.id)
      index.unverified.add(row.id)
    }
  }
  for (const { id, reason, number } of hidden) {
    index.notRows.add(id)
    if (number > 0) index.notNumbers.add(number)
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

/** What a reader already knows of some documents' state codes (a state scan's), by id; the rest are summed. */
export type KnownCodes = (docs: readonly PlainDocument[]) => ReadonlyMap<string, number>

/**
 * Read one chunk (`page`, up to `limit`) with its comment counts and names, and record it. Its
 * states are one proved sum, but for those `known` already proves (none summed when it proves all).
 */
async function readChunk<Row extends RowExtras>(
  sdk: EvoSDK,
  index: ListIndex<Row>,
  page: DocumentQuery,
  limit: number,
  { walk = null, keep, known }: { walk?: Walk | null; keep?: (d: PlainDocument) => boolean; known?: KnownCodes } = {},
): Promise<PlainDocument[]> {
  const res = await queryComposite(sdk, compositeOf(page, limit, chunkSubs(index.repo, index.network)))
  const docs = keep ? res.page.filter(keep) : res.page
  const have = known?.(docs) ?? new Map<string, number>()
  const rest = docs.filter((d) => !have.has(str(d, '$id')))
  const codes = rest.length === 0 ? Promise.resolve(new Map(have)) : codesOf(sdk, index.repo, rest).then((m) => new Map([...have, ...m]))
  await recordChunk(sdk, index, res, docs, walk, codes)
  return docs
}

/**
 * First load, ONE composite: the newest 100 rows with their comment counts, author names and
 * member events, and as siblings the label definitions and (`withFeed`, unless another reader
 * has the feed already) the feed's first page. Beside it the rows' state sum, and the rest of
 * the labels when their first page was full. The feed is not read here ({@link feedOf}).
 * `withCounts`: the proved counts go out beside the composite (a list page stops its walk by
 * them), so they are never older than the index's first chunk by more than their shared read.
 */
async function loadListIndex<Row extends RowExtras>(
  sdk: EvoSDK,
  repo: RepoRef,
  network: Network,
  type: 'issue' | 'patch',
  view: ListIndex<Row>['view'],
  { withFeed, withCounts }: { readonly withFeed: boolean; readonly withCounts: boolean },
): Promise<ListIndex<Row>> {
  const counts = withCounts ? sharedRepoCounts(sdk, repo) : undefined
  counts?.catch(() => undefined)
  const source = repoSource(repo)
  const labelQuery = source.repoQuery(DOC.label, { orderBy: [['name', 'asc'], ['$createdAt', 'asc']] })
  const page = source.repoQuery(DOC[type], { orderBy: [['$createdAt', 'desc']] })
  const epoch = repoEpoch(repo)
  const feedSibling = withFeed && sharedRepoFeed(repo) === undefined
  const subs = [...chunkSubs(repo, network), siblingOf(labelQuery, CHUNK), ...(feedSibling ? [siblingOf(feedQuery(repo), CHUNK)] : [])]
  const res = await queryComposite(sdk, compositeOf(page, CHUNK, subs))
  // The first chunk's states are read beside the rest of the labels, not after them.
  const codes = codesOf(sdk, repo, res.page)
  codes.catch(() => undefined)
  let labelDocs = docsAt(res, EVENT_SUB + 1)
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
    ...(feedSibling ? { feedFirst: docsAt(res, EVENT_SUB + 2) } : {}),
    ...(counts !== undefined ? { counts } : {}),
    epoch,
    labels: newestLabels(labelDocs),
    rows: new Map(),
    sources: new Map(),
    unhydrated: new Set(),
    unverified: new Set(),
    notRows: new Set(),
    byNumber: new Map(),
    notNumbers: new Set(),
    hidden: new HiddenTally(),
    hiddenOpen: 0,
    walks: { desc: newWalk(), asc: newWalk() },
    queue: Promise.resolve(),
    all: false,
    byAuthor: new Map(),
    byKinds: new Map(),
    byKind: new Map(),
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
export function indexCache<Row extends RowExtras>(
  type: 'issue' | 'patch',
  view: ListIndex<Row>['view'],
  { withFeed = false }: { readonly withFeed?: boolean } = {},
): (sdk: EvoSDK, repo: RepoRef, network: Network, opts?: { readonly withCounts?: boolean }) => Promise<ListIndex<Row>> {
  const indexes = new Map<string, Promise<ListIndex<Row>>>()
  onRepoInvalidated((repo) => {
    const at = `:${repo.forge.collab}:${repo.repoId}`
    for (const key of [...indexes.keys()]) if (key.endsWith(at) || key.includes(`${at}#`)) indexes.delete(key)
  })
  onPrivateSessionEnded((id) => {
    for (const key of [...indexes.keys()]) if (key.endsWith(`#${id}`)) indexes.delete(key)
  })
  // `withCounts`: a list page's load reads the proved counts beside its first chunk; a side read
  // (an issue page's backlinks) does not, and a later list page reads them then (`repoCountsOf`).
  return (sdk, repo, network, { withCounts = false } = {}) => {
    const key = `${network}:${repo.forge.collab}:${repoKey(repo)}`
    let hit = indexes.get(key)
    if (hit === undefined) {
      hit = loadListIndex(sdk, repo, network, type, view, { withFeed, withCounts })
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
 * Resolve rows by number (the `number` index, `number in` composites of up to 100): the numbers a
 * state scan names but no loaded chunk holds. A number with no document of this type is the other
 * type's (or hidden), recorded so it is not asked for again.
 */
export function resolveNumbers<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, numbers: Iterable<number>, known?: KnownCodes): Promise<void> {
  const wanted = [...numbers]
  return serial(index, async () => {
    const todo = [...new Set(wanted)].filter((n) => !index.byNumber.has(n) && !index.notNumbers.has(n)).sort((a, b) => a - b)
    if (index.all) {
      for (const n of todo) index.notNumbers.add(n)
      return
    }
    const source = repoSource(index.repo)
    for (let i = 0; i < todo.length; i += CHUNK) {
      const batch = todo.slice(i, i + CHUNK)
      await readChunk(sdk, index, source.repoQuery(DOC[index.type], { where: [['number', 'in', batch]], orderBy: [['number', 'asc']] }), batch.length, known ? { known } : {})
      for (const n of batch) if (!index.byNumber.has(n)) index.notNumbers.add(n)
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
    for (const kind of kinds) {
      const docs = await kindTransitions(sdk, index, kind)
      if (docs === null) {
        out = null
        break
      }
      for (const t of docs) if (t.targetId !== '') out.add(t.targetId)
    }
    index.byKinds.set(key, out)
    return out
  })
}

/**
 * Every transition of one `kind` in the repo (`perRepoKind`), read once per index; null when there
 * are more than {@link KIND_MAX_PAGES} pages. Runs inside the index's queue (its callers' `serial`).
 */
async function kindTransitions<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, kind: number): Promise<readonly TransitionView[] | null> {
  const cached = index.byKind.get(kind)
  if (cached !== undefined) return cached
  let out: TransitionView[] | null
  try {
    const docs = await queryAllDocuments(
      sdk,
      repoSource(index.repo).repoQuery(DOC.transition, { where: [['kind', '==', kind]], orderBy: [['kind', 'asc']] }),
      { maxPages: KIND_MAX_PAGES },
    )
    out = docs.map(transitionOf)
  } catch (e) {
    if (!(e instanceof IncompleteReadError)) throw e
    out = null
  }
  index.byKind.set(kind, out)
  return out
}

/**
 * The issues whose newest close says `reason` (`reason:`, QW4-028): from the repo's issue-close
 * transitions, the same read as the Closed tab's candidates. A close that gives no reason is a
 * completed one, as its icon says. The newest close is the current reason only while the issue is
 * closed: the caller checks the row's state. Null when there are too many closes to read.
 */
export function closedWithReason<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, reason: CloseReason): Promise<Set<string> | null> {
  return serial(index, async () => {
    const closes = await kindTransitions(sdk, index, ISSUE_CLOSE)
    if (closes === null) return null
    const newest = new Map<string, TransitionView>()
    for (const t of closes) {
      const seen = newest.get(t.targetId)
      if (seen === undefined || compareKey(t, seen) > 0) newest.set(t.targetId, t)
    }
    const out = new Set<string>()
    for (const [id, t] of newest) if ((closeReasonOf(t, 0)?.reason ?? 'completed') === reason) out.add(id)
    return out
  })
}

/**
 * Feed targets whose member events can pass the label, assignee and milestone filters, or null when none
 * applies or the feed is not read ({@link feedOf} first). A loaded row is checked exactly
 * (`loaded`); one not loaded yet is admitted on its events and filtered once resolved.
 */
export function metaCandidates<Row extends RowExtras>(
  index: ListIndex<Row>,
  q: { readonly labels: readonly string[]; readonly assignee: string | null; readonly milestone?: string | null },
  loaded: (row: Row) => boolean,
): Set<string> | null {
  const assignee = q.assignee !== null && q.assignee !== 'none' ? q.assignee : null
  const milestone = q.milestone ?? null
  const feed = index.feed
  if ((q.labels.length === 0 && assignee === null && milestone === null) || feed == null) return null
  const out = new Set<string>()
  for (const [id, log] of feed) {
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
 * Whether a state tab should read its candidates (every target of its transition kinds, resolved
 * by id: about three requests per 100) rather than walk the newest rows (two per chunk of 100)
 * until the page is full (every row, for a sort by comments), by the proved counts: `tab` rows of
 * `total`. A dense tab (most PRs are merged) fills its page from a chunk or two; a sparse one (a
 * handful of closed issues among thousands) is cheaper by its transitions. Unknown counts read
 * the candidates (the complete answer).
 */
export function candidatesCheaper<Row extends RowExtras>(index: ListIndex<Row>, walk: PageWalk, tab: number | null, total: number | null): boolean {
  if (tab === null || total === null) return true
  if (tab === 0 || index.all) return false
  const need = walk.walkAll ? tab : Math.min(walk.want + 1, tab)
  const chunks = Math.max(0, Math.ceil((need * total) / tab / CHUNK) - Math.floor(index.walks[walk.direction].ids.length / CHUNK))
  return 3 * Math.ceil(tab / CHUNK) < 2 * chunks
}

/** Of the repo's open issues and PRs, the share that are `typeOpen` (one type's open rows), for {@link ScanTab.openShare}. */
export function openShare(counts: RepoCounts, typeOpen: number): number {
  const all = counts.issuesOpen + counts.prsOpen
  return all > 0 ? Math.max(typeOpen / all, 0.01) : 1
}

/**
 * Whether an unfiltered state tab is cheaper to read through the state scan ({@link scanSelect})
 * than by walking its rows, by the proved counts: walking reads two heavy requests per 100 rows of
 * this type until the page's rows are held; the scan one light request per 100 state changes
 * until it covers them, plus a read per 100 rows it names (for the Open tab, numbers no change
 * names: every open row of either type among them). A dense tab fills from a chunk or two; the
 * Open PRs of a repo with thousands of merged ones (QW3-002) are found by the scan. A public repo
 * only (a private repo's counts include rows this reader cannot open), newest or oldest first.
 */
export function scanCheaper<Row extends RowExtras>(
  index: ListIndex<Row>,
  walk: PageWalk,
  tab: number,
  counts: RepoCounts,
  openTab: boolean,
): boolean {
  if (index.repo.visibility === 'private' || walk.walkAll || index.all || tab <= 0) return false
  const typeTotal = index.type === 'issue' ? counts.issues : counts.patches
  const transitions = counts.transitions
  if (transitions <= 0) return false
  const need = walk.direction === 'desc' ? Math.min(walk.want + 1, tab) : tab
  const walked = index.walks[walk.direction].ids.length
  const walkCost = 2 * Math.max(0, Math.ceil((need * typeTotal) / tab / CHUNK) - Math.floor(walked / CHUNK))
  // A page the walk already holds costs nothing more: never scan for it.
  if (walkCost === 0) return false
  const scan = index.scan
  // A scan that has read every change only names and reads the page's rows.
  const pages = scan?.done && scan.complete ? 0 : Math.max(0, Math.ceil((need * transitions) / tab / CHUNK) - (scan?.pages ?? 0))
  const share = openTab ? openShare(counts, Math.min(tab, index.type === 'issue' ? counts.issuesOpen : counts.prsOpen)) : 1
  return pages + Math.ceil(need / share / CHUNK) < walkCost
}

/**
 * The rows of every feed target with a member event of `kind` (resolved by id; the other type's
 * targets are skipped), or null when the feed was too large to read, so a caller's answer is
 * unknown rather than wrong.
 */
export async function rowsWithEvent<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, kind: TargetLog['events'][number]['kind']): Promise<Row[] | null> {
  const feed = await feedOf(sdk, index)
  if (feed === null) return null
  const ids = [...feed].filter(([id, log]) => id !== '' && log.events.some((e) => e.kind === kind)).map(([id]) => id)
  await resolveIds(sdk, index, ids)
  await hydrate(sdk, index, ids)
  return rowsOf(index, ids)
}

/** The loaded rows of `ids`, in order (ids not loaded are skipped). */
export function rowsOf<Row extends RowExtras>(index: ListIndex<Row>, ids: Iterable<string>): Row[] {
  return [...ids].map((id) => index.rows.get(id)).filter((r): r is Row => r !== undefined)
}

/** How far a list page read when its answer covers only part of the repo. */
export interface SearchedOf {
  /**
   * Rows looked at, newest (or oldest) first; for a state scan (`kind` `scan`), the newest issue
   * and PR numbers its state changes cover.
   */
  readonly searched: number
  /** Rows in the repo, when known (a state scan: issues and PRs together). */
  readonly total: number | null
  /** The page stopped at its chunk budget: reading on (the same query again) looks further. */
  readonly more: boolean
  /**
   * What was read: rows matched against a search (`rows`, the default), rows sorted by their
   * comment counts (`sort`), or the state changes a sparse tab finds its rows through (`scan`).
   */
  readonly kind?: 'rows' | 'sort' | 'scan'
  /**
   * The tab's proved count says rows are still unread: the list reads on by itself (a state
   * scan), rather than waiting to be asked.
   */
  readonly auto?: boolean
}

/** What a list page's caller may ask besides its query. */
export interface ListOptions {
  /** Told how many rows a walk holds after each chunk it reads (a search's progress). */
  readonly onProgress?: (searched: number) => void
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
  /** The walk stopped at its chunk budget before the page was full: reading on can find more. */
  readonly more: boolean
  /** What `searched` counts ({@link SearchedOf.kind}); absent: rows. */
  readonly kind?: SearchedOf['kind']
  /** Reading on is the list's own next step ({@link SearchedOf.auto}). */
  readonly auto?: boolean
  /** What `searched` is out of, when the selection knows it better than the caller (a scan). */
  readonly total?: number | null
}

/**
 * The matching rows for a page: an index-named candidate set resolved by id, or else a keyset walk
 * in `direction` until `want` rows (and one more, for a next page) match, every row the proved
 * count says there is (`known`) is held, or (a sort by comments, `walkAll`) every chunk. At most
 * `maxChunks` chunks are read per call; `partial` says whether a short walk should report how
 * much it searched (a text search or a comment sort; a walk that stopped at its budget always
 * does). `needLogs`: `matches` reads labels, assignees or milestones, so every row is given its
 * member events before it is matched. `onProgress` is told how many rows the walk holds after
 * each chunk.
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
    minRows = 0,
    known = () => null,
    needLogs = false,
    onProgress,
  }: {
    candidates: Set<string> | null
    matches: (r: Row) => boolean
    cmp: (a: Row, b: Row) => number
    direction: Direction
    want: number
    walkAll: boolean
    partial: boolean
    /** At most this many chunks more (default {@link MAX_CHUNKS}): a page or a side read bounds its cost. */
    maxChunks?: number
    /** Until this many rows match (a page's first row), read on to {@link MAX_CHUNKS} rather than stop at `maxChunks`. */
    minRows?: number
    /** How many rows can match in the whole repo, when proved (an unfiltered tab's count), else null. */
    known?: () => number | null
    needLogs?: boolean
    onProgress?: (searched: number) => void
  },
): Promise<Selected<Row>> {
  if (candidates !== null) {
    await resolveIds(sdk, index, candidates)
    if (needLogs) await hydrate(sdk, index, candidates)
    return { rows: rowsOf(index, candidates).filter(matches).sort(cmp), complete: true, short: false, searched: null, more: false }
  }
  const walk = index.walks[direction]
  // Once every row is loaded, the walk's own order does not matter: sort the whole set.
  const loaded = (): string[] => (index.all ? [...index.rows.keys()] : walk.ids)
  const matching = (): Row[] => rowsOf(index, loaded()).filter(matches)
  // Every row the proved count allows is held: no chunk can add one, so reading stops (the walk
  // is not complete for that: it has not reached the repo's end).
  const holdsAll = (found: number): boolean => {
    const n = known()
    return n !== null && found >= n
  }
  const enough = (): boolean => {
    const found = matching().length
    return holdsAll(found) || (!walkAll && found > want)
  }
  // A page with nothing to show yet reads on as a search does, when the proved count says there
  // is something to find (not for an empty tab, nor a count that may lag this browser's write).
  const budget = (): number => {
    const n = known()
    return matching().length >= minRows || n === null || n === 0 ? maxChunks : Math.max(maxChunks, MAX_CHUNKS)
  }
  if (needLogs) await hydrate(sdk, index, loaded())
  let chunks = 0
  for (; !walk.done && !index.all && chunks < budget() && !enough(); chunks++) {
    await serial(index, async () => {
      if (walk.done || index.all) return
      const bound: [string, '<=' | '>=', number][] = walk.bound === null ? [] : [['$createdAt', direction === 'desc' ? '<=' : '>=', walk.bound]]
      await readChunk(sdk, index, repoSource(index.repo).repoQuery(DOC[index.type], { where: bound, orderBy: [['$createdAt', direction]] }), CHUNK, { walk })
    })
    if (needLogs) await hydrate(sdk, index, loaded())
    onProgress?.(loaded().length)
  }
  const rows = matching()
  const complete = index.all || (walk.done && walk.complete)
  // Stopped at the chunk budget with the page unfilled: reading on can find more.
  const more = !complete && !walk.done && !enough()
  const short = !complete && (walk.done || more)
  // Every row the proved count allows is held: a search or sort over them saw them all.
  const searched = !complete && (more || (partial && !holdsAll(rows.length))) ? loaded().length : null
  return { rows: rows.sort(cmp), complete, short, searched, more, ...(walkAll ? { kind: 'sort' as const } : {}) }
}

/** State-scan pages one list load reads at most before it shows what it has and reads on. */
export const SCAN_PAGES_PER_LOAD = 15
/** State-scan pages a list reads on by itself at most, over all its loads (then it waits to be asked). */
export const SCAN_AUTO_PAGES = 200
/** Scan pages between reads of the candidates they named, when those are not yet expected to fill the page. */
const RESOLVE_EVERY = 4

/** A sparse tab read through the state scan ({@link scanSelect}). */
export interface ScanTab<Row> {
  /** Whether a row in state `code` (`statusOfCode`) is in the tab. */
  readonly inTab: (code: number) => boolean
  /** Whether a loaded row is in the tab (its proved state). */
  readonly matches: (r: Row) => boolean
  readonly cmp: (a: Row, b: Row) => number
  /** Newest or oldest first. */
  readonly direction: Direction
  /** Rows the page needs (its own and one more, for a next page). */
  readonly want: number
  /** How many rows the tab holds in the whole repo (its proved count). */
  readonly known: number
  /** The repo's issue and PR numbers run 1..`max` (the proved totals: numbering is dense). */
  readonly max: number
  /** This index's type's rows in the repo (its proved total): progress is told in them. */
  readonly typeTotal: number
  /** Of the repo's open issues and PRs, the share that are of this index's type (how many unnamed numbers to read per open row expected). */
  readonly openShare: number
  readonly onProgress?: (covered: number) => void
}

/**
 * A sparse tab's rows through the repo's state scan (`./state-scan`), QW3-002: the Open PRs of a
 * mirror with thousands of merged ones sit anywhere in its history, and walking every PR above
 * them costs two heavy reads per 100. The scan reads the repo's state changes newest first (one
 * light read per 100) and names the tab's candidates among the numbers it covers: a row whose
 * newest state change puts it in the tab (or whose state the scan cannot settle), and, for a tab
 * that holds open rows, every number no change names that was created after the watermark (one
 * never closed). Only those are read, by id or number, each with its proved state sum. Reading
 * stops when the page is proved:
 *
 * - every row the tab's proved count allows is held; or
 * - the page's last row was created after the scan's watermark: every number above it was too,
 *   so every state change of theirs is read and every candidate among them is named and read;
 * - or the scan reached the repo's first state change.
 *
 * At most {@link SCAN_PAGES_PER_LOAD} scan pages per call: past that the answer is partial and says
 * so (`more`, `auto`: the proved count says rows are still missing, so the list reads on).
 * Candidates are read in batches, once enough of them are expected to be the tab's rows
 * (`openShare` of the unnamed numbers), not after every scan page.
 */
export async function scanSelect<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, tab: ScanTab<Row>): Promise<Selected<Row>> {
  const scan = (index.scan ??= newScan())
  const kind = index.type === 'issue' ? 0 : 1
  const openTab = tab.inTab(0) || tab.inTab(8)
  // The newest-first page needs its own rows and one more; an oldest-first one needs every row of
  // the tab (the oldest come last), unless the scan reaches the start.
  const need = tab.direction === 'desc' ? Math.min(tab.want, tab.known) : tab.known
  const tabRows = (): Row[] => [...index.rows.values()].filter(tab.matches).sort((a, b) => b.number - a.number)
  // How far the scan reaches, in this type's rows (about: the numbers it covers are both types').
  const covered = (): number => Math.round((Math.max(0, tab.max - Math.max(1, scanFloor(scan)) + 1) * tab.typeTotal) / Math.max(1, tab.max))
  // The lowest number no state change names that can be taken as never closed: above every
  // loaded row created before the watermark (numbers run in creation order), and within the scan's
  // reach (its oldest page's middle number: a page of late closes of old rows does not drag it
  // down). A number named below it is read and its proved state decides; this bounds the cost.
  const gapFloor = (): number => {
    if (scan.done && scan.complete) return 1
    const mark = scan.watermark
    if (mark === null) return tab.max + 1
    let stale = 0
    for (const r of index.rows.values()) if (r.createdAt <= mark && r.number > stale) stale = r.number
    return Math.max(stale + 1, scanFloor(scan))
  }
  // The candidates from the newest number down, until `need` rows are sure (held, or settled in
  // the tab by the scan): every candidate above that point is named. A row whose state the scan
  // has not settled yet (its newest change on the watermark's timestamp, or only a lock read) is
  // named only when it must be (`unsettled`): the next scan page usually settles it, unread.
  // `held` counts the sure rows already loaded; `whole`: the descent looked at every number down to 1.
  const nominate = (floor = gapFloor(), unsettled = false): { numbers: number[]; sure: number; held: number; whole: boolean } => {
    const numbers: number[] = []
    let sure = 0
    let held = 0
    let m = tab.max
    for (; m >= 1 && (tab.direction === 'asc' || sure < need); m--) {
      const loaded = index.byNumber.get(m)
      if (loaded !== undefined) {
        const r = index.rows.get(loaded)
        if (r !== undefined && tab.matches(r)) {
          sure++
          held++
        }
        continue
      }
      if (index.notNumbers.has(m)) continue
      const id = scan.byNumber.get(m)
      if (id === undefined) {
        if (openTab && m >= floor) numbers.push(m)
        continue
      }
      const t = scan.targets.get(id)
      if (t === undefined || t.kind !== kind || index.notRows.has(id)) continue
      const code = settledCode(scan, t)
      if (code === null) {
        if (unsettled) numbers.push(m)
      } else if (tab.inTab(code)) {
        numbers.push(m)
        sure++
      }
    }
    return { numbers, sure, held, whole: m < 1 }
  }
  // A row the scan settles needs no state sum: one read per batch, not two.
  const known: KnownCodes = (docs) => scanCodes(scan, docs)
  let sinceRead = 0
  // One read by number per batch (the scan knows every named row's number).
  const resolve = async (numbers: readonly number[]): Promise<void> => {
    sinceRead = 0
    await resolveNumbers(sdk, index, numbers, known)
  }
  const done = (rows: Row[], complete: boolean): Selected<Row> => ({ rows: rows.sort(tab.cmp), complete, short: false, searched: null, more: false })
  let pages = 0
  for (;;) {
    let rows = tabRows()
    if (index.all || rows.length >= tab.known) return done(rows, true)
    const atEnd = scan.done || pages >= SCAN_PAGES_PER_LOAD
    // Read the candidates when they are expected to fill the page, every few scan pages, or when
    // the scan can go no further this load: a read per scan page would double its cost.
    const named = nominate(gapFloor(), atEnd)
    const batch = named.numbers.length
    // Settled rows are sure; unnamed numbers are this type's open rows at `openShare`.
    const settled = named.sure - named.held
    const expected = named.sure + (batch - settled) * tab.openShare
    if (batch > 0 && (atEnd || expected >= need || batch >= CHUNK || sinceRead >= RESOLVE_EVERY)) {
      await resolve(named.numbers)
      rows = tabRows()
      if (rows.length >= tab.known) return done(rows, true)
    }
    if (scan.done && scan.complete) {
      // Every state change is read: every candidate the page needs is named; once they are read,
      // the page is proved. A named row that turns out not to be one (hidden, another type) lets
      // the descent name more, so it names again until nothing new is named. The whole tab is
      // held when its count is, or when the descent looked at every number (a count read before
      // a later close can be one too many: the scan is the newer proof).
      const tried = new Set<number>()
      for (;;) {
        const rest = nominate(1, true)
        const fresh = rest.numbers.filter((n) => !tried.has(n))
        if (fresh.length === 0) {
          const held = tabRows()
          return done(held, held.length >= tab.known || rest.whole)
        }
        for (const n of fresh) tried.add(n)
        await resolve(fresh)
      }
    }
    // The page's last row created after the watermark: every number above it was too, so every
    // candidate above it is named; once they are read, the page is proved.
    const last = rows[need - 1]
    if (last !== undefined && tab.direction === 'desc' && scan.watermark !== null && last.createdAt > scan.watermark) {
      // The descent stops at `last` (the need-th sure row): everything it names is above it.
      const above = nominate(last.number + 1, true).numbers
      if (above.length === 0) return done(rows, false)
      await resolve(above)
      continue
    }
    if (atEnd) {
      // Partial: what is held so far, and how far the scan reaches.
      const auto = !scan.done && scan.pages < SCAN_AUTO_PAGES
      return { rows: rows.sort(tab.cmp), complete: false, short: scan.done, searched: covered(), more: !scan.done, kind: 'scan', auto, total: tab.typeTotal }
    }
    await serial(index, () => readScanPage(sdk, index.repo, scan))
    pages++
    sinceRead++
    tab.onProgress?.(covered())
  }
}

/**
 * The rows matching a filter in any state (a filtered list's tab counts): every candidate an index
 * names, resolved, or every row once all are loaded; null when only a chunk walk could tell.
 * `needLogs` as for {@link selectRows}.
 */
export async function rowsInAnyState<Row extends RowExtras>(
  sdk: EvoSDK,
  index: ListIndex<Row>,
  candidates: Set<string> | null,
  matches: (r: Row) => boolean,
  needLogs = false,
): Promise<Row[] | null> {
  const ids = candidates ?? (index.all ? [...index.rows.keys()] : null)
  if (ids === null) return null
  await resolveIds(sdk, index, ids)
  if (needLogs) await hydrate(sdk, index, ids)
  return rowsOf(index, ids).filter(matches)
}

/**
 * How one list page for `q` walks ({@link selectRows}): newest (or oldest) first until its pages'
 * rows are held, or every chunk for a sort by comments. A filtered page (a search) or a comment
 * sort reads up to {@link MAX_CHUNKS} chunks and says how far it read; an unfiltered page at most
 * {@link PAGE_CHUNKS} per load once it has a row to show.
 */
export interface PageWalk {
  readonly direction: Direction
  readonly want: number
  readonly walkAll: boolean
  readonly partial: boolean
  readonly maxChunks: number
  readonly minRows: number
}

export function pageWalk(q: { readonly sort: 'newest' | 'oldest' | 'comments'; readonly page: number; readonly pageSize: number }, filtered: boolean): PageWalk {
  const partial = filtered || q.sort === 'comments'
  return {
    direction: q.sort === 'oldest' ? 'asc' : 'desc',
    want: q.page * q.pageSize,
    walkAll: q.sort === 'comments',
    partial,
    // A search or a sort by comments reads as much per load as an unfiltered page (QW3-004,
    // QW3-019): it says how far it read and reads on when asked, rather than reading a
    // thousands-row repo before it shows anything.
    maxChunks: PAGE_CHUNKS,
    // An unfiltered page with nothing to show yet reads on (its proved count says there is
    // something to find); a search or sort has no count to go by, so it stops at its budget.
    minRows: partial ? 0 : (q.page - 1) * q.pageSize + 1,
  }
}

/**
 * How many rows match in the whole repo, for a page's count: every match, when the selection
 * holds them all; else, unfiltered, the tab's proved count (`tabCount`), before the walk reaches
 * them all. Unknown when filtered, or when the walk ended short of the repo's end for good.
 */
export function matchingOf(selected: Selected<unknown>, filtered: boolean, tabCount: number | null): number | null {
  if (selected.complete) return selected.rows.length
  if (filtered || (selected.short && !selected.more)) return null
  return tabCount
}

/** How far a page read, when its answer covers only part of the repo (`total`: the repo's rows, when known). */
export function searchedOfPage(selected: Selected<unknown>, total: number | null): SearchedOf | null {
  if (selected.searched === null) return null
  return {
    searched: selected.searched,
    total: selected.total !== undefined ? selected.total : total,
    more: selected.more,
    ...(selected.kind !== undefined ? { kind: selected.kind } : {}),
    ...(selected.auto ? { auto: true } : {}),
  }
}

/** The rows of page `page` (1-based) of `pageSize`, and whether a next page exists. */
export function pageOf<Row>(rows: readonly Row[], page: number, pageSize: number): { rows: Row[]; hasNext: boolean } {
  const start = (page - 1) * pageSize
  return { rows: rows.slice(start, start + pageSize), hasNext: rows.length > start + pageSize }
}

/**
 * The page's rows as they are shown: each given its member events first ({@link hydrate}; rows
 * whose chunk lookup carried them cost nothing), in the page's order.
 */
export async function shownRows<Row extends RowExtras>(sdk: EvoSDK, index: ListIndex<Row>, rows: readonly Row[]): Promise<Row[]> {
  const ids = rows.map((r) => r.id)
  await hydrate(sdk, index, ids)
  return rowsOf(index, ids)
}

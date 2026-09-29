/**
 * What the issue index (`./issue-index`) and the pull index (`./pull-index`) share: a keyset walk
 * over one document type read in composites of 100 (with comment counts and author names), the
 * repo's member-event feed and label definitions read once, `$id in` resolution of ids an index
 * names but has not loaded, the `author` index, the targets of a transition kind, and the
 * per-repo cache a write drops (`platform-parity-spec.md` §1.2, §3.3; L-44, L-77).
 *
 * Each index supplies its rows through {@link ListIndex.toRows}: the ONE step that turns admitted
 * documents into rows with their state (a proved transition sum per chunk, `./transitions`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { compositeOf, countsAt, docsAt, queryComposite, siblingOf, type CompositeResult, type CompositeSub } from '../sdk/composite'
import { IncompleteReadError, queryAllDocuments, type DocumentQuery, type PlainDocument } from '../sdk'
import { DOC, asIdentifierString, repoKey, str, type RepoRef } from './contract'
import { feedQuery, onRepoInvalidated, readRepoFeedFrom, repoEpoch, sharedRepoFeed, type TargetLog } from './issues'
import { newestLabels, type LabelDef } from './labels'
import { HiddenTally, gateFor, type ContentGate } from './private-content'
import { onPrivateSessionEnded } from './private-session'
import { repoSource } from './source'
import { readRepoCounts } from './transitions'

type RepoCounts = Awaited<ReturnType<typeof readRepoCounts>>

/** Rows per keyset chunk (the page limit of one composite). */
export const CHUNK = 100
/** Chunks one call may read to satisfy a query (a sort by comments reads every chunk up to this). */
export const MAX_CHUNKS = 30
/** Pages of one transition kind read for a tab's candidates before the tab walks chunks instead. */
const KIND_MAX_PAGES = 30

/** One keyset walk over the repo's rows, in one direction. */
export interface Walk {
  /** Loaded ids, in walk order. */
  readonly ids: string[]
  /** The `$createdAt` bound of the next chunk (`<=` newest-first, `>=` oldest-first). */
  bound: number | null
  done: boolean
  /** False when the walk stopped on a timestamp shared by 100+ rows (it did not reach the end). */
  complete: boolean
}

/** A repo's list index of one type (mutable while it loads). */
export interface ListIndex<Row extends { readonly id: string }> {
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
  readonly desc: Walk
  readonly asc: Walk
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
  /** The rows of admitted documents, with their comment counts: the index's one state step. */
  readonly toRows: RowBuilder<Row>
}

/** Builds an index's rows from admitted documents and their comment counts (null: not counted). */
export type RowBuilder<Row extends { readonly id: string }> = (
  sdk: EvoSDK,
  index: ListIndex<Row>,
  docs: readonly PlainDocument[],
  counts: ReadonlyMap<string, number> | null,
) => Promise<Row[]>

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
export function serial<T>(index: { queue: Promise<void> }, task: () => Promise<T>): Promise<T> {
  const run = index.queue.then(task)
  index.queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Record a chunk's documents: admit each, build the new rows, and (a keyset chunk) keep their order. */
async function addDocs<Row extends { readonly id: string }>(
  sdk: EvoSDK,
  index: ListIndex<Row>,
  docs: readonly PlainDocument[],
  counts: ReadonlyMap<string, number> | null,
  walk: Walk | null,
): Promise<void> {
  const fresh: PlainDocument[] = []
  const freshIds = new Set<string>()
  for (const raw of docs) {
    const id = str(raw, '$id')
    if (id === '' || index.notRows.has(id)) continue
    if (index.rows.has(id) || freshIds.has(id)) {
      if (walk !== null && !walk.ids.includes(id)) walk.ids.push(id)
      continue
    }
    const admitted = await index.gate.admit(index.type, raw)
    if (!admitted.ok) {
      index.notRows.add(id)
      index.hidden.add(admitted.reason)
      continue
    }
    fresh.push(admitted.doc)
    freshIds.add(id)
    walk?.ids.push(id)
  }
  for (const row of await index.toRows(sdk, index, fresh, counts)) index.rows.set(row.id, row)
}

/** Record one keyset chunk and move its walk's bound. */
async function addChunk<Row extends { readonly id: string }>(
  sdk: EvoSDK,
  index: ListIndex<Row>,
  walk: Walk,
  docs: readonly PlainDocument[],
  counts: ReadonlyMap<string, number> | null,
): Promise<void> {
  const before = walk.ids.length
  await addDocs(sdk, index, docs, counts, walk)
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

/** Record a composite's page (`docs`) with its comment counts and names (sub-queries 0 and 1). */
async function record<Row extends { readonly id: string }>(sdk: EvoSDK, index: ListIndex<Row>, res: CompositeResult, docs: readonly PlainDocument[], walk: Walk | null): Promise<void> {
  if (walk === null) await addDocs(sdk, index, docs, countsAt(res, 0), null)
  else await addChunk(sdk, index, walk, docs, countsAt(res, 0))
  await seedNames(index.network, docs, docsAt(res, 1))
}

/** Read one chunk (`page`, up to `limit`) with its comment counts and names, and record it. */
async function readChunk<Row extends { readonly id: string }>(
  sdk: EvoSDK,
  index: ListIndex<Row>,
  page: DocumentQuery,
  limit: number,
  { walk = null, keep }: { walk?: Walk | null; keep?: (d: PlainDocument) => boolean } = {},
): Promise<PlainDocument[]> {
  const res = await queryComposite(sdk, compositeOf(page, limit, chunkSubs(index.network)))
  const docs = keep ? res.page.filter(keep) : res.page
  await record(sdk, index, res, docs, walk)
  return docs
}

/**
 * First load, ONE composite: the newest 100 rows with their comment counts and author names, and
 * as siblings the label definitions and (unless another reader has the feed already) the feed's
 * first page. Then the rest of the feed, shared with the other index (`readRepoFeedFrom`), and of
 * the labels when their first pages were full.
 */
export async function loadListIndex<Row extends { readonly id: string }>(
  sdk: EvoSDK,
  repo: RepoRef,
  network: Network,
  type: 'issue' | 'patch',
  toRows: RowBuilder<Row>,
): Promise<ListIndex<Row>> {
  const source = repoSource(repo)
  const labelQuery = source.repoQuery(DOC.label, { orderBy: [['name', 'asc'], ['$createdAt', 'asc']] })
  const page = source.repoQuery(DOC[type], { orderBy: [['$createdAt', 'desc']] })
  const epoch = repoEpoch(repo)
  const shared = sharedRepoFeed(repo)
  const subs = [...chunkSubs(network), siblingOf(labelQuery, CHUNK), ...(shared === undefined ? [siblingOf(feedQuery(repo), CHUNK)] : [])]
  const res = await queryComposite(sdk, compositeOf(page, CHUNK, subs))
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
    desc: newWalk(),
    asc: newWalk(),
    queue: Promise.resolve(),
    all: false,
    byAuthor: new Map(),
    byKinds: new Map(),
    gate: gateFor(repo),
    toRows,
  }
  await record(sdk, index, res, res.page, index.desc)
  return index
}

/** Read the next keyset chunk in `direction` (`<=` / `>=` its bound; the boundary row is skipped as seen). */
export function loadChunk<Row extends { readonly id: string }>(sdk: EvoSDK, index: ListIndex<Row>, direction: 'desc' | 'asc'): Promise<void> {
  return serial(index, async () => {
    const walk = direction === 'desc' ? index.desc : index.asc
    if (walk.done || index.all) return
    const bound: [string, '<=' | '>=', number][] = walk.bound === null ? [] : [['$createdAt', direction === 'desc' ? '<=' : '>=', walk.bound]]
    await readChunk(sdk, index, repoSource(index.repo).repoQuery(DOC[index.type], { where: bound, orderBy: [['$createdAt', direction]] }), CHUNK, { walk })
  })
}

/**
 * Read chunks in `direction` while `more()` holds, the walk has not ended and at most
 * {@link MAX_CHUNKS} chunks: returns whether the walk covered every row.
 */
export async function walkWhile<Row extends { readonly id: string }>(sdk: EvoSDK, index: ListIndex<Row>, direction: 'desc' | 'asc', more: () => boolean): Promise<boolean> {
  const walk = direction === 'asc' ? index.asc : index.desc
  for (let chunks = 0; !walk.done && !index.all && chunks < MAX_CHUNKS && more(); chunks++) await loadChunk(sdk, index, direction)
  return index.all || (walk.done && walk.complete)
}

/** The rows the walk in `direction` has loaded, in walk order (every row once all are loaded). */
export function loadedIds<Row extends { readonly id: string }>(index: ListIndex<Row>, direction: 'desc' | 'asc'): Iterable<string> {
  return index.all ? index.rows.keys() : (direction === 'asc' ? index.asc : index.desc).ids
}

/** Resolve ids an index names but no loaded chunk holds: `$id in` composites of up to 100. */
export function resolveIds<Row extends { readonly id: string }>(sdk: EvoSDK, index: ListIndex<Row>, ids: Iterable<string>): Promise<void> {
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
export function authorCandidates<Row extends { readonly id: string }>(sdk: EvoSDK, index: ListIndex<Row>, author: string): Promise<Set<string> | null> {
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
export function transitionTargets<Row extends { readonly id: string }>(sdk: EvoSDK, index: ListIndex<Row>, kinds: readonly number[]): Promise<Set<string> | null> {
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
 * Feed targets whose member events can pass the label and assignee filters, or null when neither
 * applies. A loaded row is checked exactly (`loaded`); one not loaded yet is admitted on its
 * events and filtered once resolved.
 */
export function metaCandidates<Row extends { readonly id: string }>(
  index: ListIndex<Row>,
  q: { readonly labels: readonly string[]; readonly assignee: string | null },
  loaded: (row: Row) => boolean,
): Set<string> | null {
  const byFeed = q.labels.length > 0 || (q.assignee !== null && q.assignee !== 'none')
  if (!byFeed || index.feed === null) return null
  const out = new Set<string>()
  for (const [id, log] of index.feed) {
    if (id === '' || index.notRows.has(id)) continue
    const row = index.rows.get(id)
    if (row !== undefined) {
      if (loaded(row)) out.add(id)
      continue
    }
    if (q.labels.length > 0 && !log.events.some((e) => e.kind === 'labelAdd')) continue
    if (q.assignee !== null && q.assignee !== 'none' && !log.events.some((e) => e.kind === 'assign' && e.value === q.assignee)) continue
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
 * transitions by kind), read once per index; null when they could not be read (tried again next
 * time).
 */
export async function repoCountsOf<Row extends { readonly id: string }>(sdk: EvoSDK, index: ListIndex<Row>): Promise<RepoCounts | null> {
  index.counts ??= readRepoCounts(sdk, index.repo)
  return index.counts.catch(() => {
    index.counts = undefined
    return null
  })
}

/** The loaded rows of `ids`, in order (ids not loaded are skipped). */
export function rowsOf<Row extends { readonly id: string }>(index: ListIndex<Row>, ids: Iterable<string>): Row[] {
  return [...ids].map((id) => index.rows.get(id)).filter((r): r is Row => r !== undefined)
}

/**
 * A per-repo cache of one kind of index: one load per network, repo and (private) reader session
 * (a private index holds decrypted titles and bodies), dropped by any write to the repo and when
 * the session ends.
 */
export function indexCache<Row extends { readonly id: string }>(): (sdk: EvoSDK, repo: RepoRef, network: Network, load: () => Promise<ListIndex<Row>>) => Promise<ListIndex<Row>> {
  const indexes = new Map<string, Promise<ListIndex<Row>>>()
  onRepoInvalidated((repo) => {
    const at = `:${repo.forge.collab}:${repo.repoId}`
    for (const key of [...indexes.keys()]) if (key.endsWith(at) || key.includes(`${at}#`)) indexes.delete(key)
  })
  onPrivateSessionEnded((id) => {
    for (const key of [...indexes.keys()]) if (key.endsWith(`#${id}`)) indexes.delete(key)
  })
  return (_sdk, repo, network, load) => {
    const key = `${network}:${repo.forge.collab}:${repoKey(repo)}`
    let hit = indexes.get(key)
    if (hit === undefined) {
      hit = load()
      indexes.set(key, hit)
      hit.catch(() => {
        if (indexes.get(key) === hit) indexes.delete(key)
      })
    }
    return hit
  }
}

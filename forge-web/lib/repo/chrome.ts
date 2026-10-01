/**
 * The repo chrome read (`platform-parity-spec.md` §3.3, S-1): ONE composite request resolves a
 * repo and reads what every repo page needs, and a per-repo store keeps the append-only
 * timelines between pages and loads.
 *
 * The composite's page is the `repo` document by `($ownerId, name)` (limit 1); its sub-queries,
 * all bound `$id → repoId` (10, the protocol's maximum):
 * - counts: `star`, `issue`, `patch` (the About card's stars, the tab totals);
 * - lookups: `maintainer`, `writer` (the membership the pack list ranks copies by);
 * - the first page, or since the last read the delta, of each append-only timeline on its
 *   `(repoId, $createdAt)` index: `config`, `refUpdate`, `protectedRefUpdate`, `packManifest`;
 * - the owner's DPNS name (`$ownerId → records.identity`).
 *
 * A timeline whose page came back full is read on with plain pages (`queryAllDocuments`
 * continuing from that page), so the answer is complete: ⌈rows/100⌉ − 1 requests more. That
 * read-on waits for a reader that needs the whole timeline ({@link ChromeTimelines}): an issue
 * or PR list needs only the config and a ref or two, and takes each ref's history alone (one
 * equality read per ref-update type whose page came back full) instead of the dash mirror's
 * ~700 ref updates as eight key ranges (8 of the Open PR tab's 35 requests, QW3 list engine).
 *
 * The four timeline types are `documentsMutable: false`, `canBeDeleted: false`: a row once read
 * never changes or goes. So the store keeps them, and a later read asks only for rows at or after
 * the newest `$createdAt` it holds (`>=`, so a row of that same block is not missed; rows are
 * merged by `$id`). A revalidation is then one request, whatever the repo's size.
 *
 * Verified against Platform 4.2.0-beta.6 (`rs-drive` `composite_document_query/mod.rs`):
 * at most 10 sub-queries and 100 bound values; a lookup's bound field must be the index's last
 * or second-to-last property, so every lookup orders `repoId` first; counts need a countable (or
 * `rangeCountable`) index; lookups off an empty page answer empty. And live on moutai: the
 * composite's first page of each timeline equals the plain query's, and its counts the plain
 * `count`s.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, NETWORKS, type Network } from '../constants'
import type { ForgeIds } from '../deployments'
import { compositeOf, countsAt, docsAt, queryComposite, type CompositeSub } from '../sdk/composite'
import { base64ToHex, cursorPadded, queryAllDocuments, shareInFlight, type PlainDocument, type WhereClause } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { membersGeneration, membershipsFromDocs, seedMemberships } from './members'
import { noteForkOf } from './fork-parent'
import { readOneRef, readRefRowsInRanges, refRowsMissParent, rowsOfRef } from './refs'
import { repoRefOf, toRepoDoc, type RepoDoc } from './resolveRepo'
import { seedTargetCounts } from './social'
import { repoSource } from './source'

/** The timelines keyed by `refNameHash` too, so a long one can be read as key ranges in parallel. */
const REF_TYPES: ReadonlySet<string> = new Set([DOC.refUpdate, DOC.protectedRefUpdate])

/** The two ref-update timelines. */
const TIMELINE_REF_TYPES = [DOC.refUpdate, DOC.protectedRefUpdate] as const

/** The append-only timelines the store keeps. */
export const TIMELINE_TYPES = [DOC.config, DOC.refUpdate, DOC.protectedRefUpdate, DOC.packManifest] as const
export type TimelineType = (typeof TIMELINE_TYPES)[number]

/** Every row of each timeline (complete), oldest first. */
export type RepoTimelines = Readonly<Record<TimelineType, readonly PlainDocument[]>>

/** A page of every query, the protocol's per-query cap. */
const PAGE = 100

/**
 * Refs one chrome read reads alone ({@link ChromeTimelines.ref}) before the next asks for the whole
 * timelines instead: a PR list with many base branches would otherwise cost more than the key ranges.
 */
const REFS_READ_ALONE = 4

/**
 * How old a stored read may be and still answer a reader that did not start it (a code page's
 * pack list right after the home's read). The home itself always reads again.
 */
export const TIMELINES_FRESH_MS = 5_000

interface StoreEntry {
  /** The repo the rows are of (the key is its address, which a new repo could take over). */
  readonly repoId: string
  /** When the read behind `read` was issued. */
  readonly at: number
  /** The repo's write generation when it was issued ({@link staleRepoTimelines}). */
  readonly generation: number
  /** The read's timelines, read on as far as its readers asked. */
  readonly read: ChromeTimelines
  /** Its whole timelines are still being read on (a later reader joins them rather than checking its age). */
  pending: boolean
  /** The newest complete timelines known (this read's once read on, else the previous one's). */
  settled?: RepoTimelines
}

/** Repos whose timelines are kept (least recently used dropped first). */
const STORE_REPOS = 20
const store = new Map<string, StoreEntry>()
/** Per repo address: bumped by {@link staleRepoTimelines} (this tab wrote to the repo). */
const writeGenerations = new Map<string, number>()
/** Chrome reads in flight, per repo address and write generation. */
const chromeInFlight = new Map<string, Promise<RepoChrome | null>>()
/** Composites the node refused (answered by plain queries instead): a count to watch, not a failure. */
let fallbacks = 0

const generationOf = (key: string): number => writeGenerations.get(key) ?? 0

/** The store's entry for `key`, touched as most recently used. */
function touch(key: string): StoreEntry | undefined {
  const hit = store.get(key)
  if (hit !== undefined) {
    store.delete(key)
    store.set(key, hit)
  }
  return hit
}

/** A repo's store key: its address, which both a route and a {@link RepoRef} know. */
function keyOf(forge: ForgeIds, ownerId: string, name: string): string {
  return `${forge.core}:${ownerId}:${name}`
}

/** What one chrome read found. */
export interface RepoChrome {
  readonly repo: RepoRef
  readonly doc: RepoDoc
  /** Proven by the count tree (a repo nobody starred counts 0). */
  readonly starCount: number
  /** The owner's DPNS `domain` documents (for the name cache; empty: proven nameless). */
  readonly ownerDomains: readonly PlainDocument[]
  /**
   * The timelines, read on only as far as a reader asks (public repos; a private repo's are read
   * through its session).
   */
  readonly read: ChromeTimelines | null
}

/** One ref's rows of both ref-update types. */
export interface RefRows {
  readonly refUpdate: readonly PlainDocument[]
  readonly protectedRefUpdate: readonly PlainDocument[]
}

/**
 * A chrome read's timelines, read on only as far as its readers need. The composite's first page
 * of each timeline holds a short one whole; a long one (a full page) is read on when asked.
 */
export interface ChromeTimelines {
  /** Every timeline came back whole in the composite: {@link all} costs no request. */
  readonly whole: boolean
  /** Both ref-update timelines came back whole: {@link refs} costs no request. */
  readonly refsWhole: boolean
  /**
   * Every row of each timeline (complete), a long one read on (the ref updates as key ranges,
   * QW-087). Started on the first call, then shared.
   */
  all(): Promise<RepoTimelines>
  /** The config timeline, complete, without reading the others on. */
  config(): Promise<readonly PlainDocument[]>
  /**
   * One ref's rows of both types, complete, without reading the other refs': a type the
   * composite's page held whole gives its rows, any other is read for this ref alone (one
   * equality read); once {@link all} has started, or {@link REFS_READ_ALONE} refs were read
   * alone, its rows. Shared per ref.
   */
  ref(refNameHashB64: string): Promise<RefRows>
  /** Every ref's rows of both types, complete: the composite's pages when whole, else {@link all}'s. */
  refs(): Promise<RefRows>
}

/** {@link ChromeTimelines}, plus what the store watches. */
interface StoredTimelines extends ChromeTimelines {
  /** Call `listener` with {@link all}'s read once it starts (now, if it has). */
  onAll(listener: (read: Promise<RepoTimelines>) => void): void
}

const createdAtOf = (d: PlainDocument): number => (typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0)

/**
 * The `$createdAt >=` clause a timeline's read carries: none on a first read, else from the newest
 * row held (`>=`, so a row of that same block is not missed). The composite's first page and its
 * plain continuation pages must use the same bound, so both take it from here.
 */
function sinceWhere(known: RepoTimelines | undefined, type: TimelineType): { where?: WhereClause[] } {
  let newest: number | null = null
  for (const d of known?.[type] ?? []) newest = Math.max(newest ?? 0, createdAtOf(d))
  return newest === null ? {} : { where: [['$createdAt', '>=', newest]] }
}

/** `known` plus `fresh`, each `$id` once, oldest first (`$createdAt`, then `$id`). */
function mergeRows(known: readonly PlainDocument[], fresh: readonly PlainDocument[]): PlainDocument[] {
  const byId = new Map<string, PlainDocument>()
  for (const d of [...known, ...fresh]) byId.set(String(d['$id']), d)
  return [...byId.values()].sort((a, b) => createdAtOf(a) - createdAtOf(b) || (String(a['$id']) < String(b['$id']) ? -1 : 1))
}

/**
 * The composite's sub-queries. Order matters: the results are read back by index
 * ({@link SUB}). `known`: the rows already held, so each timeline asks only for its delta.
 */
function chromeSubs(forge: ForgeIds, network: Network, known: RepoTimelines | undefined): CompositeSub[] {
  const bind = { sourceProperty: '$id', field: 'repoId' }
  const ordered = (field: string) => [['repoId', 'asc'], [field, 'asc']] as const
  const timeline = (type: TimelineType): CompositeSub => ({
    dataContractId: forge.core,
    documentType: type,
    bind,
    ...sinceWhere(known, type),
    orderBy: ordered('$createdAt'),
    limit: PAGE,
  })
  return [
    { dataContractId: forge.community, documentType: DOC.star, kind: 'counts', bind },
    { dataContractId: forge.collab, documentType: DOC.issue, kind: 'counts', bind },
    { dataContractId: forge.collab, documentType: DOC.patch, kind: 'counts', bind },
    { dataContractId: forge.core, documentType: DOC.maintainer, bind, orderBy: ordered('memberId'), limit: PAGE },
    { dataContractId: forge.core, documentType: DOC.writer, bind, orderBy: ordered('memberId'), limit: PAGE },
    ...TIMELINE_TYPES.map(timeline),
    {
      dataContractId: NETWORKS[network].dpnsContractId,
      documentType: 'domain',
      bind: { sourceProperty: '$ownerId', field: 'records.identity' },
      limit: PAGE,
    },
  ]
}

/** Where each answer sits in the composite's sub-results. */
const SUB = { star: 0, issue: 1, patch: 2, maintainer: 3, writer: 4, timeline: 5, domain: 5 + TIMELINE_TYPES.length } as const

/** A timeline's rows from a page's start: the page itself when short, else read on to the end. */
type SerialRead = (type: TimelineType) => Promise<PlainDocument[]>

/**
 * The timelines of one chrome read (see {@link ChromeTimelines}). `known`: the rows held before
 * it (the pages are the delta after them); `pages`: the composite's page of each timeline.
 */
function chromeTimelines(sdk: EvoSDK, repo: RepoRef, known: RepoTimelines | undefined, pages: readonly (readonly PlainDocument[])[]): StoredTimelines {
  const pageOf = (type: TimelineType): readonly PlainDocument[] => pages[TIMELINE_TYPES.indexOf(type)] ?? []
  const isWhole = (type: TimelineType): boolean => pageOf(type).length < PAGE
  const held = (type: TimelineType): PlainDocument[] => mergeRows(known?.[type] ?? [], pageOf(type))
  // Each long timeline is read on at most once, whoever asks first (a failed read is retried).
  const serials = new Map<TimelineType, Promise<PlainDocument[]>>()
  const serial: SerialRead = (type) => {
    const page = pageOf(type)
    if (page.length < PAGE) return Promise.resolve([...page])
    return remembered(serials, type, () =>
      queryAllDocuments(sdk, repoSource(repo).repoQuery(type, { ...sinceWhere(known, type), orderBy: [['$createdAt', 'asc']] }), { firstPage: page }),
    )
  }
  let full: Promise<RepoTimelines> | null = null
  const listeners: ((read: Promise<RepoTimelines>) => void)[] = []
  const refs = new Map<string, Promise<RefRows>>()
  let readAlone = 0
  const all = (): Promise<RepoTimelines> => {
    if (full === null) {
      const read = completeTimelines(sdk, repo, known, pageOf, serial)
      full = read
      // A failed read is not kept: the next caller reads again.
      read.catch(() => {
        if (full === read) full = null
      })
      for (const listener of listeners) listener(read)
    }
    return full
  }
  const refsWhole = isWhole(DOC.refUpdate) && isWhole(DOC.protectedRefUpdate)
  return {
    whole: TIMELINE_TYPES.every(isWhole),
    refsWhole,
    all,
    config: () => (isWhole(DOC.config) ? Promise.resolve(held(DOC.config)) : full !== null ? full.then((t) => t.config) : serial(DOC.config).then((rows) => mergeRows(known?.config ?? [], rows))),
    ref: (refNameHashB64) => {
      const hex = base64ToHex(refNameHashB64)
      return remembered(refs, hex, async () => {
        const alone = (type: TimelineType): boolean => !isWhole(type)
        if (full === null && TIMELINE_REF_TYPES.some(alone) && (readAlone += 1) > REFS_READ_ALONE) all()
        const whole = full
        const rowsOf = async (type: TimelineType): Promise<PlainDocument[]> => {
          if (whole !== null) return (await whole)[type] as PlainDocument[]
          return isWhole(type) ? held(type) : readOneRef(sdk, repo, type, refNameHashB64)
        }
        const [plain, prot] = await Promise.all([rowsOf(DOC.refUpdate), rowsOf(DOC.protectedRefUpdate)])
        return { refUpdate: rowsOfRef(plain, hex), protectedRefUpdate: rowsOfRef(prot, hex) }
      })
    },
    refs: async () => {
      if (refsWhole) return { refUpdate: held(DOC.refUpdate), protectedRefUpdate: held(DOC.protectedRefUpdate) }
      const t = await all()
      return { refUpdate: t.refUpdate, protectedRefUpdate: t.protectedRefUpdate }
    },
    onAll: (listener) => {
      listeners.push(listener)
      if (full !== null) listener(full)
    },
  }
}

/** `map[key]`, read by `read` on first use and kept, unless it fails (the next caller reads again). */
function remembered<K, T>(map: Map<K, Promise<T>>, key: K, read: () => Promise<T>): Promise<T> {
  const hit = map.get(key)
  if (hit !== undefined) return hit
  const fresh = read()
  map.set(key, fresh)
  fresh.catch(() => {
    if (map.get(key) === fresh) map.delete(key)
  })
  return fresh
}

/**
 * Finish the timelines from the composite's pages: a full page is read on to the end; each is
 * merged into what was already held.
 */
async function completeTimelines(
  sdk: EvoSDK,
  repo: RepoRef,
  known: RepoTimelines | undefined,
  pageOf: (type: TimelineType) => readonly PlainDocument[],
  serial: SerialRead,
): Promise<RepoTimelines> {
  // A first read of a repo's ref updates past a page (dashpay/dash: ~700) reads the rest as key
  // ranges side by side, not page after page (QW-087). Null: read serially instead — every delta
  // read, and a node that does not honor the ranges or fails one outright.
  const ranged = async (type: TimelineType): Promise<PlainDocument[] | null> => {
    if (known !== undefined || !REF_TYPES.has(type) || pageOf(type).length < PAGE) return null
    const rows = await readRefRowsInRanges(sdk, repo, type).catch(() => null)
    return rows === null ? null : [...pageOf(type), ...rows]
  }
  const read = await Promise.all(
    TIMELINE_TYPES.map(async (type) => {
      const fromRanges = await ranged(type)
      return { type, fromRanges: fromRanges !== null, rows: fromRanges ?? (await serial(type)) }
    }),
  )
  const rows = Object.fromEntries(read.map((r) => [r.type, r.rows])) as Record<TimelineType, PlainDocument[]>
  // Ranges that answered in order can still have lost rows, and the loss would stick: later reads
  // ask only for newer rows. So the ref rows get the `prevOid` check the full ref read runs (across
  // both types), and a failure re-reads the ranged types the `$createdAt` way (the rest already were).
  if (read.some((r) => r.fromRanges) && lostParent(repo, rows)) {
    await Promise.all(
      read.filter((r) => r.fromRanges).map(async (r) => {
        rows[r.type] = await serial(r.type)
      }),
    )
  }
  return Object.fromEntries(TIMELINE_TYPES.map((type) => [type, mergeRows(known?.[type] ?? [], rows[type])])) as unknown as RepoTimelines
}

/** {@link refRowsMissParent} over the ref timelines; a row it cannot attribute counts as a loss. */
function lostParent(repo: RepoRef, rows: Readonly<Record<TimelineType, readonly PlainDocument[]>>): boolean {
  try {
    return refRowsMissParent(repo, rows)
  } catch {
    return true
  }
}

/**
 * Resolve the repo `(ownerId, name)` and read its chrome in one request (see the module doc).
 * Null when no such repo exists. A public repo's timelines go to the store, where a code page's
 * pack list and a PR list's base refs find them ({@link repoTimelines}).
 */
export function readRepoChrome(
  sdk: EvoSDK,
  forge: ForgeIds,
  ownerId: string,
  name: string,
  network: Network = DEFAULT_NETWORK,
): Promise<RepoChrome | null> {
  // Two readers at once (the home revalidating, and its browse context re-resolving behind a
  // stale reader) share one request, but never across this tab's write to the repo: a read issued
  // after it must not be answered by one issued before.
  const key = keyOf(forge, ownerId, name)
  return shareInFlight(chromeInFlight, `${key}@${generationOf(key)}`, () => readChrome(sdk, key, forge, ownerId, name, network))
}

async function readChrome(
  sdk: EvoSDK,
  key: string,
  forge: ForgeIds,
  ownerId: string,
  name: string,
  network: Network,
): Promise<RepoChrome | null> {
  const started = Date.now()
  const generation = generationOf(key)
  const membersAtStart = membersGeneration()
  const held = touch(key)
  // Only on protocol 14 is a delta page continued safely: a `startAfter` cursor below it drops
  // rows tied with the cursor, and the `>=` bound rules out the tie probe. Read whole there.
  const known = cursorPadded() ? held?.settled : undefined
  const q = compositeOf(
    { dataContractId: forge.core, documentTypeName: DOC.repo, where: [['$ownerId', '==', ownerId], ['name', '==', name]] },
    1,
    chromeSubs(forge, network, known),
  )
  const res = await queryComposite(sdk, q, { onFallback: () => noteFallback(known !== undefined) })
  const raw = res.page[0]
  if (raw === undefined) return null
  const doc = toRepoDoc(raw)
  const repo = repoRefOf(forge, doc)
  noteForkOf(forge, doc.repoId, doc.forkOf)
  // The name now names another repo (the old one deleted, a new one made): what is held was the
  // old repo's, and the deltas were asked relative to it. Read the new one from the start.
  if (known !== undefined && held?.repoId !== repo.repoId) {
    if (store.get(key) === held) store.delete(key)
    return readChrome(sdk, key, forge, ownerId, name, network)
  }
  const count = (i: number): number => countsAt(res, i)?.get(repo.repoId) ?? 0

  seedTargetCounts(forge, repo.repoId, { issues: count(SUB.issue), pulls: count(SUB.patch) }, started)
  // Only a short page is the whole membership.
  const role = (i: number): PlainDocument[] | null => (docsAt(res, i).length < PAGE ? docsAt(res, i) : null)
  const members = membershipsFromDocs(role(SUB.maintainer), role(SUB.writer))
  if (members !== null) seedMemberships(repo, network, members, membersAtStart)

  let read: StoredTimelines | null = null
  if (repo.visibility === 'public') {
    read = chromeTimelines(sdk, repo, known, TIMELINE_TYPES.map((_, i) => docsAt(res, SUB.timeline + i)))
    // A read issued before this tab's write to the repo still answers its own caller, but is not
    // kept: the next reader must not take it for a read made after the write.
    if (generation === generationOf(key)) remember(key, { repoId: repo.repoId, at: started, generation }, read)
  }
  return { repo, doc, starCount: count(SUB.star), ownerDomains: docsAt(res, SUB.domain), read }
}

/** A composite answered by plain queries: logged, and counted for {@link chromeFallbacks}. */
function noteFallback(delta: boolean): void {
  fallbacks += 1
  // eslint-disable-next-line no-console
  console.warn(`[forge] the repo chrome composite${delta ? ' (a delta read)' : ''} was refused; read with plain queries instead`)
}

/** How many chrome composites this tab had to answer with plain queries (a node refused the shape). */
export function chromeFallbacks(): number {
  return fallbacks
}

/** Put a read in the store; one whose read-on fails is dropped (the next reader reads again). */
function remember(key: string, meta: Pick<StoreEntry, 'repoId' | 'at' | 'generation'>, read: StoredTimelines): void {
  const prev = store.get(key)
  const entry: StoreEntry = { ...meta, read, pending: false, settled: prev?.repoId === meta.repoId ? prev.settled : undefined }
  store.delete(key)
  store.set(key, entry)
  for (const k of store.keys()) {
    if (store.size <= STORE_REPOS) break
    store.delete(k)
  }
  read.onAll((promise) => {
    entry.pending = true
    promise.then(
      (settled) => {
        entry.settled = settled
        entry.pending = false
      },
      () => {
        if (store.get(key) === entry) store.delete(key)
      },
    )
  })
}

/**
 * A public repo's complete timelines, for a repo this tab read through {@link readRepoChrome}:
 * {@link repoChromeTimelines}, read on to the end. Null when the store holds nothing for this repo
 * (it was never read through the chrome, or its name now names another repo): the caller reads
 * the plain way.
 */
export async function repoTimelines(sdk: EvoSDK, repo: RepoRef, options: RepoTimelinesOptions = {}): Promise<RepoTimelines | null> {
  const read = await repoChromeTimelines(sdk, repo, options)
  return read === null ? null : read.all()
}

export interface RepoTimelinesOptions {
  readonly maxAgeMs?: number
  readonly issuedAfter?: number
  readonly network?: Network
}

/**
 * A public repo's timelines, for a repo this tab read through {@link readRepoChrome}: the stored
 * read when its read-on is in flight or it started within `maxAgeMs` (and after `issuedAfter`),
 * else a new chrome read (one request for what is new). Null when the store holds nothing for
 * this repo (it was never read through the chrome, or its name now names another repo): the
 * caller reads the plain way.
 *
 * `issuedAfter`: a re-resolve checking what an earlier read saw (a browse context's pack list,
 * read by then) takes only a read issued after it, such as the home's revalidation of a moment
 * ago, never the read it is checking (D-11).
 */
export async function repoChromeTimelines(
  sdk: EvoSDK,
  repo: RepoRef,
  { maxAgeMs = TIMELINES_FRESH_MS, issuedAfter = -Infinity, network = DEFAULT_NETWORK }: RepoTimelinesOptions = {},
): Promise<ChromeTimelines | null> {
  if (repo.visibility !== 'public') return null
  const key = keyOf(repo.forge, repo.ownerId, repo.name)
  const hit = touch(key)
  if (hit === undefined || hit.repoId !== repo.repoId) return null
  // A read-on in flight is joined (as the browse cache joins a re-resolve in flight), a read
  // answers within `maxAgeMs` if issued after `issuedAfter`; neither when it was issued before
  // this tab's last write.
  if (hit.generation === generationOf(key) && (hit.pending || (Date.now() - hit.at < maxAgeMs && hit.at > issuedAfter))) return hit.read
  const chrome = await readRepoChrome(sdk, repo.forge, repo.ownerId, repo.name, network)
  return chrome?.repo.repoId === repo.repoId ? chrome.read : null
}

/**
 * The repo's content changed through this tab (a push, a merge, a release): the next reader
 * reads again, and no read issued before now answers it, even one still in flight. What is held
 * stays, so that read asks only for the new rows.
 */
export function staleRepoTimelines(repo: RepoRef): void {
  const key = keyOf(repo.forge, repo.ownerId, repo.name)
  writeGenerations.set(key, generationOf(key) + 1)
}

/** Test hook: forget every stored timeline. */
export function resetRepoTimelines(): void {
  store.clear()
  chromeInFlight.clear()
  writeGenerations.clear()
  fallbacks = 0
}

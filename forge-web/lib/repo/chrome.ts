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
 * continuing from that page), so the answer is complete: ⌈rows/100⌉ − 1 requests more.
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
import { queryAllDocuments, type PlainDocument, type WhereClause } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { membershipsFromDocs, seedMemberships } from './members'
import { repoRefOf, toRepoDoc, type RepoDoc } from './resolveRepo'
import { seedTargetCounts } from './social'
import { repoSource } from './source'

/** The append-only timelines the store keeps. */
export const TIMELINE_TYPES = [DOC.config, DOC.refUpdate, DOC.protectedRefUpdate, DOC.packManifest] as const
export type TimelineType = (typeof TIMELINE_TYPES)[number]

/** Every row of each timeline (complete), oldest first. */
export type RepoTimelines = Readonly<Record<TimelineType, readonly PlainDocument[]>>

/** A page of every query, the protocol's per-query cap. */
const PAGE = 100

/**
 * How old a stored read may be and still answer a reader that did not start it (a code page's
 * pack list right after the home's read). The home itself always reads again.
 */
export const TIMELINES_FRESH_MS = 5_000

interface StoreEntry {
  /** The repo the rows are of (the key is its address, which a new repo could take over). */
  readonly repoId: string
  /** When the read behind `promise` started (0: out of date, read again before use). */
  at: number
  readonly promise: Promise<RepoTimelines>
  /** `promise` once it has settled (a later reader of a settled read checks its age). */
  settledPromise?: Promise<RepoTimelines>
  /** The newest complete timelines known (this read's once it settles, else the previous one's). */
  settled?: RepoTimelines
}

const store = new Map<string, StoreEntry>()

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
  /** The complete timelines (public repos; a private repo's are read through its session). */
  readonly timelines: Promise<RepoTimelines> | null
}

/** The newest `$createdAt` among `rows`, or null. */
function newestAt(rows: readonly PlainDocument[]): number | null {
  let newest: number | null = null
  for (const d of rows) {
    const at = d['$createdAt']
    if (typeof at === 'number' && (newest === null || at > newest)) newest = at
  }
  return newest
}

/** The plain query a timeline sub-query stands for (its continuation pages use it). */
function timelineQuery(repo: RepoRef, type: TimelineType, since: number | null) {
  return repoSource(repo).repoQuery(type, {
    ...(since === null ? {} : { where: [['$createdAt', '>=', since]] as WhereClause[] }),
    orderBy: [['$createdAt', 'asc']],
  })
}

/** `known` plus `fresh`, each `$id` once, oldest first (`$createdAt`, then `$id`). */
function mergeRows(known: readonly PlainDocument[], fresh: readonly PlainDocument[]): PlainDocument[] {
  const byId = new Map<string, PlainDocument>()
  for (const d of [...known, ...fresh]) byId.set(String(d['$id']), d)
  const at = (d: PlainDocument): number => (typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0)
  return [...byId.values()].sort((a, b) => at(a) - at(b) || (String(a['$id']) < String(b['$id']) ? -1 : 1))
}

/**
 * The composite's sub-queries. Order matters: the results are read back by index
 * ({@link SUB}). `known`: the rows already held, so each timeline asks only for its delta.
 */
function chromeSubs(forge: ForgeIds, network: Network, known: RepoTimelines | undefined): CompositeSub[] {
  const bind = { sourceProperty: '$id', field: 'repoId' }
  const ordered = (field: string) => [['repoId', 'asc'], [field, 'asc']] as const
  const timeline = (type: TimelineType): CompositeSub => {
    const since = known === undefined ? null : newestAt(known[type])
    return {
      dataContractId: forge.core,
      documentType: type,
      bind,
      ...(since === null ? {} : { where: [['$createdAt', '>=', since]] as WhereClause[] }),
      orderBy: ordered('$createdAt'),
      limit: PAGE,
    }
  }
  return [
    { dataContractId: forge.collab, documentType: DOC.star, kind: 'counts', bind },
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

/**
 * Finish the timelines from the composite's pages: a full page is read on to the end; each is
 * merged into what was already held.
 */
async function completeTimelines(
  sdk: EvoSDK,
  repo: RepoRef,
  known: RepoTimelines | undefined,
  pages: readonly (readonly PlainDocument[])[],
): Promise<RepoTimelines> {
  const read = await Promise.all(
    TIMELINE_TYPES.map(async (type, i) => {
      const page = pages[i] ?? []
      const since = known === undefined ? null : newestAt(known[type])
      const rows = page.length < PAGE ? page : await queryAllDocuments(sdk, timelineQuery(repo, type, since), { firstPage: page })
      return [type, mergeRows(known?.[type] ?? [], rows)] as const
    }),
  )
  return Object.fromEntries(read) as unknown as RepoTimelines
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
  // stale reader) share one request: both started after whatever they are checking.
  const key = keyOf(forge, ownerId, name)
  const held = chromeInFlight.get(key)
  if (held !== undefined) return held
  const read = readChrome(sdk, forge, ownerId, name, network)
  chromeInFlight.set(key, read)
  const done = (): void => {
    if (chromeInFlight.get(key) === read) chromeInFlight.delete(key)
  }
  read.then(done, done)
  return read
}

/** Chrome reads in flight, per repo address. */
const chromeInFlight = new Map<string, Promise<RepoChrome | null>>()

async function readChrome(
  sdk: EvoSDK,
  forge: ForgeIds,
  ownerId: string,
  name: string,
  network: Network,
): Promise<RepoChrome | null> {
  const key = keyOf(forge, ownerId, name)
  const started = Date.now()
  const held = store.get(key)
  const known = held?.settled
  const res = await queryComposite(
    sdk,
    compositeOf(
      { dataContractId: forge.core, documentTypeName: DOC.repo, where: [['$ownerId', '==', ownerId], ['name', '==', name]] },
      1,
      chromeSubs(forge, network, known),
    ),
  )
  const raw = res.page[0]
  if (raw === undefined) return null
  const doc = toRepoDoc(raw)
  const repo = repoRefOf(forge, doc)
  // The name now names another repo (the old one deleted, a new one made): what is held was the
  // old repo's, and the deltas were asked relative to it. Read the new one from the start.
  if (known !== undefined && held?.repoId !== repo.repoId) {
    if (store.get(key) === held) store.delete(key)
    return readChrome(sdk, forge, ownerId, name, network)
  }
  const count = (i: number): number => countsAt(res, i)?.get(repo.repoId) ?? 0

  seedTargetCounts(forge, repo.repoId, { issues: count(SUB.issue), pulls: count(SUB.patch) })
  // Only a short page is the whole membership.
  const role = (i: number): PlainDocument[] | null => (docsAt(res, i).length < PAGE ? docsAt(res, i) : null)
  const members = membershipsFromDocs(role(SUB.maintainer), role(SUB.writer))
  if (members !== null) seedMemberships(repo, network, members)

  let timelines: Promise<RepoTimelines> | null = null
  if (repo.visibility === 'public') {
    const pages = TIMELINE_TYPES.map((_, i) => docsAt(res, SUB.timeline + i))
    timelines = completeTimelines(sdk, repo, known, pages)
    remember(key, repo.repoId, started, timelines)
  }
  return { repo, doc, starCount: count(SUB.star), ownerDomains: docsAt(res, SUB.domain), timelines }
}

/** Put a read in the store; a failed one is dropped (the next reader reads again). */
function remember(key: string, repoId: string, at: number, promise: Promise<RepoTimelines>): void {
  const entry: StoreEntry = { repoId, at, promise, settled: store.get(key)?.settled }
  store.set(key, entry)
  promise.then(
    (settled) => {
      entry.settled = settled
      entry.settledPromise = promise
    },
    () => {
      if (store.get(key) === entry) store.delete(key)
    },
  )
}

/**
 * A public repo's complete timelines, for a repo this tab read through {@link readRepoChrome}:
 * the stored ones when that read is in flight or started within `maxAgeMs`, else a new chrome
 * read (one request for what is new, plus any full pages). Null when the store holds nothing for
 * this repo (it was never read through the chrome, or its name now names another repo): the
 * caller reads the plain way.
 */
export async function repoTimelines(
  sdk: EvoSDK,
  repo: RepoRef,
  { maxAgeMs = TIMELINES_FRESH_MS, network = DEFAULT_NETWORK }: { readonly maxAgeMs?: number; readonly network?: Network } = {},
): Promise<RepoTimelines | null> {
  if (repo.visibility !== 'public') return null
  const hit = store.get(keyOf(repo.forge, repo.ownerId, repo.name))
  if (hit === undefined || hit.repoId !== repo.repoId) return null
  // A read in flight is joined (as the browse cache joins a re-resolve in flight), a settled one
  // answers within `maxAgeMs`; `at` 0 is a read a write made stale, in flight or not.
  if (hit.at !== 0 && (hit.promise !== hit.settledPromise || Date.now() - hit.at < maxAgeMs)) return hit.promise
  const chrome = await readRepoChrome(sdk, repo.forge, repo.ownerId, repo.name, network)
  return chrome?.repo.repoId === repo.repoId ? chrome.timelines : null
}

/**
 * The repo's content changed through this tab (a push, a merge, a release): the next reader
 * reads again. What is held stays, so that read asks only for the new rows.
 */
export function staleRepoTimelines(repo: RepoRef): void {
  const hit = store.get(keyOf(repo.forge, repo.ownerId, repo.name))
  if (hit !== undefined) hit.at = 0
}

/** Test hook: forget every stored timeline. */
export function resetRepoTimelines(): void {
  store.clear()
  chromeInFlight.clear()
}

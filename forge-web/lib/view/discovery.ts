/**
 * Discovery reads (view glue) — the repo feeds for the landing page, Explore and profiles.
 *
 * A repo IS a `repo` document in forge-core, so every feed is one proof-checked composite
 * (`documents.composite`, protocol 14): the page of repos plus, in the same verified round
 * trip, their star and issue counts (forge-collab's countable `star.byRepo` and `issue.number`
 * indexes, bound to the page's ids), their owners' DPNS names, and their latest pushes.
 *
 * - **Recent**: the `repo.recent` index (`$createdAt`), newest first.
 * - **Search**: the `repo.name` index. A name prefix is the range `name >= p AND name < p⁺`
 *   (Drive's `startsWith` is that same range, but it cannot be combined with the page's own
 *   range clause, and a composite page takes no cursor).
 * - **Most starred** and **Trending**: proved ranked reads (`documents.ranked`) of the
 *   `star.byRepo` and `starBeat.byWeek` indexes (C-1, platform-parity-spec §4.3), then the
 *   ranked repos by id ({@link rankedRepos}): two requests over every star on the network.
 * - **Recently updated**: pushes have no cross-repo index (`packManifest` and `refUpdate`
 *   indexes all lead with `repoId`), so the pushes of the last week of each repo already on a
 *   newest-first page ride along as a bound lookup, and the section ranks those repos only.
 *
 * Paging is keyset: the next page starts at the boundary value, and the ids already shown at
 * that value are skipped, so repos sharing a name or a timestamp are neither lost nor repeated.
 *
 * A profile lists the repos an identity owns (`($ownerId, name)`) and the ones it is a member
 * of (`memberId` indexes).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, NETWORKS, type Network } from '../constants'
import type { ForgeIds } from '../deployments'
import type { Role } from '../rules/v2'
import { queryDocumentsWithProof, type PlainDocument, type WhereClause } from '../sdk'
import { countsAt, docsAt, queryComposite, type CompositeSub, type CompositeResult } from '../sdk/composite'
import { DOC, readMemberRepoIds, toRepoDoc, type RepoDoc } from '../repo'
import { readMostForked, readMostStarred, readTrending, type TrendingWindow } from '../repo/trending'
import { seedFromDomains } from './dpns'

/** A repo row for the discovery feeds and profiles. */
export interface DiscoveredRepo {
  /** Stable row key: the `repo` document id. */
  readonly key: string
  readonly ownerId: string
  /** Display name (`displayName`, else the repo name). */
  readonly name: string
  /** The URL segment that addresses it (the repo `name`). */
  readonly slug: string
  readonly description: string
  readonly createdAt: number
  readonly visibility: 'public' | 'private'
  /** Provable counts, or null when not read. */
  readonly stars?: number | null
  readonly issues?: number | null
  /**
   * The newest push that uploaded objects (a `packManifest`) in the last week, when the page's
   * push lookup read it; null when none was read (none in the window, or past the read's end).
   */
  readonly pushedAt?: number | null
  /** Profile pages: the viewer's role in a repo it does not own. */
  readonly role?: Role
}

function fromRepoDoc(doc: RepoDoc, extra: Partial<Pick<DiscoveredRepo, 'stars' | 'issues' | 'pushedAt'>> = {}): DiscoveredRepo {
  return {
    key: doc.repoId,
    ownerId: doc.ownerId,
    name: doc.displayName || doc.name,
    slug: doc.name,
    description: doc.description,
    createdAt: doc.createdAt,
    visibility: doc.visibility,
    stars: extra.stars ?? null,
    issues: extra.issues ?? null,
    pushedAt: extra.pushedAt ?? null,
  }
}

/** Rows per page on Explore and the landing page. */
export const REPO_PAGE = 24
/** The window "Recently updated" looks back over. */
export const PUSH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** A composite page and every bound lookup return at most this many rows. */
const MAX_ROWS = 100
/** A search term is a repo-name prefix: the characters a repo name can hold. */
const NAME_CHARS = /^[a-z0-9._-]{1,63}$/

/**
 * Where the next page starts: the boundary value of the ordering field, and the ids already
 * shown at exactly that value (skipped on the next read).
 */
export interface Keyset<T extends string | number> {
  readonly at: T
  readonly seen: readonly string[]
}

/** A page of repos and where the next one starts (null: this was the last). */
export interface RepoPage<T extends string | number> {
  readonly repos: DiscoveredRepo[]
  readonly next: Keyset<T> | null
  /** Whether each repo's `pushedAt` is known (the push lookups were short, so complete). */
  readonly pushesComplete: boolean
  /** The composite was refused, so the page came from a plain query: no counts, no pushes. */
  readonly fallback: boolean
  /**
   * More repos than one read holds shared the boundary value, so the rest of them were skipped
   * to keep paging (the list is incomplete there).
   */
  readonly skippedTies: boolean
}

/**
 * Cut one keyset page out of `rows` (read with `limit + after.seen.length` rows starting AT
 * `after.at`): drop the rows already shown, keep `limit`, and say where the next page starts.
 */
export function keysetPage<T extends string | number>(
  rows: readonly PlainDocument[],
  field: string,
  limit: number,
  requested: number,
  after: Keyset<T> | null,
): { rows: PlainDocument[]; next: Keyset<T> | null } {
  const skip = new Set(after?.seen ?? [])
  const fresh = rows.filter((d) => !skip.has(String(d['$id'])))
  const kept = fresh.slice(0, limit)
  const more = rows.length >= requested || fresh.length > kept.length
  const last = kept[kept.length - 1]
  if (!more || last === undefined) return { rows: kept, next: null }
  const at = last[field] as T
  const tied = kept.filter((d) => d[field] === at).map((d) => String(d['$id']))
  const seen = after !== null && after.at === at ? [...after.seen, ...tied] : tied
  return { rows: kept, next: { at, seen } }
}

/** The exclusive upper bound of every string starting with `prefix` (its last byte + 1). */
export function prefixUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
}

/**
 * The repo-name prefix a search box text asks for, or null when no repo name could start with
 * it (repo names are `[a-z0-9._-]`, lowercase; `owner/name` searches the name part).
 */
export function searchPrefix(text: string): string | null {
  const t = text.trim().toLowerCase()
  const name = t.includes('/') ? t.slice(t.lastIndexOf('/') + 1) : t
  return NAME_CHARS.test(name) ? name : null
}

/**
 * The sub-queries a repo page carries, bound to the repos (`$id`) found at `source`: star and
 * issue counts, the owners' DPNS names and, with `pushesSince`, the pushes since then. A push
 * is a `packManifest` (one per push that uploads objects; `refUpdate` rows are one per ref, and
 * a mirror's tag push is hundreds). The lookup walks the page's direction, so a descending page
 * sees each repo's newest push first.
 */
function repoSubs(forge: ForgeIds, network: Network, source: 'page' | number, pushesSince: number | null): CompositeSub[] {
  const bind = { source, sourceProperty: '$id', field: 'repoId' }
  return [
    { dataContractId: forge.collab, documentType: DOC.star, kind: 'counts', bind },
    { dataContractId: forge.collab, documentType: DOC.issue, kind: 'counts', bind },
    {
      dataContractId: NETWORKS[network].dpnsContractId,
      documentType: 'domain',
      bind: { source, sourceProperty: '$ownerId', field: 'records.identity' },
      limit: MAX_ROWS,
    },
    ...(pushesSince === null
      ? []
      : [
          {
            dataContractId: forge.core,
            documentType: DOC.packManifest,
            bind,
            where: [['$createdAt', '>', pushesSince]] as WhereClause[],
            orderBy: [['repoId', 'desc'], ['$createdAt', 'desc']] as const,
            limit: MAX_ROWS,
          },
        ]),
  ]
}

/** The repo rows of a composite whose {@link repoSubs} start at sub-result `first`. */
function reposOf(res: CompositeResult, repoDocs: readonly PlainDocument[], first: number, network: Network): { repos: DiscoveredRepo[]; pushesComplete: boolean } {
  const stars = countsAt(res, first)
  const issues = countsAt(res, first + 1)
  const pushDocs = docsAt(res, first + 3)
  const pushed = new Map<string, number>()
  for (const d of pushDocs) {
    const repoId = String(d['repoId'] ?? '')
    const at = typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0
    if (at > (pushed.get(repoId) ?? 0)) pushed.set(repoId, at)
  }
  const docs = repoDocs.map(toRepoDoc)
  seedFromDomains(network, [...new Set(docs.map((d) => d.ownerId))], docsAt(res, first + 2))
  // A missing id in a proven count is zero; an absent count sub-result is unknown.
  const count = (m: ReadonlyMap<string, number> | null, id: string): number | null => (m === null ? null : m.get(id) ?? 0)
  return {
    repos: docs.map((doc) => fromRepoDoc(doc, { stars: count(stars, doc.repoId), issues: count(issues, doc.repoId), pushedAt: pushed.get(doc.repoId) ?? null })),
    // A full lookup may have stopped before some repos' pushes.
    pushesComplete: res.subs.length > first + 3 && pushDocs.length < MAX_ROWS,
  }
}

/**
 * One keyset page of `repo` documents ordered by `field`, with the page's counts, names and
 * pushes in the same composite. If the composite surface is refused, the same page is read as
 * a plain query without counts (never one count request per repo).
 */
async function readRepoPage<T extends string | number>(
  sdk: EvoSDK,
  forge: ForgeIds,
  network: Network,
  order: { field: string; direction: 'asc' | 'desc' },
  where: (after: Keyset<T> | null, strict: boolean) => WhereClause[],
  limit: number,
  after: Keyset<T> | null,
): Promise<RepoPage<T>> {
  // The ids shown at the boundary are re-read and skipped. Once they would crowd out a page,
  // step strictly past the boundary instead, and say that the rest of that tie was skipped.
  const strict = after !== null && after.seen.length + limit > MAX_ROWS
  const from = strict ? null : after
  const requested = Math.min(MAX_ROWS, limit + (from?.seen.length ?? 0))
  const pageWhere = where(after, strict)
  const orderBy = [[order.field, order.direction]] as const
  const pushesSince = order.direction === 'desc' ? Date.now() - PUSH_WINDOW_MS : null
  let rows: PlainDocument[]
  let res: CompositeResult | null = null
  try {
    res = await queryComposite(
      sdk,
      { dataContractId: forge.core, documentType: DOC.repo, where: pageWhere, orderBy, limit: requested, subQueries: repoSubs(forge, network, 'page', pushesSince) },
      { plainFallback: false },
    )
    rows = res.page
  } catch (e) {
    if (!isRefused(e)) throw e
    rows = (await queryDocumentsWithProof(sdk, { dataContractId: forge.core, documentTypeName: DOC.repo, where: pageWhere, orderBy, limit: requested })).documents
  }
  const cut = keysetPage<T>(rows, order.field, limit, requested, from)
  const { repos, pushesComplete } =
    res === null ? { repos: cut.rows.map((d) => fromRepoDoc(toRepoDoc(d))), pushesComplete: true } : reposOf(res, cut.rows, 0, network)
  return { repos, next: cut.next, pushesComplete, fallback: res === null, skippedTies: strict }
}

/**
 * The composite surface refused the request's shape (an older node or SDK, which answers a
 * shape it does not know with "invalid argument"), not a network error.
 */
export function isRefused(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)
  return /unsupported|not supported|not available|unimplemented|unknown (field|variant)|is not a function|invalid argument/i.test(msg)
}

const EMPTY_PAGE: RepoPage<never> = { repos: [], next: null, pushesComplete: true, fallback: false, skippedTies: false }

function forgeOf(network: Network): ForgeIds | null {
  return NETWORKS[network].v2
}

/** A page of the newest repos, newest first (`$createdAt <=` the previous page's oldest). */
export async function recentReposPage(
  sdk: EvoSDK,
  opts: { network?: Network; limit?: number; after?: Keyset<number> | null } = {},
): Promise<RepoPage<number>> {
  const network = opts.network ?? DEFAULT_NETWORK
  const forge = forgeOf(network)
  if (forge === null) return EMPTY_PAGE
  return readRepoPage<number>(
    sdk,
    forge,
    network,
    { field: '$createdAt', direction: 'desc' },
    (after, strict) => (after === null ? [] : [['$createdAt', strict ? '<' : '<=', after.at]]),
    opts.limit ?? REPO_PAGE,
    opts.after ?? null,
  )
}

/**
 * The landing feed: the newest repos, newest first. Empty on a network without a forge-v2
 * deployment (the caller shows "not deployed" before asking).
 */
export async function listRecentRepos(sdk: EvoSDK, opts: { network?: Network; limit?: number } = {}): Promise<DiscoveredRepo[]> {
  return (await recentReposPage(sdk, opts)).repos
}

/**
 * A page of the repos whose name starts with `text` (see {@link searchPrefix}), by name.
 * A text no repo name can start with answers empty without a request.
 */
export async function searchRepos(
  sdk: EvoSDK,
  text: string,
  opts: { network?: Network; limit?: number; after?: Keyset<string> | null } = {},
): Promise<RepoPage<string>> {
  const network = opts.network ?? DEFAULT_NETWORK
  const forge = forgeOf(network)
  const prefix = searchPrefix(text)
  if (forge === null || prefix === null) return EMPTY_PAGE
  const upper = prefixUpperBound(prefix)
  return readRepoPage<string>(
    sdk,
    forge,
    network,
    { field: 'name', direction: 'asc' },
    (after, strict) => [
      after === null ? ['name', '>=', prefix] : ['name', strict ? '>' : '>=', after.at],
      ['name', '<', upper],
    ],
    opts.limit ?? REPO_PAGE,
    opts.after ?? null,
  )
}

/** Repos named exactly `name` (any owner), for the jump box: the first {@link NAMED_MAX}. */
export const NAMED_MAX = 20

/**
 * The repos named exactly `name`, any owner (a name is unique per owner only, so this is a
 * short page on the `name` index), and whether more owners use it. Empty for an invalid name.
 */
export async function reposNamed(sdk: EvoSDK, name: string, opts: { network?: Network } = {}): Promise<{ repos: DiscoveredRepo[]; more: boolean }> {
  const network = opts.network ?? DEFAULT_NETWORK
  const forge = forgeOf(network)
  const n = name.trim().toLowerCase()
  if (forge === null || !NAME_CHARS.test(n)) return { repos: [], more: false }
  const page = await readRepoPage<string>(sdk, forge, network, { field: 'name', direction: 'asc' }, () => [['name', '==', n]], NAMED_MAX, null)
  return { repos: page.repos, more: page.next !== null }
}

/** A proved ranking of repos: the ranked read's order and counts, with each repo's row. */
export interface RankedRepos {
  /** Highest first, as the ranked index proved it (ties by repo id, descending). */
  readonly repos: readonly (DiscoveredRepo & { readonly rankCount: number })[]
  /** Ranked groups whose `repo` document could not be read (should not happen: repos are permanent). */
  readonly missing: number
  /** Whether each repo's `pushedAt` is known (the push lookup was short, so complete). */
  readonly pushesComplete: boolean
}

/**
 * Trending (new stargazers in the week or today, `starBeat`), Most starred (all time,
 * `star.byRepo`) or Most forked (`repo.forkOf`, its non-fork null group dropped): one proved ranked read, then the ranked repos by id in one composite with
 * their star and issue counts, owners' names and pushes. Two requests, whatever the star count
 * (this replaces the bounded 100-star read that ranked only the repos those stars named).
 */
export async function rankedRepos(
  sdk: EvoSDK,
  kind: TrendingWindow | 'most-starred' | 'most-forked',
  opts: { network?: Network; limit?: number } = {},
): Promise<RankedRepos> {
  const network = opts.network ?? DEFAULT_NETWORK
  const forge = forgeOf(network)
  if (forge === null) return { repos: [], missing: 0, pushesComplete: true }
  const limit = Math.min(opts.limit ?? 12, MAX_ROWS)
  const page =
    kind === 'most-starred'
      ? await readMostStarred(sdk, forge, limit)
      : kind === 'most-forked'
        ? await readMostForked(sdk, forge, limit)
        : await readTrending(sdk, forge, kind, limit)
  const ids = page.entries.map((e) => e.group).filter((id) => id !== '')
  if (ids.length === 0) return { repos: [], missing: 0, pushesComplete: true }
  let rows: DiscoveredRepo[]
  let pushesComplete = true
  try {
    const res = await queryComposite(
      sdk,
      {
        dataContractId: forge.core,
        documentType: DOC.repo,
        where: [['$id', 'in', ids]],
        // Descending, as the pushes lookup is: a sub-query that disagrees with the page's
        // direction is refused (and this would silently fall back to the plain read).
        orderBy: [['$id', 'desc']],
        limit: ids.length,
        subQueries: repoSubs(forge, network, 'page', Date.now() - PUSH_WINDOW_MS),
      },
      { plainFallback: false },
    )
    ;({ repos: rows, pushesComplete } = reposOf(res, res.page, 0, network))
  } catch (e) {
    if (!isRefused(e)) throw e
    const plain = await queryDocumentsWithProof(sdk, { dataContractId: forge.core, documentTypeName: DOC.repo, where: [['$id', 'in', ids]], orderBy: [['$id', 'asc']], limit: ids.length })
    rows = plain.documents.map((d) => fromRepoDoc(toRepoDoc(d)))
  }
  const byId = new Map(rows.map((r) => [r.key, r]))
  const repos = page.entries.flatMap((e) => {
    const r = byId.get(e.group)
    return r === undefined ? [] : [{ ...r, rankCount: e.count }]
  })
  return { repos, missing: ids.length - repos.length, pushesComplete }
}

/**
 * "Recently updated": the repos among `lists` with a push in the window, newest push first,
 * each repo once (the copy with the newest push). Pure; the pushes came with the lists' reads.
 */
export function recentlyUpdated(lists: readonly (readonly DiscoveredRepo[])[], limit = 12): DiscoveredRepo[] {
  const byId = new Map<string, DiscoveredRepo>()
  for (const r of lists.flat()) {
    if (typeof r.pushedAt !== 'number') continue
    const held = byId.get(r.key)
    if (held === undefined || (held.pushedAt ?? 0) < r.pushedAt) byId.set(r.key, r)
  }
  return [...byId.values()].sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0)).slice(0, limit)
}

/**
 * Repos an identity owns (`repo` documents, `($ownerId, name)` index) and repos it is a
 * maintainer or writer of, each newest first.
 */
export async function listReposByOwner(
  sdk: EvoSDK,
  ownerId: string,
  opts: { network?: Network; limit?: number; counts?: boolean } = {},
): Promise<{ owned: DiscoveredRepo[]; member: DiscoveredRepo[] }> {
  const forge = NETWORKS[opts.network ?? DEFAULT_NETWORK].v2
  if (forge === null) return { owned: [], member: [] }
  const limit = opts.limit ?? 50

  // `counts`: one composite with each repo's star and issue counts (L-86: the profile's cards
  // show them, as Explore's do), through the `ownerName` index. Callers that need only the ids
  // (the inbox poll) keep the plain read.
  const owned = async (): Promise<DiscoveredRepo[]> => {
    if (opts.counts) {
      const page = await readRepoPage<string>(sdk, forge, opts.network ?? DEFAULT_NETWORK, { field: 'name', direction: 'asc' }, () => [['$ownerId', '==', ownerId]], Math.min(limit, MAX_ROWS), null)
      return page.repos
    }
    const { documents } = await queryDocumentsWithProof(sdk, {
      dataContractId: forge.core,
      documentTypeName: DOC.repo,
      where: [['$ownerId', '==', ownerId]],
      orderBy: [['name', 'asc']],
      limit,
    })
    return documents.map((d) => fromRepoDoc(toRepoDoc(d)))
  }
  const member = async (): Promise<DiscoveredRepo[]> => {
    const rows = (await readMemberRepoIds(sdk, forge, ownerId)).slice(0, limit)
    if (rows.length === 0) return []
    const { documents } = await queryDocumentsWithProof(sdk, {
      dataContractId: forge.core,
      documentTypeName: DOC.repo,
      where: [['$id', 'in', rows.map((r) => r.repoId)]],
      limit: rows.length,
    })
    const roleOf = new Map(rows.map((r) => [r.repoId, r.role]))
    return documents
      .map(toRepoDoc)
      .filter((doc) => doc.ownerId !== ownerId)
      .map((doc) => ({ ...fromRepoDoc(doc), role: roleOf.get(doc.repoId) }))
  }

  // Independent sources: one failing must not blank the other. Both failing is an error.
  const settled = await Promise.allSettled([owned(), member()])
  if (settled.every((r) => r.status === 'rejected')) throw (settled[0] as PromiseRejectedResult).reason
  const [ownedRows, memberRows] = settled.map((r) => (r.status === 'fulfilled' ? r.value : [])) as [
    DiscoveredRepo[],
    DiscoveredRepo[],
  ]
  const newestFirst = (x: DiscoveredRepo, y: DiscoveredRepo): number => y.createdAt - x.createdAt
  return { owned: ownedRows.sort(newestFirst), member: memberRows.sort(newestFirst) }
}

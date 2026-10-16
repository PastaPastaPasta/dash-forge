/**
 * Discovery reads (view glue) — the repo feeds for the landing page, Explore and profiles.
 *
 * A repo IS a `repo` document in forge-core, so every feed is one proof-checked composite
 * (`documents.composite`, protocol 14): the page of repos plus, in the same verified round
 * trip, their star and issue counts (forge-community's countable `star.byRepo` and forge-collab's `issue.number`
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
import { queryDocumentsWithProof, RANGE_OPERATORS, type PlainDocument, type WhereClause } from '../sdk'
import { countsAt, docsAt, queryComposite, type CompositeSub, type CompositeResult } from '../sdk/composite'
import { DOC, asIdentifierString, contractOf, readMemberRepoIds, toRepoDoc, type RepoDoc } from '../repo'
import { starShape } from '../repo/star-shape'
import {
  FUSED_READ_AHEAD,
  MIN_STARGAZERS,
  OWNER_STAR_LOOKUP_LIMIT,
  fusedTrending,
  ownerStarLookupOf,
  readMostForked,
  readMostStarred,
  readOwnerStars,
  readTrending,
  selfStarDecidable,
  trendingWindowOf,
  type OwnerStarLookup,
  type TrendingWindow,
} from '../repo/trending'
import { MAX_TOPIC_CHARS, TOPIC_PATTERN } from '../repo/settings'
import { activeHidden, dropHidden, type Hidden } from './curation'
import { mapPooled } from './pool'
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
  /** The repo it was forked from (its id), or null; absent where a caller built the row by hand. */
  readonly forkOf?: string | null
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

export function fromRepoDoc(doc: RepoDoc, extra: Partial<Pick<DiscoveredRepo, 'stars' | 'issues' | 'pushedAt'>> = {}): DiscoveredRepo {
  return {
    key: doc.repoId,
    ownerId: doc.ownerId,
    name: doc.displayName || doc.name,
    slug: doc.name,
    description: doc.description,
    createdAt: doc.createdAt,
    visibility: doc.visibility,
    forkOf: doc.forkOf ?? null,
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
 * a mirror's tag push is hundreds). The lookup's outer (`repoId`) ordering must match the
 * direction the node walks the page in (else it refuses the composite; see {@link pageWalk}).
 * Each repo's pushes are newest first either way; the newest is what is kept.
 */
function repoSubs(forge: ForgeIds, network: Network, source: 'page' | number, pushesSince: number | null, pushesOuter: 'asc' | 'desc' = 'desc'): CompositeSub[] {
  const bind = { source, sourceProperty: '$id', field: 'repoId' }
  return [
    { dataContractId: forge.community, documentType: DOC.star, kind: 'counts', bind },
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
            orderBy: [['repoId', pushesOuter], ['$createdAt', 'desc']] as const,
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
 * The direction the node walks a page, which is the one a composite's bound documents sub-query
 * must be ordered in (drive's `page_direction`: the page path query's `left_to_right`). A page
 * whose last clause is a range (`in` counts as one) walks in its order's direction; a page whose
 * clauses are all `==` walks ascending, whatever its order asks; a page with no clause walks in
 * its order's direction (drive `single_in_path_query`). Measured on bonsia: `repo.recent
 * (visibility, $createdAt)` pages `$createdAt desc`; its first page needed `asc`, and its later
 * pages, which add `$createdAt <=`, needed `desc`. A later page sent with the first page's `asc`
 * was refused, fell back to the plain query, and lost its counts and names.
 */
export function pageWalk(where: readonly WhereClause[], order: { field: string; direction: 'asc' | 'desc' }): 'asc' | 'desc' {
  const walks = where.length === 0 || where.some(([, op]) => op === 'in' || RANGE_OPERATORS.has(op))
  return walks ? order.direction : 'asc'
}

/**
 * One keyset page of `repo` documents ordered by `field`, with the page's counts, names and
 * pushes in the same composite. If the composite surface is refused, the same page is read as
 * a plain query without counts (never one count request per repo).
 */
async function readRepoPageOnce<T extends string | number>(
  sdk: EvoSDK,
  forge: ForgeIds,
  network: Network,
  order: { field: string; direction: 'asc' | 'desc' },
  where: (after: Keyset<T> | null, strict: boolean) => WhereClause[],
  limit: number,
  after: Keyset<T> | null,
): Promise<RepoPage<T> & { readonly dropped: number }> {
  // The ids shown at the boundary are re-read and skipped. Once they would crowd out a page,
  // step strictly past the boundary instead, and say that the rest of that tie was skipped.
  const strict = after !== null && after.seen.length + limit > MAX_ROWS
  const from = strict ? null : after
  const requested = Math.min(MAX_ROWS, limit + (from?.seen.length ?? 0))
  const pageWhere = where(after, strict)
  const orderBy = [[order.field, order.direction]] as const
  // Every page reads its repos' recent pushes, name-ordered ones (search, a profile) too, so a
  // card says "pushed" or "created" by the same rule wherever it shows (QW3-041: search and
  // profile cards said "created 17h ago" where Explore's said "pushed 16h ago"). The lookup's
  // outer order follows the page's walk ({@link pageWalk}), which the node requires.
  const pushesSince = Date.now() - PUSH_WINDOW_MS
  let rows: PlainDocument[]
  let res: CompositeResult | null = null
  try {
    res = await queryComposite(
      sdk,
      { dataContractId: forge.core, documentType: DOC.repo, where: pageWhere, orderBy, limit: requested, subQueries: repoSubs(forge, network, 'page', pushesSince, pageWalk(pageWhere, order)) },
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
  // Hosted curation (docs/hosted-curation.md): dropped after the keyset cut, so paging is unchanged.
  const shown = dropHidden(repos)
  return { repos: shown, next: cut.next, pushesComplete, fallback: res === null, skippedTies: strict, dropped: repos.length - shown.length }
}

/** Most reads a page makes to fill itself past hidden repos. */
const FILL_READS = 3

/**
 * {@link readRepoPageOnce}, read on while hidden repos left the page short and more follow: a
 * page of hidden repos (one identity bulk-creating repos) must not read as the end of the list
 * (docs/hosted-curation.md). Costs nothing when nothing on the page is hidden. The pages are
 * joined, so a result may hold more than `limit` repos; `next` is where the last read ended.
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
  let page = await readRepoPageOnce(sdk, forge, network, order, where, limit, after)
  for (let i = 1; i < FILL_READS && page.dropped > 0 && page.repos.length < limit && page.next !== null && !page.skippedTies; i++) {
    const more = await readRepoPageOnce(sdk, forge, network, order, where, limit - page.repos.length, page.next)
    page = {
      repos: [...page.repos, ...more.repos],
      next: more.next,
      pushesComplete: page.pushesComplete && more.pushesComplete,
      fallback: page.fallback || more.fallback,
      skippedTies: more.skippedTies,
      dropped: page.dropped + more.dropped,
    }
  }
  const { dropped: _dropped, ...rest } = page
  return rest
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

/**
 * A page of the newest public repos, newest first (`$createdAt <=` the previous page's oldest).
 * RC1's `repo.recent` index is `(visibility, $createdAt)`: the page binds `visibility ==
 * "public"` and pages on `$createdAt` within it (a query ordered by `$createdAt` alone names
 * no index, and consensus refuses it), so private repos are no longer listed.
 */
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
    (after, strict) => [['visibility', '==', 'public'], ...(after === null ? [] : [['$createdAt', strict ? '<' : '<=', after.at] as WhereClause])],
    opts.limit ?? REPO_PAGE,
    opts.after ?? null,
  )
}

/**
 * The landing feed: the newest public repos, newest first. Empty on a network without a forge-v2
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

/** Pages `/github.com/<owner>/<repo>` reads of same-named repos before it says "no mirror" (ABU-04). */
export const MIRROR_NAMED_PAGES = 5

/**
 * The repos named exactly `name`, any owner (a name is unique per owner only, so this is a
 * short page on the `name` index), and whether more owners use it. Empty for an invalid name.
 * `pages` times {@link NAMED_MAX} repos (the jump box reads one page; a mirror lookup must not
 * be hidden behind 20 look-alikes, so it reads {@link MIRROR_NAMED_PAGES}) in ONE read. One
 * composite holds at most {@link MAX_ROWS} repos: past that `more` stays true.
 */
export async function reposNamed(sdk: EvoSDK, name: string, opts: { network?: Network; pages?: number } = {}): Promise<{ repos: DiscoveredRepo[]; more: boolean }> {
  const network = opts.network ?? DEFAULT_NETWORK
  const forge = forgeOf(network)
  const n = name.trim().toLowerCase()
  if (forge === null || !NAME_CHARS.test(n)) return { repos: [], more: false }
  // One read of up to `pages` pages' worth (a composite page holds at most MAX_ROWS repos).
  const want = Math.min(MAX_ROWS, NAMED_MAX * Math.max(1, opts.pages ?? 1))
  const page = await readRepoPage<string>(sdk, forge, network, { field: 'name', direction: 'asc' }, () => [['name', '==', n]], want, null)
  return { repos: page.repos, more: page.next !== null }
}

/** A proved ranking of repos: the ranked read's order and counts, with each repo's row. */
export interface RankedRepos {
  /**
   * Highest first, as the ranked index proved it (ties by repo id, descending); on a fused-star
   * Trending, as filtered on read (`fusedTrending`: private repos and owners' stars left out).
   */
  readonly repos: readonly (DiscoveredRepo & { readonly rankCount: number })[]
  /** Ranked groups whose `repo` document could not be read (should not happen: repos are permanent). */
  readonly missing: number
  /** Whether each repo's `pushedAt` is known (the push lookup was short, so complete). */
  readonly pushesComplete: boolean
  /**
   * Most forked: some repo had more forks than one read holds, so its count of distinct owners
   * is a lower bound (the first {@link MAX_ROWS} forks).
   */
  readonly approximate?: boolean
  /**
   * Most forked: the groups examined were the most forked by raw count, and the window was full,
   * so a repo with fewer forks from more owners may be missing.
   */
  readonly incomplete?: boolean
}

/**
 * Trending (new stargazers in the week or today: `starBeat`, or the star itself on a fused-star
 * contract, `lib/repo/star-shape.ts`), Most starred (all time, `star.byRepo`) or Most forked
 * (`repo.forkOf`, its non-fork null group dropped): one proved ranked read, then the ranked
 * repos by id in one composite with their star and issue counts, owners' names and pushes. Two
 * requests, whatever the star count (this replaces the bounded 100-star read that ranked only
 * the repos those stars named).
 *
 * ABU-02: counts are unweighted (every identity counts once, however new), so a repo needs
 * {@link MIN_STARGAZERS} (stargazers, or new ones in the window) to be ranked at all, and Most
 * forked counts distinct fork owners ({@link rankedForked}). Repos this build hides are left out.
 *
 * On a fused-star contract consensus no longer keeps private repos and owners' own stars out
 * of Trending, so the read takes {@link FUSED_READ_AHEAD} times the rows and filters them here
 * ({@link fusedTrending}). Whether an owner stars its own repo rides in the repos' composite
 * (a lookup of the page owners' stars, `star.byOwner`), so Trending is still two requests; a
 * lookup the node refused or cut short leaves the unsettled pairs to one read each
 * ({@link readOwnerStars}).
 */
export async function rankedRepos(
  sdk: EvoSDK,
  kind: TrendingWindow | 'most-starred' | 'most-forked',
  opts: { network?: Network; limit?: number; minStargazers?: number } = {},
): Promise<RankedRepos> {
  const network = opts.network ?? DEFAULT_NETWORK
  const forge = forgeOf(network)
  if (forge === null) return { repos: [], missing: 0, pushesComplete: true }
  const limit = Math.min(opts.limit ?? 12, MAX_ROWS)
  if (kind === 'most-forked') return rankedForked(sdk, forge, network, limit)
  const minStargazers = opts.minStargazers ?? MIN_STARGAZERS
  const fused = kind !== 'most-starred' && (await starShape(sdk, forge)) === 'fused'
  const ahead = fused ? Math.min(limit * FUSED_READ_AHEAD, MAX_ROWS) : limit
  const page = kind === 'most-starred' ? await readMostStarred(sdk, forge, limit) : await readTrending(sdk, forge, kind, ahead)
  // The ranking is by count, highest first: a repo below the floor ends the list (ABU-02: a few
  // sock-puppet identities must not top it). Nothing past the floor is read.
  const entries = page.entries.filter((e) => e.group !== '' && e.count >= minStargazers)
  const ids = entries.map((e) => e.group)
  if (ids.length === 0) return { repos: [], missing: 0, pushesComplete: true }
  const got = await reposById(sdk, forge, network, ids, { ownerStars: fused })
  const { pushesComplete, ownerStars } = got
  // A hidden repo is not "missing": it was read and is left out (docs/hosted-curation.md).
  const missing = ids.filter((id) => !got.byId.has(id)).length
  const byId = withoutHidden(got.byId)
  if (fused) {
    const window = trendingWindowOf(kind as TrendingWindow, Date.now())
    const young = [...byId.values()].filter((r) => selfStarDecidable(r, window))
    const ownerStarred = await readOwnerStars(sdk, forge, young.map((r) => ({ repoId: r.key, ownerId: r.ownerId })), ownerStars)
    return { repos: fusedTrending(entries, byId, ownerStarred, limit, minStargazers), missing, pushesComplete }
  }
  const repos = entries.flatMap((e) => {
    const r = byId.get(e.group)
    return r === undefined ? [] : [{ ...r, rankCount: e.count }]
  })
  return { repos, missing, pushesComplete }
}

/** Most forked reads this many times the page's groups: the raw count is re-ranked below the page. */
export const FORK_READ_AHEAD = 3

/**
 * The distinct owners of each parent's forks, from fork documents (`repo` rows with `forkOf`).
 * The parent's own owner is left out: forking your own repo says nothing about it. So are the
 * identities this build hides (docs/hosted-curation.md).
 */
export function forkOwnersByParent(
  forks: readonly PlainDocument[],
  parentOwners: ReadonlyMap<string, string>,
  hidden: Hidden = activeHidden(),
): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>()
  for (const d of forks) {
    const parent = asIdentifierString(d['forkOf'])
    const owner = asIdentifierString(d['$ownerId'])
    if (parent === '' || owner === '' || owner === parentOwners.get(parent) || hidden.identities.has(owner)) continue
    const held = owners.get(parent)
    if (held === undefined) owners.set(parent, new Set([owner]))
    else held.add(owner)
  }
  return owners
}

/** Fork reads in flight at once when a repo's forks were not all in the page's lookup. */
const FORK_READ_PARALLEL = 8

/**
 * Most forked, ranked by distinct fork owners (ABU-02): the `repo.forkOf` ranked read counts fork
 * documents, so one identity forking a repo 300 times topped it. The top {@link FORK_READ_AHEAD}
 * times the page of groups is read, with their forks in the same composite as the repos (a
 * lookup bound to the page), and re-ranked by how many different identities forked each. A
 * fork's "has a ref update" is not required: that needs a read per fork that no index answers
 * in bulk, so a fork counts when it exists.
 *
 * Two things make the result partial, and it says so:
 * - the lookup holds at most {@link MAX_ROWS} forks. A repo whose forks were not all in it is
 *   read on its own (one query, its first {@link MAX_ROWS} forks); past that its count is a
 *   lower bound (`approximate`);
 * - only the groups with the most forks by raw count are examined, so when that window is full
 *   and its last raw count could still beat the shown ones, a repo with fewer forks from more
 *   owners may be missing (`incomplete`).
 */
async function rankedForked(sdk: EvoSDK, forge: ForgeIds, network: Network, limit: number): Promise<RankedRepos> {
  const read = Math.min(limit * FORK_READ_AHEAD, MAX_ROWS)
  const page = await readMostForked(sdk, forge, read)
  const ids = page.entries.map((e) => e.group).filter((id) => id !== '')
  if (ids.length === 0) return { repos: [], missing: 0, pushesComplete: true }
  const got = await reposById(sdk, forge, network, ids, { forks: true })
  const missing = ids.filter((id) => !got.byId.has(id)).length
  const byId = withoutHidden(got.byId)
  const parentOwners = new Map([...got.byId.values()].map((r) => [r.key, r.ownerId]))
  const raw = new Map(page.entries.map((e) => [e.group, e.count]))
  const held = new Map<string, number>()
  for (const d of got.forkRows ?? []) held.set(asIdentifierString(d['forkOf']), (held.get(asIdentifierString(d['forkOf'])) ?? 0) + 1)
  // Groups the lookup did not hold whole (or all of them, when it was refused) are read on their
  // own, a few at a time. A hidden repo is never listed, so its forks are not read.
  const unheld = ids.filter((id) => byId.has(id) && (held.get(id) ?? 0) < (raw.get(id) ?? 0))
  const own = await mapPooled(unheld, FORK_READ_PARALLEL, async (id) => ({
    id,
    documents: (
      await queryDocumentsWithProof(sdk, {
        dataContractId: forge.core,
        documentTypeName: DOC.repo,
        where: [['forkOf', '==', id]],
        orderBy: [['forkOf', 'asc']],
        limit: MAX_ROWS,
      })
    ).documents,
  }))
  const readOwn = new Set(unheld)
  // This group's partial rows are replaced by the group's own read.
  const rows = [...(got.forkRows ?? []).filter((d) => !readOwn.has(asIdentifierString(d['forkOf']))), ...own.flatMap((o) => o.documents)]
  const approximate = own.some((o) => o.documents.length >= MAX_ROWS && (raw.get(o.id) ?? 0) > MAX_ROWS)
  const owners = forkOwnersByParent(rows, parentOwners)
  const ranked = page.entries.flatMap((e) => {
    const r = byId.get(e.group)
    const n = owners.get(e.group)?.size ?? 0
    return r === undefined || n === 0 ? [] : [{ ...r, rankCount: n, tie: e.keyHex }]
  })
  // As Drive ranks: count descending, then group key descending.
  ranked.sort((a, b) => b.rankCount - a.rankCount || (a.tie < b.tie ? 1 : a.tie > b.tie ? -1 : 0))
  const shown = ranked.slice(0, limit)
  // The window was full, and the group past it could hold as many owners as the last one shown.
  const lastRaw = page.entries[page.entries.length - 1]?.count ?? 0
  const incomplete = page.entries.length >= read && (shown.length < limit || lastRaw > (shown[limit - 1]?.rankCount ?? 0))
  return {
    repos: shown.map(({ tie: _tie, ...r }) => r),
    missing,
    pushesComplete: got.pushesComplete,
    ...(approximate ? { approximate } : {}),
    ...(incomplete ? { incomplete } : {}),
  }
}

/** `byId` without the repos this build hides (docs/hosted-curation.md). */
function withoutHidden(byId: ReadonlyMap<string, DiscoveredRepo>): Map<string, DiscoveredRepo> {
  const kept = new Set(dropHidden([...byId.values()]).map((r) => r.key))
  return new Map([...byId].filter(([id]) => kept.has(id)))
}

/**
 * Repos of `ids` (at most {@link MAX_ROWS}) in one composite, with their star and issue counts,
 * owners' names and pushes, by id; one missing is left out. The showcase reads its repos so
 * (QW-045): one request, and the owner chips need no DPNS read of their own.
 */
export async function discoverReposById(sdk: EvoSDK, ids: readonly string[], opts: { network?: Network } = {}): Promise<Map<string, DiscoveredRepo>> {
  const network = opts.network ?? DEFAULT_NETWORK
  const forge = forgeOf(network)
  if (forge === null || ids.length === 0) return new Map()
  if (ids.length > MAX_ROWS) throw new Error(`discoverReposById reads at most ${MAX_ROWS} repos`)
  return withoutHidden((await reposById(sdk, forge, network, [...new Set(ids)])).byId)
}

/**
 * Repos by id (at most {@link MAX_ROWS}) in one composite, with their star and issue counts,
 * owners' names and pushes; the plain proved read if the composite is refused. With
 * `ownerStars`, the composite also looks up the stars of the repos' owners (`star.byOwner`) for
 * {@link readOwnerStars}; the result is null when that was not asked for or the composite was
 * refused.
 */
async function reposById(
  sdk: EvoSDK,
  forge: ForgeIds,
  network: Network,
  ids: readonly string[],
  opts: { ownerStars?: boolean; forks?: boolean } = {},
): Promise<{ byId: Map<string, DiscoveredRepo>; pushesComplete: boolean; ownerStars: OwnerStarLookup | null; forkRows: PlainDocument[] | null }> {
  let rows: DiscoveredRepo[]
  let pushesComplete = true
  let ownerStars: OwnerStarLookup | null = null
  let forkRows: PlainDocument[] | null = null
  const subQueries = repoSubs(forge, network, 'page', Date.now() - PUSH_WINDOW_MS)
  let ownerStarsAt = -1
  let forksAt = -1
  if (opts.forks) {
    forksAt = subQueries.length
    // The forks of the page's repos (`repo.forkOf`), for counting distinct fork owners. The page
    // walks `$id` descending, and a bound lookup must walk the same way.
    subQueries.push({
      dataContractId: forge.core,
      documentType: DOC.repo,
      bind: { source: 'page', sourceProperty: '$id', field: 'forkOf' },
      orderBy: [['forkOf', 'desc']],
      limit: MAX_ROWS,
    })
  }
  if (opts.ownerStars) {
    ownerStarsAt = subQueries.length
    subQueries.push({
      dataContractId: forge.community,
      documentType: DOC.star,
      bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' },
      // The page walks `$id` descending, and a bound lookup must walk the same way.
      orderBy: [['$ownerId', 'desc']],
      limit: OWNER_STAR_LOOKUP_LIMIT,
    })
  }
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
        subQueries,
      },
      { plainFallback: false },
    )
    ;({ repos: rows, pushesComplete } = reposOf(res, res.page, 0, network))
    // A missing or wrong-kind sub-result is no lookup (every pair is read), not an empty one.
    const lookup = res.subs[ownerStarsAt]
    if (opts.ownerStars && res.subs.length === subQueries.length && lookup?.kind === 'documents') ownerStars = ownerStarLookupOf(lookup.documents)
    const forkLookup = res.subs[forksAt]
    if (opts.forks && res.subs.length === subQueries.length && forkLookup?.kind === 'documents') forkRows = forkLookup.documents
  } catch (e) {
    if (!isRefused(e)) throw e
    const plain = await queryDocumentsWithProof(sdk, { dataContractId: forge.core, documentTypeName: DOC.repo, where: [['$id', 'in', ids]], orderBy: [['$id', 'asc']], limit: ids.length })
    rows = plain.documents.map((d) => fromRepoDoc(toRepoDoc(d)))
  }
  return { byId: new Map(rows.map((r) => [r.key, r])), pushesComplete, ownerStars, forkRows }
}

/** How many tagged repos a topic page shows (the newest tags). */
export const TOPIC_PAGE = 48

/** A topic's repos: the newest {@link TOPIC_PAGE} tags, and whether older ones exist. */
export interface TopicRepos {
  /** Newest tag first. */
  readonly repos: readonly DiscoveredRepo[]
  /** More repos carry the topic than were read. */
  readonly more: boolean
  /** Tags whose `repo` document could not be read (should not happen: repos are permanent). */
  readonly missing: number
}

/**
 * The public repos tagged `topic` (QW-073): the `topic` documents on its `byName` index
 * (name, $createdAt), newest first, then those repos by id. Two proved reads. A topic document
 * exists only for a public repo (forge-core refuses one for a private repo), so a private repo
 * is never listed. Empty for a name no topic can have.
 */
export async function reposWithTopic(sdk: EvoSDK, topic: string, opts: { network?: Network } = {}): Promise<TopicRepos> {
  const network = opts.network ?? DEFAULT_NETWORK
  const forge = forgeOf(network)
  if (forge === null || !TOPIC_PATTERN.test(topic) || topic.length > MAX_TOPIC_CHARS) return { repos: [], more: false, missing: 0 }
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: contractOf(forge, DOC.topic),
    documentTypeName: DOC.topic,
    where: [['name', '==', topic]],
    orderBy: [['$createdAt', 'desc']],
    limit: TOPIC_PAGE + 1,
  })
  const more = documents.length > TOPIC_PAGE
  const ids = [...new Set(documents.slice(0, TOPIC_PAGE).map((d) => asIdentifierString(d['repoId'])).filter((id) => id !== ''))]
  if (ids.length === 0) return { repos: [], more, missing: 0 }
  const { byId } = await reposById(sdk, forge, network, ids)
  const repos = ids.flatMap((id) => {
    const r = byId.get(id)
    return r === undefined ? [] : [r]
  })
  // Hidden repos are read and left out: not "missing" (docs/hosted-curation.md).
  return { repos: dropHidden(repos), more, missing: ids.length - repos.length }
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

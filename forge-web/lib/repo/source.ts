/**
 * RepoSource — where a repo's documents live and how a query is scoped to one repo.
 *
 * Every reader in `lib/repo` and `lib/view` builds its queries here. Every repo shares
 * forge-core (code: refs, config, packs, members, releases, labels), forge-collab (issues,
 * PRs, transitions, comments, reviews, events, milestones) and forge-community (stars,
 * watches, follows, check runs, policies, webhooks, profiles). Indexes that list a repo's documents lead
 * with `repoId`, so {@link RepoSource.repoQuery} prefixes `repoId ==` (`forge-v2.md` §2).
 * Indexes keyed by a document id (`targetId`, `patchId`) need no prefix — consensus ties
 * those references to the same repo — and go through {@link RepoSource.targetQuery}.
 *
 * Parity: forge-core's v2 data plane scopes its reads the same way; the index shapes are the
 * contract's own (`forge-contracts/contracts/forge-{core,collab,community}.json`).
 */

import { hexToBase64, type DocumentQuery, type OrderByClause, type WhereClause } from '../sdk'
import type { ForgeIds } from '../deployments'
import { DOC, type RepoRef } from './contract'

/** The forge-v2 document types held by forge-core. */
const CORE_TYPES: ReadonlySet<string> = new Set([
  DOC.repo,
  DOC.maintainer,
  DOC.writer,
  DOC.refUpdate,
  DOC.protectedRefUpdate,
  DOC.config,
  DOC.repoKey,
  DOC.packManifest,
  DOC.manifestPart,
  DOC.chunk,
  DOC.release,
  DOC.label,
  DOC.runner,
  DOC.topic,
])

/** The forge-v2 document types held by forge-community; the rest is forge-collab. */
export const COMMUNITY_TYPES: ReadonlySet<string> = new Set([
  DOC.star,
  DOC.starBeat,
  DOC.watch,
  DOC.follow,
  DOC.checkRun,
  DOC.policy,
  DOC.webhook,
  DOC.profile,
])

/** The contract of `forge` that holds `type` (`forge-v2.md` §2). */
export function contractOf(forge: ForgeIds, type: string): string {
  if (CORE_TYPES.has(type)) return forge.core
  return COMMUNITY_TYPES.has(type) ? forge.community : forge.collab
}

/** The clauses a caller adds to a scoped query. */
export interface QueryShape {
  readonly where?: readonly WhereClause[]
  readonly orderBy?: readonly OrderByClause[]
  readonly limit?: number
}

export interface RepoSource {
  /** A query on an index that lists this repo's documents (`repoId ==` prefixed). */
  repoQuery(documentType: string, shape?: QueryShape): DocumentQuery
  /**
   * A query on an index keyed by one of this repo's document ids (`targetId`, `patchId`).
   * The id already names one repo's document, so nothing is prefixed.
   */
  targetQuery(documentType: string, shape?: QueryShape): DocumentQuery
  /**
   * The `chunk` rows `seqs` of the artifact `packHashHex`. Chunks are keyed by the
   * uploader too (`(repoId, $ownerId, packHash, seq)`, `forge-v2.md` §4), so `uploader` —
   * the `$ownerId` of the manifest copy being read — is required.
   */
  chunkQuery(packHashHex: string, uploader: string, seqs: readonly number[]): DocumentQuery
}

/**
 * Platform's per-query document cap. A document query returns at most this many rows, so a
 * chunk read spanning more seqs than this is split (browse-source `queryChunkBatch`).
 */
export const CHUNK_QUERY_MAX = 100

function build(dataContractId: string, documentTypeName: string, shape: QueryShape): DocumentQuery {
  return { dataContractId, documentTypeName, ...shape }
}

/** The {@link RepoSource} for `repo`. Cheap: a few closures, no I/O. */
export function repoSource(repo: RepoRef): RepoSource {
  const repoQuery = (type: string, shape: QueryShape = {}): DocumentQuery =>
    build(contractOf(repo.forge, type), type, {
      ...shape,
      where: [['repoId', '==', repo.repoId], ...(shape.where ?? [])],
    })
  return {
    repoQuery,
    targetQuery: (type, shape = {}) => build(contractOf(repo.forge, type), type, shape),
    chunkQuery: (packHashHex, uploader, seqs) =>
      repoQuery(DOC.chunk, {
        where: [
          ['$ownerId', '==', uploader],
          ['packHash', '==', hexToBase64(packHashHex)],
          ['seq', 'in', [...seqs]],
        ],
        orderBy: [['seq', 'asc']],
        limit: CHUNK_QUERY_MAX,
      }),
  }
}

/**
 * RepoSource — where a repo's documents live and how a query is scoped to one repo.
 *
 * Every reader in `lib/repo` and `lib/view` builds its queries here, so the two data models
 * differ in exactly one place:
 *
 *  - **v1**: the repo IS a contract (`repo-v1.json`). Every document type sits in it and
 *    every index is already per-repo, so a query needs no scoping.
 *  - **v2**: every repo shares forge-core (code: refs, config, packs, members, releases,
 *    labels) and forge-collab (issues, PRs, comments, reviews, events, social). Indexes that
 *    list a repo's documents lead with `repoId`, so {@link RepoSource.repoQuery} prefixes
 *    `repoId ==` (`forge-v2.md` §2). Indexes keyed by a document id (`targetId`, `patchId`)
 *    need no prefix — consensus ties those references to the same repo — and go through
 *    {@link RepoSource.targetQuery}.
 *
 * Parity: forge-core's v2 data plane scopes its reads the same way (PR C); the index shapes
 * are the contract's own (`forge-contracts/contracts/forge-core.json`, `forge-collab.json`).
 */

import { hexToBase64, type DocumentQuery, type OrderByClause, type WhereClause } from '../sdk'
import { DOC, V2_DOC, type RepoRef } from './contract'

/** The forge-v2 document types held by forge-core; everything else is forge-collab. */
const CORE_TYPES: ReadonlySet<string> = new Set([
  V2_DOC.repo,
  V2_DOC.maintainer,
  V2_DOC.writer,
  DOC.refUpdate,
  DOC.protectedRefUpdate,
  DOC.config,
  DOC.packManifest,
  DOC.manifestPart,
  DOC.chunk,
  DOC.release,
  DOC.label,
  'repoKey',
])

/** The clauses a caller adds to a scoped query. */
export interface QueryShape {
  readonly where?: readonly WhereClause[]
  readonly orderBy?: readonly OrderByClause[]
  readonly limit?: number
}

export interface RepoSource {
  readonly repo: RepoRef
  /** The contract holding `documentType` for this repo. */
  contractOf(documentType: string): string
  /** A query on an index that lists this repo's documents (v2: `repoId ==` prefixed). */
  repoQuery(documentType: string, shape?: QueryShape): DocumentQuery
  /**
   * A query on an index keyed by one of this repo's document ids (`targetId`, `patchId`).
   * The id already names one repo's document, so nothing is prefixed.
   */
  targetQuery(documentType: string, shape?: QueryShape): DocumentQuery
  /**
   * The `chunk` rows `seqs` of the artifact `packHashHex`. On v2 chunks are keyed by the
   * uploader too (`(repoId, $ownerId, packHash, seq)`, `forge-v2.md` §4), so `uploader` —
   * the `$ownerId` of the manifest copy being read — is required there.
   */
  chunkQuery(packHashHex: string, uploader: string, seqs: readonly number[]): DocumentQuery
}

/** Platform's per-query document cap; a chunk batch never asks for more seqs than this. */
export const CHUNK_QUERY_MAX = 100

function build(dataContractId: string, documentTypeName: string, shape: QueryShape): DocumentQuery {
  return {
    dataContractId,
    documentTypeName,
    ...(shape.where !== undefined ? { where: shape.where } : {}),
    ...(shape.orderBy !== undefined ? { orderBy: shape.orderBy } : {}),
    ...(shape.limit !== undefined ? { limit: shape.limit } : {}),
  }
}

function v1Source(repo: Extract<RepoRef, { kind: 'v1' }>): RepoSource {
  const contractOf = (): string => repo.contractId
  return {
    repo,
    contractOf,
    repoQuery: (type, shape = {}) => build(repo.contractId, type, shape),
    targetQuery: (type, shape = {}) => build(repo.contractId, type, shape),
    chunkQuery: (packHashHex, _uploader, seqs) =>
      build(repo.contractId, DOC.chunk, {
        where: [
          ['packHash', '==', hexToBase64(packHashHex)],
          ['seq', 'in', [...seqs]],
        ],
        orderBy: [
          ['packHash', 'asc'],
          ['seq', 'asc'],
        ],
        limit: CHUNK_QUERY_MAX,
      }),
  }
}

function v2Source(repo: Extract<RepoRef, { kind: 'v2' }>): RepoSource {
  const contractOf = (type: string): string =>
    CORE_TYPES.has(type) ? repo.forge.core : repo.forge.collab
  const repoQuery = (type: string, shape: QueryShape = {}): DocumentQuery =>
    build(contractOf(type), type, {
      ...shape,
      where: [['repoId', '==', repo.repoId], ...(shape.where ?? [])],
    })
  return {
    repo,
    contractOf,
    repoQuery,
    targetQuery: (type, shape = {}) => build(contractOf(type), type, shape),
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

/** The {@link RepoSource} for `repo`. Cheap: a few closures, no I/O. */
export function repoSource(repo: RepoRef): RepoSource {
  return repo.kind === 'v1' ? v1Source(repo) : v2Source(repo)
}

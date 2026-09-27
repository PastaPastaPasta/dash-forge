/**
 * Discovery reads (view glue) — the repo feeds for the landing page and profiles.
 *
 * A repo IS a `repo` document in forge-core, so the feed is one proof-checked query on the
 * `$createdAt` index, and the star and issue counts ride along in the same verified round trip
 * (`documents.composite`: counts over forge-collab's `star.byRepo` and `issue.number` indexes,
 * bound to the page's repo ids). A profile lists the repos an identity owns (`($ownerId,
 * name)`) and the ones it is a member of (`memberId` indexes).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, NETWORKS, type Network } from '../constants'
import type { ForgeIds } from '../deployments'
import type { Role } from '../rules/v2'
import { normalizeDocument, queryDocumentsWithProof } from '../sdk'
import { DOC, readMemberRepoIds, toRepoDoc, type RepoDoc } from '../repo'

/** A repo row for the discovery feed and profiles. */
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
  /** Profile pages: the viewer's role in a repo it does not own. */
  readonly role?: Role
}

function fromRepoDoc(doc: RepoDoc, counts?: { stars?: number | null; issues?: number | null }): DiscoveredRepo {
  return {
    key: doc.repoId,
    ownerId: doc.ownerId,
    name: doc.displayName || doc.name,
    slug: doc.name,
    description: doc.description,
    createdAt: doc.createdAt,
    visibility: doc.visibility,
    stars: counts?.stars ?? null,
    issues: counts?.issues ?? null,
  }
}

interface CompositeResultLike {
  pageDocuments: unknown[]
  subResults: ({ kind: 'counts'; counts: Map<string, bigint> } | { kind: 'documents' })[]
}
interface CompositeFacadeLike {
  documents: { composite(q: unknown): Promise<CompositeResultLike> }
}

/**
 * A repo's count from a verified `counts` sub-result. The composite reports a value with no
 * documents as absent, so a missing id is 0; a missing sub-result is unknown (null).
 */
function countOf(counts: Map<string, bigint> | undefined, id: string): number | null {
  if (counts === undefined) return null
  const v = counts.get(id)
  return v === undefined ? 0 : Number(v)
}

/**
 * The newest forge-v2 repos with their star and issue counts, in ONE proof-checked round trip
 * (`documents.composite`, protocol 14). Falls back to a plain page without counts if the
 * composite surface is unavailable.
 */
async function readRecentRepos(
  sdk: EvoSDK,
  forge: ForgeIds,
  limit = 24,
): Promise<DiscoveredRepo[]> {
  try {
    const result = await (sdk as unknown as CompositeFacadeLike).documents.composite({
      dataContractId: forge.core,
      documentType: DOC.repo,
      orderBy: [['$createdAt', 'desc']],
      limit,
      subQueries: [
        {
          dataContractId: forge.collab,
          documentType: DOC.star,
          kind: 'counts',
          bind: { sourceProperty: '$id', field: 'repoId' },
        },
        {
          dataContractId: forge.collab,
          documentType: DOC.issue,
          kind: 'counts',
          bind: { sourceProperty: '$id', field: 'repoId' },
        },
      ],
    })
    const [stars, issues] = result.subResults.map((r) => (r.kind === 'counts' ? r.counts : undefined))
    return result.pageDocuments.map((raw) => {
      const doc = toRepoDoc(normalizeDocument(raw))
      return fromRepoDoc(doc, { stars: countOf(stars, doc.repoId), issues: countOf(issues, doc.repoId) })
    })
  } catch {
    const { documents } = await queryDocumentsWithProof(sdk, {
      dataContractId: forge.core,
      documentTypeName: DOC.repo,
      orderBy: [['$createdAt', 'desc']],
      limit,
    })
    return documents.map((d) => fromRepoDoc(toRepoDoc(d)))
  }
}

/**
 * The landing feed: the newest repos, newest first. Empty on a network without a forge-v2
 * deployment (the caller shows "not deployed" before asking).
 */
export async function listRecentRepos(
  sdk: EvoSDK,
  opts: { network?: Network; limit?: number } = {},
): Promise<DiscoveredRepo[]> {
  const forge = NETWORKS[opts.network ?? DEFAULT_NETWORK].v2
  return forge === null ? [] : readRecentRepos(sdk, forge, opts.limit ?? 24)
}

/**
 * Repos an identity owns (`repo` documents, `($ownerId, name)` index) and repos it is a
 * maintainer or writer of, each newest first.
 */
export async function listReposByOwner(
  sdk: EvoSDK,
  ownerId: string,
  opts: { network?: Network; limit?: number } = {},
): Promise<{ owned: DiscoveredRepo[]; member: DiscoveredRepo[] }> {
  const forge = NETWORKS[opts.network ?? DEFAULT_NETWORK].v2
  if (forge === null) return { owned: [], member: [] }
  const limit = opts.limit ?? 50

  const owned = async (): Promise<DiscoveredRepo[]> => {
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

/**
 * forge-v2 membership reads — who is a maintainer or writer of a repo (`forge-v2.md` §2, §6).
 *
 * A v2 repo's ACL is its current `maintainer` and `writer` documents in forge-core: the owner
 * creates them, deleting one revokes it, and consensus gates every write-path type on them.
 * The client rules that still need membership — approvals, pack-copy order, and which
 * controls the UI offers — read it through {@link RoleOracle} (FORGE_RULES_V2).
 *
 * v1 repos have no membership documents; their ACL is the WRITE/MAINTAIN token history
 * (`./tokens`). {@link readViewerPermissions} answers "what may this viewer do" for both.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, type Network } from '../constants'
import type { ForgeIds } from '../deployments'
import type { Holdings } from '../rules'
import { RoleOracle, type Membership, type Role } from '../rules/v2'
import { queryAllDocuments, type PlainDocument } from '../sdk'
import { V2_DOC, asIdentifierString, type RepoRef, type V2RepoRef } from './contract'
import { repoSource } from './source'
import { readViewerHoldings } from './tokens'

const ROLES: readonly Role[] = ['maintainer', 'writer']
const ROLE_DOC: Readonly<Record<Role, string>> = { maintainer: V2_DOC.maintainer, writer: V2_DOC.writer }

/** A repo an identity is a member of. */
export interface MemberRepo {
  readonly repoId: string
  readonly role: Role
  readonly createdAt: number
}

function toMembership(doc: PlainDocument, role: Role): Membership | null {
  const identity = asIdentifierString(doc['memberId'])
  const createdAt = doc['$createdAt']
  if (identity === '' || typeof createdAt !== 'number') return null
  return { identity, role, createdAt }
}

/**
 * Every current membership document of a v2 repo, maintainers first. Complete (paged):
 * approvals and pack-copy order fold over it, and a member missing from it would read as a
 * stranger.
 */
export async function readMemberships(sdk: EvoSDK, repo: V2RepoRef): Promise<Membership[]> {
  const source = repoSource(repo)
  const perRole = await Promise.all(
    ROLES.map(async (role) => {
      const docs = await queryAllDocuments(
        sdk,
        source.repoQuery(ROLE_DOC[role], {
          orderBy: [['memberId', 'asc']],
        }),
      )
      return docs.map((d) => toMembership(d, role)).filter((m): m is Membership => m !== null)
    }),
  )
  return perRole.flat()
}

// Membership changes rarely and every issue, PR and browse view of a repo consults it, so it
// is cached per repo like the v1 token history. A failed read is never cached.
const MEMBERS_TTL_MS = 5 * 60_000
const membersCache = new Map<string, { at: number; promise: Promise<Membership[]> }>()

function membersKey(network: Network, repo: V2RepoRef): string {
  return `${network}:${repo.forge.core}:${repo.repoId}`
}

/** {@link readMemberships} through the per-repo session cache. */
export function readMembershipsCached(
  sdk: EvoSDK,
  repo: V2RepoRef,
  network: Network = DEFAULT_NETWORK,
): Promise<Membership[]> {
  const key = membersKey(network, repo)
  const hit = membersCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < MEMBERS_TTL_MS) return hit.promise
  const promise = readMemberships(sdk, repo)
  membersCache.set(key, { at: Date.now(), promise })
  promise.catch(() => {
    if (membersCache.get(key)?.promise === promise) membersCache.delete(key)
  })
  return promise
}

/** Drop a repo's cached membership (for tests now; for member add/revoke with v2 writes). */
export function invalidateMembers(repo: V2RepoRef, network: Network = DEFAULT_NETWORK): void {
  membersCache.delete(membersKey(network, repo))
}

/** A v2 repo's {@link RoleOracle}, from the cached membership. */
export async function readRoleOracle(
  sdk: EvoSDK,
  repo: V2RepoRef,
  network: Network = DEFAULT_NETWORK,
): Promise<RoleOracle> {
  return new RoleOracle(await readMembershipsCached(sdk, repo, network))
}

/**
 * A role as the v1-shaped {@link Holdings} the UI gates on: a writer may push and act on
 * issues and PRs (`write`); a maintainer may also do what v1 reserved for MAINTAIN (protected
 * refs, config, releases).
 */
export function holdingsOfRole(role: Role | null): Holdings {
  return { write: role !== null, maintain: role === 'maintainer' }
}

/**
 * What `identity` may do on `repo` now: v1 from the token history, v2 from the membership
 * documents. `null` means the ACL could not be read — "unknown" stays distinct from "none",
 * so a read failure never strips a maintainer's controls or grants a stranger's.
 */
export async function readViewerPermissions(
  sdk: EvoSDK,
  repo: RepoRef,
  identity: string,
  network: Network = DEFAULT_NETWORK,
): Promise<Holdings | null> {
  if (repo.kind === 'v1') return readViewerHoldings(sdk, repo, identity, network)
  try {
    const oracle = await readRoleOracle(sdk, repo, network)
    return holdingsOfRole(oracle.currentRole(identity))
  } catch {
    return null
  }
}

/** The repos an identity is a maintainer or writer of (`byMember` index), newest first. */
export async function readMemberRepoIds(
  sdk: EvoSDK,
  forge: ForgeIds,
  memberId: string,
): Promise<MemberRepo[]> {
  const perRole = await Promise.all(
    ROLES.map(async (role) => {
      const docs = await queryAllDocuments(sdk, {
        dataContractId: forge.core,
        documentTypeName: ROLE_DOC[role],
        where: [['memberId', '==', memberId]],
      })
      return docs.map((d) => ({
        repoId: asIdentifierString(d['repoId']),
        role,
        createdAt: typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0,
      }))
    }),
  )
  // One row per repo, the better role winning (maintainer is listed first).
  const byRepo = new Map<string, MemberRepo>()
  for (const row of perRole.flat()) {
    if (row.repoId !== '' && !byRepo.has(row.repoId)) byRepo.set(row.repoId, row)
  }
  return [...byRepo.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * forge-v2 membership reads — who is a maintainer or writer of a repo (`forge-v2.md` §2, §6).
 *
 * A repo's ACL is its current `maintainer` and `writer` documents in forge-core: the owner
 * creates them, deleting one revokes it, and consensus gates every write-path type on them.
 * The client rules that still need membership — approvals, pack-copy order, and which
 * controls the UI offers — read it through {@link RoleOracle} (FORGE_RULES_V2).
 * {@link readViewerPermissions} answers "what may this viewer do".
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, type Network } from '../constants'
import type { ForgeIds } from '../deployments'
import type { Holdings } from '../rules'
import { writerRoleOf } from '../rules/roles'
import { RoleOracle, type Membership, type Role } from '../rules/v2'
import { queryAllDocuments, type PlainDocument } from '../sdk'
import { DOC, asIdentifierString, type RepoRef } from './contract'
import { repoSource } from './source'

/** The two membership document types: `maintainer`, and `writer` (whose `role` is writer, triage or reader). */
const MEMBER_DOCS = [DOC.maintainer, DOC.writer] as const
type MemberDoc = (typeof MEMBER_DOCS)[number]

/** The membership document type that holds `role`. */
export function memberDocOf(role: Role): MemberDoc {
  return role === 'maintainer' ? DOC.maintainer : DOC.writer
}

/**
 * The role a membership document grants: a `maintainer` document's, or a `writer` document's
 * `role` (read tolerant: absent is writer; an out-of-range code grants nothing).
 */
export function roleOfMemberDoc(type: MemberDoc, doc: PlainDocument): Role | null {
  return type === DOC.maintainer ? 'maintainer' : writerRoleOf(doc['role'])
}

/** A repo an identity is a member of. */
export interface MemberRepo {
  readonly repoId: string
  readonly role: Role
  readonly createdAt: number
}

function toMembership(doc: PlainDocument, type: MemberDoc): Membership | null {
  const identity = asIdentifierString(doc['memberId'])
  const createdAt = doc['$createdAt']
  const role = roleOfMemberDoc(type, doc)
  if (identity === '' || typeof createdAt !== 'number' || role === null) return null
  return { identity, role, createdAt }
}

/**
 * Every current membership document of a repo, maintainers first. Complete (paged):
 * approvals and pack-copy order fold over it, and a member missing from it would read as a
 * stranger.
 */
export async function readMemberships(sdk: EvoSDK, repo: RepoRef): Promise<Membership[]> {
  return (await Promise.all(MEMBER_DOCS.map((type) => readMemberDocs(sdk, repo, type)))).flat()
}

/** The current maintainers of a repo: its `maintainer` documents alone (forge-core `MemberReader::maintainers`). */
export async function readMaintainers(sdk: EvoSDK, repo: RepoRef): Promise<string[]> {
  return (await readMemberDocs(sdk, repo, DOC.maintainer)).map((m) => m.identity)
}

/** Every current membership document of one type, complete (paged). */
async function readMemberDocs(sdk: EvoSDK, repo: RepoRef, type: MemberDoc): Promise<Membership[]> {
  const docs = await queryAllDocuments(sdk, repoSource(repo).repoQuery(type, { orderBy: [['memberId', 'asc']] }))
  return docs.map((d) => toMembership(d, type)).filter((m): m is Membership => m !== null)
}

// Membership changes rarely and every issue, PR and browse view of a repo consults it, so it
// is cached per repo. A failed read is never cached.
const MEMBERS_TTL_MS = 5 * 60_000
const membersCache = new Map<string, { at: number; promise: Promise<Membership[]> }>()

function membersKey(network: Network, repo: RepoRef): string {
  return `${network}:${repo.forge.core}:${repo.repoId}`
}

/** {@link readMemberships} through the per-repo session cache. */
export function readMembershipsCached(
  sdk: EvoSDK,
  repo: RepoRef,
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

/**
 * The membership documents of `repo` as a complete read would return them, from rows read
 * elsewhere (a composite's `maintainer` / `writer` siblings). Only a short page is complete, so
 * a caller passes `null` for a role whose page was full, and nothing is recorded then.
 */
export function membershipsFromDocs(maintainers: readonly PlainDocument[] | null, writers: readonly PlainDocument[] | null): Membership[] | null {
  if (maintainers === null || writers === null) return null
  const of = (docs: readonly PlainDocument[], type: MemberDoc) => docs.map((d) => toMembership(d, type)).filter((m): m is Membership => m !== null)
  return [...of(maintainers, DOC.maintainer), ...of(writers, DOC.writer)]
}

/**
 * Bumped by every {@link invalidateMembers} (a member add or revoke through this tab): a read that
 * started before one never seeds the cache. One counter for all repos: a seed skipped for another
 * repo's change only costs that repo one membership read.
 */
let membersGenerationNow = 0

/** The membership generation now: pass it to {@link seedMemberships} for a read starting now. */
export function membersGeneration(): number {
  return membersGenerationNow
}

/**
 * Record a repo's complete membership read elsewhere, unless a fresher read is cached, or a
 * membership changed through this tab since that read started (`generation`, taken then).
 */
export function seedMemberships(repo: RepoRef, network: Network, memberships: Membership[], generation: number): void {
  const key = membersKey(network, repo)
  if (generation !== membersGenerationNow) return
  const hit = membersCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < MEMBERS_TTL_MS) return
  membersCache.set(key, { at: Date.now(), promise: Promise.resolve(memberships) })
}

/** Drop a repo's cached membership (tests; and after a member add/revoke). */
export function invalidateMembers(repo: RepoRef, network: Network = DEFAULT_NETWORK): void {
  membersCache.delete(membersKey(network, repo))
  membersGenerationNow += 1
}

/**
 * The identities whose `imported` provenance names the repo's mirror source: the owner (the
 * mirror signer) and its current maintainers (never a triage member or reader), the owner first, once each. When the membership
 * cannot be read, the owner alone: a missing note is better than a failed page.
 */
export async function readProvenanceTrust(sdk: EvoSDK, repo: RepoRef, network: Network = DEFAULT_NETWORK): Promise<string[]> {
  const maintainers = await readMembershipsCached(sdk, repo, network).then(
    (ms) => ms.filter((m) => m.role === 'maintainer').map((m) => m.identity),
    () => [],
  )
  return [...new Set([repo.ownerId, ...maintainers])]
}

/** A repo's {@link RoleOracle}, from the cached membership. */
export async function readRoleOracle(
  sdk: EvoSDK,
  repo: RepoRef,
  network: Network = DEFAULT_NETWORK,
): Promise<RoleOracle> {
  return new RoleOracle(await readMembershipsCached(sdk, repo, network))
}

/**
 * A role as the {@link Holdings} the UI gates on: `member` for any membership document (it
 * proves membership on comments and reviews), `maintain` for a maintainer, and the `role`
 * itself, whose `capabilitiesOf` says which member writes it may make.
 */
export function holdingsOfRole(role: Role | null): Holdings {
  return { member: role !== null, maintain: role === 'maintainer', role }
}

/**
 * What `identity` may do on `repo` now, from its membership documents. `null` means the ACL could not be read — "unknown" stays distinct from "none",
 * so a read failure never strips a maintainer's controls or grants a stranger's.
 */
export async function readViewerPermissions(
  sdk: EvoSDK,
  repo: RepoRef,
  identity: string,
  network: Network = DEFAULT_NETWORK,
): Promise<Holdings | null> {
  try {
    const oracle = await readRoleOracle(sdk, repo, network)
    return holdingsOfRole(oracle.currentRole(identity))
  } catch {
    return null
  }
}

/** The repos an identity is a member of (`byMember` index), newest first, with its best role. */
export async function readMemberRepoIds(
  sdk: EvoSDK,
  forge: ForgeIds,
  memberId: string,
): Promise<MemberRepo[]> {
  const perRole = await Promise.all(
    MEMBER_DOCS.map(async (type) => {
      const docs = await queryAllDocuments(sdk, {
        dataContractId: forge.core,
        documentTypeName: type,
        where: [['memberId', '==', memberId]],
      })
      return docs.flatMap((d) => {
        const role = roleOfMemberDoc(type, d)
        return role === null ? [] : [{ repoId: asIdentifierString(d['repoId']), role, createdAt: typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0 }]
      })
    }),
  )
  // One row per repo, the better role winning (maintainer is listed first).
  const byRepo = new Map<string, MemberRepo>()
  for (const row of perRole.flat()) {
    if (row.repoId !== '' && !byRepo.has(row.repoId)) byRepo.set(row.repoId, row)
  }
  return [...byRepo.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Re-read the signer's role, uncached (the CLI's `require_role` before uploading): a maintainer
 * revoked since the page loaded must not upload for a write consensus will refuse.
 */
export async function requireMaintainer(sdk: EvoSDK, repo: RepoRef, identityId: string, network: Network): Promise<void> {
  invalidateMembers(repo, network)
  const holdings = await readViewerPermissions(sdk, repo, identityId, network)
  if (holdings === null) throw new Error("couldn't read this repo's members to confirm you are a maintainer; try again")
  if (!holdings.maintain) throw new Error('you are no longer a maintainer of this repo: only maintainers can publish releases')
}

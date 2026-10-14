/**
 * The role a gated write claims (RC2 member roles: `r` on `refUpdate`, `packManifest`, `chunk`,
 * `checkRun`, `label`, `milestone`, `transition` and `event`), and the pre-check that refuses a
 * write the signer's role cannot make, before anything is signed or paid for.
 *
 * `r` is set only where the registered contract declares it (`contract-shape.ts`, as the RC2
 * riders are): a contract from before member roles refuses an unknown property, and has no roles
 * to check. The rule itself is pure: {@link claimedRole} (`rules/roles.ts`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { RoleRefusedError, claimedRole, isRoleGated } from '../rules/roles'
import { MAINTAINER_KINDS, manifestR } from '../rules/aud'
import { ConsensusRefusal, GATE_REFUSED_CODE, WHERE_MISMATCH_CODE, type WriteAuth } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { contractHasProperty } from './contract-shape'
import { CONTENT_TYPES, manifestMaintKinds } from './mainnet-fields'
import { invalidateMembers, readRoleOracle } from './members'
import { contractOf } from './source'

/** The claimed-role property of the gated types. */
export const ROLE_CLAIM = 'r'

/**
 * The `{ r }` a write of `documentType` holding `data` by `auth` carries (empty for a type that
 * carries none, or a contract without it). Reads the signer's role from the repo's membership
 * (cached per repo; a refusal re-reads it once, so a member promoted meanwhile is not refused by
 * a stale read). An author's transition claims 1 without reading the membership.
 *
 * @throws RoleRefusedError when the signer's role cannot make this write (nothing is signed).
 */
export async function roleClaim(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  documentType: string,
  data: Readonly<Record<string, unknown>>,
): Promise<{ readonly r?: number }> {
  if (!isRoleGated(documentType)) return {}
  if (!(await contractHasProperty(sdk, contractOf(repo.forge, documentType), documentType, ROLE_CLAIM))) return {}
  // The author's operand admits it whatever the signer's role: no membership read is needed.
  if (documentType === DOC.transition && Number(data['asAuthor'] ?? 0) > 0) return { r: 1 }
  const claim = async (): Promise<{ readonly r?: number }> => {
    const r = claimedRole(documentType, data, (await readRoleOracle(sdk, repo, auth.network)).currentRole(auth.identityId))
    return r === null ? {} : { r: await manifestClaim(sdk, repo, documentType, data, r) }
  }
  try {
    return await claim()
  } catch (e) {
    if (!(e instanceof RoleRefusedError)) throw e
    invalidateMembers(repo, auth.network)
    return claim()
  }
}

/**
 * The `r` a pack manifest of a maintainer-only kind claims (7, 8, 9, 11): 0 where the contract
 * admits it (mainnet C3: `packManifest.r` has `minimum` 0, and only the maintainer operand passes
 * it), else `r`. Parity: forge-core `RepoService::write_pack_manifest`.
 */
async function manifestClaim(sdk: EvoSDK, repo: RepoRef, documentType: string, data: Readonly<Record<string, unknown>>, r: number): Promise<number> {
  const kind = data['kind']
  if (documentType !== DOC.packManifest || typeof kind !== 'number' || !MAINTAINER_KINDS.includes(kind)) return r
  return manifestR({ maintKinds: await manifestMaintKinds(sdk, repo) }, kind, r)
}

/**
 * Whether `e` is the gate refusing the signer's membership or claimed role: 40120 (no document the
 * gate refers to) or 40127 (a writer document whose `role` is not the claimed `r`).
 */
export function isMemberGateRefusal(e: unknown): boolean {
  return e instanceof ConsensusRefusal && (e.code === GATE_REFUSED_CODE || e.code === WHERE_MISMATCH_CODE)
}

/**
 * Run the create or replace of a `documentType` write; when the gate refuses a role-gated write
 * or a post's membership proof and its `mRole` ({@link isMemberGateRefusal}), drop the repo's
 * cached membership, so the next claim reads the signer's role afresh instead of repeating a
 * stale one until the cache expires.
 */
export async function refreshRoleOnRefusal<T>(repo: RepoRef, auth: Pick<WriteAuth, 'network'>, documentType: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (e) {
    if ((isRoleGated(documentType) || CONTENT_TYPES.has(documentType)) && isMemberGateRefusal(e)) invalidateMembers(repo, auth.network)
    throw e
  }
}

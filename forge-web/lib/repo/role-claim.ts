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
import type { WriteAuth } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { contractHasProperty } from './contract-shape'
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
    return r === null ? {} : { r }
  }
  try {
    return await claim()
  } catch (e) {
    if (!(e instanceof RoleRefusedError)) throw e
    invalidateMembers(repo, auth.network)
    return claim()
  }
}

/**
 * The role badge beside an author on an issue, pull request, comment or review: what that
 * identity is to the repository now, as GitHub's "Owner" and "Member" badges say.
 *
 * It comes from the repository's current membership documents, the set every approval and
 * moderation rule already reads with a proof, so a badge is never self-declared: anyone can
 * register a name or grind an id that looks like a maintainer's, but only the owner can write
 * the document that earns the badge. A former member shows none.
 *
 * Pure: no SDK, no network.
 */

import { ROLE_HOLDER, ROLE_LABEL } from '../rules/roles'
import { RoleOracle, type Membership, type Role } from '../rules/v2'

/** What an author is to the repository: its owner, or a member's role. */
export type AuthorRole = 'owner' | Role

/** The badge text. */
export const AUTHOR_ROLE_LABEL: Readonly<Record<AuthorRole, string>> = { owner: 'Owner', ...ROLE_LABEL }

/** The badge's tooltip. */
export const AUTHOR_ROLE_TITLE: Readonly<Record<AuthorRole, string>> = {
  owner: 'Owner of this repository',
  maintainer: `${ROLE_HOLDER.maintainer} of this repository`,
  writer: `${ROLE_HOLDER.writer} of this repository`,
  triage: `${ROLE_HOLDER.triage} of this repository`,
  reader: `${ROLE_HOLDER.reader} of this repository`,
}

/** Each member's role and the owner's, keyed by identity id. */
export function authorRoles(owner: string, members: readonly Membership[]): ReadonlyMap<string, AuthorRole> {
  const oracle = new RoleOracle(members)
  const roles = new Map<string, AuthorRole>()
  for (const { identity } of members) {
    const role = oracle.currentRole(identity)
    if (role !== null) roles.set(identity, role)
  }
  roles.set(owner, 'owner')
  return roles
}

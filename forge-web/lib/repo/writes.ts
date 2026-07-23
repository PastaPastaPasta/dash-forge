/**
 * Write paths — STUBBED for M3.
 *
 * M3 priority is the READ + rules + browse plane (logged-out browsing of any-size repos).
 * Writes (create issue/comment, star, push refUpdate, collaborator grant/suspend) are
 * WRITE/MAINTAIN-token-gated state transitions that require identity signing (platform-auth
 * engine: key login / passkey PRF / wallet QR) — that wiring is a later milestone.
 *
 * These stubs pin the intended signatures and the doc types / token gates each will use, so
 * the UI can be built against a stable surface. Each throws until the signing path lands.
 */

import type { RepoRef } from './contract'

/** Raised by every write stub until the identity-signing path is implemented. */
export class WriteNotImplementedError extends Error {
  constructor(op: string) {
    super(`${op}: write paths are stubbed in M3 (needs identity signing) — read/rules/browse only`)
    this.name = 'WriteNotImplementedError'
  }
}

/** Create an `issue` (un-gated create; author-owned). STUBBED. */
export function createIssue(_repo: RepoRef, _input: { title: string; body: string }): never {
  throw new WriteNotImplementedError('createIssue')
}

/** Create a `comment` on an issue/PR (un-gated; author-owned). STUBBED. */
export function createComment(
  _repo: RepoRef,
  _input: { targetId: string; body: string; replyTo?: string },
): never {
  throw new WriteNotImplementedError('createComment')
}

/** Star a repo (`star` create in the registry; unstar = delete). STUBBED. */
export function starRepo(_listingId: string): never {
  throw new WriteNotImplementedError('starRepo')
}

/** Post a `refUpdate` / `protectedRefUpdate` (WRITE / MAINTAIN gated). STUBBED. */
export function pushRefUpdate(
  _repo: RepoRef,
  _input: { refName: string; newOid: string; prevOid?: string; force?: boolean; protected?: boolean },
): never {
  throw new WriteNotImplementedError('pushRefUpdate')
}

/** Grant a collaborator (mint WRITE / MAINTAIN). STUBBED — CRITICAL-key token admin op. */
export function grantCollaborator(_repo: RepoRef, _identityId: string, _maintain: boolean): never {
  throw new WriteNotImplementedError('grantCollaborator')
}

/** Suspend (freeze) / revoke (freeze + destroy) a collaborator. STUBBED. */
export function suspendCollaborator(_repo: RepoRef, _identityId: string): never {
  throw new WriteNotImplementedError('suspendCollaborator')
}

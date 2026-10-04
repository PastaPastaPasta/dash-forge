/**
 * CI re-run requests: member `event` kind 26 (`ciRerun`, forge-v2.md §3.3), a client convention
 * inside the contract's open `event.kind` (4–255), like the policy bypass (23). Parity:
 * forge-core `rules::ci_rerun`; vectors `ci_rerun__*`.
 *
 * A request asks the repository's runners to run a pull request's checks again: `targetId` the
 * PR, `oid` the commit (its head when asked), `refId` **the repository's own id** (so runners
 * read exactly its requests on the sparse `addressee (refId, $createdAt)` index), and `value`
 * the check's name, or none for every check of the PR's own runs. Consensus admits it from
 * triage too (`t_triageKinds` is a deny-list); it counts only from the owner, a maintainer or a
 * role-1 writer ({@link rerunCounts}), so clients refuse a triage member's before signing.
 */

import type { RoleOracle } from './v2'

/** The `event.kind` of a CI re-run request. */
export const CI_RERUN_KIND = 26

/** A check name's bounds: characters, then UTF-8 bytes (`checkRun.name`). */
export const CHECK_NAME_MAX = { chars: 100, bytes: 200 } as const

/** Whether `name` is a check name a run can carry (1–100 characters, at most 200 bytes). */
export function isCheckName(name: string): boolean {
  return name.length > 0 && [...name].length <= CHECK_NAME_MAX.chars && new TextEncoder().encode(name).length <= CHECK_NAME_MAX.bytes
}

const OID_HEX = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/

/** An `event` document as the re-run rule reads it (`oid` as hex, ids as base58). */
export interface RerunEvent {
  readonly id: string
  /** `repoId`: the repository the event belongs to. */
  readonly repoId: string
  readonly targetId: string
  readonly targetNumber: number
  readonly kind: number
  readonly refId?: string | null
  readonly oid?: string | null
  /** Opened, in a private repository. */
  readonly value?: string | null
  /** A private repository's sealed `value` this reader could not open: no request (never "every check"). */
  readonly valueHidden?: boolean
  /** `$ownerId`: who asked. */
  readonly actor: string
  readonly createdAt: number
}

/** A well-formed re-run request. */
export interface RerunRequest {
  readonly id: string
  readonly targetId: string
  readonly number: number
  /** The commit (lowercase hex). */
  readonly sha: string
  /** The check to run again; null: every check of the PR's own runs. */
  readonly check: string | null
  readonly requester: string
  readonly createdAt: number
}

/**
 * The request `e` makes to the repository `repoId`, or null when it is not a well-formed one:
 * another kind, an event of another repository (its `repoId`; the index is keyed by `refId`
 * alone, which any member of any repository can set), a `refId` that is not the repository, an
 * `oid` that is not a commit id, a `value` that is no check name or that this reader could not
 * open, or no target number.
 */
export function rerunRequest(repoId: string, e: RerunEvent): RerunRequest | null {
  if (e.kind !== CI_RERUN_KIND || e.repoId !== repoId || e.refId !== repoId || e.valueHidden === true) return null
  const sha = e.oid ?? ''
  if (!OID_HEX.test(sha)) return null
  const value = e.value ?? null
  if (value !== null && !isCheckName(value)) return null
  if (!Number.isInteger(e.targetNumber) || e.targetNumber < 1 || e.targetNumber > 0xffff_ffff) return null
  return { id: e.id, targetId: e.targetId, number: e.targetNumber, sha: sha.toLowerCase(), check: value, requester: e.actor, createdAt: e.createdAt }
}

/**
 * Whether `req` counts: its writer is the repository `owner`, or held a maintainer or role-1
 * writer document at its `createdAt`. A triage member's request (consensus admits it) does not.
 */
export function rerunCounts(req: RerunRequest, owner: string, oracle: RoleOracle): boolean {
  return req.requester === owner || oracle.approverAt(req.requester, req.createdAt)
}

/** What a request stores beside its target ({@link rerunFields}). */
export interface RerunFields {
  readonly kind: number
  /** The commit (lowercase hex). */
  readonly oid: string
  /** The repository's id (base58). */
  readonly refId: string
  readonly value?: string
}

/**
 * What a request for commit `sha` (hex) and an optional `check` stores beside its target.
 *
 * @throws Error naming a bad commit id or check name, before anything is signed.
 */
export function rerunFields(repoId: string, sha: string, check?: string | null): RerunFields {
  if (!OID_HEX.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a commit id (40 or 64 hex digits)`)
  if (check !== undefined && check !== null && !isCheckName(check)) {
    throw new Error(`${JSON.stringify(check)} is not a check name (1 to ${CHECK_NAME_MAX.chars} characters, at most ${CHECK_NAME_MAX.bytes} bytes)`)
  }
  return { kind: CI_RERUN_KIND, oid: sha.toLowerCase(), refId: repoId, ...(check !== undefined && check !== null ? { value: check } : {}) }
}

/** A check run as {@link pendingReruns} reads it. */
export interface RunLike {
  readonly name: string
  readonly createdAt: number
}

/**
 * The counted requests on `headOid` that no run has answered yet: a request for one check is
 * pending until a run of that name newer than it is reported, one for every check until any
 * run newer than it is. The newest request per check (null: every check) is kept. Display
 * only: what the Checks tab marks "re-run requested".
 */
export function pendingReruns(requests: readonly RerunRequest[], runs: readonly RunLike[], headOid: string): Map<string | null, RerunRequest> {
  const head = headOid.toLowerCase()
  const newest = new Map<string | null, RerunRequest>()
  for (const r of requests) {
    if (r.sha !== head) continue
    const held = newest.get(r.check)
    if (held === undefined || r.createdAt > held.createdAt) newest.set(r.check, r)
  }
  for (const [check, r] of newest) {
    const answered = runs.some((run) => (check === null || run.name === check) && run.createdAt > r.createdAt)
    if (answered) newest.delete(check)
  }
  return newest
}

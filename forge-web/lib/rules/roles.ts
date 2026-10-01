/**
 * RC2 member roles (`design/v5/RECUT-OR-NEVER.md` §3, §5): what each role may write, and the
 * role a gated write claims (`r`). Pure: no SDK, no network.
 *
 * A `writer` document carries `role` (1 writer, 2 triage, 3 reader; absent: writer). Eight
 * document types carry a required `r`, and the writer leaf of their gate proves `role == r`:
 *
 * - `refUpdate`, `packManifest`, `chunk`, `checkRun`: `r` 1 only (push and checks: role 1).
 * - `label`, `milestone`, `transition`, `event`: `r` 1 or 2; a transition of kind 13/14/15
 *   (merge, draft, ready) and an event of kind 8, 15, 16, 19, 20 or 23 need `r` 1.
 *
 * Maintainers (the repo owner's own maintainer document included), authors (`transition`
 * `asAuthor` > 0) and runners pass through other operands, so they always claim 1. A reader
 * writes none of these as a member. forge-core's writers claim `r` by the same rule.
 */

import type { Role } from './v2'

/** The `writer` document's `role` integer per role (a maintainer has a document type of its own). */
export const WRITER_ROLE_CODE = { writer: 1, triage: 2, reader: 3 } as const

/** A role a `writer` document grants. */
export type WriterRole = keyof typeof WRITER_ROLE_CODE

/**
 * The role a `writer` document's `role` grants. Read tolerant: an absent `role` (a pre-RC2
 * document) is a writer; an out-of-range code (consensus admits none) grants nothing (null).
 */
export function writerRoleOf(code: unknown): WriterRole | null {
  const n = typeof code === 'bigint' ? Number(code) : code
  if (n === undefined || n === null || n === 1) return 'writer'
  if (n === 2) return 'triage'
  if (n === 3) return 'reader'
  return null
}

/**
 * The roles the owner may grant on a repo of `visibility`, in picker order: a reader only on a
 * private repo (a public one has nothing to read that everyone cannot; a client rule).
 */
export function grantableRoles(visibility: 'public' | 'private'): readonly Role[] {
  return visibility === 'private' ? ['writer', 'triage', 'reader', 'maintainer'] : ['writer', 'triage', 'maintainer']
}

/** How a role is named to users. */
export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  maintainer: 'Maintainer',
  writer: 'Writer',
  triage: 'Triage',
  reader: 'Reader',
}

/** One line on what a role may do (the Collaborators picker and badges). */
export const ROLE_SUMMARY: Readonly<Record<Role, string>> = {
  maintainer: 'Everything a writer can, plus protected branches, settings, releases and moderation.',
  writer: 'Push, merge, review with a counted approval, and manage issues and pull requests.',
  triage: 'Close, reopen and lock, label, assign, set milestones, request reviews and resolve threads. Cannot push or merge; approvals are not counted.',
  reader: 'Read the private repo (receives its key). Can comment, review, and open issues and pull requests, but changes nothing as a member; approvals are not counted.',
}

/** What a role may do as a member (an author keeps its author abilities whatever its role). */
export interface Capabilities {
  /** Push (`refUpdate`, `packManifest`, `chunk`), and update a PR's head as a member. */
  readonly canPush: boolean
  readonly canMerge: boolean
  /** Mark someone else's PR draft or ready. */
  readonly canDraftReady: boolean
  readonly canCloseReopen: boolean
  readonly canLock: boolean
  /** Apply labels, and define them (`label` documents). */
  readonly canLabel: boolean
  readonly canAssign: boolean
  /** Set a thread's milestone, and define milestones. */
  readonly canMilestone: boolean
  readonly canRequestReview: boolean
  readonly canResolve: boolean
  /** Dismiss a review (event kind 15). */
  readonly canDismiss: boolean
  /** Change a PR's base (event kind 8). */
  readonly canRetarget: boolean
  /** Pin or unpin (event kinds 19/20). */
  readonly canPin: boolean
  readonly canPostChecks: boolean
  /** Merge past an unmet branch policy, recorded as event kind 23 (maintainers only, a client rule). */
  readonly canBypass: boolean
  /** Protected branches, config, releases, members, moderation. */
  readonly canManageSettings: boolean
}

const NONE: Capabilities = {
  canPush: false,
  canMerge: false,
  canDraftReady: false,
  canCloseReopen: false,
  canLock: false,
  canLabel: false,
  canAssign: false,
  canMilestone: false,
  canRequestReview: false,
  canResolve: false,
  canDismiss: false,
  canRetarget: false,
  canPin: false,
  canPostChecks: false,
  canBypass: false,
  canManageSettings: false,
}

const TRIAGE: Capabilities = {
  ...NONE,
  canCloseReopen: true,
  canLock: true,
  canLabel: true,
  canAssign: true,
  canMilestone: true,
  canRequestReview: true,
  canResolve: true,
}

const WRITER: Capabilities = {
  ...TRIAGE,
  canPush: true,
  canMerge: true,
  canDraftReady: true,
  canDismiss: true,
  canRetarget: true,
  canPin: true,
  canPostChecks: true,
}

/** A policy bypass is a maintainer's (the clients' rule: consensus admits role 1 too). */
const MAINTAINER: Capabilities = { ...WRITER, canBypass: true, canManageSettings: true }

/** What `role` (null: not a member, or unknown) may do as a member. */
export function capabilitiesOf(role: Role | null | undefined): Capabilities {
  switch (role) {
    case 'maintainer':
      return MAINTAINER
    case 'writer':
      return WRITER
    case 'triage':
      return TRIAGE
    default:
      return NONE
  }
}

/** The types whose gate admits role 1 only (`r` maximum 1). */
export const PUSH_GATED_TYPES: ReadonlySet<string> = new Set(['refUpdate', 'packManifest', 'chunk', 'checkRun'])
/** The types whose gate admits roles 1 and 2 (`r` 1..2). */
export const TRIAGE_GATED_TYPES: ReadonlySet<string> = new Set(['label', 'milestone', 'transition', 'event'])
/** Transition kinds that need `r` 1 (`e_mergeOid`): merge, draft, ready. */
export const WRITER_TRANSITION_KINDS: ReadonlySet<number> = new Set([13, 14, 15])
/**
 * Event kinds that need `r` 1 (`t_triageKinds`): retarget, review dismiss, head update, pin,
 * unpin, policy bypass.
 */
export const WRITER_EVENT_KINDS: ReadonlySet<number> = new Set([8, 15, 16, 19, 20, 23])

/** Whether `documentType` carries `r` (its gate proves the writer document's role). */
export function isRoleGated(documentType: string): boolean {
  return PUSH_GATED_TYPES.has(documentType) || TRIAGE_GATED_TYPES.has(documentType)
}

/** A write the signer's role cannot make: refused before signing. */
export class RoleRefusedError extends Error {
  constructor(
    readonly role: Role,
    what: string,
  ) {
    super(`your role on this repo is ${role}: ${role === 'reader' ? 'a reader' : 'a triage member'} cannot ${what}`)
    this.name = 'RoleRefusedError'
  }
}

function intOf(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  return null
}

const EVENT_WHAT: Readonly<Record<number, string>> = {
  8: 'change a pull request’s base branch',
  15: 'dismiss a review',
  16: 'update a pull request’s head',
  19: 'pin a conversation',
  20: 'unpin a conversation',
  23: 'record a policy bypass',
}

const TRANSITION_WHAT: Readonly<Record<number, string>> = {
  13: 'merge a pull request',
  14: 'convert a pull request to a draft',
  15: 'mark a pull request ready for review',
}

/**
 * The `r` a write of `documentType` holding `data` claims, by a signer whose best current role
 * is `role` (null: holds no membership document: the owner without one, a runner, or a stranger,
 * whom consensus judges by its other operands). Null for a type that carries no `r`.
 *
 * - push class and `checkRun`: 1; refused for triage and reader;
 * - an author's transition (`asAuthor` > 0): 1;
 * - a maintainer, a role-1 writer, or no membership: 1;
 * - triage: 2, refused for the writer-only transition and event kinds;
 * - reader: refused.
 *
 * @throws RoleRefusedError when consensus would refuse the write for the signer's role.
 */
export function claimedRole(documentType: string, data: Readonly<Record<string, unknown>>, role: Role | null): 1 | 2 | null {
  if (!isRoleGated(documentType)) return null
  if (PUSH_GATED_TYPES.has(documentType)) {
    if (role === 'triage' || role === 'reader') throw new RoleRefusedError(role, documentType === 'checkRun' ? 'post check runs' : 'push')
    return 1
  }
  if (documentType === 'transition' && (intOf(data['asAuthor']) ?? 0) > 0) return 1
  if (role === null || role === 'maintainer' || role === 'writer') return 1
  const kind = intOf(data['kind'])
  if (role === 'reader') {
    const what = documentType === 'transition' ? 'change its state as a member (only as the author of your own issue or pull request)' : documentType === 'event' ? 'label, assign, or otherwise change issues and pull requests as a member' : `define ${documentType}s`
    throw new RoleRefusedError(role, what)
  }
  if (documentType === 'transition' && kind !== null && WRITER_TRANSITION_KINDS.has(kind)) {
    throw new RoleRefusedError(role, TRANSITION_WHAT[kind] as string)
  }
  if (documentType === 'event' && kind !== null && WRITER_EVENT_KINDS.has(kind)) {
    throw new RoleRefusedError(role, EVENT_WHAT[kind] as string)
  }
  return 2
}

/**
 * Why a member of `role` cannot `what` (a tooltip or a note beside a hidden or disabled control),
 * or null for a role this does not limit (a maintainer, a writer, or no membership, which other
 * notes cover). Pass the action `capabilitiesOf(role)` denies.
 */
export function roleLimit(role: Role | null | undefined, what: string): string | null {
  if (role !== 'triage' && role !== 'reader') return null
  return `Your role here is ${role}: ${role === 'reader' ? 'a reader' : 'a triage member'} can't ${what}.`
}

/**
 * Whether `role` may write a member `event` of numeric `kind` (else the author's `authorEvent`, or
 * nothing): a maintainer or writer any kind, a triage member any but {@link WRITER_EVENT_KINDS}
 * (moderation's hide and unhide stay a maintainer's, proved by `asMaintainer`), a reader none.
 */
export function memberMayWriteEvent(role: Role | null | undefined, kind: number): boolean {
  if (role === 'maintainer' || role === 'writer') return true
  return role === 'triage' && !WRITER_EVENT_KINDS.has(kind) && kind !== 24 && kind !== 25
}

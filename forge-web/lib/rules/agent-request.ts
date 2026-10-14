/**
 * Asking a bot to work on something: member `event` kind 27 (mixed-visibility DESIGN §4.9 "Asking
 * a bot", D33; `docs/security/private-repos.md` §22.2), a client convention inside the contract's
 * open `event.kind`. Parity: forge-core `rules::agent_request`; vectors `access_notice__ask`.
 *
 * - `targetId` / `targetNumber`: the issue or pull request the bot is asked about;
 * - `refId`: **the bot's identity id**, so a runner reads its bot's requests on the sparse
 *   `addressee (refId, $createdAt)` index, as it reads CI re-runs (kind 26) under the repo's id;
 * - `value`: the task (1–120 characters, at most 480 bytes). Like every event value it follows its
 *   target: members-only on a members-only thread and in a private repository, so everyone sees
 *   that someone asked and only members what.
 *
 * Before signing, a client checks the bot's current access notice ({@link checkAsk}, E813): it is
 * live, allows something, names the asker's role among its askers and the thread among its
 * threads, and allows reading on request when the thread is members-only.
 */

import { dateWords, isBlank, noticeCovers, noticeLiveAt, noticeMay, textOk, MAY_READ_ON_REQUEST, type AccessNotice, type Askers } from '../private/access-notice'
import type { Role } from './v2'

/** The `event.kind` of a request to a bot. */
export const AGENT_REQUEST_KIND = 27

/** A task's bounds: characters, then UTF-8 bytes (`event.value`). */
export const TASK_MAX = { chars: 120, bytes: 480 } as const

/** Whether `task` fits an event's `value`: 1–120 characters, at most 480 bytes, no control character but a newline. */
export function isTask(task: string): boolean {
  return !isBlank(task) && textOk(task, TASK_MAX.chars, true) && new TextEncoder().encode(task).length <= TASK_MAX.bytes
}

/** An `event` document as the request rule reads it (ids as base58). */
export interface RequestEvent {
  readonly id: string
  readonly repoId: string
  readonly targetId: string
  readonly targetNumber: number
  readonly kind: number
  readonly refId?: string | null
  /** `value`, opened when it was members-only and this reader holds the key. */
  readonly value?: string | null
  /** A members-only `value` this reader could not open. */
  readonly valueHidden?: boolean
  /** `$ownerId`: who asked. */
  readonly actor: string
  readonly createdAt: number
}

/** A well-formed request to a bot. */
export interface AgentRequest {
  /** The event's `$id`: the job a `read` letter names. */
  readonly id: string
  readonly targetId: string
  readonly number: number
  /** The bot asked (base58). */
  readonly bot: string
  /** The task, or null when it is members-only and this reader cannot open it. */
  readonly task: string | null
  /** Who asked. */
  readonly asker: string
  readonly createdAt: number
}

/**
 * The request `e` makes in repository `repoId`, or null when it is not a well-formed one: another
 * kind, another repository's event, no `refId` (no bot), no target number, or a task that is
 * neither readable within bounds nor hidden from this reader.
 */
export function agentRequest(repoId: string, e: RequestEvent): AgentRequest | null {
  if (e.kind !== AGENT_REQUEST_KIND || e.repoId !== repoId) return null
  const bot = e.refId ?? ''
  if (bot === '') return null
  if (!Number.isInteger(e.targetNumber) || e.targetNumber < 1 || e.targetNumber > 0xffff_ffff) return null
  const value = e.value ?? null
  // a readable task within bounds, or one hidden from this reader
  if (value === null ? e.valueHidden !== true : !isTask(value)) return null
  return { id: e.id, targetId: e.targetId, number: e.targetNumber, bot, task: value, asker: e.actor, createdAt: e.createdAt }
}

/** Why asking a bot is refused before signing (E813). Serialized as forge-core `AskRefusal`. */
export type AskRefusal =
  /** No current notice gives the bot access here, or the newest allows nothing. */
  | { readonly why: 'noAccess' }
  /** The notice's `until` has passed. */
  | { readonly why: 'ended'; readonly until: number }
  /** The asker's role (null: not a member) is not among the notice's askers. */
  | { readonly why: 'askers'; readonly askers: Askers; readonly role: Role | null }
  /** The notice lists threads and this is not one of them. */
  | { readonly why: 'thread'; readonly number: number }
  /** The thread is members-only and the notice does not let the bot read on request. */
  | { readonly why: 'noRead' }

/** Whether `role` (the owner passes as a maintainer) is among `askers`. */
export function askerAllowed(askers: Askers, role: Role | null): boolean {
  return askers === 'writers' ? role === 'maintainer' || role === 'writer' : role === 'maintainer'
}

/**
 * Check, before anything is signed, that someone of `role` (the owner as a maintainer; null outside
 * the members) may ask the bot of `notice` (its current notice, if any) about thread `number`,
 * members-only or not, at `now` (ms). The first refusal that applies, in the order: access, its
 * end, askers, threads, reading; null when it may.
 */
export function checkAsk(notice: AccessNotice | null, role: Role | null, number: number, membersOnly: boolean, now: number): AskRefusal | null {
  if (notice === null || notice.may.length === 0) return { why: 'noAccess' }
  if (notice.until !== null && !noticeLiveAt(notice, now)) return { why: 'ended', until: notice.until }
  if (!askerAllowed(notice.askers, role)) return { why: 'askers', askers: notice.askers, role }
  if (!noticeCovers(notice, number)) return { why: 'thread', number }
  if (membersOnly && !noticeMay(notice, MAY_READ_ON_REQUEST)) return { why: 'noRead' }
  return null
}

/** Whether a written request counts for a runner: {@link checkAsk} passes at its `createdAt` against the notice that counted then. */
export function requestAllowed(req: AgentRequest, notice: AccessNotice | null, roleThen: Role | null, membersOnly: boolean): boolean {
  return checkAsk(notice, roleThen, req.number, membersOnly, req.createdAt) === null
}

/** A role as the access copy names it (DESIGN §10 glossary). */
export function roleWords(role: Role | null): string {
  switch (role) {
    case 'maintainer':
      return 'Maintain access'
    case 'writer':
      return 'Write access'
    case 'triage':
      return 'Triage access'
    case 'reader':
      return 'Read access'
    case 'bot':
      return 'the Bot role'
    default:
      return 'no access'
  }
}

/**
 * The E813 message and its fix line for `refusal`, for bot `bot` as the copy names it (`@ci-bot`)
 * in repository `repo` (`o/r`), with `untilWords` the notice's end as the copy writes a date.
 * The same strings as forge-core `AskRefusal::words`.
 */
export function askRefusalWords(refusal: AskRefusal, bot: string, repo: string, untilWords: string): { readonly message: string; readonly fix: string } {
  const change = `ask a maintainer to change ${bot}'s access`
  switch (refusal.why) {
    case 'noAccess':
      return { message: `${bot} has no access in ${repo}`, fix: `ask a maintainer to give ${bot} access (Settings → Bots and runners)` }
    case 'ended':
      return { message: `${bot}'s access in ${repo} ended on ${untilWords}`, fix: change }
    case 'askers': {
      const who = refusal.askers === 'writers' ? 'someone with Write access' : 'a maintainer'
      const people = refusal.role === null ? `people outside ${repo}'s members` : `people with ${roleWords(refusal.role)}`
      return { message: `${bot} can't be asked by ${people} in ${repo}`, fix: `${change}, or ask ${who}` }
    }
    case 'thread':
      return { message: `${bot} can't be asked about #${refusal.number} in ${repo}`, fix: `ask a maintainer to add #${refusal.number} to ${bot}'s access` }
    case 'noRead':
      return { message: `${bot} can't read members-only threads in ${repo}`, fix: `ask a maintainer to let ${bot} read pull requests and issues it's asked about` }
  }
}

/** {@link askRefusalWords} with the notice's end as the copy writes a date. */
export function refusalWords(refusal: AskRefusal, bot: string, repo: string): { readonly message: string; readonly fix: string } {
  return askRefusalWords(refusal, bot, repo, refusal.why === 'ended' ? dateWords(refusal.until) : '')
}

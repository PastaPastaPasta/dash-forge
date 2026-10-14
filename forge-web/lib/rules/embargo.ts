/**
 * Publication dates for coordinated fixes: member `event` kind 28 (`embargo`, forge-v2.md §3.5;
 * mixed-visibility DESIGN §4.7 "Embargo", D18), a client convention inside the contract's open
 * `event.kind` (4–255), like the policy bypass (23) and CI re-runs (26). Parity: forge-core
 * `rules::embargo`; vectors `embargo__*` (tools/private-repos-vectors/embargo.py).
 *
 * The date and the plan are the event's `value`, sealed under the members key because the
 * tracking issue (or pull request) is members-only: the public learns that a date was set on the
 * thread, by whom and when, never the date or what is published. `refId` is the repository's own
 * id, so a release bot reads every date with one query on the sparse `addressee` index. The value
 * is one canonical JSON object of at most 120 characters; anything else is no record. A schedule
 * counts from the owner, a maintainer or a role-1 writer at its `createdAt`, a cancellation or
 * completion from anyone (consensus admitted its writer as a member); per target the newest
 * counted schedule is the embargo, and a newer cancellation or completion ends it.
 */

import { isLegalRefName } from './oid'
import type { RoleOracle } from './v2'

/** The `event.kind` of a publication date. */
export const EMBARGO_KIND = 28

/** The value's bounds: characters, then UTF-8 bytes (`event.value`). */
export const EMBARGO_VALUE_MAX = { chars: 120, bytes: 480 } as const

/** What is published at the date. */
export interface EmbargoPlan {
  /** The date: Unix seconds (UTC). */
  readonly at: number
  /** A members-only pull request whose branch is published onto its base. */
  readonly pr?: number
  /** Or a members-only branch (short name) … */
  readonly branch?: string
  /** … published onto this public branch. */
  readonly onto?: string
  /** A tag made on the published commit, then released. */
  readonly tag?: string
  /** The published commit's message. */
  readonly message?: string
}

/** One kind-28 value. */
export type EmbargoValue =
  | ({ readonly type: 'schedule' } & EmbargoPlan)
  | { readonly type: 'cancel' }
  | { readonly type: 'done'; readonly commit: string }

const isBranchName = (n: string): boolean => !n.startsWith('refs/') && isLegalRefName(`refs/heads/${n}`)
const isTagName = (n: string): boolean => !n.startsWith('refs/') && isLegalRefName(`refs/tags/${n}`)
const isCommit = (h: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(h)
/** Rust's `char::is_control`: C0, DEL and C1. */
const isControl = (c: string): boolean => {
  const n = c.codePointAt(0) ?? 0
  return n < 0x20 || (n >= 0x7f && n <= 0x9f)
}

/** A lone UTF-16 surrogate: not text Rust or Python can store. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** What is wrong with `p`, or null. Parity: forge-core `plan_problem`. */
function planProblem(p: EmbargoPlan): string | null {
  if (!Number.isInteger(p.at) || p.at <= 0) return 'the date is missing'
  if (p.at > Number.MAX_SAFE_INTEGER) return 'the date is out of range'
  for (const t of [p.branch, p.onto, p.tag, p.message]) if (t !== undefined && LONE_SURROGATE.test(t)) return 'the plan is not valid text'
  if (p.pr !== undefined) {
    if (p.pr === 0) return 'pull request 0 does not exist'
    if (p.branch !== undefined || p.onto !== undefined) return 'a pull request is published onto its own base: name no branch'
  } else if (p.branch === undefined) {
    return 'name a pull request or a branch to publish'
  } else if (p.onto === undefined) {
    return 'name the public branch it is published onto'
  } else {
    if (!isBranchName(p.branch)) return `${JSON.stringify(p.branch)} is not a branch name`
    if (!isBranchName(p.onto)) return `${JSON.stringify(p.onto)} is not a branch name`
    if (p.branch === p.onto) return "a branch can't be published onto itself"
  }
  if (p.tag !== undefined && !isTagName(p.tag)) return `${JSON.stringify(p.tag)} is not a tag name`
  if (p.message !== undefined) {
    if (/^[ \n]*$/.test(p.message)) return 'the message is empty'
    if ([...p.message].some((c) => c !== '\n' && isControl(c))) return 'the message has control characters'
  }
  return null
}

/** The wire object, keys in their one order. */
function wire(v: EmbargoValue): Record<string, unknown> {
  if (v.type === 'cancel') return { v: 1, cancel: true }
  if (v.type === 'done') return { v: 1, done: v.commit }
  const w: Record<string, unknown> = { v: 1, at: v.at }
  if (v.pr !== undefined) w['pr'] = v.pr
  if (v.branch !== undefined) w['b'] = v.branch
  if (v.onto !== undefined) w['o'] = v.onto
  if (v.tag !== undefined) w['t'] = v.tag
  if (v.message !== undefined) w['m'] = v.message
  return w
}

/**
 * The value as stored: canonical JSON, at most {@link EMBARGO_VALUE_MAX}.
 *
 * @throws Error naming a malformed plan or commit, or a value over the bound, before signing.
 */
export function encodeEmbargo(v: EmbargoValue): string {
  if (v.type === 'schedule') {
    const why = planProblem(v)
    if (why !== null) throw new Error(why)
  }
  if (v.type === 'done' && !isCommit(v.commit)) throw new Error(`${JSON.stringify(v.commit)} is not a commit id (lowercase hex)`)
  const s = JSON.stringify(wire(v))
  const chars = [...s].length
  if (chars > EMBARGO_VALUE_MAX.chars || new TextEncoder().encode(s).length > EMBARGO_VALUE_MAX.bytes) {
    throw new Error(`the plan is ${chars} characters stored and a publication date holds at most ${EMBARGO_VALUE_MAX.chars}: use a shorter branch name, tag or message`)
  }
  return s
}

const PLAN_KEYS = ['pr', 'b', 'o', 't', 'm'] as const
const KEYS = new Set(['v', 'at', ...PLAN_KEYS, 'cancel', 'done'])
const isU = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max

/** The value `text` stores, or null when it is not exactly one value's canonical form. */
export function parseEmbargo(text: string): EmbargoValue | null {
  let w: unknown
  try {
    w = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof w !== 'object' || w === null || Array.isArray(w)) return null
  const o = w as Record<string, unknown>
  if (Object.keys(o).some((k) => !KEYS.has(k)) || o['v'] !== 1) return null
  for (const k of ['b', 'o', 't', 'm', 'done']) if (k in o && typeof o[k] !== 'string') return null
  if ('at' in o && !isU(o['at'], Number.MAX_SAFE_INTEGER)) return null // past 2^53 - 1 is refused by every stack
  if ('pr' in o && !isU(o['pr'], 0xffff_ffff)) return null
  if ('cancel' in o && typeof o['cancel'] !== 'boolean') return null
  const hasPlan = PLAN_KEYS.some((k) => k in o)
  let v: EmbargoValue
  if ('at' in o && !('cancel' in o) && !('done' in o)) {
    v = {
      type: 'schedule',
      at: o['at'] as number,
      ...('pr' in o ? { pr: o['pr'] as number } : {}),
      ...('b' in o ? { branch: o['b'] as string } : {}),
      ...('o' in o ? { onto: o['o'] as string } : {}),
      ...('t' in o ? { tag: o['t'] as string } : {}),
      ...('m' in o ? { message: o['m'] as string } : {}),
    }
  } else if (o['cancel'] === true && !('at' in o) && !('done' in o) && !hasPlan) {
    v = { type: 'cancel' }
  } else if ('done' in o && !('at' in o) && !('cancel' in o) && !hasPlan) {
    v = { type: 'done', commit: o['done'] as string }
  } else {
    return null
  }
  // canonical only: this also refuses duplicate keys (JSON.parse keeps the last one)
  try {
    return encodeEmbargo(v) === text ? v : null
  } catch {
    return null
  }
}

/** An `event` document as the rule reads it (ids as base58; `value` opened). */
export interface EmbargoEvent {
  readonly id: string
  readonly repoId: string
  readonly targetId: string
  readonly targetNumber: number
  readonly kind: number
  readonly refId?: string | null
  readonly value?: string | null
  readonly actor: string
  readonly createdAt: number
}

/** A well-formed kind-28 record. */
export interface EmbargoRecord {
  readonly id: string
  readonly targetId: string
  readonly number: number
  readonly value: EmbargoValue
  readonly actor: string
  readonly createdAt: number
}

/** The record `e` makes in the repository `repoId`, or null. */
export function embargoRecord(repoId: string, e: EmbargoEvent): EmbargoRecord | null {
  if (e.kind !== EMBARGO_KIND || e.repoId !== repoId || e.refId !== repoId) return null
  if (!Number.isInteger(e.targetNumber) || e.targetNumber < 1 || e.targetNumber > 0xffff_ffff) return null
  if (e.value === undefined || e.value === null) return null
  const value = parseEmbargo(e.value)
  if (value === null) return null
  return { id: e.id, targetId: e.targetId, number: e.targetNumber, value, actor: e.actor, createdAt: e.createdAt }
}

/**
 * Whether `r` counts: a schedule from the owner, or a maintainer or role-1 writer at its
 * `createdAt`; a withdrawal or completion always (consensus admitted its writer as a member then,
 * and it only stops a publication, so a later removal never brings a withdrawn date back).
 */
export function embargoCounts(r: EmbargoRecord, owner: string, oracle: RoleOracle): boolean {
  return r.value.type !== 'schedule' || r.actor === owner || oracle.approverAt(r.actor, r.createdAt)
}

/** Where an embargo stands. */
export type EmbargoState =
  | { readonly state: 'scheduled' }
  | { readonly state: 'cancelled'; readonly by: string; readonly at: number }
  | { readonly state: 'done'; readonly commit: string; readonly by: string; readonly at: number }

/** One target's embargo. */
export interface Embargo {
  readonly targetId: string
  readonly number: number
  readonly plan: EmbargoPlan
  readonly setBy: string
  readonly setAt: number
  readonly id: string
  readonly state: EmbargoState
}

/** Whether `e` is waiting and its date has come (`now`: Unix seconds). */
export function embargoDue(e: Embargo, now: number): boolean {
  return e.state.state === 'scheduled' && now >= e.plan.at
}

/** The embargo of `targetId` from counted `records`: its newest schedule, ended by a newer cancellation or completion. */
export function embargoOf(targetId: string, records: readonly EmbargoRecord[]): Embargo | null {
  const mine = records
    .filter((r) => r.targetId === targetId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let i = -1
  for (let j = mine.length - 1; j >= 0; j--) {
    if (mine[j]!.value.type === 'schedule') {
      i = j
      break
    }
  }
  if (i < 0) return null
  const s = mine[i]!
  const { type: _type, ...plan } = s.value as { type: 'schedule' } & EmbargoPlan
  let state: EmbargoState = { state: 'scheduled' }
  for (const r of mine.slice(i + 1)) {
    if (r.value.type === 'cancel') {
      state = { state: 'cancelled', by: r.actor, at: r.createdAt }
      break
    }
    if (r.value.type === 'done') {
      state = { state: 'done', commit: r.value.commit, by: r.actor, at: r.createdAt }
      break
    }
  }
  return { targetId: s.targetId, number: s.number, plan, setBy: s.actor, setAt: s.createdAt, id: s.id, state }
}

/** One step of the release, in order. */
export type EmbargoStep =
  | { readonly step: 'makePublic'; readonly issue: number }
  | { readonly step: 'publish' }
  | { readonly step: 'tag'; readonly tag: string }
  | { readonly step: 'release'; readonly tag: string }

/** What a client knows of the steps (null or absent: not known; a completion ticks them all). */
export interface EmbargoFacts {
  readonly issuePublic?: boolean | null
  readonly published?: boolean | null
  readonly tagged?: boolean | null
  readonly released?: boolean | null
}

/** One checklist line. */
export type ChecklistItem = EmbargoStep & { readonly done: boolean }

/** `e`'s checklist: make the tracking issue public (an issue target), publish, then tag and release (with a tag). */
export function embargoChecklist(e: Embargo, isIssue: boolean, facts: EmbargoFacts): ChecklistItem[] {
  const complete = e.state.state === 'done'
  const item = (step: EmbargoStep, fact: boolean | null | undefined): ChecklistItem => ({ ...step, done: complete || fact === true })
  const out: ChecklistItem[] = []
  if (isIssue) out.push(item({ step: 'makePublic', issue: e.number }, facts.issuePublic))
  out.push(item({ step: 'publish' }, facts.published))
  if (e.plan.tag !== undefined) {
    out.push(item({ step: 'tag', tag: e.plan.tag }, facts.tagged))
    out.push(item({ step: 'release', tag: e.plan.tag }, facts.released))
  }
  return out
}

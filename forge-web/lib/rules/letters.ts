/**
 * Who a letter goes to (mixed-visibility DESIGN §4.2, D2, D26): the recipients of an issue,
 * comment or review sealed to specific people (`enc` v0x04), fixed when it is posted. The twin of
 * `crates/forge-core/src/rules/letters.rs`; the `role_group_letter__*` vectors hold the two equal.
 *
 * A preset resolves to its group's current people: Maintainers is the owner and the maintainers,
 * Writers and maintainers adds the role-1 writers (never triage members or readers). A reply
 * re-lists the letters it answers: a Specific-people parent's list, or a group parent's group as
 * it is now plus that parent's writer, so someone who joined the group since reads from the reply
 * on. A reply may name more people, never fewer. The writer is always slot 0; the rest are in
 * ascending id order.
 */

import type { LetterGroup } from '../private/tlv'
import type { Role } from './v2'

export type { LetterGroup }

/** At most this many recipients, the writer included (the slots sit in one 5,120-byte field). */
export const MAX_LETTER_RECIPIENTS = 16

/** A member of the repository, as the member documents say now. */
export interface LetterMember {
  /** Base58 identity id. */
  readonly identity: string
  readonly role: Role
}

/** What the writer asked for: a preset, people named one by one, or both. */
export interface LetterRequest {
  readonly group: LetterGroup | null
  readonly people: readonly string[]
}

/** A letter a new one replies under, as its writer listed it (slot 0 is its writer). */
export interface ParentLetter {
  readonly recipients: readonly string[]
  readonly group: LetterGroup | null
}

/** Everything {@link letterPlan} needs. */
export interface LetterInput {
  /** The repository's owner: in every group. */
  readonly owner: string
  /** The writer: always slot 0. */
  readonly sender: string
  readonly members: readonly LetterMember[]
  /** Identities with no usable encryption key. */
  readonly keyless: readonly string[]
  /** What the writer asked for (`null`: re-list the parents). */
  readonly request: LetterRequest | null
  /** The picker's exact list, instead of a request: it must hold every parent's recipients. */
  readonly exact: readonly string[] | null
  readonly parents: readonly ParentLetter[]
  /** Written under a members-only parent: every recipient must be a member. */
  readonly membersOnlyParent: boolean
}

/** Who a letter goes to. */
export interface LetterPlan {
  /** The writer, then the rest by id. */
  readonly recipients: readonly string[]
  /** People it would have gone to who have no usable encryption key, left out. */
  readonly skipped: readonly string[]
  /** The group the TLV names (tag 29): only when everyone else is in it. */
  readonly group: LetterGroup | null
}

/** Why a letter is refused before signing. */
export type LetterRefusal =
  | { readonly error: 'noRecipients' }
  | { readonly error: 'narrower'; readonly people: readonly string[] }
  | { readonly error: 'noEncryptionKey'; readonly people: readonly string[] }
  | { readonly error: 'notMembers'; readonly people: readonly string[] }
  | { readonly error: 'tooMany'; readonly count: number }

/** Whether a member with `role` is in `group`. */
export function inGroup(group: LetterGroup, role: Role): boolean {
  return group === 'maintainers' ? role === 'maintainer' : role === 'maintainer' || role === 'writer'
}

/** The people `group` is now: the owner, and every member whose role is in it. */
export function groupNow(group: LetterGroup, owner: string, members: readonly LetterMember[]): Set<string> {
  return new Set([owner, ...members.filter((m) => inGroup(group, m.role)).map((m) => m.identity)])
}

/** What a reply re-lists of `p` when it asks for nothing: its list, or its group now and its writer. */
function inherited(p: ParentLetter, owner: string, members: readonly LetterMember[]): string[] {
  if (p.group === null) return [...p.recipients]
  return [...groupNow(p.group, owner, members), ...p.recipients.slice(0, 1)]
}

/** Who a reply must still go to under `p`: its list, less who left a group parent's group (its writer stays). */
function required(p: ParentLetter, owner: string, members: readonly LetterMember[]): string[] {
  if (p.group === null) return [...p.recipients]
  const now = groupNow(p.group, owner, members)
  return p.recipients.filter((r, i) => i === 0 || now.has(r))
}

/** Ascending, without repeats: the order Rust's `BTreeSet<String>` gives (ids are ASCII). */
function sorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Who a letter goes to, or why it is refused (the module docs; checked in this order: a narrower
 * list, people named with no key, non-members under a members-only parent, too many).
 */
export function letterPlan(i: LetterInput): LetterPlan | LetterRefusal {
  const { owner, sender, members, parents } = i
  const keyless = new Set(i.keyless)
  const want = new Set<string>([sender])
  const named = new Set<string>()
  if (i.exact !== null) {
    for (const p of i.exact) want.add(p)
    const missing = sorted(parents.flatMap((p) => required(p, owner, members)).filter((r) => !want.has(r)))
    if (missing.length > 0) return { error: 'narrower', people: missing }
  } else {
    if (i.request === null && parents.length === 0) return { error: 'noRecipients' }
    for (const p of parents) for (const r of inherited(p, owner, members)) want.add(r)
    if (i.request !== null) {
      for (const p of i.request.people) named.add(p)
      if (i.request.group !== null) for (const r of groupNow(i.request.group, owner, members)) want.add(r)
    }
    for (const p of named) want.add(p)
  }
  const noKey = sorted([...named].filter((p) => p !== sender && keyless.has(p)))
  if (noKey.length > 0) return { error: 'noEncryptionKey', people: noKey }
  if (i.membersOnlyParent) {
    const memberIds = new Set([owner, ...members.map((m) => m.identity)])
    const outside = sorted([...want].filter((p) => !memberIds.has(p)))
    if (outside.length > 0) return { error: 'notMembers', people: outside }
  }
  const others = [...want].filter((p) => p !== sender)
  const skipped = sorted(others.filter((p) => keyless.has(p)))
  const recipients = [sender, ...sorted(others.filter((p) => !keyless.has(p)))]
  if (recipients.length > MAX_LETTER_RECIPIENTS) return { error: 'tooMany', count: recipients.length }
  let candidate: LetterGroup | null = null
  if (i.exact === null) {
    if (i.request !== null) candidate = i.request.people.length === 0 ? i.request.group : null
    else {
      const groups = new Set(parents.map((p) => p.group))
      candidate = groups.size === 1 ? ([...groups][0] ?? null) : null
    }
  }
  const now = candidate === null ? null : groupNow(candidate, owner, members)
  const group = now !== null && recipients.every((r) => r === sender || now.has(r)) ? candidate : null
  return { recipients, skipped, group }
}

/** Whether `p` is a refusal. */
export function isLetterRefusal(p: LetterPlan | LetterRefusal): p is LetterRefusal {
  return 'error' in p
}

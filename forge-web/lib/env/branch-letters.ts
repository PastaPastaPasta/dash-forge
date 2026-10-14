/**
 * The narrower branches a member change re-letters (mixed-visibility DESIGN §4.3 "Narrower
 * branches (phase 3F)", D34; parity with dg's `narrow::prepare` and forge-core `narrow::plan`,
 * `narrow::reletter`): planned beside the environments before anything is signed, sent after the
 * role change lands.
 *
 * For every narrower branch the signer holds the key of, its audience is resolved against the
 * members as the change leaves them, keeping the people with a usable encryption key. Someone who
 * holds its current key and is no longer in it starts a new generation (a fresh key appended to
 * every earlier one); otherwise, when people in it don't hold the key, the current generation (all
 * keys: joiners read the whole history). Every letter goes to everyone the audience resolves to now,
 * so every holder's record of who holds the key stays complete. A branch that has had
 * {@link MAX_BRANCH_GENERATIONS} keys gets no new one. Branches the signer holds no key for are only
 * counted: the next person to push each one updates who can read it.
 *
 * Pure but for {@link BranchLetterSender}, which `saver.ts` binds to the SDK and the vault.
 */

import { BranchKey, MAX_ARTIFACT_RECIPIENTS, MAX_BRANCH_GENERATIONS, artifactHeaderLength, branchKeyLetterToTyped, type Branch, type BranchKeyLetter, type LetterRecipient, type TypedLetter } from '../private'
import { resolveNow, type HeldBranches } from '../repo/branch-ring'
import type { Membership } from '../rules/v2'
import { errText } from '../storage/util'
import { compareStrings as cmp, type Audience } from './format'
import { EnvSaveError, recipientsOf, snapshotCredits, type PersonKey, type Sender } from './write'

/** What a narrower branch's letters need (forge-core `narrow::Reletter`). */
export type Reletter =
  | { readonly kind: 'nothing' }
  /** The audience grew (these people joined): a letter of the current generation, to everyone in it now. */
  | { readonly kind: 'joiners'; readonly people: readonly string[] }
  /** The audience shrank (these people left): a new generation, to everyone in it now. */
  | { readonly kind: 'newGeneration'; readonly left: readonly string[] }

/**
 * What `branch` needs when its audience resolves to `now` (people with a usable encryption key):
 * someone holding the current generation who is not in `now` starts a new one; otherwise someone
 * in `now` not holding it gets a letter (forge-core `narrow::plan`).
 */
export function reletterOf(branch: Branch, now: ReadonlySet<string>): Reletter {
  const holders = new Set(branch.holders)
  const left = branch.holders.filter((h) => !now.has(h))
  if (left.length > 0) return { kind: 'newGeneration', left: [...left].sort(cmp) }
  const joined = [...now].filter((p) => !holders.has(p)).sort(cmp)
  return joined.length === 0 ? { kind: 'nothing' } : { kind: 'joiners', people: joined }
}

/** The most a letter to `n` people costs: one Platform chunk of its sealed bytes and its manifest (dg `letter_credits`). */
export function letterCredits(n: number): number {
  return snapshotCredits(artifactHeaderLength(Math.min(64, Math.max(1, n))) + 2 * 512 + 16)
}

/** One narrower branch a member change sends a key letter for. */
export interface BranchItem {
  /** The full ref name. */
  readonly name: string
  readonly audience: Audience
  /** The branch as the signer holds it (every generation's key: what its letter carries). */
  readonly branch: Branch
  readonly action: Exclude<Reletter, { readonly kind: 'nothing' }>
  /** Who it is for once the change lands, with a usable encryption key (ascending). */
  readonly now: readonly string[]
  /** Who it is for but has no usable encryption key (ascending). */
  readonly noKey: readonly string[]
  /** The most its letter costs, in credits. */
  readonly credits: number
}

/** The narrower branches part of a member change's plan. */
export interface BranchPlan {
  readonly items: readonly BranchItem[]
  /** Narrower branches the signer holds no key for: the next person to push each one updates it. */
  readonly notHeld: number
  /** Why the signer's branch keys couldn't be read (nothing is sent then), or null. */
  readonly unread: string | null
}

/** No narrower branch to speak of. */
export const NO_BRANCHES: BranchPlan = { items: [], notHeld: 0, unread: null }

/** The signer's held narrower branches, as a plan reads them. */
export interface BranchReads {
  /** The branches the signer holds, read now (null: none can be held here, e.g. no members-key session). */
  readonly held: () => Promise<HeldBranches | null>
  /** How many narrower branches the signer holds no key for. */
  readonly notHeld: () => number
}

/**
 * The letters a change needs, with the members as it leaves them (`after`) and each person's
 * usable key id (`keys`; absent or `null`: none). Pure.
 */
export function planBranchLetters(held: HeldBranches, notHeld: number, owner: string, after: readonly Membership[], keys: ReadonlyMap<string, number | null>): BranchPlan {
  const items: BranchItem[] = []
  for (const b of held.ring.branches.values()) {
    const people = [...resolveNow(b.audience, owner, after)].sort(cmp)
    const now = people.filter((p) => (keys.get(p) ?? null) !== null)
    const noKey = people.filter((p) => (keys.get(p) ?? null) === null)
    const action = reletterOf(b, new Set(now))
    if (action.kind === 'nothing') continue
    items.push({ name: b.name, audience: b.audience, branch: b, action, now, noKey, credits: letterCredits(now.length) })
  }
  return { items, notHeld, unread: null }
}

/** Everyone {@link planBranchLetters} needs the keys of: the owner, the members after, and every held branch's people. */
export function branchPeople(held: HeldBranches | null, owner: string, after: readonly Membership[]): string[] {
  const ids = new Set<string>([owner, ...after.map((m) => m.identity)])
  for (const b of held?.ring.branches.values() ?? []) for (const p of b.audience.also) ids.add(p)
  return [...ids].sort(cmp)
}

/** What one sent letter came to. */
export interface LetterSent {
  /** Its kind-10 manifest's id. */
  readonly id: string
  /** Who it went to (ascending, the sender among them). */
  readonly to: readonly string[]
  /** People it was for with no usable encryption key: left out. */
  readonly skipped: readonly string[]
}

/** Seals and stores a `branchKey` letter (the sender first, then each of `people` with a usable key). */
export interface BranchLetterSender {
  send(letter: Omit<BranchKeyLetter, 'to'>, people: ReadonlySet<string>): Promise<LetterSent>
}

/** The reads and writes a {@link BranchLetterSender} makes (bound to the SDK and the vault in `saver.ts`). */
export interface LetterIO {
  /** The signer's slot: the newest usable encryption key this browser holds. */
  readonly sender: () => Promise<Sender>
  /** Each person's usable encryption key (`null`: none). */
  readonly keysOf: (ids: readonly string[]) => Promise<ReadonlyMap<string, PersonKey | null>>
  /** Seal `letter` to `slots` (slot 0 is the sender) as a key letter. */
  readonly seal: (slots: readonly LetterRecipient[], letter: TypedLetter) => Promise<Uint8Array>
  /** Store `sealed` as Platform chunks and record its kind-10 manifest (superseding nothing); its id. */
  readonly store: (sealed: Uint8Array) => Promise<string>
}

/**
 * A sender over `io` (forge-core `narrow::write_letter`): the signer at slot 0, then each person
 * with a usable encryption key in id order; the letter's `to` is every recipient, ascending. More
 * than {@link MAX_ARTIFACT_RECIPIENTS} recipients is refused before anything is sealed.
 */
export function branchLetterSender(io: LetterIO): BranchLetterSender {
  return {
    send: async (letter, people) => {
      const sender = await io.sender()
      const r = recipientsOf(sender, people, await io.keysOf([...people].filter((p) => p !== sender.identity)))
      if (r.to.length > MAX_ARTIFACT_RECIPIENTS) {
        throw new EnvSaveError(`This branch is for ${r.to.length} people. Its key can be sent to at most ${MAX_ARTIFACT_RECIPIENTS}; nothing was sent.`)
      }
      const to = [...r.to].sort(cmp)
      const id = await io.store(await io.seal(r.slots, branchKeyLetterToTyped({ ...letter, to })))
      return { id, to, skipped: r.skipped }
    },
  }
}

/** What sending one branch's letter did. */
export type LetterOutcome =
  | { readonly kind: 'sent'; readonly branch: string; readonly audience: Audience; readonly to: number }
  | { readonly kind: 'failed'; readonly branch: string; readonly reason: string }
  /** It has had {@link MAX_BRANCH_GENERATIONS} keys: no new one is made, nothing was sent. */
  | { readonly kind: 'tooManyKeys'; readonly branch: string; readonly keys: number }

/**
 * Send `plan`'s letters, after the role change landed (forge-core `narrow::reletter`), each to
 * everyone in the audience now: the current generation when people joined, a new one when people
 * left (refused for a branch that has had {@link MAX_BRANCH_GENERATIONS} keys). A letter that fails
 * is reported; the branch's next pusher sends it.
 */
export async function sendBranchLetters(plan: BranchPlan, sender: BranchLetterSender): Promise<LetterOutcome[]> {
  const out: LetterOutcome[] = []
  for (const item of plan.items) {
    const b = item.branch
    try {
      if (item.action.kind === 'newGeneration' && b.keys.length >= MAX_BRANCH_GENERATIONS) {
        out.push({ kind: 'tooManyKeys', branch: item.name, keys: b.keys.length })
        continue
      }
      const keys = item.action.kind === 'joiners' ? [...b.keys] : [...b.keys, BranchKey.generate()]
      const sent = await sender.send({ name: b.name, keys, audience: item.audience }, new Set(item.now))
      out.push({ kind: 'sent', branch: item.name, audience: item.audience, to: sent.to.length })
    } catch (e) {
      out.push({ kind: 'failed', branch: item.name, reason: errText(e) })
    }
  }
  return out
}

/** A plan whose branch keys couldn't be read: nothing is sent, and the plan says so. */
export function unreadBranches(e: unknown, notHeld: number): BranchPlan {
  return { items: [], notHeld, unread: errText(e) }
}

/**
 * A member change's environment flow in the browser (DESIGN §4.5, D34; parity with `dg collab
 * add|remove`): {@link planMemberChange} before anything is signed (shown with its cost), then
 * {@link runMemberChange} around the change itself:
 *
 * 1. a promotion's first saves (the new maintainer's earlier snapshots would otherwise start
 *    counting and change values);
 * 2. the change (the caller's membership write, and any key share or rotation);
 * 3. a maintainer removal's saves, each only if its environment still has the predicted heads;
 * 4. the regroup, planned again from a fresh read once the saves just made show, for the members
 *    as the change left them.
 *
 * A save that fails is reported and the rest go on: the change is never undone for it, and making
 * the change again (or Save it again) finishes it, since plans compare actual recipients.
 */

import type { Membership, Role } from '../rules/v2'
import { sleep } from '../sdk/facade'
import { errText } from '../storage/util'
import type { Exposure } from './chain'
import { audienceLabel, compareStrings as cmp } from './format'
import { exposureFor, snapshotOf, stateOf, unreadableCount, type EnvBook } from './loader'
import { membersAfter, pinsCredits, planPromotion, planRegroup, planRemoval, wroteSnapshots, type NotUpdated, type PeopleKeys, type Pin } from './regroup'
import { baseOf, newEnvId, prepareSave, storeSave, type EnvSaver } from './write'

/** A member change, as Settings → Members makes it. */
export type MemberChange =
  | { readonly kind: 'grant'; readonly member: string; readonly role: Role }
  | { readonly kind: 'change'; readonly member: string; readonly role: Role; readonly to: Role }
  | { readonly kind: 'revoke'; readonly member: string; readonly role: Role }

/** The reads a plan makes. */
export interface MemberEnvIO {
  /** Every environment as the signer reads it; `asMaintainer`: as if they were a maintainer too (a promotion's dry run). */
  readonly read: (asMaintainer?: string) => Promise<EnvBook>
  /** The current membership documents. */
  readonly members: () => Promise<Membership[]>
  /** Each person's highest-id usable encryption key id (`null`: none). */
  readonly keys: (ids: readonly string[]) => Promise<ReadonlyMap<string, number | null>>
}

/** What a member change does to environments, shown before signing. */
export interface MemberEnvPlan {
  readonly change: MemberChange
  /** The membership once the change lands. */
  readonly after: readonly Membership[]
  /** The member leaves the repository (no role left). */
  readonly leaves: boolean
  /** Saved before the change (a promotion). */
  readonly first: readonly Pin[]
  /** Saved after the change, keeping environments as they were (a maintainer's removal or demotion). */
  readonly removal: readonly Pin[]
  /** Saved after the change for the people their audiences cover then. */
  readonly regroup: readonly Pin[]
  readonly notUpdated: readonly NotUpdated[]
  /** A removal's checklist: the current values the member could read. */
  readonly exposures: readonly Exposure[]
  /** Environments the signer can't read at all (the checklist can't list them). */
  readonly unreadable: number
  /** The most it all costs, in credits. */
  readonly credits: number
}

/** Every save a plan makes. */
export function planPins(p: MemberEnvPlan): Pin[] {
  return [...p.first, ...p.removal, ...p.regroup]
}

/** The membership once `change` lands. */
export function afterChange(before: readonly Membership[], change: MemberChange): Membership[] {
  if (change.kind === 'grant') return membersAfter(before, change.member, change.role, true)
  if (change.kind === 'revoke') return membersAfter(before, change.member, change.role, false)
  return membersAfter(membersAfter(before, change.member, change.role, false), change.member, change.to, true)
}

/** The people a plan resolves against: the owner, the members after, and everyone the readable environments name. */
async function peopleKeys(io: MemberEnvIO, book: EnvBook, owner: string, me: string, members: readonly Membership[], after: readonly Membership[]): Promise<PeopleKeys> {
  const ids = new Set<string>([owner, me, ...members.map((m) => m.identity), ...after.map((m) => m.identity)])
  for (const e of book.resolution.environments) {
    const head = e.heads[0]
    const s = e.state === 'current' && head !== undefined ? snapshotOf(book, head) : null
    if (s !== null) for (const p of [...s.to, ...s.audience.also]) ids.add(p)
  }
  return { owner, members: [...members], keys: await io.keys([...ids].sort(cmp)) }
}

/**
 * Plan `change`'s environment saves for the signer `me` of a repo owned by `owner`.
 * `heldMembersKey`: a removed member held the members key (the checklist then counts old-format
 * values too).
 */
export async function planMemberChange(io: MemberEnvIO, change: MemberChange, me: string, owner: string, heldMembersKey: boolean): Promise<MemberEnvPlan> {
  const [book, before] = await Promise.all([io.read(), io.members()])
  const after = afterChange(before, change)
  const member = change.member
  const leaves = !after.some((m) => m.identity === member)
  const wasMaintainer = before.some((m) => m.identity === member && m.role === 'maintainer')
  const isMaintainer = after.some((m) => m.identity === member && m.role === 'maintainer')
  // the plan resolves groups against the members as the change leaves them; the keys of the
  // people they name are read now (a save made later reads them again)
  const people = await peopleKeys(io, book, owner, me, after, after)
  let first: Pin[] = []
  const notUpdated: NotUpdated[] = []
  if (!wasMaintainer && isMaintainer && wroteSnapshots(book, member)) {
    const promo = planPromotion(book, await io.read(member), member, before, owner)
    first = [...promo.pins]
    for (const env of promo.cannot) notUpdated.push({ kind: 'cannot', env })
    for (const env of promo.appeared) notUpdated.push({ kind: 'appeared', env, member })
  }
  let removal: Pin[] = []
  if (wasMaintainer && !isMaintainer) {
    const r = planRemoval(book, member, after, owner, leaves)
    removal = [...r.pins]
    for (const env of r.cannot) notUpdated.push({ kind: 'cannot', env })
  }
  const skip = new Set([...first, ...removal].map((p) => p.env))
  const regroup = planRegroup(book, people, me, after, leaves ? member : null, skip)
  notUpdated.push(...regroup.notUpdated)
  const all = [...first, ...removal, ...regroup.pins]
  return {
    change,
    after,
    leaves,
    first,
    removal,
    regroup: regroup.pins,
    notUpdated,
    exposures: change.kind === 'revoke' && leaves ? exposureFor(book, member, heldMembersKey) : [],
    unreadable: change.kind === 'revoke' && leaves ? unreadableCount(book) : 0,
    credits: pinsCredits(all),
  }
}

/** One line of what the saves did. */
export type SaveOutcome =
  | { readonly kind: 'saved'; readonly env: string; readonly audience: string; readonly to: number; readonly skipped: readonly string[] }
  | { readonly kind: 'moved'; readonly env: string }
  | { readonly kind: 'failed'; readonly env: string; readonly reason: string }
  | { readonly kind: 'unread'; readonly reason: string }

/** What {@link runMemberChange} did beside the change. */
export interface MemberChangeOutcome {
  readonly saves: readonly SaveOutcome[]
  /** Environments the regroup run after the change could not save from here. */
  readonly notUpdated: readonly NotUpdated[]
  /** What people who lost access could read (a demotion's; a removal shows its own checklist). */
  readonly gone: readonly { readonly who: string; readonly exposure: Exposure }[]
}

/** How long the regroup after a change waits for the saves just made to show in a read. */
const VISIBLE_ATTEMPTS = 12
const VISIBLE_DELAY_MS = 1500

/**
 * Save `pins` as the signer, each only if its environment still has exactly the predicted heads
 * (checked against one read made before any is written; dg `save_pins`). Returns what happened
 * and the `packHash`es saved.
 */
export async function savePins(io: MemberEnvIO, saver: EnvSaver, pins: readonly Pin[]): Promise<{ readonly outcomes: SaveOutcome[]; readonly hashes: string[] }> {
  const outcomes: SaveOutcome[] = []
  const hashes: string[] = []
  if (pins.length === 0) return { outcomes, hashes }
  let book: EnvBook
  try {
    book = await io.read()
  } catch (e) {
    return { outcomes: [{ kind: 'unread', reason: errText(e) }], hashes }
  }
  for (const pin of pins) {
    const heads = stateOf(book, pin.env)?.heads ?? []
    if (heads.join() !== pin.predicted.join()) {
      outcomes.push({ kind: 'moved', env: pin.env })
      continue
    }
    try {
      const id = pin.snapshot.id ?? safeBaseId(book, pin.env) ?? newEnvId()
      const prepared = await prepareSave(saver, {
        env: pin.env,
        id,
        audience: pin.audience,
        vars: pin.snapshot.vars,
        supersedes: pin.supersedes,
        ...(pin.savedFor !== undefined ? { savedFor: pin.savedFor } : {}),
        markedChanged: pin.snapshot.markedChanged,
        people: pin.people,
      })
      const saved = await storeSave(saver, prepared)
      outcomes.push({ kind: 'saved', env: pin.env, audience: audienceLabel(pin.audience), to: saved.to.length, skipped: saved.skipped })
      hashes.push(saved.packHash)
    } catch (e) {
      outcomes.push({ kind: 'failed', env: pin.env, reason: errText(e) })
    }
  }
  return { outcomes, hashes }
}

function safeBaseId(book: EnvBook, env: string): string | null {
  try {
    return baseOf(book, env).id
  } catch {
    return null
  }
}

/** The change itself failed after the first saves were made: `saves` says what they did. */
export class MemberChangeFailed extends Error {
  constructor(
    readonly cause: unknown,
    readonly saves: readonly SaveOutcome[],
  ) {
    super(errText(cause))
    this.name = 'MemberChangeFailed'
  }
}

/** Read until `ready` holds for a read (or the attempts run out): the last read, or null when none succeeded. */
async function readUntil(io: MemberEnvIO, ready: (b: EnvBook) => boolean): Promise<EnvBook | null> {
  let book: EnvBook | null = null
  for (let attempt = 0; attempt < VISIBLE_ATTEMPTS; attempt++) {
    try {
      const b = await io.read()
      book = b
      if (ready(b)) break
    } catch {
      // read again
    }
    await sleep(VISIBLE_DELAY_MS)
  }
  return book
}

/**
 * Run `change` (the membership write, `doChange`) with its environment saves around it, as
 * `plan` showed them. `precheck` runs before anything is saved (what would refuse the change
 * without signing). `doChange` throwing stops everything after the first saves
 * ({@link MemberChangeFailed} carries what they did).
 */
export async function runMemberChange(
  io: MemberEnvIO,
  saver: EnvSaver,
  plan: MemberEnvPlan,
  owner: string,
  doChange: () => Promise<void>,
  precheck: () => Promise<void> = async () => undefined,
): Promise<MemberChangeOutcome> {
  await precheck()
  const first = await savePins(io, saver, plan.first)
  try {
    await doChange()
  } catch (e) {
    if (first.outcomes.length === 0) throw e
    throw new MemberChangeFailed(e, first.outcomes)
  }
  // A removed maintainer's snapshots stop counting only once a read no longer lists them: a
  // node a block behind would still predict the old heads and every save would be skipped.
  if (plan.removal.length > 0) await readUntil(io, (b) => !b.maintainers.has(plan.change.member))
  const removal = await savePins(io, saver, plan.removal)
  const waitFor = [...first.hashes, ...removal.hashes]
  const saves = [...first.outcomes, ...removal.outcomes]
  // nothing planned and nothing saved just before: nothing to do
  if (plan.regroup.length === 0 && plan.notUpdated.length === 0 && waitFor.length === 0) return { saves, notUpdated: [], gone: [] }
  const book = await readUntil(io, (b) => waitFor.every((h) => b.manifests.some((m) => m.packHash === h)))
  if (book === null) return { saves: [...saves, { kind: 'unread', reason: "couldn't read the environments to save them again" }], notUpdated: [], gone: [] }
  let people: PeopleKeys
  try {
    people = await peopleKeys(io, book, owner, saver.me, await io.members(), plan.after)
  } catch (e) {
    return { saves: [...saves, { kind: 'unread', reason: `couldn't read the members to save the environments again (${errText(e)})` }], notUpdated: [], gone: [] }
  }
  // against the members as planned: a node a block behind may not list the change yet
  const regroup = planRegroup(book, { ...people, members: [...plan.after] }, saver.me, plan.after, plan.leaves ? plan.change.member : null)
  const done = await savePins(io, saver, regroup.pins)
  const gone: { who: string; exposure: Exposure }[] = []
  // what people who lose access but stay members could read (a demotion's, or one role of
  // several removed); someone who leaves gets the removal's own checklist
  if (plan.change.kind !== 'grant' && !plan.leaves) {
    for (const p of regroup.pins) {
      for (const who of p.gone) {
        for (const exposure of exposureFor(book, who, false).filter((e) => e.env === p.env)) gone.push({ who, exposure })
      }
    }
  }
  return { saves: [...saves, ...done.outcomes], notUpdated: regroup.notUpdated, gone }
}

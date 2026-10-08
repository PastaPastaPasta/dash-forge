/**
 * What a member change does to environments (DESIGN §4.5 "Groups change", D24, D34), planned
 * before anything is signed: the twin of dg's `plan_regroup`, `plan_removal` and
 * `prepare_promotion` (`crates/dg/src/env.rs`), so the web and `dg collab add|remove` save the
 * same environments for the same people.
 *
 * - **Regroup**: every environment this signer can read whose people differ from what its
 *   audience covers once the change lands (or that adds someone who leaves) is saved again for
 *   them. Compared with each environment's actual recipients, so a change made again after a
 *   failure still finishes it. Planned again from a fresh read after the change lands.
 * - **Removal of a maintainer** (or a maintainer's demotion): their snapshots stop counting, so
 *   each environment whose heads that changes is saved again first-hand, keeping it as it was.
 * - **Promotion**: their earlier snapshots (ignored until now) would start counting, so each
 *   environment they would change is saved first with its current values.
 * - Environments this signer can't open are named ("not updated: ask @x").
 *
 * Pure: `member-change.ts` does the reads and the saves.
 */

import { memberDocOf } from '../repo/members'
import type { Membership, Role } from '../rules/v2'
import { changedEnvironments, resolveSnapshots, type EnvState, type Resolution } from './chain'
import { compareStrings as cmp, diffSnapshots, MAX_RECIPIENTS, membersKey, type Audience, type Change, type Snapshot } from './format'
import { currentOf, headOf, snapshotOf, stateOf, type EnvBook, type EnvManifest } from './loader'
import { resolvePeople, type PeopleView } from './view'
import { MAX_SEALED, estimatedSealedSize, hashesOf, joined, snapshotCredits, windowOf, windowOver } from './write'

/** The repo's people and their current encryption keys, as a plan needs them. */
export interface PeopleKeys extends PeopleView {
  /** Each person's highest-id usable encryption key id (`null`: none). Unknown people have none. */
  readonly keys: ReadonlyMap<string, number | null>
}

function hasKey(people: PeopleKeys, id: string): boolean {
  return (people.keys.get(id) ?? null) !== null
}

/** Why a planned save is made, for the plan shown before signing. */
export type PinWhy =
  /** Saved for the people its audience covers once the change lands. */
  | { readonly kind: 'regroup' }
  /** A removed maintainer wrote its latest version: saved again as the signer with their values. */
  | { readonly kind: 'theirs'; readonly member: string; readonly changes: ReadonlyArray<readonly [string, Change]> }
  /** Saved again unchanged, so its history stays in one piece once their snapshots stop counting. */
  | { readonly kind: 'chain'; readonly member: string }
  /** Their version of a conflict saved again, so it stays one of the versions. */
  | { readonly kind: 'conflict'; readonly member: string; readonly head: string }
  /** Their earlier changes would replace its values: saved first with its current values. */
  | { readonly kind: 'promotion'; readonly member: string }

/** One snapshot a member change saves, planned before it (values held in memory only; dg `Pin`). */
export interface Pin {
  readonly env: string
  /** The heads it is predicted to have when saved: saved only if it still has exactly these. */
  readonly predicted: readonly string[]
  readonly supersedes: readonly string[]
  readonly snapshot: Snapshot
  /** Who it is for once saved (its audience, without a removed member among the people it adds). */
  readonly audience: Audience
  /** The people that audience covers (the signer is added when it is sealed). */
  readonly people: ReadonlySet<string>
  readonly savedFor?: string
  readonly why: PinWhy
  /** Its estimated sealed size. */
  readonly size: number
  /** People this save gives access to, and takes it from (a regroup's). */
  readonly added: readonly string[]
  readonly gone: readonly string[]
}

/** An environment a change affects that this signer can't save from here. */
export type NotUpdated =
  | { readonly kind: 'conflict'; readonly env: string }
  | { readonly kind: 'unreadable'; readonly env: string; readonly author: string }
  | { readonly kind: 'onlyRemoved'; readonly env: string; readonly member: string }
  | { readonly kind: 'tooMany'; readonly env: string; readonly audience: Audience; readonly n: number }
  | { readonly kind: 'tooLarge'; readonly env: string; readonly n: number }
  /** Environments this signer can't open at all; `removed`: someone leaving may read them. */
  | { readonly kind: 'hidden'; readonly n: number; readonly authors: readonly string[]; readonly removed: string | null }
  /** It changes when the role lands or goes, and this signer can't read it to save it first. */
  | { readonly kind: 'cannot'; readonly env: string }
  /** The new maintainer saved it while not one: it appears once the role lands. */
  | { readonly kind: 'appeared'; readonly env: string; readonly member: string }

function pin(
  env: string,
  snap: Snapshot,
  audience: Audience,
  people: ReadonlySet<string>,
  predicted: readonly string[],
  supersedes: readonly string[],
  why: PinWhy,
  extra: { readonly savedFor?: string; readonly added?: readonly string[]; readonly gone?: readonly string[] } = {},
): Pin {
  return {
    env,
    predicted,
    supersedes,
    snapshot: snap,
    audience,
    people,
    ...(extra.savedFor !== undefined ? { savedFor: extra.savedFor } : {}),
    why,
    size: estimatedSealedSize(snap, people.size),
    added: extra.added ?? [],
    gone: extra.gone ?? [],
  }
}

/** What saving every one of `pins` costs, at most. */
export function pinsCredits(pins: readonly Pin[]): number {
  return pins.reduce((sum, p) => sum + snapshotCredits(p.size), 0)
}

/**
 * The membership documents once `member` gets `role` (`grant`) or loses the document `role` is
 * held in (dg `members_after`).
 */
export function membersAfter(before: readonly Membership[], member: string, role: Role, grant: boolean): Membership[] {
  const doc = memberDocOf(role)
  const out = before.filter((m) => !(m.identity === member && memberDocOf(m.role) === doc))
  if (grant) out.push({ identity: member, role, createdAt: 0 })
  return out
}

/** `snap`'s audience without `removed` among the people it adds (dg `audience_without`). */
export function audienceWithout(snap: Snapshot, removed: string | null): Audience {
  return removed === null ? snap.audience : { group: snap.audience.group, also: snap.audience.also.filter((p) => p !== removed) }
}

function sameAudience(a: Audience, b: Audience): boolean {
  return a.group === b.group && a.also.length === b.also.length && a.also.every((x, i) => x === b.also[i])
}

/** Who made the latest change to `env` (empty when none; dg `last_author`). */
export function lastAuthor(book: EnvBook, env: string): string {
  const heads = stateOf(book, env)?.heads ?? []
  const last = heads[heads.length - 1]
  return last === undefined ? '' : headOf(book, last).author
}

/** The authors of the latest changes of environments this reader can't name (dg `hidden_authors`). */
export function hiddenAuthors(book: EnvBook): string[] {
  const out = new Set<string>()
  for (const h of book.resolution.hidden) {
    for (const id of h.heads) {
      const m = book.manifests.find((x) => x.id === id)
      if (m !== undefined) out.add(m.ownerId)
    }
  }
  return [...out].sort(cmp)
}

/**
 * Whether saving `snap` (written by `author`) again for `audience`, with `members` the membership,
 * would change who can read it: someone in it now is missing (and has a key), someone no longer
 * in it is still a recipient (never its writer), or a recipient's key changed since (dg
 * `stale_against`'s `fixed_by_saving`).
 */
export function savingFixes(snap: Snapshot, audience: Audience, author: string, people: PeopleKeys, members: readonly Membership[]): boolean {
  if (membersKey(snap)) return false
  const expected = resolvePeople(audience, { owner: people.owner, members })
  const to = new Set(snap.to)
  if ([...expected].some((who) => !to.has(who) && hasKey(people, who))) return true
  if (snap.to.some((who) => !expected.has(who) && who !== author)) return true
  // slot 0 is the writer's own, sealed with the key they sent with
  return snap.to.some((who, i) => {
    if (i === 0) return false
    const now = people.keys.get(who) ?? null
    return now !== null && now !== snap.toKeys[i]
  })
}

/** The regroup's saves and the environments it can't save (dg `plan_regroup`). */
export interface Regroup {
  readonly pins: readonly Pin[]
  readonly notUpdated: readonly NotUpdated[]
}

/**
 * {@link Regroup} of `book` once the members are `after`; `me` is the signer; `removed`: someone
 * who leaves the repository (taken out of the people environments add); `skip`: environments
 * another plan of this change already saves.
 */
export function planRegroup(
  book: EnvBook,
  people: PeopleKeys,
  me: string,
  after: readonly Membership[],
  removed: string | null,
  skip: ReadonlySet<string> = new Set(),
): Regroup {
  const pins: Pin[] = []
  const notUpdated: NotUpdated[] = []
  for (const e of book.resolution.environments) {
    if (skip.has(e.env)) continue
    const cur = currentOf(book, e.env)
    if (!cur.ok) {
      notUpdated.push(cur.blocked.kind === 'conflict' ? { kind: 'conflict', env: e.env } : { kind: 'unreadable', env: e.env, author: lastAuthor(book, e.env) })
      continue
    }
    const snap = cur.snapshot
    const aud = audienceWithout(snap, removed)
    if (aud.group === null && aud.also.length === 0) {
      notUpdated.push({ kind: 'onlyRemoved', env: e.env, member: removed ?? '' })
      continue
    }
    const author = lastAuthor(book, e.env)
    // an old-format environment is read with the members key, which the change hands over or
    // rotates already; Save it again converts it
    if (membersKey(snap) || (sameAudience(aud, snap.audience) && !savingFixes(snap, aud, author, people, after))) continue
    const all = resolvePeople(aud, { owner: people.owner, members: after })
    const will = new Set([...all].filter((p) => hasKey(people, p)))
    will.add(me)
    if (will.size > MAX_RECIPIENTS) {
      notUpdated.push({ kind: 'tooMany', env: e.env, audience: aud, n: will.size })
      continue
    }
    const now = new Set(snap.to)
    const added = [...will].filter((p) => !now.has(p)).sort(cmp)
    const gone = [...now].filter((p) => !will.has(p) && (p !== author || !all.has(p))).sort(cmp)
    const p = pin(e.env, snap, aud, all, e.heads, windowOf(book, e.env), { kind: 'regroup' }, { added, gone })
    if (p.size > MAX_SEALED) {
      notUpdated.push({ kind: 'tooLarge', env: e.env, n: will.size })
      continue
    }
    pins.push(p)
  }
  if (book.resolution.hidden.length > 0) {
    notUpdated.push({ kind: 'hidden', n: book.resolution.hidden.length, authors: hiddenAuthors(book), removed })
  }
  return { pins, notUpdated }
}

/**
 * The resolution these manifests would have if the maintainers were `maintainers` (a dry run of
 * a removal: only snapshots this book opened can be named; forge-core `Book::resolution_with`).
 */
export function resolutionWith(book: EnvBook, maintainers: ReadonlySet<string>): Resolution {
  const byHash = new Map<string, string>()
  for (const m of book.manifests) {
    if (!maintainers.has(m.ownerId)) continue
    const s = snapshotOf(book, m.id)
    if (s !== null) byHash.set(m.packHash, s.env)
  }
  return resolveSnapshots(maintainers, book.manifests, (h) => byHash.get(h) ?? null)
}

function manifest(book: EnvBook, id: string): EnvManifest | undefined {
  return book.manifests.find((m) => m.id === id)
}

/**
 * The newest earlier snapshot of `state`'s environment below `head` that someone other than
 * `author` wrote and this reader opened: what a removed maintainer's change is compared with
 * (forge-core `Book::previous_by_other`).
 */
function previousByOther(book: EnvBook, state: EnvState, head: EnvManifest, author: string): Snapshot | null {
  let best: { m: EnvManifest; s: Snapshot } | null = null
  for (const id of state.snapshots) {
    const m = manifest(book, id)
    const s = snapshotOf(book, id)
    if (m === undefined || s === null || m.ownerId === author || m.height >= head.height) continue
    if (best === null || m.height > best.m.height || (m.height === best.m.height && cmp(m.id, best.m.id) > 0)) best = { m, s }
  }
  return best?.s ?? null
}

/**
 * The pack hashes of the snapshots among `kept` that `head` descends from through the links
 * among `counted`, newest first (dg `kept_ancestors`).
 */
function keptAncestors(book: EnvBook, counted: readonly string[], kept: readonly string[], head: EnvManifest): string[] {
  const manifests = counted.map((id) => manifest(book, id)).filter((m): m is EnvManifest => m !== undefined)
  const seen = new Set<string>()
  const todo = [head]
  const found: EnvManifest[] = []
  for (let m = todo.pop(); m !== undefined; m = todo.pop()) {
    const cur = m
    for (const p of manifests.filter((p) => cur.supersedes.includes(p.packHash) && p.height < cur.height)) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      if (kept.includes(p.id)) found.push(p)
      todo.push(p)
    }
  }
  found.sort((a, b) => b.height - a.height || cmp(b.id, a.id))
  return found.map((m) => m.packHash)
}

/** A removal's (or a maintainer demotion's) saves, and the environments it can't save first. */
export interface RemovalPlan {
  readonly pins: readonly Pin[]
  readonly cannot: readonly string[]
}

/**
 * The saves that keep every environment as it is when `member` stops being a maintainer (dg
 * `plan_removal`): a dry run of the resolution without them, per environment whose heads change.
 * Each is saved for its audience as it will be (`after`); `leaves`: they leave the repository.
 */
export function planRemoval(book: EnvBook, member: string, after: readonly Membership[], owner: string, leaves: boolean): RemovalPlan {
  const without = new Set(book.maintainers)
  without.delete(member)
  const resolvedAfter = resolutionWith(book, without)
  const diff = changedEnvironments(book.resolution, resolvedAfter)
  const pins: Pin[] = []
  const cannot: string[] = []
  const forAudience = (snap: Snapshot): [Audience, Set<string>] => {
    const aud = audienceWithout(snap, leaves ? member : null)
    return [aud, resolvePeople(aud, { owner, members: after })]
  }
  for (const env of [...diff.changed, ...diff.vanished]) {
    const state = stateOf(book, env)
    if (state === undefined) continue
    const a = resolvedAfter.environments.find((x) => x.env === env)
    const predicted = a?.heads ?? []
    const keptIds = a?.snapshots ?? []
    if (state.state === 'current') {
      const id = state.heads[0] as string
      const m = manifest(book, id)
      const snap = snapshotOf(book, id)
      if (m === undefined || snap === null) {
        cannot.push(env)
        continue
      }
      const theirs = m.ownerId === member
      const [aud, people] = forAudience(snap)
      const first = hashesOf(book, predicted)
      if (theirs) first.unshift(m.packHash)
      const why: PinWhy = theirs ? { kind: 'theirs', member, changes: diffSnapshots(previousByOther(book, state, m, member), snap) } : { kind: 'chain', member }
      pins.push(pin(env, snap, aud, people, predicted, joined(first, windowOver(book, keptIds, predicted)), why, theirs ? { savedFor: member } : {}))
    } else if (state.state === 'conflict') {
      for (const id of state.heads) {
        const m = manifest(book, id)
        if (m === undefined || m.ownerId !== member) continue
        const snap = snapshotOf(book, id)
        if (snap === null) {
          cannot.push(env)
          continue
        }
        // their version again, linked to the versions it came from that still count: it stays
        // one of the versions at the same time, without replacing any other head
        const [aud, people] = forAudience(snap)
        const first = [m.packHash, ...keptAncestors(book, state.snapshots, keptIds, m)]
        pins.push(pin(env, snap, aud, people, predicted, joined(first, []), { kind: 'conflict', member, head: id }, { savedFor: member }))
      }
    } else {
      cannot.push(env)
    }
  }
  return { pins, cannot }
}

/** A promotion's first saves (dg `Promotion`). */
export interface PromotionPlan {
  readonly pins: readonly Pin[]
  readonly cannot: readonly string[]
  readonly appeared: readonly string[]
}

/**
 * What making `member` a maintainer does (dg `prepare_promotion`): `now` is the book as it is,
 * `then` the same read as if they were a maintainer already. Each environment their earlier
 * snapshots would change is saved first with its current values, for its audience as it is now
 * (`before`): the role isn't granted yet; the regroup after it adds them.
 */
export function planPromotion(now: EnvBook, then: EnvBook, member: string, before: readonly Membership[], owner: string): PromotionPlan {
  const diff = changedEnvironments(now.resolution, then.resolution)
  const pins: Pin[] = []
  const cannot: string[] = []
  for (const env of diff.changed) {
    const cur = currentOf(now, env)
    if (!cur.ok) {
      cannot.push(env)
      continue
    }
    const snap = cur.snapshot
    const current = stateOf(now, env)?.heads ?? []
    const st = stateOf(then, env)
    const people = resolvePeople(snap.audience, { owner, members: before })
    const supersedes = joined(hashesOf(now, current), windowOver(then, st?.snapshots ?? [], st?.heads ?? []))
    pins.push(pin(env, snap, snap.audience, people, current, supersedes, { kind: 'promotion', member }))
  }
  return { pins, cannot, appeared: diff.appeared }
}

/** Whether `member` wrote any environment snapshot (only then can a promotion change one). */
export function wroteSnapshots(book: EnvBook, member: string): boolean {
  return book.manifests.some((m) => m.ownerId === member)
}

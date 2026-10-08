/**
 * What Settings → Environments and a removal's checklist show, from an {@link EnvBook}: one card per
 * environment this reader can name, the count of those it cannot, and the sentences (DESIGN §10;
 * `dg env ls`, `dg env get`'s warning and E608, `dg collab remove`'s checklist say the same).
 * Pure: the page renders it, vitest pins it. Values stay in the cards in memory only; the page
 * masks them.
 */

import type { Role } from '../rules/v2'
import type { Exposure } from './chain'
import { OLD_FORMAT_HISTORY_SENTENCE, OLD_FORMAT_SENTENCE, audienceLabel, compareStrings as cmp, membersKey, type Audience, type Group, type Snapshot, type VarType } from './format'
import {
  currentOf,
  headOf,
  ignoredCount,
  ignoredNewerOf,
  needsAttention,
  oldFormatOf,
  shortHead,
  snapshotOf,
  type EnvBook,
  type Head,
} from './loader'

/** One entry as a card lists it. */
export interface EntryView {
  readonly name: string
  readonly type: VarType
  readonly note: string
  /** Held in memory for the show/hide toggle; never rendered unless shown. */
  readonly value: string
}

/** One version of a conflict. */
export interface VersionView {
  readonly head: Head
  /** Its entries, when it opens here. */
  readonly entries: readonly EntryView[] | null
}

/** One environment this reader can name. */
export interface EnvCardView {
  readonly env: string
  readonly kind: 'current' | 'conflict' | 'unreadable'
  /** Who can read it (the newest readable version's audience). */
  readonly audience: Audience | null
  /** How the audience is told: "Maintainers", "Writers and maintainers + 1 more", "All members (old format)". */
  readonly audienceLabel: string | null
  /** The newest readable version is an old-format Members snapshot (under the members key). */
  readonly membersKey: boolean
  /** The people it was saved to (base58), the writer first, as of its last save; empty in the old format. */
  readonly readers: readonly string[]
  /** What the old format left in it, when that needs attention (DESIGN §10). */
  readonly oldFormat: OldFormatView | null
  /** Maintainers only: who it misses or still includes against its audience now. */
  readonly stale: readonly StaleItem[]
  /** The values in use (`current` only). */
  readonly entries: readonly EntryView[]
  /** Who saved the version in use, and when (every head of a conflict is in `conflict`). */
  readonly updated: Head | null
  /** A maintainer saved this version again for a removed maintainer (base58). */
  readonly savedFor: string | null
  /** The newest ignored change naming its latest version, and how many more there are. */
  readonly ignored: { readonly head: Head; readonly more: number } | null
  readonly conflict: { readonly headline: string; readonly split: boolean; readonly versions: readonly VersionView[] } | null
  /** Why its latest change can't be read here (`unreadable`). */
  readonly unreadable: { readonly reason: string; readonly unfetched: boolean; readonly head: Head } | null
}

/** The old-format banner of one environment (DESIGN §10). */
export interface OldFormatView {
  /** Its latest version is in the old format (Save it again); else earlier ones are (Mark changed). */
  readonly latest: boolean
  /** {@link OLD_FORMAT_SENTENCE} when the latest version is old, else {@link OLD_FORMAT_HISTORY_SENTENCE}. */
  readonly sentence: string
  /** Names held in old-format versions not marked changed yet (only when the latest version is not old). */
  readonly unmarked: readonly string[]
  /** What to run: `dg env resave --env <name>` or `dg env mark-changed --env <name>`. */
  readonly command: string
}

/** The repo's people, as the precise list of who an environment misses needs them. */
export interface PeopleView {
  /** The repository owner (base58): in every group. */
  readonly owner: string
  /** The current membership documents (an identity may hold two). */
  readonly members: readonly { readonly identity: string; readonly role: Role }[]
}

/** Someone an environment's latest version misses, or still includes, against its audience now. */
export interface StaleItem {
  readonly who: string
  /** `missing`: in its audience now, not in `to`. `extra`: in `to`, no longer in its audience. */
  readonly kind: 'missing' | 'extra'
  /** How they are told for `missing`: "a writer", "a maintainer", "added to it"... */
  readonly role: string
}

/** What {@link environmentsView} knows about the viewer and the repo's people. */
export interface ViewContext {
  /** The viewer (base58), when this page may speak for them (signed in, unlocked). */
  readonly viewer?: string | null
  /** The repo's people: a maintainer's precise list needs them. */
  readonly people?: PeopleView | null
}

export interface EnvPageView {
  readonly cards: readonly EnvCardView[]
  /** Environments this reader cannot name (counted, never named). */
  readonly hidden: number
  /** Changes by people who aren't maintainers now, ignored. */
  readonly ignored: number
  /** The repository has no environment at all. */
  readonly empty: boolean
  /**
   * The viewer is not a maintainer and some environment is out of their reach: "An environment in
   * this repo hasn't been shared with you" (E612), since from outside "not in its audience" and
   * "in the group, not saved since" look the same.
   */
  readonly notShared: boolean
  /** The viewer is a maintainer (`false` when unknown). */
  readonly viewerMaintainer: boolean
}

/** `ms` as `YYYY-MM-DD HH:MM UTC` (as `dg` prints it). */
export function utc(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

/** `n thing(s)`. */
export function count(n: number, thing: string): string {
  if (n === 1) return `1 ${thing}`
  return `${n} ${thing.endsWith('y') ? `${thing.slice(0, -1)}ies` : `${thing}s`}`
}

function entriesOf(book: EnvBook, id: string): EntryView[] | null {
  const s = snapshotOf(book, id)
  if (s === null) return null
  return [...s.vars.entries()].sort(([a], [b]) => cmp(a, b)).map(([name, v]) => ({ name, type: v.type, note: v.note, value: v.value }))
}

/**
 * A conflict's headline: "2 people changed production at the same time", "production was
 * changed 2 times at the same time", or for heads with no earlier version in common "production
 * has 2 separate histories" (forge-core `conflict_headline`).
 */
export function conflictHeadline(env: string, heads: readonly Head[], split: boolean): string {
  if (split) return `${env} has ${heads.length} separate histories`
  const authors = new Set(heads.map((h) => h.author))
  return authors.size > 1 ? `${authors.size} people changed ${env} at the same time` : `${env} was changed ${heads.length} times at the same time`
}

/** The E612 line for a viewer who is not a maintainer (DESIGN §10; `dg env ls` says it too). */
export const NOT_SHARED_TEXT = "An environment in this repo hasn't been shared with you. If you should have access, ask a maintainer to save it again."

const ROLE_WORD: Readonly<Record<Role, string>> = { maintainer: 'a maintainer', writer: 'a writer', triage: 'a triage member', reader: 'a reader' }
const ROLE_ORDER: readonly Role[] = ['maintainer', 'writer', 'triage', 'reader']

/** Whether a member with `role` is in `group` (forge-core `Group::includes`). */
function groupIncludes(group: Group, role: Role): boolean {
  if (group === 'maintainers') return role === 'maintainer'
  if (group === 'writers') return role === 'maintainer' || role === 'writer'
  return true
}

/**
 * The people `audience` resolves to now (forge-core `resolve_people`): the people it adds, and
 * for a group the owner and every member in it.
 */
export function resolvePeople(audience: Audience, people: PeopleView): Set<string> {
  const out = new Set(audience.also)
  if (audience.group !== null) {
    const group = audience.group
    out.add(people.owner)
    for (const m of people.members) if (groupIncludes(group, m.role)) out.add(m.identity)
  }
  return out
}

function roleWord(people: PeopleView, who: string): string {
  const best = ROLE_ORDER.find((r) => people.members.some((m) => m.identity === who && m.role === r))
  if (best !== undefined) return ROLE_WORD[best]
  return who === people.owner ? 'the owner' : 'added to it'
}

/**
 * Who `env`'s latest version misses or still includes, against its audience now (forge-core
 * `stale_of`, minus encryption-key changes, which only `dg` can check). The writer of the latest
 * version is never listed as no longer covered. Old-format Members versions are the old-format
 * banner's business.
 */
export function staleOf(book: EnvBook, env: string, people: PeopleView): StaleItem[] {
  const cur = currentOf(book, env)
  if (!cur.ok || membersKey(cur.snapshot)) return []
  const snap = cur.snapshot
  const state = book.resolution.environments.find((e) => e.env === env)
  const lastHead = state?.heads[state.heads.length - 1]
  const author = lastHead === undefined ? '' : headOf(book, lastHead).author
  const expected = resolvePeople(snap.audience, people)
  const to = new Set(snap.to)
  const out: StaleItem[] = []
  for (const who of [...expected].sort(cmp)) {
    if (!to.has(who)) out.push({ who, kind: 'missing', role: roleWord(people, who) })
  }
  for (const who of snap.to) {
    if (!expected.has(who) && who !== author) out.push({ who, kind: 'extra', role: '' })
  }
  return out
}

/** One line of the precise list (DESIGN §10): "dana is a writer, but staging hasn't been saved since." `name` is how the page names `item.who`. */
export function staleLine(env: string, item: StaleItem, name: string): string {
  return item.kind === 'missing'
    ? `${name} is ${item.role}, but ${env} hasn't been saved since.`
    : `${name} isn't in its audience any more, but can read ${env} until it's saved again.`
}

/** The command that saves `env` again. */
export function resaveCommand(env: string): string {
  return `dg env resave --env ${env}`
}

/** The old-format banner of `env`, when it needs one (forge-core `old_format_line`). */
export function oldFormatView(book: EnvBook, env: string): OldFormatView | null {
  const old = oldFormatOf(book, env)
  if (old === null || !needsAttention(old)) return null
  if (old.latest) return { latest: true, sentence: OLD_FORMAT_SENTENCE, unmarked: [], command: resaveCommand(env) }
  return { latest: false, sentence: OLD_FORMAT_HISTORY_SENTENCE, unmarked: old.unmarked, command: `dg env mark-changed --env ${env}` }
}

function cardAudienceLabel(s: Snapshot): string {
  return membersKey(s) ? 'All members (old format)' : audienceLabel(s.audience)
}

/** Every environment of `book` as the page shows it. */
export function environmentsView(book: EnvBook, ctx: ViewContext = {}): EnvPageView {
  const viewer = ctx.viewer ?? null
  const viewerMaintainer = viewer !== null && book.maintainers.has(viewer)
  const cards = book.resolution.environments.map((state): EnvCardView => {
    const env = state.env
    const ignoredList = ignoredNewerOf(book, env)
    const last = ignoredList[ignoredList.length - 1]
    const ignored = last === undefined ? null : { head: last, more: ignoredList.length - 1 }
    // the newest readable version says who can read the environment
    const newest = [...state.heads].reverse().map((id) => snapshotOf(book, id)).find((s) => s !== null) ?? null
    const old = newest !== null && membersKey(newest)
    const base = {
      env,
      audience: newest?.audience ?? null,
      audienceLabel: newest === null ? null : cardAudienceLabel(newest),
      membersKey: old,
      readers: newest?.to ?? [],
      oldFormat: oldFormatView(book, env),
      stale: viewerMaintainer && ctx.people ? staleOf(book, env, ctx.people) : [],
      ignored,
    }
    const cur = currentOf(book, env)
    if (cur.ok) {
      const head = headOf(book, state.heads[0] as string)
      return { ...base, kind: 'current', entries: entriesOf(book, head.id) ?? [], updated: head, savedFor: cur.snapshot.savedFor ?? null, conflict: null, unreadable: null }
    }
    const b = cur.blocked
    if (b.kind === 'conflict') {
      const versions = b.heads.map((head) => ({ head, entries: entriesOf(book, head.id) }))
      return { ...base, kind: 'conflict', entries: [], updated: null, savedFor: null, conflict: { headline: conflictHeadline(env, b.heads, b.split), split: b.split, versions }, unreadable: null }
    }
    if (b.kind === 'unreadable') {
      return { ...base, kind: 'unreadable', entries: [], updated: b.head, savedFor: null, conflict: null, unreadable: { reason: b.reason, unfetched: b.unfetched, head: b.head } }
    }
    // `missing` cannot happen for a resolved environment; shown as unreadable to fail closed
    const head = headOf(book, state.heads[0] as string)
    return { ...base, kind: 'unreadable', entries: [], updated: head, savedFor: null, conflict: null, unreadable: { reason: '', unfetched: false, head } }
  })
  const hidden = book.resolution.hidden.length
  const ignored = ignoredCount(book)
  const notShared = viewer !== null && !viewerMaintainer && (hidden > 0 || cards.some((c) => c.kind === 'unreadable'))
  return { cards, hidden, ignored, empty: cards.length === 0 && hidden === 0 && ignored === 0, notShared, viewerMaintainer }
}

/**
 * The one-line warning about an ignored newer change (as `dg env ls|get|run` print it): "production
 * has a newer change by <author> at <time> (<id>), who isn't a maintainer now; it was ignored. Ask
 * a maintainer to check production's values." `author` is how the page names the identity.
 */
export function ignoredWarning(env: string, ignored: { readonly head: Head; readonly more: number }, author: string): string {
  const more = ignored.more > 0 ? ` (and ${ignored.more} more)` : ''
  return `${env} has a newer change by ${author} at ${utc(ignored.head.createdAt)} (${shortHead(ignored.head)})${more}, who isn't a maintainer now; it was ignored. Ask a maintainer to check ${env}'s values.`
}

/** The line for ignored changes (`dg env ls`'s "Ignored:" line): "2 changes by people who aren't maintainers now were ignored." */
export function ignoredLine(n: number): string {
  return `${count(n, 'change')} by people who aren't maintainers now ${n === 1 ? 'was' : 'were'} ignored.`
}

/** The count line for environments this reader cannot name: "2 environments" or, beside named ones, "1 more environment you can't read". */
export function hiddenLine(hidden: number, named: number): string {
  return named === 0 ? count(hidden, 'environment') : `${hidden} more ${hidden === 1 ? 'environment' : 'environments'} you can't read`
}

/**
 * One line of the removal checklist (DESIGN §10): "bob could read 2 dev values (and every past
 * value saved in the old format). Change them where they're used: A, B".
 */
export function exposureLine(member: string, e: Exposure): string {
  const n = e.names.length
  const past = e.oldFormat ? ' (and every past value saved in the old format)' : ''
  const change = n === 1 ? "Change it where it's used" : "Change them where they're used"
  return `${member} could read ${n} ${e.env} ${n === 1 ? 'value' : 'values'}${past}. ${change}: ${e.names.join(', ')}`
}

/** The removal dialog's line for environments the remover can't read (as `dg collab remove` says it). */
export function unreadableLine(member: string, n: number): string {
  return `You can't read ${count(n, 'environment')} here, so ${n === 1 ? "it isn't" : "they aren't"} listed. ${member} may have been able to read values there.`
}

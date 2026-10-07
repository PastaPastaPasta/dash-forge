/**
 * What Settings → Environments and the removal dialog show, from an {@link EnvBook}: one card per
 * environment this reader can name, the count of those it cannot, and the sentences (DESIGN §10;
 * `dg env ls`, `dg env get`'s warning and E608, `dg collab remove`'s checklist say the same).
 * Pure: the page renders it, vitest pins it. Values stay in the cards in memory only; the page
 * masks them.
 */

import type { Exposure } from './chain'
import { compareStrings as cmp, type Audience, type VarType } from './format'
import { currentOf, exposureFor, headOf, ignoredCount, ignoredNewerOf, shortHead, snapshotOf, unreadableCount, type EnvBook, type Head } from './loader'

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
  /** Maintainers: the recipients when it was saved (base58), the writer first; empty for Members. */
  readonly readers: readonly string[]
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

export interface EnvPageView {
  readonly cards: readonly EnvCardView[]
  /** Environments this reader cannot name (counted, never named). */
  readonly hidden: number
  /** Changes by people who aren't maintainers now, ignored. */
  readonly ignored: number
  /** The repository has no environment at all. */
  readonly empty: boolean
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

/** Every environment of `book` as the page shows it. */
export function environmentsView(book: EnvBook): EnvPageView {
  const cards = book.resolution.environments.map((state): EnvCardView => {
    const env = state.env
    const ignoredList = ignoredNewerOf(book, env)
    const last = ignoredList[ignoredList.length - 1]
    const ignored = last === undefined ? null : { head: last, more: ignoredList.length - 1 }
    // the newest readable version says who can read the environment
    const newest = [...state.heads].reverse().map((id) => snapshotOf(book, id)).find((s) => s !== null) ?? null
    const base = {
      env,
      audience: newest?.audience ?? null,
      readers: newest?.audience === 'maintainers' ? newest.to : [],
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
  return { cards, hidden, ignored: ignoredCount(book), empty: cards.length === 0 && hidden === 0 }
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

/** The count line for environments this reader cannot name: "2 environments" or, beside named ones, "1 more environment you can't read". */
export function hiddenLine(hidden: number, named: number): string {
  return named === 0 ? count(hidden, 'environment') : `${hidden} more ${hidden === 1 ? 'environment' : 'environments'} you can't read`
}

/** One line of the removal checklist (DESIGN §10): "bob could read 2 dev values (and every past value of it). Rotate them at their source: A, B". */
export function exposureLine(member: string, e: Exposure): string {
  const n = e.names.length
  const past = e.audience === 'members' ? ' (and every past value of it)' : ''
  const rotate = n === 1 ? 'Rotate it at its source' : 'Rotate them at their source'
  return `${member} could read ${n} ${e.env} ${n === 1 ? 'value' : 'values'}${past}. ${rotate}: ${e.names.join(', ')}`
}

/** What the removal dialog lists for `removed` ({@link exposureFor}), and the environments the remover can't read. */
export interface RemovalView {
  readonly exposures: readonly Exposure[]
  /** Environments the remover can't read: the member may have read values there. */
  readonly unreadable: number
}

export function removalView(book: EnvBook, removed: string, heldMembersKey: boolean): RemovalView {
  return { exposures: exposureFor(book, removed, heldMembersKey), unreadable: unreadableCount(book) }
}

/** The removal dialog's line for environments the remover can't read (as `dg collab remove` says it). */
export function unreadableLine(member: string, n: number): string {
  return `You can't read ${count(n, 'environment')} here, so ${n === 1 ? "it isn't" : "they aren't"} listed. ${member} may have been able to read values there.`
}

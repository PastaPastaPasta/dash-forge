/**
 * The owners and repositories this browser has seen, kept so a look-alike can be pointed out
 * (TS-24, `confusable.ts`): "Not to be confused with dashpay, which you starred."
 *
 * Kept in localStorage, never sent anywhere: a DPNS name or repo name with the identity or repo
 * it belongs to, and how the viewer knows it (visited, starred, followed). Nothing in it is
 * secret, but it is a browsing history, so it stays small and only names what the warning
 * needs. Pure functions over a list, plus a thin storage layer.
 */

import { looksLike } from './confusable'

/** How the viewer knows a name, weakest first. */
export type Acquaintance = 'visited' | 'starred' | 'followed'

const RANK: Readonly<Record<Acquaintance, number>> = { visited: 0, starred: 1, followed: 1 }

export interface KnownName {
  /** An owner's DPNS name, or a repository's name. */
  readonly kind: 'owner' | 'repo'
  readonly name: string
  /** The owner's identity id; for a repo, its owner's. */
  readonly identity: string
  /** A repo's document id. */
  readonly repoId?: string
  /** How a repo is named on the page: `dashpay/dash`. */
  readonly label?: string
  readonly how: Acquaintance
  readonly at: number
}

/** Kept at most: the oldest, weakest go first. */
export const KNOWN_MAX = 300

function sameThing(a: Pick<KnownName, 'kind' | 'identity' | 'repoId'>, b: Pick<KnownName, 'kind' | 'identity' | 'repoId'>): boolean {
  return a.kind === b.kind && (a.kind === 'owner' ? a.identity === b.identity : a.repoId === b.repoId)
}

/** `list` with `entry` recorded: a stronger acquaintance replaces a weaker one, never the reverse. */
export function remember(list: readonly KnownName[], entry: KnownName): KnownName[] {
  const old = list.find((k) => sameThing(k, entry))
  const how = old !== undefined && RANK[old.how] > RANK[entry.how] ? old.how : entry.how
  const label = entry.label ?? old?.label
  const next = [{ ...entry, how, ...(label === undefined ? {} : { label }) }, ...list.filter((k) => !sameThing(k, entry))]
  if (next.length <= KNOWN_MAX) return next
  // Drop visits before stars and follows, the oldest first.
  const order = [...next].sort((a, b) => RANK[a.how] - RANK[b.how] || a.at - b.at)
  const drop = new Set(order.slice(0, next.length - KNOWN_MAX))
  return next.filter((k) => !drop.has(k))
}

/**
 * The known name `name` could be mistaken for, when it belongs to something else: the
 * strongest acquaintance first, then the most recent.
 */
export function lookalikeOf(list: readonly KnownName[], subject: Pick<KnownName, 'kind' | 'name' | 'identity' | 'repoId'>): KnownName | null {
  const hits = list.filter((k) => k.kind === subject.kind && !sameThing(k, subject) && looksLike(subject.name, k.name))
  hits.sort((a, b) => RANK[b.how] - RANK[a.how] || b.at - a.at)
  return hits[0] ?? null
}

const KEY = 'forge.known-names'

/** What this browser keeps (`[]` without storage or on a corrupt value). */
export function readKnown(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): KnownName[] {
  try {
    const raw = storage?.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed.filter((k) => typeof k === 'object' && k !== null && typeof k.name === 'string' && typeof k.identity === 'string') as KnownName[]) : []
  } catch {
    return []
  }
}

/** Record `entry` in this browser. Storage that refuses (private mode, full) is not an error. */
export function rememberName(entry: KnownName, storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(remember(readKnown(storage), entry)))
  } catch {
    /* nothing kept */
  }
}

/**
 * The owners and repositories this browser has seen on one network, kept so a look-alike can be
 * pointed out (TS-24, `confusable.ts`): "Not to be confused with dashpay, which you starred."
 *
 * Kept in localStorage per network, never sent anywhere: a DPNS name or repo name with the
 * identity (and repo) it belongs to, and how the viewer knows it. A star or a follow is a choice
 * the viewer made, so a page that looks like one is warned against it. A visit is not: the
 * impostor's page may be the one visited first, so a look-alike of a visited name is only noted
 * as "another identity you've visited", both ways round. Unstarring or unfollowing makes the
 * entry a visit again. Pure functions over a list, plus a thin storage layer.
 */

import { comparable, looksLike } from './confusable'

/** How the viewer knows a name. */
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

/** What a page asks about: a name and whose it is. */
export type Subject = Pick<KnownName, 'kind' | 'name' | 'identity' | 'repoId' | 'label'> & {
  /** A repo that is not a fork: another owner's repo of the very same name is worth a note. */
  readonly sameNameCounts?: boolean
}

/** Kept at most: visits go before stars and follows, the oldest first. */
export const KNOWN_MAX = 300

function sameThing(a: Pick<KnownName, 'kind' | 'identity' | 'repoId'>, b: Pick<KnownName, 'kind' | 'identity' | 'repoId'>): boolean {
  return a.kind === b.kind && (a.kind === 'owner' ? a.identity === b.identity : a.repoId === b.repoId)
}

function bounded(list: KnownName[]): KnownName[] {
  if (list.length <= KNOWN_MAX) return list
  const order = [...list].sort((a, b) => RANK[a.how] - RANK[b.how] || a.at - b.at)
  const drop = new Set(order.slice(0, list.length - KNOWN_MAX))
  return list.filter((k) => !drop.has(k))
}

/**
 * `list` with `entries` recorded. A visit never weakens a star or follow; `unset` turns an entry
 * that was starred or followed (as `entry.how` says) back into a visit.
 */
export function remember(list: readonly KnownName[], entries: readonly KnownName[], unset = false): KnownName[] {
  let next = [...list]
  for (const entry of entries) {
    const old = next.find((k) => sameThing(k, entry))
    if (unset && old?.how !== entry.how) continue
    const how = unset ? 'visited' : old !== undefined && RANK[old.how] > RANK[entry.how] ? old.how : entry.how
    const label = entry.label ?? old?.label
    const { kind, name, identity, repoId, at } = entry
    next = [{ kind, name, identity, ...(repoId === undefined ? {} : { repoId }), ...(label === undefined ? {} : { label }), how, at }, ...next.filter((k) => !sameThing(k, entry))]
  }
  return bounded(next)
}

/**
 * The known name `subject` could be mistaken for, when it is someone else's: a starred or
 * followed one first, then the most recent. A repo of the same owner never counts.
 */
export function lookalikeOf(list: readonly KnownName[], subject: Subject): KnownName | null {
  const c = comparable(subject.name)
  const hits = list.filter((k) => k.kind === subject.kind && k.identity !== subject.identity && looksLike(c, k.name, subject.kind === 'repo' && subject.sameNameCounts === true))
  hits.sort((a, b) => RANK[b.how] - RANK[a.how] || b.at - a.at)
  return hits[0] ?? null
}

const HOWS: readonly string[] = ['visited', 'starred', 'followed']

function isKnownName(k: unknown): k is KnownName {
  if (typeof k !== 'object' || k === null) return false
  const r = k as Record<string, unknown>
  return (r['kind'] === 'owner' || r['kind'] === 'repo') && typeof r['name'] === 'string' && typeof r['identity'] === 'string' && HOWS.includes(r['how'] as string) && typeof r['at'] === 'number'
}

const keyOf = (network: string): string => `forge.known-names:${network}`

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** What this browser keeps for `network` (`[]` without storage or on a corrupt value). */
export function readKnown(network: string, storage: Storage | null = storageOrNull()): KnownName[] {
  try {
    const raw = storage?.getItem(keyOf(network))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isKnownName) : []
  } catch {
    return []
  }
}

/** Record `entries` (see {@link remember}) in one write. Storage that refuses is not an error. */
export function rememberNames(network: string, entries: readonly KnownName[], unset = false, storage: Storage | null = storageOrNull()): void {
  if (entries.length === 0) return
  try {
    storage?.setItem(keyOf(network), JSON.stringify(remember(readKnown(network, storage), entries, unset)))
  } catch {
    /* nothing kept */
  }
}

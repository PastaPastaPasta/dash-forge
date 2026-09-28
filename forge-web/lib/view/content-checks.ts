/**
 * Content-check ledger (view glue) — what the browse plane actually verified, per repo, this
 * session.
 *
 * The trust panel used to hard-code "packs verified". The checks it describes do happen, but
 * only when bytes are read: {@link BrowseReader} re-hashes every object against the git id it
 * was requested by, and the fallback clone sha256-checks each whole pack against its
 * manifest. This ledger records those outcomes where they happen so the panel can report
 * what was checked instead of what could be — including "nothing read yet" and a mismatch.
 *
 * Keyed by `repoKey` (the repo id) and kept for the session, the same lifetime as the browse caches
 * whose reads it counts. Subscribable for `useSyncExternalStore`: every update replaces the
 * repo's record, so a snapshot is a stable reference until something changes.
 */

import type { ObjectVerdict } from '../browse'
import { onPrivateSessionEnded } from '../repo/private-session'

/** Everything the browse plane checked (or could not check) for one repo. */
export interface ContentChecks {
  /** Objects re-hashed after reconstruction whose hash equalled the requested git id. */
  readonly objectsVerified: number
  /** Objects returned by a reader running with verification disabled. */
  readonly objectsUnchecked: number
  /** Objects whose reconstructed hash did not match — the read was refused. */
  readonly objectsFailed: number
  /** Whole packs whose sha256 matched their proof-read manifest (fallback clone). */
  readonly packsVerified: number
  /** Whole packs that failed their size / sha256 / object-count check. */
  readonly packsFailed: number
  /** Where bytes actually came from: `platform`, `browser cache`, or an external host. */
  readonly sources: readonly string[]
  /** Pack hash (hex, lowercase) → the places that served its bytes this session. */
  readonly packSources: Readonly<Record<string, readonly string[]>>
  /**
   * The packs the CURRENT view's objects came from (memo hits included), since {@link beginView}.
   * The summary names their places, not the session's first (L-18).
   */
  readonly viewPacks: readonly string[]
  /**
   * Live external packs (hash hex) the in-browser clone skipped because no mirror served
   * them. What is shown was checked, but it is not the whole repo: objects only those packs
   * hold are missing.
   */
  readonly unavailablePacks: readonly string[]
  /**
   * Of those, the packs some mirror answered with bytes that failed the sha256 check — a host
   * serving bad data, reported distinctly from an outage.
   */
  readonly corruptMirrorPacks: readonly string[]
  /**
   * Places that did not serve a pack, with why, as the card lists them
   * (`pub-9a1.r2.dev (timed out)`, `ipfs gateway ipfs.io (down: HTTP 429)`).
   */
  readonly unreachable: readonly string[]
}

export const NO_CONTENT_CHECKS: ContentChecks = {
  objectsVerified: 0,
  objectsUnchecked: 0,
  objectsFailed: 0,
  packsVerified: 0,
  packsFailed: 0,
  sources: [],
  packSources: {},
  viewPacks: [],
  unavailablePacks: [],
  corruptMirrorPacks: [],
  unreachable: [],
}

type Counter = Exclude<keyof ContentChecks, 'sources' | 'packSources' | 'viewPacks' | 'unavailablePacks' | 'corruptMirrorPacks' | 'unreachable'>

/**
 * A change to one repo's ledger: counter increments, a byte source seen (and the pack it served),
 * and/or a live pack that could not be fetched (hash hex).
 */
export type ContentCheckDelta = Partial<Record<Counter, number>> & {
  readonly source?: string
  /** With `source`: the pack (hash hex) whose bytes it served. */
  readonly pack?: string
  readonly unavailablePack?: string
  /** With `unavailablePack`: a mirror served bytes that failed the sha256 check. */
  readonly corruptMirror?: boolean
  /** Places that did not answer (see {@link ContentChecks.unreachable}). */
  readonly unreachable?: readonly string[]
}

const ledger = new Map<string, ContentChecks>()

// A private repo's entries are keyed `repoId#sessionId` and hold decrypted state: they go with
// the session, however it ends (lock, key change, retirement).
onPrivateSessionEnded((id) => {
  for (const m of [ledger]) for (const k of [...m.keys()]) if (k.endsWith(`#${id}`) || k.includes(`#${id}\0`)) m.delete(k)
})
const listeners = new Set<() => void>()

/** Record checks for a repo. No-op (no notification) when nothing would change. */
export function noteContentCheck(key: string, delta: ContentCheckDelta): void {
  const prev = ledger.get(key) ?? NO_CONTENT_CHECKS
  const newSource = delta.source !== undefined && !prev.sources.includes(delta.source)
  const pack = delta.source !== undefined ? delta.pack?.toLowerCase() : undefined
  const packPlaces = pack === undefined ? undefined : prev.packSources[pack] ?? []
  const newPackSource = pack !== undefined && delta.source !== undefined && !packPlaces?.includes(delta.source)
  const counters: Counter[] = [
    'objectsVerified',
    'objectsUnchecked',
    'objectsFailed',
    'packsVerified',
    'packsFailed',
  ]
  const bumped = counters.some((k) => (delta[k] ?? 0) > 0)
  const missing = delta.unavailablePack?.toLowerCase()
  const newMissing = missing !== undefined && !prev.unavailablePacks.includes(missing)
  const newCorrupt =
    missing !== undefined && delta.corruptMirror === true && !prev.corruptMirrorPacks.includes(missing)
  const newPlaces = (delta.unreachable ?? []).filter((p) => !prev.unreachable.includes(p))
  if (!newSource && !newPackSource && !bumped && !newMissing && !newCorrupt && newPlaces.length === 0) return

  const next: { -readonly [K in keyof ContentChecks]: ContentChecks[K] } = { ...prev }
  for (const k of counters) next[k] = prev[k] + Math.max(0, delta[k] ?? 0)
  if (newSource && delta.source !== undefined) next.sources = [...prev.sources, delta.source]
  if (newPackSource && pack !== undefined && delta.source !== undefined) {
    next.packSources = { ...prev.packSources, [pack]: [...(packPlaces ?? []), delta.source] }
  }
  if (newMissing) next.unavailablePacks = [...prev.unavailablePacks, missing]
  if (newCorrupt) next.corruptMirrorPacks = [...prev.corruptMirrorPacks, missing]
  if (newPlaces.length > 0) next.unreachable = [...prev.unreachable, ...newPlaces]
  ledger.set(key, next)
  for (const l of listeners) l()
}

/**
 * "Try again": forget the places that did not answer and the packs they held, so the card
 * reports what the retry finds rather than the last outage for the rest of the session.
 */
export function clearUnreachable(key: string): void {
  const prev = ledger.get(key)
  if (prev === undefined || (prev.unreachable.length === 0 && prev.unavailablePacks.length === 0)) return
  ledger.set(key, { ...prev, unreachable: [], unavailablePacks: [], corruptMirrorPacks: [] })
  for (const l of listeners) l()
}

/**
 * A new view of the repo starts (a route or its query changed): the objects it reads, and so the
 * places the summary names, are counted from here. The session's totals are kept.
 */
export function beginView(key: string): void {
  const prev = ledger.get(key)
  if (prev === undefined || prev.viewPacks.length === 0) return
  ledger.set(key, { ...prev, viewPacks: [] })
  for (const l of listeners) l()
}

/** The current view read an object from pack `packHash` (hex). No-op when already counted. */
export function noteViewPack(key: string, packHash: string): void {
  const pack = packHash.toLowerCase()
  const prev = ledger.get(key) ?? NO_CONTENT_CHECKS
  if (prev.viewPacks.includes(pack)) return
  ledger.set(key, { ...prev, viewPacks: [...prev.viewPacks, pack] })
  for (const l of listeners) l()
}

/** The places that served the current view's objects, in first-seen order (L-18). */
export function viewSources(checks: ContentChecks): string[] {
  return [...new Set(checks.viewPacks.flatMap((p) => checks.packSources[p] ?? []))]
}

/** The repo's ledger (a stable reference until the next change). */
export function contentChecks(key: string): ContentChecks {
  return ledger.get(key) ?? NO_CONTENT_CHECKS
}

/** Subscribe to ledger changes (any repo). Returns the unsubscribe function. */
export function subscribeContentChecks(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const VERDICT_COUNTER: Readonly<Record<ObjectVerdict, Counter>> = {
  verified: 'objectsVerified',
  unchecked: 'objectsUnchecked',
  failed: 'objectsFailed',
}

/** A {@link BrowseReader} `onObject` callback that records into this repo's ledger. */
export function objectObserver(key: string): (verdict: ObjectVerdict, count?: number) => void {
  return (verdict, count = 1) => noteContentCheck(key, { [VERDICT_COUNTER[verdict]]: count })
}

/** Test hook: forget every repo's ledger. */
export function resetContentChecks(): void {
  ledger.clear()
  for (const l of listeners) l()
}

/**
 * Name the place an external artifact URI serves bytes from, for the panel's source line —
 * the host, so a reader can see *which* gateway or bucket answered.
 */
export function externalSourceName(uri: string): string {
  try {
    const url = new URL(uri)
    return url.host !== '' ? url.host : url.protocol.replace(/:$/, '')
  } catch {
    return 'external'
  }
}

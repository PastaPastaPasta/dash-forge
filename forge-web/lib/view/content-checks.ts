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
 * Keyed by repo contract id and kept for the session, the same lifetime as the browse caches
 * whose reads it counts. Subscribable for `useSyncExternalStore`: every update replaces the
 * repo's record, so a snapshot is a stable reference until something changes.
 */

import type { ObjectVerdict } from '../browse'

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
}

export const NO_CONTENT_CHECKS: ContentChecks = {
  objectsVerified: 0,
  objectsUnchecked: 0,
  objectsFailed: 0,
  packsVerified: 0,
  packsFailed: 0,
  sources: [],
  unavailablePacks: [],
  corruptMirrorPacks: [],
}

type Counter = Exclude<keyof ContentChecks, 'sources' | 'unavailablePacks' | 'corruptMirrorPacks'>

/**
 * A change to one repo's ledger: counter increments, a byte source seen, and/or a live pack
 * that could not be fetched (hash hex).
 */
export type ContentCheckDelta = Partial<Record<Counter, number>> & {
  readonly source?: string
  readonly unavailablePack?: string
  /** With `unavailablePack`: a mirror served bytes that failed the sha256 check. */
  readonly corruptMirror?: boolean
}

const ledger = new Map<string, ContentChecks>()
const listeners = new Set<() => void>()

/** Record checks for a repo. No-op (no notification) when nothing would change. */
export function noteContentCheck(contractId: string, delta: ContentCheckDelta): void {
  const prev = ledger.get(contractId) ?? NO_CONTENT_CHECKS
  const newSource = delta.source !== undefined && !prev.sources.includes(delta.source)
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
  if (!newSource && !bumped && !newMissing && !newCorrupt) return

  const next: { -readonly [K in keyof ContentChecks]: ContentChecks[K] } = { ...prev }
  for (const k of counters) next[k] = prev[k] + Math.max(0, delta[k] ?? 0)
  if (newSource && delta.source !== undefined) next.sources = [...prev.sources, delta.source]
  if (newMissing) next.unavailablePacks = [...prev.unavailablePacks, missing]
  if (newCorrupt) next.corruptMirrorPacks = [...prev.corruptMirrorPacks, missing]
  ledger.set(contractId, next)
  for (const l of listeners) l()
}

/** The repo's ledger (a stable reference until the next change). */
export function contentChecks(contractId: string): ContentChecks {
  return ledger.get(contractId) ?? NO_CONTENT_CHECKS
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
export function objectObserver(contractId: string): (verdict: ObjectVerdict) => void {
  return (verdict) => noteContentCheck(contractId, { [VERDICT_COUNTER[verdict]]: 1 })
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

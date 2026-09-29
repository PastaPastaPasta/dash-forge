/**
 * The history index (`packManifest.kind == 3`) a browse context carries: which published
 * indexes count, and loading the one a listing needs (`docs/design/history-index.md`).
 *
 * The manifests come from the browse resolve's own pack-list read, so finding an index costs
 * no query. An index counts when its representative copy (members first, `packsOfKind`) is a
 * CURRENT member's and no member's manifest supersedes it: it is the pusher's claim, and a
 * former writer's or a stranger's claims do not stand. Parity: forge-core `plan_history_index`.
 */

import { ACTIVE_NETWORK, PACK_KIND } from '../constants'
import { packsOfKind, type PackManifest } from '../repo'
import { overlayHistory, parseHistoryIndex, type HistoryIndex } from '../browse/history-index'
import { loadIndexArtifact } from './index-cache'

/** A published history index, from its manifest alone. */
export interface HistoryEntry {
  readonly manifest: PackManifest
  readonly tip: string
  /** For a delta: the tip of the full index it extends. */
  readonly baseTip: string | null
}

/** The history indexes of a repository, and a loader for the one covering a tip. */
export interface HistorySource {
  /** Live indexes by tip (a full index and a delta of the same tip: the full one). */
  readonly byTip: ReadonlyMap<string, HistoryEntry>
  /** Whether an index covers `tip`. */
  covers(tip: string): boolean
  /** The index of `tip` (a delta overlaid on its base), downloaded once and cached. */
  load(tip: string): Promise<HistoryIndex>
}

/** The live history indexes among `manifests` (raw copies carrying `ownerRole`). */
export function liveHistoryIndexes(manifests: readonly PackManifest[]): HistoryEntry[] {
  const member = (m: PackManifest): boolean => m.ownerRole !== null && m.ownerRole !== undefined
  const superseded = new Set(manifests.filter(member).flatMap((m) => m.supersedes.map((h) => h.toLowerCase())))
  return packsOfKind(manifests, PACK_KIND.HISTORY_INDEX)
    .filter((p) => member(p) && !superseded.has(p.packHash.toLowerCase()))
    .flatMap((p) => {
      const [tip, baseTip] = p.tips
      return tip === undefined ? [] : [{ manifest: p, tip, baseTip: baseTip ?? null }]
    })
}

/**
 * A {@link HistorySource} over `manifests`, or null when the repository has published none.
 * `fetch` loads an artifact's verified bytes (the browse source's `loadArtifactBytes`).
 */
export function historySource(
  manifests: readonly PackManifest[],
  fetch: (m: PackManifest) => Promise<Uint8Array>,
): HistorySource | null {
  const live = liveHistoryIndexes(manifests)
  if (live.length === 0) return null
  const byTip = new Map<string, HistoryEntry>()
  // Oldest first, so a full index wins over a delta of the same tip, and the newest of two
  // full indexes of one tip wins.
  for (const e of live) {
    const had = byTip.get(e.tip)
    if (had === undefined || had.baseTip !== null) byTip.set(e.tip, e)
  }
  const fulls = new Map(live.filter((e) => e.baseTip === null).map((e) => [e.manifest.packHash.toLowerCase(), e]))
  const parsed = new Map<string, Promise<HistoryIndex>>()
  const read = (e: HistoryEntry): Promise<HistoryIndex> => {
    const key = e.manifest.packHash.toLowerCase()
    let p = parsed.get(key)
    if (p === undefined) {
      p = loadIndexArtifact(ACTIVE_NETWORK.key, key, () => fetch(e.manifest)).then(parseHistoryIndex)
      parsed.set(key, p)
      p.catch(() => parsed.delete(key))
    }
    return p
  }
  return {
    byTip,
    covers: (tip) => byTip.has(tip),
    async load(tip: string): Promise<HistoryIndex> {
      const e = byTip.get(tip)
      if (e === undefined) throw new Error(`no history index covers ${tip.slice(0, 12)}`)
      const ix = await read(e)
      if (ix.tip !== tip) throw new Error('the history index describes another tip than its manifest')
      if (ix.base === null) return ix
      const base = fulls.get(ix.base)
      if (base === undefined) throw new Error('the history index extends an index that is not live')
      const full = await read(base)
      if (full.base !== null || full.tip !== e.baseTip) throw new Error('the history index extends another tip')
      return overlayHistory(full, ix)
    },
  }
}

/** Every browse context's history source, by the reader's memo scope (one per resolve). */
const sources = new WeakMap<object, HistorySource | null>()

/** Attach the history source to a browse context's reader (its `memoScope`). */
export function attachHistory(scope: object, source: HistorySource | null): void {
  sources.set(scope, source)
}

/** The history source of the context a reader belongs to, or null. */
export function historyOf(reader: { readonly memoScope?: object }): HistorySource | null {
  return reader.memoScope === undefined ? null : (sources.get(reader.memoScope) ?? null)
}

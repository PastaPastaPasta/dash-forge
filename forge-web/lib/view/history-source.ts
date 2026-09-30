/**
 * The history index a browse context carries: which published indexes count, and loading the one
 * a view needs (`docs/design/history-index.md`).
 *
 * A push publishes two artifacts of a tip: the column index (`packManifest.kind == 3`, format 1:
 * each path's last change and the commit counts), which the file list, the ref bar's count and
 * the log total read, and the version lists (kind 5, format 2: the whole index), which only Blame
 * and a path's History read. Each kind is its own series of full indexes and deltas, so the file
 * list never downloads the lists.
 *
 * The manifests come from the browse resolve's own pack-list read, so finding an index costs
 * no query. An index counts when its representative copy (members first, `packsOfKind`) is a
 * CURRENT member's and no member's manifest supersedes it: it is the pusher's claim, and a
 * former writer's or a stranger's claims do not stand. Parity: forge-core `plan_history_index`.
 */

import { ACTIVE_NETWORK, PACK_KIND } from '../constants'
import { packsOfKind, type PackManifest } from '../repo'
import { overlayHistory, parseHistoryIndexOfKind, type HistoryIndex } from '../browse/history-index'
import { loadIndexArtifact } from './index-cache'

/** A published history index, from its manifest alone. */
export interface HistoryEntry {
  readonly manifest: PackManifest
  readonly tip: string
  /** For a delta: the tip of the full index it extends. */
  readonly baseTip: string | null
}

/** The history indexes of a repository, and loaders for the ones covering a tip. */
export interface HistorySource {
  /** Live column indexes by tip (a full index and a delta of the same tip: the full one). */
  readonly byTip: ReadonlyMap<string, HistoryEntry>
  /** Whether a column index covers `tip`. */
  covers(tip: string): boolean
  /** The column index of `tip` (a delta overlaid on its base), downloaded once and cached. */
  load(tip: string): Promise<HistoryIndex>
  /** Whether version lists cover `tip`. */
  coversVersions(tip: string): boolean
  /** The version lists of `tip` (the whole index, a delta overlaid on its base). */
  loadVersions(tip: string): Promise<HistoryIndex>
}

/** The live history indexes of `kind` (the column index by default) among `manifests`. */
export function liveHistoryIndexes(manifests: readonly PackManifest[], kind: number = PACK_KIND.HISTORY_INDEX): HistoryEntry[] {
  const member = (m: PackManifest): boolean => m.ownerRole !== null && m.ownerRole !== undefined
  const superseded = new Set(manifests.filter(member).flatMap((m) => m.supersedes.map((h) => h.toLowerCase())))
  return packsOfKind(manifests, kind)
    .filter((p) => member(p) && !superseded.has(p.packHash.toLowerCase()))
    .flatMap((p) => {
      const [tip, baseTip] = p.tips
      return tip === undefined ? [] : [{ manifest: p, tip, baseTip: baseTip ?? null }]
    })
}

/** One kind's live indexes by tip, and a loader of a tip's index. */
interface Series {
  readonly byTip: ReadonlyMap<string, HistoryEntry>
  load(tip: string): Promise<HistoryIndex>
}

/** The {@link Series} of `kind` among `manifests`, loading artifacts through `fetch`. */
function series(
  manifests: readonly PackManifest[],
  kind: number,
  fetch: (m: PackManifest) => Promise<Uint8Array>,
): Series {
  const live = liveHistoryIndexes(manifests, kind)
  const fulls = new Map(live.filter((e) => e.baseTip === null).map((e) => [e.manifest.packHash.toLowerCase(), e]))
  const fullTips = new Set([...fulls.values()].map((e) => e.tip))
  // A delta covers its tip only while a live full index of its base tip stands behind it
  // (forge-core `plan_history_index`). Per tip: a full index over a delta, then the newer of two
  // alike (`live` is in first-upload order, oldest first).
  const byTip = new Map<string, HistoryEntry>()
  for (const e of live) {
    if (e.baseTip !== null && !fullTips.has(e.baseTip)) continue
    const had = byTip.get(e.tip)
    if (had === undefined || e.baseTip === null || had.baseTip !== null) byTip.set(e.tip, e)
  }
  const parsed = new Map<string, Promise<HistoryIndex>>()
  const read = (e: HistoryEntry): Promise<HistoryIndex> => {
    const key = e.manifest.packHash.toLowerCase()
    let p = parsed.get(key)
    if (p === undefined) {
      p = loadIndexArtifact(ACTIVE_NETWORK.key, key, () => fetch(e.manifest)).then((bytes) => parseHistoryIndexOfKind(bytes, kind))
      parsed.set(key, p)
      p.catch(() => parsed.delete(key))
    }
    return p
  }
  return {
    byTip,
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

/**
 * A {@link HistorySource} over `manifests`, or null when the repository has published none.
 * `fetch` loads an artifact's verified bytes (the browse source's `loadArtifactBytes`).
 */
export function historySource(
  manifests: readonly PackManifest[],
  fetch: (m: PackManifest) => Promise<Uint8Array>,
): HistorySource | null {
  const columns = series(manifests, PACK_KIND.HISTORY_INDEX, fetch)
  const lists = series(manifests, PACK_KIND.HISTORY_VERSIONS, fetch)
  if (columns.byTip.size === 0 && lists.byTip.size === 0) return null
  return {
    byTip: columns.byTip,
    covers: (tip) => columns.byTip.has(tip),
    load: (tip) => columns.load(tip),
    coversVersions: (tip) => lists.byTip.has(tip),
    loadVersions: (tip) => lists.load(tip),
  }
}

/**
 * `own`'s indexes, then `inherited`'s for a tip `own` does not cover: a fork reads its parent's
 * (QW-023). An index describes a tip commit's history, which is the same in every repository
 * holding that commit, so a parent's index of a tip the fork shares is the fork's too.
 */
export function chainHistory(own: HistorySource | null, inherited: HistorySource | null): HistorySource | null {
  if (own === null) return inherited
  if (inherited === null) return own
  // Own first; the inherited index of the same tip when own's will not load.
  const first = (mine: boolean, theirs: boolean, a: () => Promise<HistoryIndex>, b: () => Promise<HistoryIndex>): Promise<HistoryIndex> =>
    mine ? a().catch((e: unknown) => (theirs ? b() : Promise.reject(e))) : b()
  return {
    byTip: new Map([...inherited.byTip, ...own.byTip]),
    covers: (tip) => own.covers(tip) || inherited.covers(tip),
    load: (tip) => first(own.covers(tip), inherited.covers(tip), () => own.load(tip), () => inherited.load(tip)),
    coversVersions: (tip) => own.coversVersions(tip) || inherited.coversVersions(tip),
    loadVersions: (tip) =>
      first(own.coversVersions(tip), inherited.coversVersions(tip), () => own.loadVersions(tip), () => inherited.loadVersions(tip)),
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

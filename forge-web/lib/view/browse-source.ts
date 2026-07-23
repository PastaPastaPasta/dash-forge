/**
 * Browse-plane data source (view glue) — turns Platform `chunk` documents / external URIs
 * into the ranged byte access {@link BrowseReader} + {@link ObjectLocator} need.
 *
 * An artifact (objectLocator, flatIndex, or git pack) is identified by its `packHash` and
 * stored either as on-platform `chunk` docs (`storage 0`, `d0..d2` byteArrays reassembled by
 * `seq`) or at external `uris` (`storage 1`, fetched with HTTP Range). This module reassembles
 * either into a {@link RangeFetch}, and builds a {@link PackSource} over a repo's git-pack
 * manifests so blob/tree/commit reconstruction works without materializing the repo.
 *
 * Availability is best-effort and honestly surfaced: a repo that never published browse
 * artifacts (no locator/flatIndex manifest) degrades to a clear "not indexed yet" state in
 * the UI rather than a hard failure.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { CHUNK_PAYLOAD_MAX, PACK_KIND } from '../constants'
import {
  BrowseReader,
  FlatIndex,
  ObjectLocator,
  type PackSource,
  type RangeFetch,
} from '../browse'
import {
  liveGitPackManifests,
  readPackManifests,
  type PackManifest,
  type RepoRef,
} from '../repo'
import { base64ToBytes, hexToBase64, queryDocumentsWithProof } from '../sdk'
import { DOC } from '../repo'

/** Concatenate the `d0..d2` byteArray fields (base64) of one chunk row, in order. */
function chunkPayload(doc: Record<string, unknown>): Uint8Array {
  const parts: Uint8Array[] = []
  for (const f of ['d0', 'd1', 'd2']) {
    const v = doc[f]
    if (typeof v === 'string' && v.length > 0) parts.push(base64ToBytes(v))
  }
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Chunk LRU — session cache of platform `chunk` payloads
// ---------------------------------------------------------------------------

/**
 * Chunks are content-addressed (`packHash` is the artifact's sha256) and immutable, so a
 * session-wide LRU is always safe. Entries hold the fetch PROMISE, so concurrent reads of
 * the same chunk dedupe to one query. Only resolved entries carry a size and count toward
 * the budget; rejected fetches are evicted so a retry re-queries. Map insertion order is
 * the recency order (touched entries are re-inserted).
 */
const CHUNK_CACHE_BUDGET_BYTES = 32 * 1024 * 1024
interface ChunkCacheEntry {
  promise: Promise<Uint8Array>
  /** Set once resolved; undefined while in flight. */
  size?: number
}
const chunkCache = new Map<string, ChunkCacheEntry>()
let chunkCacheBytes = 0

function chunkCacheGet(key: string): Promise<Uint8Array> | undefined {
  const entry = chunkCache.get(key)
  if (entry === undefined) return undefined
  // Touch: re-insert so Map order stays least-recently-used-first.
  chunkCache.delete(key)
  chunkCache.set(key, entry)
  return entry.promise
}

function chunkCacheSet(key: string, promise: Promise<Uint8Array>): void {
  const entry: ChunkCacheEntry = { promise }
  chunkCache.set(key, entry)
  promise
    .then((bytes) => {
      if (chunkCache.get(key) !== entry) return
      entry.size = bytes.length
      chunkCacheBytes += bytes.length
      evictChunks()
    })
    .catch(() => {
      if (chunkCache.get(key) === entry) chunkCache.delete(key)
    })
}

function evictChunks(): void {
  for (const [key, entry] of chunkCache) {
    if (chunkCacheBytes <= CHUNK_CACHE_BUDGET_BYTES) break
    if (entry.size === undefined) continue // in flight — a caller still awaits it
    chunkCache.delete(key)
    chunkCacheBytes -= entry.size
  }
}

/** Test hook: drop all cached chunks (and reset the byte budget). */
export function clearChunkCache(): void {
  chunkCache.clear()
  chunkCacheBytes = 0
}

/** Query one batch of chunk docs (uncached) and return payloads keyed by seq. */
async function queryChunkBatch(
  sdk: EvoSDK,
  contractId: string,
  packHashHex: string,
  seqs: readonly number[],
): Promise<Map<number, Uint8Array>> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: contractId,
    documentTypeName: DOC.chunk,
    where: [
      ['packHash', '==', hexToBase64(packHashHex)],
      ['seq', 'in', [...seqs]],
    ],
    orderBy: [
      ['packHash', 'asc'],
      ['seq', 'asc'],
    ],
    limit: 100,
  })
  const bySeq = new Map<number, Uint8Array>()
  for (const doc of documents) {
    const raw = doc['seq']
    const seq = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'number' ? raw : -1
    if (seq >= 0) bySeq.set(seq, chunkPayload(doc))
  }
  return bySeq
}

/**
 * Fetch a contiguous `[start, end)` range of a platform-stored artifact by `packHash` (hex).
 *
 * OFFSET→SEQ MAPPING (VERIFIED against forge-core `pack.rs::split`): the chunker fills every
 * field to `FIELD_MAX` and every chunk to `FIELDS_PER_DOC` full fields before starting the
 * next, so **every chunk except the last carries exactly `CHUNK_PAYLOAD_MAX` (= FIELD_MAX ×
 * FIELDS = 4900 × 3 = 14700) bytes**. Byte offset `n` therefore lives in `seq = ⌊n /
 * CHUNK_PAYLOAD_MAX⌋` at intra-chunk offset `n mod CHUNK_PAYLOAD_MAX`. The last chunk is
 * shorter, but a range never reads past the artifact's `sizeBytes`, so the last `seq` is
 * always resolved from the row actually returned (its real length), never assumed full.
 *
 * Chunk payloads are served through the session LRU: only the seqs absent from the cache
 * are queried (one batch — the `(packHash, seq)` index is unique per key, so no
 * `in`-starvation fallback is needed), and every fetched chunk is cached for later ranges.
 */
async function fetchPlatformRange(
  sdk: EvoSDK,
  contractId: string,
  packHashHex: string,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const firstSeq = Math.floor(start / CHUNK_PAYLOAD_MAX)
  const lastSeq = Math.floor((end - 1) / CHUNK_PAYLOAD_MAX)
  const seqs: number[] = []
  for (let s = firstSeq; s <= lastSeq; s++) seqs.push(s)

  const held = new Map<number, Promise<Uint8Array>>()
  const missing: number[] = []
  for (const seq of seqs) {
    const hit = chunkCacheGet(`${packHashHex}:${seq}`)
    if (hit !== undefined) held.set(seq, hit)
    else missing.push(seq)
  }
  if (missing.length > 0) {
    const batch = queryChunkBatch(sdk, contractId, packHashHex, missing)
    for (const seq of missing) {
      const promise = batch.then((bySeq) => {
        const payload = bySeq.get(seq)
        if (payload === undefined) {
          throw new Error(`missing chunk seq ${seq} for pack ${packHashHex.slice(0, 12)}`)
        }
        return payload
      })
      chunkCacheSet(`${packHashHex}:${seq}`, promise)
      held.set(seq, promise)
    }
  }

  const out = new Uint8Array(end - start)
  for (const seq of seqs) {
    const payload = await held.get(seq)!
    const chunkStart = seq * CHUNK_PAYLOAD_MAX
    const from = Math.max(start, chunkStart) - chunkStart
    const to = Math.min(end, chunkStart + payload.length) - chunkStart
    if (to > from) out.set(payload.subarray(from, to), chunkStart + from - start)
  }
  return out
}

/** Fetch a contiguous range of an external artifact via HTTP Range. */
async function fetchExternalRange(
  uris: readonly string[],
  start: number,
  end: number,
): Promise<Uint8Array> {
  let lastErr: unknown
  for (const uri of uris) {
    try {
      const resp = await fetch(uri, { headers: { Range: `bytes=${start}-${end - 1}` } })
      if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`)
      const buf = new Uint8Array(await resp.arrayBuffer())
      // Some hosts ignore Range and return the whole body — slice defensively.
      return buf.length > end - start ? buf.subarray(start, end) : buf
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`no external URI served the range: ${String(lastErr)}`)
}

/** A {@link RangeFetch} over one artifact (platform chunks or external URIs). */
export function artifactRangeFetch(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
): RangeFetch {
  return (start: number, end: number) =>
    manifest.storage === 0
      ? fetchPlatformRange(sdk, repo.contractId, manifest.packHash, start, end)
      : fetchExternalRange(manifest.uris, start, end)
}

/** Load a whole artifact's bytes (small artifacts: locator ~101 KB, flatIndex). */
export async function loadArtifactBytes(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
): Promise<Uint8Array> {
  if (manifest.sizeBytes <= 0) return new Uint8Array(0)
  const fetchRange = artifactRangeFetch(sdk, repo, manifest)
  return fetchRange(0, manifest.sizeBytes)
}

/**
 * Max bytes per windowed whole-artifact fetch: `fetchPlatformRange` queries with
 * `limit: 100`, so one call can cover at most 100 chunk documents.
 */
const DOWNLOAD_WINDOW = 100 * CHUNK_PAYLOAD_MAX

/**
 * Load a whole artifact with download progress — the fallback-clone path for full git
 * packs, which can exceed the single-query chunk window. Platform storage downloads in
 * `DOWNLOAD_WINDOW` strides; external storage fetches the body whole (progress reported
 * only at completion).
 */
export async function loadArtifactBytesProgress(
  sdk: EvoSDK,
  repo: RepoRef,
  manifest: PackManifest,
  onProgress?: (bytesFetched: number, bytesTotal: number) => void,
): Promise<Uint8Array> {
  const total = manifest.sizeBytes
  if (total <= 0) return new Uint8Array(0)
  onProgress?.(0, total)
  if (manifest.storage !== 0) {
    const bytes = await fetchExternalRange(manifest.uris, 0, total)
    if (bytes.length !== total) throw new Error('external artifact length mismatch')
    onProgress?.(total, total)
    return bytes
  }
  const out = new Uint8Array(total)
  for (let at = 0; at < total; at += DOWNLOAD_WINDOW) {
    const end = Math.min(at + DOWNLOAD_WINDOW, total)
    out.set(await fetchPlatformRange(sdk, repo.contractId, manifest.packHash, at, end), at)
    onProgress?.(end, total)
  }
  return out
}

/**
 * Order git-pack manifests into the canonical `packRef` space.
 *
 * PACKREF ORDERING (VERIFIED / corrected): the objectLocator's `packRef` is "an index into
 * the manifest's pack list" (forge-core `pack/locator.rs`), but no explicit pack list is
 * stored on-chain — so reader and writer must share a *deterministic* ordering of the kind-0
 * pack manifests. The platform total order is `($createdAt, $id)` (data-contracts §2.3, §4),
 * so packs are sorted **oldest-first by `($createdAt, documentId)`** — NOT by reversing the
 * `$createdAt desc` query result, which drops the `$id` tiebreak on equal timestamps and is
 * wrong past one page. When the owning locator's publish time is known, the list is bounded to
 * packs that existed at/before it (`createdAt <= asOf`): a locator only indexes packs present
 * when it was built, and later incremental packs are outside its `packRef` space.
 */
export function orderGitPacks(
  gitPacks: readonly PackManifest[],
  asOf?: number,
): PackManifest[] {
  const bounded = asOf === undefined ? [...gitPacks] : gitPacks.filter((m) => m.createdAt <= asOf)
  return bounded.sort((a, b) =>
    a.createdAt !== b.createdAt
      ? a.createdAt - b.createdAt
      : a.documentId < b.documentId
        ? -1
        : a.documentId > b.documentId
          ? 1
          : 0,
  )
}

/**
 * A {@link PackSource} over a repo's git-pack manifests (kind 0), indexed by `packRef` = the
 * pack's position in oldest-first `($createdAt, $id)` order (see {@link orderGitPacks}).
 * `asOf` bounds the pack list to those published at/before the owning locator's `$createdAt`.
 */
export function buildPackSource(
  sdk: EvoSDK,
  repo: RepoRef,
  gitPacks: readonly PackManifest[],
  asOf?: number,
): PackSource {
  const ordered = orderGitPacks(gitPacks, asOf)
  return {
    async fetchRange(packRef: number, start: number, end: number): Promise<Uint8Array> {
      const manifest = ordered[packRef]
      if (!manifest) throw new Error(`packRef ${packRef} out of range (${ordered.length} packs)`)
      return artifactRangeFetch(sdk, repo, manifest)(start, end)
    },
  }
}

/** The assembled browse context for a repo, or a reason it is unavailable. */
export interface BrowseContext {
  readonly locator: ObjectLocator
  readonly packs: PackSource
  readonly reader: BrowseReader
}

/**
 * Load the newest flatIndex artifact (full recursive tree listing), or `null` if the repo
 * has not published one. Used by deep tree-browse and filename search — never the cold home.
 */
export async function loadFlatIndex(sdk: EvoSDK, repo: RepoRef): Promise<FlatIndex | null> {
  const manifests = await readPackManifests(sdk, repo, 100)
  const flatManifest = manifests.find((m) => m.kind === PACK_KIND.FLAT_INDEX)
  if (!flatManifest) return null
  const bytes = await loadArtifactBytes(sdk, repo, flatManifest)
  return FlatIndex.parse(bytes)
}

/**
 * Discriminated browse availability:
 *  - `ready` — a published locator exists; the normal browse plane serves reads.
 *  - `unindexed` — no locator, but live kind-0 packs exist: the fallback clone can
 *    download + index them in-browser (`livePacks` / `totalSizeBytes` feed that UI).
 *  - `no-packs` — nothing stored to browse at all.
 */
export type BrowseState =
  | { readonly kind: 'ready'; readonly context: BrowseContext }
  | {
      readonly kind: 'unindexed'
      readonly livePacks: PackManifest[]
      readonly totalSizeBytes: number
    }
  | { readonly kind: 'no-packs' }

/**
 * Assemble a repo's browse availability: newest objectLocator + a pack source over its git
 * packs when indexed, or the live pack set the fallback clone would need when not.
 */
export async function loadBrowseContext(sdk: EvoSDK, repo: RepoRef): Promise<BrowseState> {
  const manifests = await readPackManifests(sdk, repo, 100)
  const locatorManifest = manifests.find((m) => m.kind === PACK_KIND.OBJECT_LOCATOR)
  if (!locatorManifest) {
    const livePacks = orderGitPacks(liveGitPackManifests(manifests))
    if (livePacks.length === 0) return { kind: 'no-packs' }
    const totalSizeBytes = livePacks.reduce((s, m) => s + m.sizeBytes, 0)
    return { kind: 'unindexed', livePacks, totalSizeBytes }
  }
  const gitPacks = manifests.filter((m) => m.kind === PACK_KIND.GIT_PACK)
  const locatorBytes = await loadArtifactBytes(sdk, repo, locatorManifest)
  const locator = ObjectLocator.parse(locatorBytes)
  // Bound the packRef space to packs that existed when this locator was published.
  const packs = buildPackSource(sdk, repo, gitPacks, locatorManifest.createdAt)
  const reader = new BrowseReader(locator, packs)
  return { kind: 'ready', context: { locator, packs, reader } }
}

// ---------------------------------------------------------------------------
// Browse-context session cache
// ---------------------------------------------------------------------------

/**
 * One browse context per contract for the session (the locator-path analog of the
 * fallback-clone cache in `browse-fallback.ts`) — navigating between a repo's pages must
 * not re-fetch manifests, re-download the locator, or discard the reader's warm state.
 *
 * A `ready` state (locator published — content-addressed, effectively immutable) lives
 * {@link BROWSE_READY_TTL_MS}; `unindexed` / `no-packs` live only {@link BROWSE_RETRY_TTL_MS}
 * so a locator or first pack published out-of-band (CLI / relay — the web UI never
 * publishes packs) is noticed quickly. Rejected loads are evicted so a retry starts clean.
 */
const BROWSE_READY_TTL_MS = 5 * 60_000
const BROWSE_RETRY_TTL_MS = 60_000

interface BrowseCacheEntry {
  at: number
  promise: Promise<BrowseState>
  settled?: BrowseState
}
const browseCache = new Map<string, BrowseCacheEntry>()

function browseEntryLive(entry: BrowseCacheEntry): boolean {
  const ttl =
    entry.settled === undefined || entry.settled.kind === 'ready'
      ? BROWSE_READY_TTL_MS
      : BROWSE_RETRY_TTL_MS
  return Date.now() - entry.at < ttl
}

/** Drop a repo's cached browse context (e.g. on an explicit home reload). */
export function invalidateBrowseContext(contractId: string): void {
  browseCache.delete(contractId)
}

/** The cached settled browse state for a contract, if still live — for first-paint seeding. */
export function peekBrowseState(contractId: string): BrowseState | undefined {
  const entry = browseCache.get(contractId)
  if (entry === undefined || !browseEntryLive(entry)) return undefined
  return entry.settled
}

/** {@link loadBrowseContext} through the session cache (in-flight loads are joined). */
export function loadBrowseContextCached(sdk: EvoSDK, repo: RepoRef): Promise<BrowseState> {
  const hit = browseCache.get(repo.contractId)
  if (hit !== undefined && browseEntryLive(hit)) return hit.promise
  const entry: BrowseCacheEntry = { at: Date.now(), promise: loadBrowseContext(sdk, repo) }
  browseCache.set(repo.contractId, entry)
  entry.promise
    .then((state) => {
      entry.settled = state
    })
    .catch(() => {
      if (browseCache.get(repo.contractId) === entry) browseCache.delete(repo.contractId)
    })
  return entry.promise
}

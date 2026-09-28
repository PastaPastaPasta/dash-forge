/**
 * evo-sdk query helpers — the browser read path.
 *
 * Wraps `sdk.documents.query` / `queryWithProof` with the two Platform facts that make or
 * break correctness on an active repo (verified in S0.8):
 *
 *  1. **byteArray where-operands must be base64 strings** (NOT Uint8Array, NOT base58 —
 *     base58 is for identifiers only). Every `refNameHash` / `packHash` / oid tip query
 *     encodes its operand with {@link bytesToBase64} / {@link hexToBase64}; results also
 *     come back base64. This is load-bearing — a raw-bytes operand silently returns nothing.
 *  2. **`in`-batches do NOT round-robin** — a single global `limit` is drawn in
 *     orderBy-traversal order, so one hot key starves all siblings (measured 9/9 starved).
 *     So a multi-key read is done per key, in parallel, not as one `in` batch.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

// ---------------------------------------------------------------------------
// byteArray operand encoding (S0.8 — WASM needs base64)
// ---------------------------------------------------------------------------

/**
 * Encode raw bytes as a standard base64 string — the required wasm byteArray operand form.
 * Built 32 KiB at a time: a string grown one character per byte is slow on a multi-MiB image.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)))
  return btoa(parts.join(''))
}

/** Decode a base64 string (a query result operand) back to raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Encode a hex string (e.g. a refNameHash / oid) as the base64 operand a wasm query needs. */
export function hexToBase64(hex: string): string {
  return bytesToBase64(hexToBytes(hex))
}

/** Decode a base64 operand/result back to a lowercase hex string. */
export function base64ToHex(b64: string): string {
  return bytesToHex(base64ToBytes(b64))
}

// ---------------------------------------------------------------------------
// Query shape (tuple form, matching the wasm-sdk / yappr convention)
// ---------------------------------------------------------------------------

/** A `where` comparison operator accepted by the document query engine. */
export type WhereOperator =
  | '=='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'in'
  | 'startsWith'
  | 'contains'

/** A single `where` clause: `[field, operator, value]`. */
export type WhereClause = readonly [field: string, operator: WhereOperator, value: unknown]

/** A single `orderBy` clause: `[field, direction]`. Stored indexes are asc-only; */
/** `desc` is query-time reverse traversal of an index. */
export type OrderByClause = readonly [field: string, direction: 'asc' | 'desc']

/** A raw document query. `byteArray` operands in `where` must already be base64 (see above). */
export interface DocumentQuery {
  readonly dataContractId: string
  readonly documentTypeName: string
  readonly where?: readonly WhereClause[]
  readonly orderBy?: readonly OrderByClause[]
  readonly limit?: number
  /** A document `$id` (base58) to page after. */
  readonly startAfter?: string
  readonly startAt?: string
}

/** A normalized document: system fields ($id/$ownerId base58, $createdAt number) + content. */
export type PlainDocument = Record<string, unknown>

// The SDK exposes two document serializers with DIFFERENT field encodings:
//   - `toObject()` → identifiers as raw `Uint8Array`, integers as `bigint`, byteArrays as
//     `Uint8Array`.
//   - `toJSON(platformVersion)` → identifiers as base58 strings, integers as JS numbers,
//     byteArrays as base64 strings.
// The whole forge-web read layer is written against the `toJSON` shape (`str()` expects base58,
// `num()` expects number, `byteFieldToHex`/skip-scan expect base64) — so normalization uses
// `toJSON`. A `platformVersion` is required; the service pins it from `sdk.version()` on connect
// (the value only selects DPP's serialization rules, which are stable for our field types).
let platformVersion = 1

/** Pin the DPP platform version used by {@link normalizeDocument}'s `toJSON`. */
export function setPlatformVersion(version: number): void {
  if (Number.isInteger(version) && version > 0) platformVersion = version
}

/**
 * Follow the version the SDK learned from its latest proved response. The service seeds its
 * contracts without a request, so the first page query, not the connect, is where evo-sdk
 * learns the network's version.
 */
export function followSdkVersion(sdk: EvoSDK): void {
  try {
    setPlatformVersion(sdk.version())
  } catch {
    // Keep the pinned version if the SDK cannot report one.
  }
}

interface DocumentLike {
  toJSON?: (platformVersion: number) => unknown
  toObject?: () => unknown
}

/** Normalize a wasm Document (or already-plain object) to a JSON-friendly record. */
export function normalizeDocument(doc: unknown): PlainDocument {
  const d = doc as DocumentLike
  let raw: unknown = doc
  if (typeof d.toJSON === 'function') raw = d.toJSON(platformVersion)
  else if (typeof d.toObject === 'function') raw = d.toObject()
  if (raw === null || typeof raw !== 'object') return {}
  return raw as PlainDocument
}

function mapToDocuments(response: Map<string, unknown> | unknown): PlainDocument[] {
  const out: PlainDocument[] = []
  if (response instanceof Map) {
    for (const v of response.values()) {
      if (v != null) out.push(normalizeDocument(v))
    }
  }
  return out
}

// The evo-sdk document facade param/return types resolve loosely (wasm-bindgen d.ts); we
// narrow through these local shapes rather than leaking `any` into call sites.
interface DocumentsFacadeLike {
  query: (q: DocumentQuery) => Promise<Map<string, unknown>>
  count: (q: DocumentQuery) => Promise<Map<string, bigint>>
  ranked: (q: unknown) => Promise<{
    startingRank: bigint
    entries: ReadonlyArray<{ groupKeyHex: string; groupValue: unknown; value: bigint; rank: bigint }>
  }>
}
interface SdkLike {
  documents: DocumentsFacadeLike
}

function documentsOf(sdk: EvoSDK): DocumentsFacadeLike {
  return (sdk as unknown as SdkLike).documents
}

/** A proof-carrying read result: the documents plus whatever proof metadata the SDK returned. */
export interface ProofedDocuments {
  readonly documents: PlainDocument[]
  readonly proofMetadata: unknown
}

/**
 * Called when a read names a document type its contract does not have: a seeded contract may
 * be older than the network's. Resolves true when the contract was refreshed and the read may
 * be retried once. Set by the SDK service.
 */
type StaleContractHandler = (contractId: string) => Promise<boolean>
let staleContractHandler: StaleContractHandler | null = null

/** Install (or clear) the handler for reads against a possibly stale seeded contract. */
export function setStaleContractHandler(handler: StaleContractHandler | null): void {
  staleContractHandler = handler
}

function isUnknownDocumentType(e: unknown): boolean {
  let message = ''
  try {
    message = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)
  } catch {
    return false
  }
  return /document type not found/i.test(message)
}

/** Raw query (no proof). Prefer {@link queryDocumentsWithProof} for trust-minimized reads. */
export async function queryDocuments(sdk: EvoSDK, query: DocumentQuery): Promise<PlainDocument[]> {
  let response: Map<string, unknown>
  try {
    response = await documentsOf(sdk).query(query)
  } catch (e) {
    if (!isUnknownDocumentType(e) || !(await staleContractHandler?.(query.dataContractId))) throw e
    response = await documentsOf(sdk).query(query)
  }
  followSdkVersion(sdk)
  return mapToDocuments(response)
}

/**
 * Proof-verified query — the default forge-web read path.
 *
 * BROWSER-BUG FIX (found by the Playwright suite, invisible to node/jsdom): the explicit
 * `documents.queryWithProof(...)` facade in evo-sdk 4.0.0 **rejects in a real browser with a
 * wasm-bindgen object** (carries `__wbg_ptr`, not a JS `Error`), breaking every live read.
 * Per S0.3 the connection is `testnetTrusted()`/`mainnetTrusted()`, and a **trusted** connect
 * prefetches the quorum keys and **proof-verifies every plain `.query()` internally** — so the
 * explicit `*WithProof` variant is both redundant and buggy in-browser. This delegates to the
 * plain `.query()` (still trust-minimized, proofs on), which returns cleanly in the browser.
 * The `proofMetadata` field is retained for API compatibility (it was never consumed).
 */
export async function queryDocumentsWithProof(
  sdk: EvoSDK,
  query: DocumentQuery,
): Promise<ProofedDocuments> {
  return { documents: await queryDocuments(sdk, query), proofMetadata: null }
}

/**
 * Provable O(1) count over a countable index (`forge-v2.md` §2). Sums the grouped result
 * the SDK returns for `documents.count`. Use for star / follower / issue-total surfaces.
 */
export async function countDocuments(sdk: EvoSDK, query: DocumentQuery): Promise<number> {
  const grouped = await documentsOf(sdk).count(query)
  let total = 0n
  if (grouped instanceof Map) {
    for (const v of grouped.values()) total += v
  }
  const n = Number(total)
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER
}

/** A ranked (top-K) read: `documents.ranked` over a `rankedCountable` index (protocol 14). */
export interface RankedQuery {
  readonly dataContractId: string
  readonly documentTypeName: string
  /** The index's last property: the groups ranked. */
  readonly groupBy: string
  /** 1..100 (a hard ceiling the proof re-checks). */
  readonly limit: number
  /** A bucketed index's window: `oldest` (a near-full trailing range) or `newest`. */
  readonly timeRange?: { readonly field: string; readonly selector: 'newest' | 'oldest' }
}

/** One ranked group: its key (the group value's index encoding, hex), its value and count. */
export interface RankedEntry {
  /** The group's value as the query returns it (a base58 identifier for an id group). */
  readonly group: string
  /** The group key's raw index bytes, hex (a 32-byte id for an identifier group). */
  readonly keyHex: string
  readonly count: number
  /** 0-based rank. */
  readonly rank: number
}

export interface RankedPage {
  readonly entries: readonly RankedEntry[]
}

/**
 * The top groups of a ranked count index, highest first, proved (the verifier re-derives the
 * window of a `timeRange` selection from the quorum-signed time). Equal counts come back by
 * group key descending.
 */
export async function rankedDocuments(sdk: EvoSDK, query: RankedQuery): Promise<RankedPage> {
  const res = await documentsOf(sdk).ranked({
    dataContractId: query.dataContractId,
    documentTypeName: query.documentTypeName,
    groupBy: query.groupBy,
    aggregate: { type: 'count' },
    limit: query.limit,
    direction: 'desc',
    ...(query.timeRange ? { timeRange: [{ field: query.timeRange.field, selector: query.timeRange.selector }] } : {}),
  })
  return {
    entries: res.entries.map((e) => ({
      group: typeof e.groupValue === 'string' ? e.groupValue : String(e.groupValue ?? ''),
      keyHex: e.groupKeyHex,
      count: Number(e.value),
      rank: Number(e.rank),
    })),
  }
}

/**
 * The all-ascending `orderBy` whose traversal, reversed, is exactly `query`'s — or null when
 * the order is already ascending or has no such equivalent. Parity: forge-core
 * `platform::ascending_equivalent`.
 *
 * A complete read pages with a `startAfter` cursor. The grovedb verifier in evo-sdk 4.2 checks
 * that every proof op matches the walk direction. Protocol-13 nodes answered a
 * descending page after a cursor with a proof that fails that check. It surfaced as
 * `packManifest` reads failing once a repo passed 100 manifests. Ascending pages verify, and
 * Drive's descending walk is the exact reverse of its ascending walk. Reversing also
 * reverses any clause that was already ascending, which is only harmless when an `==` filter
 * pins that clause's field, so any other mixed order is left as requested.
 */
export function ascendingEquivalent(query: DocumentQuery): OrderByClause[] | null {
  const orderBy = query.orderBy ?? []
  if (orderBy.every(([, direction]) => direction === 'asc')) return null
  const pinned = (field: string): boolean =>
    (query.where ?? []).some(([f, op]) => f === field && op === '==')
  if (orderBy.some(([field, direction]) => direction === 'asc' && !pinned(field))) return null
  return orderBy.map(([field]) => [field, 'asc'] as const)
}

/** Thrown when a read that must be complete could not be proven complete. */
export class IncompleteReadError extends Error {
  constructor(
    readonly documentTypeName: string,
    readonly fetched: number,
    reason: string,
  ) {
    super(`incomplete read of ${documentTypeName} after ${fetched} documents: ${reason}`)
    this.name = 'IncompleteReadError'
  }
}

/**
 * Page a query to exhaustion (the `query_all` pattern — parity with forge-core
 * `platform::query_all_documents`). Repeats the proof-verified query, advancing `startAfter`
 * past the last `$id` of each page, until a **short page** proves the end was reached. Used by
 * every read that MUST be complete: the deterministic folds (`resolve_ref`, `foldIssueStateV2`,
 * `foldPrStateV2`) are folds over a whole history, so a silently truncated input does not
 * degrade the answer — it produces a confidently wrong one (a closed issue that reads open,
 * a branch pinned at its 100th push).
 *
 * **A short page is the only accepted proof of completeness.** If the cursor cannot advance
 * (a row without a string `$id`) or the `maxPages` safety cap is hit, this THROWS
 * {@link IncompleteReadError} rather than returning what it has: a caller folding a partial
 * history cannot tell the difference between "no more events" and "I stopped early", and the
 * whole point of the rules layer is that every client resolves identically. Callers that
 * genuinely want a bounded window should use {@link queryDocumentsWithProof} with a `limit`
 * and present it as a window.
 *
 * `pageLimit` bounds each round-trip; `maxPages` is a hard safety cap on total rounds.
 */
/**
 * Whether a complete read can make its page boundaries tie-safe. Parity: forge-core
 * `platform::tie_probe_allowed`. The conditions: the order ends in `$createdAt` ascending,
 * every earlier order field is pinned by an `==` filter, and every filter is an `==` on some
 * other field. The index then ends in `$createdAt`, so an equality on the boundary timestamp
 * is a valid query on the same index.
 *
 * Why: on protocol 13, a `startAfter` cursor excludes the cursor's whole `$createdAt` key.
 * Documents created in the same block as a page's last row that sort after it would be
 * silently skipped. Protocol 14 bounds the cursor by document id and does not drop them.
 *
 * forge-v2 runs on protocol 14, so this is a safety net there, kept for parity with forge-core.
 * It needs the boundary row's `$createdAt`, which every forge-v2 history type requires.
 */
export function tieProbeAllowed(query: DocumentQuery): boolean {
  const orderBy = query.orderBy ?? []
  const last = orderBy[orderBy.length - 1]
  if (last === undefined || last[0] !== '$createdAt' || last[1] !== 'asc') return false
  const where = query.where ?? []
  const pinned = (field: string): boolean => where.some(([f, op]) => f === field && op === '==')
  return (
    orderBy.slice(0, -1).every(([field, direction]) => direction === 'asc' && pinned(field)) &&
    where.every(([field, op]) => op === '==' && field !== '$createdAt')
  )
}

export async function queryAllDocuments(
  sdk: EvoSDK,
  query: DocumentQuery,
  opts: {
    readonly pageLimit?: number
    readonly maxPages?: number
    /**
     * The query's first page, already read elsewhere (a composite's sibling sub-query with
     * the same query and a `pageLimit` limit): a short one is the whole answer, a full one is
     * continued from its last row instead of being read again. Ascending queries only.
     */
    readonly firstPage?: readonly PlainDocument[]
  } = {},
): Promise<PlainDocument[]> {
  const pageLimit = opts.pageLimit ?? 100
  const maxPages = opts.maxPages ?? 1000
  // Page a descending read ascending and reverse it — see `ascendingEquivalent`.
  const ascending = ascendingEquivalent(query)
  if (opts.firstPage !== undefined && ascending !== null) throw new Error('firstPage continues an ascending query only')
  const paged = ascending === null ? query : { ...query, orderBy: ascending }
  const tieSafe = tieProbeAllowed(paged)
  const out: PlainDocument[] = []
  const held = new Set<string>()
  const take = (rows: PlainDocument[]): void => {
    for (const d of rows) {
      const id = d['$id']
      if (typeof id === 'string') {
        if (held.has(id)) continue
        held.add(id)
      }
      out.push(d)
    }
  }
  const done = (): PlainDocument[] => (ascending === null ? out : out.reverse())
  let startAfter: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const documents =
      page === 0 && opts.firstPage !== undefined
        ? [...opts.firstPage]
        : (await queryDocumentsWithProof(sdk, { ...paged, limit: pageLimit, startAfter })).documents
    take(documents)
    if (documents.length < pageLimit) return done()
    const last = documents[documents.length - 1]
    const lastId = last?.['$id']
    if (typeof lastId !== 'string') {
      throw new IncompleteReadError(
        query.documentTypeName,
        out.length,
        'a full page ended on a document with no $id, so the cursor cannot advance',
      )
    }
    let cursor: string = lastId
    // Same-block rows past the boundary: read the boundary timestamp in full (see
    // `tieProbeAllowed`), then continue after the last of them.
    const createdAt = last?.['$createdAt']
    if (tieSafe && typeof createdAt === 'number') {
      const { documents: tied } = await queryDocumentsWithProof(sdk, {
        ...paged,
        where: [...(paged.where ?? []), ['$createdAt', '==', createdAt]],
        limit: pageLimit,
      })
      if (tied.length >= pageLimit) {
        throw new IncompleteReadError(
          query.documentTypeName,
          out.length,
          `${pageLimit} or more documents share $createdAt ${createdAt}; the page boundary tie cannot be read completely`,
        )
      }
      const lastTied = tied[tied.length - 1]?.['$id']
      if (typeof lastTied === 'string') cursor = lastTied
      take(tied)
    }
    startAfter = cursor
  }
  throw new IncompleteReadError(
    query.documentTypeName,
    out.length,
    `the ${maxPages}-page safety cap was reached before a short page proved the end`,
  )
}

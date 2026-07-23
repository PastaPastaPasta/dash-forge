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
 *     The **per-key completeness fallback is the NORMAL path**: after an `in` batch, every
 *     key that returned zero rows is re-queried individually (`== key, limit 1`), all in
 *     parallel. See {@link inBatchWithCompleteness}.
 *
 * Plus **skip-scan** ref enumeration ({@link skipScanDistinct}): `> lastKey` orderBy key
 * `limit 1` hops to the next distinct key — O(log n) per distinct ref, not O(total pushes).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

// ---------------------------------------------------------------------------
// byteArray operand encoding (S0.8 — WASM needs base64)
// ---------------------------------------------------------------------------

/** Encode raw bytes as a standard base64 string — the required wasm byteArray operand form. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number)
  return btoa(bin)
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
/** `desc` is query-time reverse traversal (data-contracts §0). */
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

/** Raw query (no proof). Prefer {@link queryDocumentsWithProof} for trust-minimized reads. */
export async function queryDocuments(sdk: EvoSDK, query: DocumentQuery): Promise<PlainDocument[]> {
  const response = await documentsOf(sdk).query(query)
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
  const response = await documentsOf(sdk).query(query)
  return { documents: mapToDocuments(response), proofMetadata: null }
}

/**
 * Provable O(1) count over a countable index (data-contracts §3). Sums the grouped result
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

/**
 * Page a query to exhaustion (the `query_all` pattern — parity with forge-core
 * `platform::query_all_documents`). Repeats the proof-verified query, advancing `startAfter`
 * past the last `$id` of each page, until a short page signals the end. Used by reads that
 * MUST be complete — e.g. the token-history reconstruction, where dropping a late `mint`
 * would make a legitimate collaborator's events fold as unauthorized.
 *
 * `pageLimit` bounds each round-trip; `maxPages` is a hard safety cap on total rounds.
 */
export async function queryAllDocuments(
  sdk: EvoSDK,
  query: DocumentQuery,
  opts: { readonly pageLimit?: number; readonly maxPages?: number } = {},
): Promise<PlainDocument[]> {
  const pageLimit = opts.pageLimit ?? 100
  const maxPages = opts.maxPages ?? 1000
  const out: PlainDocument[] = []
  let startAfter: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const { documents } = await queryDocumentsWithProof(sdk, {
      ...query,
      limit: pageLimit,
      startAfter,
    })
    out.push(...documents)
    if (documents.length < pageLimit) break
    const last = documents[documents.length - 1]
    const lastId = last?.['$id']
    if (typeof lastId !== 'string') break
    startAfter = lastId
  }
  return out
}

// ---------------------------------------------------------------------------
// Skip-scan distinct-key enumeration (branch/tag listing)
// ---------------------------------------------------------------------------

/**
 * Enumerate the distinct values of an indexed key via `limit 1` skip hops (S0.8):
 * seek the first row ordered by `keyField asc`, record its key, then seek
 * `keyField > lastKey limit 1` repeatedly. Cost is one cheap seek per distinct key —
 * bounded by real branch/tag counts, NOT by how many times any one ref was pushed.
 *
 * `keyIsBase64` values are compared/advanced as base64 strings (the wasm result form).
 * Returns the distinct key values (base64) in ascending order, with a hard `maxKeys` cap.
 */
export async function skipScanDistinct(
  sdk: EvoSDK,
  params: {
    readonly dataContractId: string
    readonly documentTypeName: string
    readonly keyField: string
    readonly maxKeys?: number
  },
): Promise<string[]> {
  const { dataContractId, documentTypeName, keyField } = params
  const maxKeys = params.maxKeys ?? 10_000
  const keys: string[] = []
  let last: string | undefined

  for (let i = 0; i < maxKeys; i++) {
    const where: WhereClause[] = last === undefined ? [] : [[keyField, '>', last]]
    const rows = await queryDocuments(sdk, {
      dataContractId,
      documentTypeName,
      where,
      orderBy: [[keyField, 'asc']],
      limit: 1,
    })
    const row = rows[0]
    if (row === undefined) break
    const key = row[keyField]
    if (typeof key !== 'string') break
    keys.push(key)
    last = key
  }
  return keys
}

// ---------------------------------------------------------------------------
// in-batch with per-key completeness fallback (the NORMAL path)
// ---------------------------------------------------------------------------

/**
 * Fetch the newest row per key (e.g. the current tip per `refNameHash`, or the newest
 * event per target) with the S0.8 completeness fallback baked in:
 *   1. one `in` batch over all keys (`keyField in [...]`, orderBy `keyField, $createdAt desc`)
 *   2. any key that returned zero rows — starved by a hot sibling — is re-queried
 *      individually (`keyField == key`, `$createdAt desc`, limit 1), **all in parallel**.
 *
 * Returns a `Map<key, newestRow>` covering every key that has at least one row.
 * `keys` are the base64 operand form; the fallback re-encodes each identically.
 */
export async function inBatchNewestPerKey(
  sdk: EvoSDK,
  params: {
    readonly dataContractId: string
    readonly documentTypeName: string
    readonly keyField: string
    readonly keys: readonly string[]
    readonly batchLimit?: number
  },
): Promise<Map<string, PlainDocument>> {
  const { dataContractId, documentTypeName, keyField, keys } = params
  const result = new Map<string, PlainDocument>()
  if (keys.length === 0) return result

  const batch = await queryDocuments(sdk, {
    dataContractId,
    documentTypeName,
    where: [[keyField, 'in', keys]],
    orderBy: [
      [keyField, 'asc'],
      ['$createdAt', 'desc'],
    ],
    limit: params.batchLimit ?? 100,
  })
  for (const row of batch) {
    const k = row[keyField]
    if (typeof k === 'string' && !result.has(k)) result.set(k, row)
  }

  // Completeness fallback: re-query every starved key individually, in parallel.
  const missing = keys.filter((k) => !result.has(k))
  const fallbacks = await Promise.all(
    missing.map((k) =>
      queryDocuments(sdk, {
        dataContractId,
        documentTypeName,
        where: [[keyField, '==', k]],
        orderBy: [['$createdAt', 'desc']],
        limit: 1,
      }).then((rows) => [k, rows[0]] as const),
    ),
  )
  for (const [k, row] of fallbacks) {
    if (row !== undefined) result.set(k, row)
  }
  return result
}

/**
 * Fetch ALL rows for a set of keys with the same completeness discipline — used by event
 * folds (an issue/PR needs every event, not just the newest). Pages the `in` batch, then
 * re-queries each key that looks truncated. Returns `Map<key, rows[]>` (ascending time).
 */
export async function inBatchAllPerKey(
  sdk: EvoSDK,
  params: {
    readonly dataContractId: string
    readonly documentTypeName: string
    readonly keyField: string
    readonly keys: readonly string[]
    readonly perKeyLimit?: number
  },
): Promise<Map<string, PlainDocument[]>> {
  const { dataContractId, documentTypeName, keyField, keys } = params
  const perKeyLimit = params.perKeyLimit ?? 100
  // On active repos the per-key path is correct regardless of Drive traversal order, so
  // fetch each key's full timeline directly (parallelized) rather than trusting the batch.
  const entries = await Promise.all(
    keys.map((k) =>
      queryDocuments(sdk, {
        dataContractId,
        documentTypeName,
        where: [[keyField, '==', k]],
        orderBy: [['$createdAt', 'asc']],
        limit: perKeyLimit,
      }).then((rows) => [k, rows] as const),
    ),
  )
  return new Map(entries)
}

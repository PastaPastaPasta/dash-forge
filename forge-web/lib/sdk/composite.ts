/**
 * Composite document reads (`documents.composite`, evo-sdk 4.2): a page plus up to ten
 * sub-queries derived from it, proved together in ONE round trip
 * (`platform-parity-spec.md` §3.3).
 *
 * A sub-query is one of:
 * - a **sibling**: an independent documents query under the same proof (no `bind`);
 * - a **lookup**: `field IN <values read off the page>` (`bind`), e.g. the comments of every
 *   issue on the page (`$id → targetId`);
 * - a **count**: one count per bound value on a countable index (`kind: 'counts'`).
 *
 * What the protocol refuses (verified on moutai, evo-sdk 4.2.0-beta.4,
 * `wasm-sdk/src/queries/composite_document.rs`):
 * - more than 10 sub-queries;
 * - a page `limit` outside 1..100;
 * - a `limit` on a counts sub-query;
 * - a cursor (`startAfter`): page with a range clause on the page's order instead;
 * - two documents sub-queries that walk the same index path when one carries a limit.
 *
 * {@link queryComposite} falls back to plain queries when the SDK or the node does not
 * support the composition (an older SDK, an unsupported shape): the page, then each
 * sub-query on its own, with bound values turned into an `in` clause and counts into one count
 * per value. The fallback is slower (1 + N requests) but answers the same question.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { isContractMissingError } from './contract-missing'
import {
  countDocuments,
  followSdkVersion,
  normalizeDocument,
  queryDocumentsWithProof,
  type DocumentQuery,
  type OrderByClause,
  type PlainDocument,
  type WhereClause,
} from './query'

/** Most sub-queries one composite may carry. */
const MAX_SUB_QUERIES = 10

/** Where a sub-query's bound values come from: the page, or an earlier documents sub-query. */
export interface CompositeBind {
  /** `'page'` (default) or the index of an earlier `documents` sub-query. */
  readonly source?: 'page' | number
  /** The source property read off each source document: `$id`, `$ownerId` or an identifier field. */
  readonly sourceProperty: string
  /** The sub-query field that receives `IN <values>`. */
  readonly field: string
}

/** One sub-query of a {@link CompositeQuery}. */
export interface CompositeSub {
  /** Defaults to the page's contract. */
  readonly dataContractId?: string
  readonly documentType: string
  /** `'documents'` (default) or `'counts'`. */
  readonly kind?: 'documents' | 'counts'
  readonly where?: readonly WhereClause[]
  readonly orderBy?: readonly OrderByClause[]
  /** Required for a documents lookup or sibling; forbidden for counts. At most 100. */
  readonly limit?: number
  /** Omit for a sibling. */
  readonly bind?: CompositeBind
}

/** A page and its sub-queries. */
export interface CompositeQuery {
  readonly dataContractId: string
  readonly documentType: string
  readonly where?: readonly WhereClause[]
  readonly orderBy?: readonly OrderByClause[]
  /** The page size (1..100). */
  readonly limit: number
  readonly subQueries: readonly CompositeSub[]
}

/** A sub-query's answer, in request order. */
export type CompositeSubResult =
  | { readonly kind: 'documents'; readonly documents: PlainDocument[] }
  /** Keyed by the bound value (base58 for an identifier); a value with no entry counts 0. */
  | { readonly kind: 'counts'; readonly counts: Map<string, number> }

/** The page, then one result per sub-query. */
export interface CompositeResult {
  readonly page: PlainDocument[]
  readonly subs: CompositeSubResult[]
}

/** A composite whose page is `page` (a {@link DocumentQuery}: its contract, type, clauses) and `limit`. */
export function compositeOf(page: DocumentQuery, limit: number, subQueries: readonly CompositeSub[]): CompositeQuery {
  return {
    dataContractId: page.dataContractId,
    documentType: page.documentTypeName,
    ...(page.where ? { where: page.where } : {}),
    ...(page.orderBy ? { orderBy: page.orderBy } : {}),
    limit,
    subQueries,
  }
}

/** A sibling sub-query: `q` proved under the same root, its first `limit` rows. */
export function siblingOf(q: DocumentQuery, limit = 100): CompositeSub {
  return { dataContractId: q.dataContractId, documentType: q.documentTypeName, where: q.where ?? [], orderBy: q.orderBy ?? [], limit }
}

/** Sub-result `i`'s documents ([] when it is a counts result or absent). */
export function docsAt(r: CompositeResult, i: number): PlainDocument[] {
  const s = r.subs[i]
  return s?.kind === 'documents' ? s.documents : []
}

/** Sub-result `i`'s counts, or null when it is not a counts result. */
export function countsAt(r: CompositeResult, i: number): Map<string, number> | null {
  const s = r.subs[i]
  return s?.kind === 'counts' ? s.counts : null
}

interface RawComposite {
  readonly pageDocuments: readonly unknown[]
  readonly subResults: readonly (
    | { readonly kind: 'documents'; readonly documents: readonly unknown[] }
    | { readonly kind: 'counts'; readonly counts: Map<string, bigint | number> }
  )[]
}

interface CompositeFacadeLike {
  composite?: (q: unknown) => Promise<RawComposite>
}

/** Whether an error says the composition is unsupported (fall back), not that the node is down. */
function isUnsupported(e: unknown): boolean {
  // Drive's "contract not found" is an InvalidArgument too, but plain reads would get it again.
  if (isContractMissingError(e)) return false
  const msg = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)
  return /unsupported|not supported|unimplemented|unknown (field|variant)|invalid argument|is not a function/i.test(msg)
}

function toNumber(v: bigint | number): number {
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER
}

function check(q: CompositeQuery): void {
  if (q.subQueries.length === 0 || q.subQueries.length > MAX_SUB_QUERIES) {
    throw new Error(`a composite query carries 1-${MAX_SUB_QUERIES} sub-queries, not ${q.subQueries.length}`)
  }
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100) throw new Error('a composite page limit is 1-100')
  q.subQueries.forEach((s, i) => {
    if (s.kind === 'counts' && s.limit !== undefined) throw new Error(`subQueries[${i}]: a counts sub-query takes no limit`)
    if (typeof s.bind?.source === 'number' && (s.bind.source >= i || q.subQueries[s.bind.source]?.kind === 'counts')) {
      // copy-lint-ignore: a developer error in how a query is built, caught by tests
      throw new Error(`subQueries[${i}]: bind.source must name an earlier documents sub-query`)
    }
  })
}

/**
 * Run a composite read: one proved round trip, or (when unsupported) the same question as
 * plain queries. Documents come back normalized ({@link normalizeDocument}); counts as numbers.
 * `plainFallback: false` throws instead of falling back, for a caller whose plain equivalent
 * would cost one request per bound value (counts over a whole page).
 */
export async function queryComposite(
  sdk: EvoSDK,
  q: CompositeQuery,
  /** `onFallback`: told when the composite was refused and plain queries answer instead. */
  opts: { readonly plainFallback?: boolean; readonly onFallback?: () => void } = {},
): Promise<CompositeResult> {
  check(q)
  const facade = (sdk as unknown as { documents: CompositeFacadeLike }).documents
  if (typeof facade.composite !== 'function' && opts.plainFallback === false) throw new Error('composite queries are not available in this SDK')
  if (typeof facade.composite === 'function') {
    try {
      const raw = await facade.composite({
        dataContractId: q.dataContractId,
        documentType: q.documentType,
        ...(q.where ? { where: q.where } : {}),
        ...(q.orderBy ? { orderBy: q.orderBy } : {}),
        limit: q.limit,
        subQueries: q.subQueries.map((s) => ({
          ...(s.dataContractId ? { dataContractId: s.dataContractId } : {}),
          documentType: s.documentType,
          ...(s.kind ? { kind: s.kind } : {}),
          ...(s.where ? { where: s.where } : {}),
          ...(s.orderBy ? { orderBy: s.orderBy } : {}),
          ...(s.limit !== undefined ? { limit: s.limit } : {}),
          ...(s.bind ? { bind: s.bind } : {}),
        })),
      })
      followSdkVersion(sdk)
      return {
        page: raw.pageDocuments.filter((d) => d != null).map(normalizeDocument),
        subs: raw.subResults.map((r) =>
          r.kind === 'counts'
            ? { kind: 'counts', counts: new Map([...r.counts.entries()].map(([k, v]) => [k, toNumber(v)])) }
            : { kind: 'documents', documents: r.documents.filter((d) => d != null).map(normalizeDocument) },
        ),
      }
    } catch (e) {
      if (!isUnsupported(e) || opts.plainFallback === false) throw e
    }
  }
  opts.onFallback?.()
  return plainComposite(sdk, q)
}

/** A documents value read off a source row, as a query operand (base58 ids stay as they are). */
function sourceValue(doc: PlainDocument, property: string): string | null {
  const v = property.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), doc)
  return typeof v === 'string' && v !== '' ? v : null
}

/** The composite's question as plain queries (the fallback). */
async function plainComposite(sdk: EvoSDK, q: CompositeQuery): Promise<CompositeResult> {
  const pageQuery: DocumentQuery = {
    dataContractId: q.dataContractId,
    documentTypeName: q.documentType,
    ...(q.where ? { where: q.where } : {}),
    ...(q.orderBy ? { orderBy: q.orderBy } : {}),
    limit: q.limit,
  }
  const page = (await queryDocumentsWithProof(sdk, pageQuery)).documents
  const subs: CompositeSubResult[] = []
  for (const s of q.subQueries) {
    const contract = s.dataContractId ?? q.dataContractId
    if (s.bind === undefined) {
      const { documents } = await queryDocumentsWithProof(sdk, {
        dataContractId: contract,
        documentTypeName: s.documentType,
        ...(s.where ? { where: s.where } : {}),
        ...(s.orderBy ? { orderBy: s.orderBy } : {}),
        limit: s.limit ?? 100,
      })
      subs.push({ kind: 'documents', documents })
      continue
    }
    const source = s.bind.source === undefined || s.bind.source === 'page' ? page : (subs[s.bind.source] as { documents: PlainDocument[] }).documents
    const values = [...new Set(source.map((d) => sourceValue(d, s.bind!.sourceProperty)).filter((v): v is string => v !== null))]
    if (s.kind === 'counts') {
      const counts = new Map<string, number>()
      for (const v of values) {
        const n = await countDocuments(sdk, {
          dataContractId: contract,
          documentTypeName: s.documentType,
          where: [...(s.where ?? []), [s.bind.field, '==', v]],
        })
        if (n > 0) counts.set(v, n)
      }
      subs.push({ kind: 'counts', counts })
      continue
    }
    if (values.length === 0) {
      subs.push({ kind: 'documents', documents: [] })
      continue
    }
    // An `in` needs an order on its field; the bound field leads the lookup's index.
    const { documents } = await queryDocumentsWithProof(sdk, {
      dataContractId: contract,
      documentTypeName: s.documentType,
      where: [...(s.where ?? []), [s.bind.field, 'in', values]],
      orderBy: s.orderBy ?? [[s.bind.field, 'asc']],
      limit: s.limit ?? 100,
    })
    subs.push({ kind: 'documents', documents })
  }
  return { page, subs }
}

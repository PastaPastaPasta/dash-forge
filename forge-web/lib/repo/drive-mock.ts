/**
 * A Drive-shaped mock SDK for the list index tests (`issue-index.test.ts`, `pull-index.test.ts`):
 * it answers plain, composite, grouped count and grouped sum queries the way Drive does (every
 * `where` applied, ordered, capped at 100, paged by `startAfter`; a composite's page, counts per
 * bound value, bound lookups and siblings), and records every request so a list page's budget is
 * asserted, not assumed. Test-only.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Decode } from '../auth/base58'
import type { DocumentQuery } from '../sdk'
import type { CompositeQuery } from '../sdk/composite'

export type Doc = Record<string, unknown>
export type Store = Record<string, Record<string, Doc[]>>

/** The wasm SDK's group key: an identifier's 32 bytes, an unsigned integer with the top bit flipped. */
function groupKey(v: unknown): string {
  if (typeof v === 'number') return (v ^ 0x80).toString(16).padStart(2, '0')
  return [...base58Decode(String(v))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function matches(doc: Doc, [field, op, value]: readonly [string, string, unknown]): boolean {
  const v = field.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Doc)[k] : undefined), doc)
  switch (op) {
    case '==':
      return v === value
    case 'in':
      return Array.isArray(value) && value.includes(v)
    case '<=':
      return (v as number) <= (value as number)
    case '>=':
      return (v as number) >= (value as number)
    case '<':
      return (v as number) < (value as number)
    case '>':
      return (v as number) > (value as number)
    default:
      throw new Error(`mock: unsupported operator ${op}`)
  }
}

function run(rows: Doc[], where: readonly (readonly [string, string, unknown])[], orderBy: readonly (readonly [string, string])[], limit: number, startAfter?: string): Doc[] {
  let out = rows.filter((d) => where.every((w) => matches(d, w)))
  const dir = orderBy[orderBy.length - 1]?.[1]
  out.sort((a, b) => {
    for (const [f] of orderBy) {
      const av = a[f] as number | string
      const bv = b[f] as number | string
      if (av !== bv) return av < bv ? -1 : 1
    }
    return String(a['$id']) < String(b['$id']) ? -1 : 1
  })
  if (dir === 'desc') out.reverse()
  if (startAfter !== undefined) out = out.slice(out.findIndex((d) => d['$id'] === startAfter) + 1)
  return out.slice(0, Math.min(limit, 100))
}

/** Every request the mock answered, by kind. */
export interface Seen {
  composites: CompositeQuery[]
  queries: DocumentQuery[]
  counts: DocumentQuery[]
  sums: DocumentQuery[]
  /** Set to a promise to hold every composite's answer (computed when sent) until it resolves. */
  hold?: Promise<void> | null
}

export const newSeen = (): Seen => ({ composites: [], queries: [], counts: [], sums: [] })

/** A mock over `store[contract][type]` that answers plain, composite, count and sum queries. */
export function mockSdk(store: Store, seen: Seen): EvoSDK {
  const rows = (c: string, t: string): Doc[] => store[c]?.[t] ?? []
  const where = (q: DocumentQuery) => (d: Doc): boolean => ((q.where ?? []) as never[]).every((w) => matches(d, w))
  const query = async (q: DocumentQuery) => {
    seen.queries.push(q)
    const out = run(rows(q.dataContractId, q.documentTypeName), (q.where ?? []) as never, (q.orderBy ?? []) as never, q.limit ?? 100, q.startAfter)
    return new Map(out.map((d) => [String(d['$id']), d]))
  }
  const composite = async (q: CompositeQuery) => {
    seen.composites.push(q)
    const held = seen.hold
    const page = run(rows(q.dataContractId, q.documentType), (q.where ?? []) as never, (q.orderBy ?? []) as never, q.limit)
    const subDocs: Doc[][] = []
    const subResults = q.subQueries.map((s, i) => {
      const contract = s.dataContractId ?? q.dataContractId
      const source = s.bind === undefined ? null : s.bind.source === undefined || s.bind.source === 'page' ? page : subDocs[s.bind.source as number] ?? []
      const values = source === null ? null : [...new Set(source.map((d) => d[s.bind!.sourceProperty]).filter((v) => v !== undefined))]
      const filter = [...(s.where ?? []), ...(values === null ? [] : [[s.bind!.field, 'in', values] as const])]
      if (s.kind === 'counts') {
        const counts = new Map<string, bigint>()
        for (const v of values ?? []) {
          const n = rows(contract, s.documentType).filter((d) => d[s.bind!.field] === v).length
          if (n > 0) counts.set(String(v), BigInt(n))
        }
        subDocs[i] = []
        return { kind: 'counts', counts }
      }
      const docs = run(rows(contract, s.documentType), filter as never, (s.orderBy ?? []) as never, s.limit ?? 100)
      subDocs[i] = docs
      return { kind: 'documents', documents: docs, missingIds: [] }
    })
    if (held) await held
    return { pageDocuments: page, subResults }
  }
  return {
    documents: {
      query,
      composite,
      count: async (q: DocumentQuery & { groupBy?: string[] }) => {
        seen.counts.push(q)
        const all = rows(q.dataContractId, q.documentTypeName).filter(where(q))
        const by = q.groupBy?.[0]
        if (by === undefined) return new Map([['', BigInt(all.length)]])
        const out = new Map<string, bigint>()
        for (const d of all) out.set(groupKey(d[by]), (out.get(groupKey(d[by])) ?? 0n) + 1n)
        return out
      },
      sum: async (q: DocumentQuery & { groupBy?: string[] }, property: string) => {
        seen.sums.push(q)
        const out = new Map<string, bigint>()
        for (const d of rows(q.dataContractId, q.documentTypeName).filter(where(q))) {
          const k = groupKey(d[q.groupBy?.[0] ?? ''])
          out.set(k, (out.get(k) ?? 0n) + BigInt(Number(d[property] ?? 0)))
        }
        return out
      },
    },
  } as unknown as EvoSDK
}

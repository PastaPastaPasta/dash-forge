/**
 * THE PARITY PROOF for boards (`docs/design/boards.md`): every `board_*__*.json` vector in
 * `forge-contracts/vectors/` run against `./boards`. forge-core
 * `rules::boards::tests::board_vectors` runs the same files with the same input and output
 * shapes, so `dg board` and the web agree on specs, ranks, placement, queries, iterations and
 * the view helpers.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  bottomRank,
  columnTotals,
  defaultSpec,
  foldBoard,
  groupRows,
  implicitRankOf,
  iterationAt,
  iterationProgress,
  iterationRange,
  matchesBoardQuery,
  newestBoards,
  parseBoardQuery,
  parseFieldValues,
  parseSourceQuery,
  parseSpec,
  repoNamesOf,
  rankBetween,
  rerank,
  serializeFieldValues,
  serializeSpec,
  sortRows,
  sumFieldOf,
  topRank,
  type BoardDoc,
  type BoardFold,
  type BoardItem,
  type BoardRow,
  type BoardSpec,
  type CardDoc,
} from './boards'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { readonly [k: string]: Json }

interface Vector {
  readonly name: string
  readonly case: string
  readonly rules?: string
  readonly input: Obj
  readonly expected: Json
}

const VECTORS_DIR = resolve(process.cwd(), '..', 'forge-contracts', 'vectors')
const FILES = readdirSync(VECTORS_DIR)
  .filter((f) => f.startsWith('board_') && f.endsWith('.json'))
  .sort()

const arr = (j: Json | undefined): Json[] => j as Json[]

function specOf(j: Json | undefined): BoardSpec {
  const r = parseSpec(JSON.stringify(j))
  if ('error' in r) throw new Error(`vector spec refused: ${r.error}`)
  return r.spec
}

function canonical(spec: BoardSpec): string {
  const r = serializeSpec(spec)
  if ('error' in r) throw new Error(`spec did not serialize: ${r.error}`)
  return r.json
}

function foldOf(i: Obj): { spec: BoardSpec; items: BoardItem[]; fold: BoardFold } {
  const spec = specOf(i.spec)
  const items = i.items as unknown as BoardItem[]
  const fold = foldBoard({ spec, home: i.home as string, items, cards: i.cards as unknown as CardDoc[], now: i.now as number })
  return { spec, items, fold }
}

/** The vector's `repos`: the names its `repo:` qualifiers type, resolved to repository ids (as a client resolves them before parsing). */
const reposOf = (i: Obj): Map<string, string> => new Map(Object.entries((i.repos ?? {}) as Record<string, string>))

/** The rows a query keeps, in input order. */
function rowsOf(i: Obj, q: string, spec: BoardSpec, items: readonly BoardItem[], fold: BoardFold): BoardRow[] {
  const query = parseBoardQuery(q, spec, reposOf(i))
  const ctx = { me: (i.me as string | null | undefined) ?? null, now: i.now as number }
  return items.map((item, n) => ({ item, placement: fold.items[n]! })).filter((r) => matchesBoardQuery(r.item, r.placement, spec, query, ctx))
}

/** JSON as both clients compare it (`undefined` members dropped). */
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json

function run(v: Vector): Json {
  const i = v.input
  switch (`${v.case}/${i.op as string}`) {
    case 'board_spec/parse':
      return arr(i.cases).map((c): Json => {
        const { name, json } = c as Obj
        const r = parseSpec(json as string)
        return 'error' in r ? { name: name as string, error: r.error } : { name: name as string, json: canonical(r.spec) }
      })
    case 'board_spec/default':
      return { json: canonical(defaultSpec(i.home as string, i.now as number)) }
    case 'board_spec/values': {
      const spec = specOf(i.spec)
      const values = parseFieldValues(i.f as string | null, spec)
      const out = serializeFieldValues(values, spec)
      return plain({ values, ...out })
    }
    case 'board_rank/between':
      return plain(arr(i.pairs).map((p) => rankBetween((p as Json[])[0] as string | null, (p as Json[])[1] as string | null)))
    case 'board_rank/top':
      return plain(arr(i.firsts).map((f) => topRank(f as string | null)))
    case 'board_rank/bottom':
      return plain(arr(i.lasts).map((l) => bottomRank(l as string | null)))
    case 'board_rank/implicit':
      return arr(i.items).map((x) => implicitRankOf((x as Obj).createdAt as number, (x as Obj).id as string))
    case 'board_rank/rerank':
      return plain(rerank(i.n as number))
    case 'board_fold/fold':
      return plain(foldOf(i).fold)
    case 'board_fold/boards':
      return newestBoards(i.docs as unknown as BoardDoc[], i.withDeleted === true).map((d) => ({ key: d.key, id: d.id, state: d.state }))
    case 'board_query/parse':
      return plain(parseBoardQuery(i.text as string, specOf(i.spec), reposOf(i)))
    case 'board_query/names':
      return arr(i.texts).map((t) => repoNamesOf(t as string))
    case 'board_query/source':
      return plain(parseSourceQuery(i.text as string, specOf(i.spec)))
    case 'board_query/match': {
      const { spec, items, fold } = foldOf(i)
      return arr(i.texts).map((t) => rowsOf(i, t as string, spec, items, fold).map((r) => r.item.id))
    }
    case 'board_iteration/at':
    case 'board_iteration/range': {
      const field = specOf(i.spec).fields.find((f) => f.id === i.field)!
      return i.op === 'at' ? arr(i.dates).map((d) => iterationAt(field, d as number)) : plain(arr(i.ks).map((k) => iterationRange(field, k as number)))
    }
    default: {
      expect(v.case).toBe('board_view')
      const { spec, items, fold } = foldOf(i)
      const rows = rowsOf(i, (i.q as string | undefined) ?? '', spec, items, fold)
      switch (i.op) {
        case 'group':
          return plain(groupRows(rows, i.by as string, spec, i.now as number))
        case 'sort':
          return arr(i.sorts).map((s) => sortRows(rows, (s as string | null) ?? undefined, spec).map((r) => r.item.id))
        case 'totals': {
          const view = spec.views.find((w) => w.id === i.view) ?? null
          return plain(columnTotals(rows, spec, sumFieldOf(spec, view)))
        }
        case 'progress':
          return plain(iterationProgress(rows, spec, i.field as number, i.k as number, (i.points as number | null | undefined) ?? null))
        default:
          throw new Error(`unknown board vector ${v.case} op ${String(i.op)}`)
      }
    }
  }
}

describe('board vectors', () => {
  const vectors = FILES.map((f) => ({ file: f, v: JSON.parse(readFileSync(resolve(VECTORS_DIR, f), 'utf8')) as Vector }))

  it('loads every family', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30)
    const cases = new Set(vectors.map(({ v }) => v.case))
    for (const c of ['board_rank', 'board_spec', 'board_fold', 'board_query', 'board_iteration', 'board_view']) expect(cases.has(c), c).toBe(true)
    for (const { file, v } of vectors) expect(file.startsWith(`${v.case}__`), file).toBe(true)
  })

  for (const { file, v } of vectors) {
    it(file, () => {
      expect(run(v)).toEqual(v.expected)
    })
  }
})

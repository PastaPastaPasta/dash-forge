/**
 * Explore's discovery reads (L-25) against a Drive-shaped mock that answers composites the
 * way `documents.composite` does (page, by-id joins, bound lookups, counts) and records every
 * request, so each read's request budget is asserted, not assumed.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it } from 'vitest'

import { NETWORKS, DEFAULT_NETWORK } from '../constants'
import type { DocumentQuery } from '../sdk'
import type { CompositeQuery } from '../sdk/composite'
import { cachedDpnsName, clearDpnsCache } from './dpns'
import {
  keysetPage,
  mostStarredRepos,
  prefixUpperBound,
  recentReposPage,
  recentlyUpdated,
  reposNamed,
  searchPrefix,
  searchRepos,
  type DiscoveredRepo,
} from './discovery'

type Doc = Record<string, unknown>
const NET = DEFAULT_NETWORK
const FORGE = NETWORKS[NET].v2!
const DPNS = NETWORKS[NET].dpnsContractId
const NOW = Date.now()

function cmp(a: unknown, b: unknown): number {
  return a === b ? 0 : (a as string | number) < (b as string | number) ? -1 : 1
}

function matches(doc: Doc, [field, op, value]: readonly [string, string, unknown]): boolean {
  const v = field.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Doc)[k] : undefined), doc)
  switch (op) {
    case '==':
      return v === value
    case 'in':
      return Array.isArray(value) && value.includes(v)
    case '<=':
      return cmp(v, value) <= 0
    case '>=':
      return cmp(v, value) >= 0
    case '<':
      return cmp(v, value) < 0
    case '>':
      return cmp(v, value) > 0
    default:
      throw new Error(`mock: unsupported operator ${op}`)
  }
}

/** Drive's walk: filter, order by the order fields (ties by $id), last direction wins, cap. */
function run(rows: Doc[], where: readonly (readonly [string, string, unknown])[], orderBy: readonly (readonly [string, string])[], limit: number): Doc[] {
  const out = rows.filter((d) => where.every((w) => matches(d, w)))
  out.sort((a, b) => {
    for (const [f] of orderBy) {
      const c = cmp(a[f], b[f])
      if (c !== 0) return c
    }
    return cmp(a['$id'], b['$id'])
  })
  if (orderBy[0]?.[1] === 'desc') out.reverse()
  return out.slice(0, Math.min(limit, 100))
}

interface Seen {
  composites: CompositeQuery[]
  queries: DocumentQuery[]
  counts: DocumentQuery[]
}

function mockSdk(store: Record<string, Record<string, Doc[]>>, seen: Seen, opts: { noComposite?: boolean } = {}): EvoSDK {
  const rows = (c: string, t: string): Doc[] => store[c]?.[t] ?? []
  const composite = async (q: CompositeQuery) => {
    seen.composites.push(q)
    const page = run(rows(q.dataContractId, q.documentType), (q.where ?? []) as never, (q.orderBy ?? []) as never, q.limit)
    const subDocs: Doc[][] = []
    const subResults = q.subQueries.map((s, i) => {
      const contract = s.dataContractId ?? q.dataContractId
      const source = s.bind === undefined ? null : s.bind.source === undefined || s.bind.source === 'page' ? page : subDocs[s.bind.source as number] ?? []
      const values = source === null ? null : [...new Set(source.map((d) => d[s.bind!.sourceProperty]).filter((v) => v !== undefined))]
      if (s.kind === 'counts') {
        const counts = new Map<string, bigint>()
        for (const v of values ?? []) {
          const n = rows(contract, s.documentType).filter((d) => d[s.bind!.field] === v).length
          if (n > 0) counts.set(String(v), BigInt(n))
        }
        subDocs[i] = []
        return { kind: 'counts', counts }
      }
      const where = [...(s.where ?? []), ...(values === null ? [] : [[s.bind!.field, 'in', values] as const])]
      const nested = (d: Doc, f: string): unknown => f.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Doc)[k] : undefined), d)
      const all = rows(contract, s.documentType).filter((d) => where.every(([f, op, v]) => matches({ ...d, [f]: nested(d, f) }, [f, op, v])))
      const docs = s.bind?.field === '$id' ? all : run(all, [], (s.orderBy ?? []) as never, s.limit ?? 100)
      subDocs[i] = docs
      return { kind: 'documents', documents: docs, missingIds: [] }
    })
    return { pageDocuments: page, subResults }
  }
  return {
    documents: {
      query: async (q: DocumentQuery) => {
        seen.queries.push(q)
        const out = run(rows(q.dataContractId, q.documentTypeName), (q.where ?? []) as never, (q.orderBy ?? []) as never, q.limit ?? 100)
        return new Map(out.map((d) => [String(d['$id']), d]))
      },
      count: async (q: DocumentQuery) => {
        seen.counts.push(q)
        return new Map([['', 0n]])
      },
      ...(opts.noComposite ? {} : { composite }),
    },
    dpns: { resolveName: async () => undefined },
  } as unknown as EvoSDK
}

const id = (s: string): string => s.padEnd(44, '1').slice(0, 44)
const OWNER_A = id('OwnerA')
const OWNER_B = id('OwnerB')

function repo(name: string, createdAt: number, ownerId = OWNER_A, extra: Doc = {}): Doc {
  return { $id: id(`R${name}`), $ownerId: ownerId, $createdAt: createdAt, name, visibility: 'public', description: '', ...extra }
}

/** 60 repos: `demo-00` … `demo-59`, one a second, plus ripgrep and jq (two owners each for jq). */
function store(): Record<string, Record<string, Doc[]>> {
  const repos: Doc[] = []
  for (let i = 0; i < 60; i++) repos.push(repo(`demo-${String(i).padStart(2, '0')}`, 1_000 + i * 1000))
  repos.push(repo('ripgrep', 500, OWNER_B), repo('jq', 400, OWNER_A), repo('jq', 400, OWNER_B))
  const star = (owner: string, target: string): Doc => ({ $id: id(`S${owner}${target}`), $ownerId: owner, repoId: target })
  const stars = [star('X1', id('Rripgrep')), star('X2', id('Rripgrep')), star('X3', id('Rripgrep')), star('X1', id('Rjq')), star('X2', id('Rdemo-05'))]
  const push = (target: string, at: number, n: number): Doc => ({ $id: id(`P${target}${n}`), $ownerId: OWNER_A, $createdAt: at, repoId: target })
  return {
    [FORGE.core]: {
      repo: repos,
      packManifest: [push(id('Rdemo-59'), NOW - 60_000, 1), push(id('Rripgrep'), NOW - 10_000, 1), push(id('Rdemo-58'), NOW - 30 * 86_400_000, 1)],
    },
    [FORGE.collab]: {
      star: stars,
      issue: [{ $id: id('I1'), repoId: id('Rripgrep') }, { $id: id('I2'), repoId: id('Rripgrep') }],
    },
    [DPNS]: {
      domain: [{ $id: id('D1'), label: 'burntsushi', normalizedParentDomainName: 'dash', records: { identity: OWNER_B } }],
    },
  }
}

const fresh = (): Seen => ({ composites: [], queries: [], counts: [] })
const names = (rs: readonly DiscoveredRepo[]): string[] => rs.map((r) => r.slug)
const requests = (s: Seen): number => s.composites.length + s.queries.length + s.counts.length

beforeEach(() => clearDpnsCache())

describe('searchPrefix / prefixUpperBound', () => {
  it('reads a repo-name prefix, lowercased, the name part of owner/name', () => {
    expect(searchPrefix('  RipGrep ')).toBe('ripgrep')
    expect(searchPrefix('alice/forge-v2')).toBe('forge-v2')
    expect(searchPrefix('a b')).toBeNull()
    expect(searchPrefix('é')).toBeNull()
    expect(searchPrefix('')).toBeNull()
  })
  it('bounds a prefix range by bumping its last character', () => {
    expect(prefixUpperBound('rip')).toBe('riq')
    expect(prefixUpperBound('forge-')).toBe('forge.')
    // Every name with the prefix sorts below the bound, and the next name past it does not.
    expect('ripgrep' < prefixUpperBound('rip')).toBe(true)
    expect('riq' < prefixUpperBound('rip')).toBe(false)
  })
})

describe('keysetPage', () => {
  const rows = (vals: [string, number][]): Doc[] => vals.map(([i, at]) => ({ $id: i, at }))
  it('keeps the ids seen at the boundary, so ties are neither lost nor repeated', () => {
    const first = keysetPage<number>(rows([['a', 3], ['b', 2], ['c', 2], ['d', 2]]), 'at', 2, 2, null)
    expect(first.rows.map((d) => d['$id'])).toEqual(['a', 'b'])
    expect(first.next).toEqual({ at: 2, seen: ['b'] })
    // The next read starts AT 2 and returns b again; it is skipped.
    const second = keysetPage<number>(rows([['b', 2], ['c', 2], ['d', 2]]), 'at', 2, 3, first.next)
    expect(second.rows.map((d) => d['$id'])).toEqual(['c', 'd'])
    expect(second.next).toEqual({ at: 2, seen: ['b', 'c', 'd'] })
  })
  it('ends on a short read', () => {
    expect(keysetPage<number>(rows([['a', 1]]), 'at', 2, 2, null).next).toBeNull()
  })
})

describe('searchRepos (the repo.name index)', () => {
  it('finds a repo by a name prefix in ONE composite, with counts and the owner name', async () => {
    const seen = fresh()
    const page = await searchRepos(mockSdk(store(), seen), 'rip', { network: NET })
    expect(names(page.repos)).toEqual(['ripgrep'])
    expect(page.repos[0]).toMatchObject({ stars: 3, issues: 2 })
    expect(page.next).toBeNull()
    expect(requests(seen)).toBe(1)
    const [c] = seen.composites
    expect(c?.where).toEqual([
      ['name', '>=', 'rip'],
      ['name', '<', 'riq'],
    ])
    expect(c?.orderBy).toEqual([['name', 'asc']])
    // An ascending page carries no push lookup (a lookup must walk the page's direction).
    expect(c?.subQueries.map((s) => s.documentType)).toEqual(['star', 'issue', 'domain'])
    expect(cachedDpnsName(NET, OWNER_B)).toBe('burntsushi.dash')
  })

  it('pages a long result with a name keyset, one composite per page', async () => {
    const seen = fresh()
    const sdk = mockSdk(store(), seen)
    const all: string[] = []
    let page = await searchRepos(sdk, 'demo', { network: NET, limit: 24 })
    all.push(...names(page.repos))
    while (page.next !== null) {
      page = await searchRepos(sdk, 'demo', { network: NET, limit: 24, after: page.next })
      all.push(...names(page.repos))
    }
    expect(all).toHaveLength(60)
    expect(new Set(all).size).toBe(60)
    expect(all[0]).toBe('demo-00')
    expect(seen.composites).toHaveLength(3)
    expect(requests(seen)).toBe(3)
  })

  it('pages across repos sharing a name (jq by two owners) without losing one', async () => {
    const seen = fresh()
    const sdk = mockSdk(store(), seen)
    const first = await searchRepos(sdk, 'jq', { network: NET, limit: 1 })
    expect(first.repos).toHaveLength(1)
    expect(first.next).toEqual({ at: 'jq', seen: [first.repos[0]?.key] })
    const second = await searchRepos(sdk, 'jq', { network: NET, limit: 1, after: first.next })
    expect(second.repos).toHaveLength(1)
    expect(second.repos[0]?.key).not.toBe(first.repos[0]?.key)
    const third = await searchRepos(sdk, 'jq', { network: NET, limit: 1, after: second.next })
    expect(third.repos).toEqual([])
  })

  it('answers a text no repo name can start with, with no request', async () => {
    const seen = fresh()
    expect((await searchRepos(mockSdk(store(), seen), 'no such', { network: NET })).repos).toEqual([])
    expect(requests(seen)).toBe(0)
  })

  it('falls back to one plain page (no counts, never a request per repo) without the composite surface', async () => {
    const seen = fresh()
    const page = await searchRepos(mockSdk(store(), seen, { noComposite: true }), 'demo', { network: NET })
    expect(page.repos).toHaveLength(24)
    expect(page.repos[0]?.stars).toBeNull()
    expect(requests(seen)).toBe(1)
  })
})

describe('recentReposPage', () => {
  it('reads the newest page with counts, names and last-week pushes in ONE composite', async () => {
    const seen = fresh()
    const page = await recentReposPage(mockSdk(store(), seen), { network: NET })
    expect(page.repos).toHaveLength(24)
    expect(page.repos[0]?.slug).toBe('demo-59')
    expect(page.repos[0]?.pushedAt).toBe(NOW - 60_000)
    // A push older than the window is not read.
    expect(page.repos.find((r) => r.slug === 'demo-58')?.pushedAt).toBeNull()
    expect(page.pushesComplete).toBe(true)
    expect(requests(seen)).toBe(1)
    expect(seen.composites[0]?.subQueries.map((s) => s.documentType)).toEqual(['star', 'issue', 'domain', 'packManifest'])
  })

  it('pages to the oldest repo, one composite per page', async () => {
    const seen = fresh()
    const sdk = mockSdk(store(), seen)
    const all: string[] = []
    let page = await recentReposPage(sdk, { network: NET })
    all.push(...names(page.repos))
    while (page.next !== null) {
      page = await recentReposPage(sdk, { network: NET, after: page.next })
      all.push(...names(page.repos))
    }
    expect(all).toHaveLength(63)
    expect(all.slice(-3).sort()).toEqual(['jq', 'jq', 'ripgrep'])
    expect(requests(seen)).toBe(3)
    expect(seen.composites[1]?.where).toEqual([['$createdAt', '<=', expect.any(Number)]])
  })
})

describe('mostStarredRepos', () => {
  it('ranks by exact star counts in ONE composite over the star set', async () => {
    const seen = fresh()
    const r = await mostStarredRepos(mockSdk(store(), seen), { network: NET })
    expect(names(r.repos)).toEqual(['ripgrep', 'demo-05', 'jq'])
    expect(r.repos.map((x) => x.stars)).toEqual([3, 1, 1])
    expect(r.repos[0]?.pushedAt).toBe(NOW - 10_000)
    expect(r).toMatchObject({ starsRead: 5, complete: true })
    expect(requests(seen)).toBe(1)
    const [c] = seen.composites
    expect(c).toMatchObject({ documentType: 'star', limit: 100 })
    expect(c?.subQueries[0]).toMatchObject({ documentType: 'repo', bind: { sourceProperty: 'repoId', field: '$id' } })
    // Counts, names and pushes bind to the joined repos, not to the star page.
    expect(c?.subQueries.slice(1).every((s) => s.bind?.source === 0)).toBe(true)
  })

  it('says it is partial when a full page of stars was read', async () => {
    const s = store()
    s[FORGE.collab]!['star'] = Array.from({ length: 150 }, (_, i) => ({ $id: id(`S${i}`), $ownerId: id(`U${i}`), repoId: id('Rripgrep') }))
    const r = await mostStarredRepos(mockSdk(s, fresh()), { network: NET })
    expect(r).toMatchObject({ starsRead: 100, complete: false })
    // The count is the exact one (150), not the 100 seen.
    expect(r.repos[0]?.stars).toBe(150)
  })
})

describe('recentlyUpdated', () => {
  const row = (key: string, pushedAt: number | null): DiscoveredRepo => ({ key, ownerId: OWNER_A, name: key, slug: key, description: '', createdAt: 0, visibility: 'public', pushedAt })
  it('ranks the repos with a push, newest first, each once', () => {
    const out = recentlyUpdated([[row('a', 5), row('b', null), row('c', 9)], [row('a', 5), row('d', 7)]])
    expect(out.map((r) => r.key)).toEqual(['c', 'd', 'a'])
  })
})

describe('reposNamed (the jump box)', () => {
  it('finds every owner of a name in one composite', async () => {
    const seen = fresh()
    const out = await reposNamed(mockSdk(store(), seen), 'JQ', { network: NET })
    expect(out.map((r) => r.ownerId).sort()).toEqual([OWNER_A, OWNER_B].sort())
    expect(requests(seen)).toBe(1)
    expect(seen.composites[0]?.where).toEqual([['name', '==', 'jq']])
  })
  it('asks nothing for a word that cannot be a repo name', async () => {
    const seen = fresh()
    expect(await reposNamed(mockSdk(store(), seen), 'Not A Name!', { network: NET })).toEqual([])
    expect(requests(seen)).toBe(0)
  })
})

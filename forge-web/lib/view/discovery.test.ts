/**
 * Explore's discovery reads (L-25) against a Drive-shaped mock that answers composites the
 * way `documents.composite` does (page, by-id joins, bound lookups, counts) and records every
 * request, so each read's request budget is asserted, not assumed.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NETWORKS } from '../constants'
import type { DocumentQuery } from '../sdk'
import type { CompositeQuery } from '../sdk/composite'
import { cachedDpnsName, clearDpnsCache } from './dpns'
import {
  keysetPage,
  pageWalk,
  rankedRepos,
  prefixUpperBound,
  recentReposPage,
  recentlyUpdated,
  reposNamed,
  searchPrefix,
  searchRepos,
  type DiscoveredRepo,
} from './discovery'

// The unit-test build targets testnet, which has no forge-v2 deployment: read moutai's ids.
vi.mock('../constants', async (orig) => {
  const real = await orig<typeof import('../constants')>()
  const { DEPLOYMENTS, forgeV2Ids } = await import('../deployments')
  const devnet = { ...real.NETWORKS.devnet, key: 'devnet-moutai', v2: forgeV2Ids(DEPLOYMENTS['devnet-moutai']) }
  return { ...real, NETWORKS: { ...real.NETWORKS, devnet } }
})


type Doc = Record<string, unknown>
const NET = 'devnet' as const
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
  ranked: Record<string, unknown>[]
}

function mockSdk(store: Record<string, Record<string, Doc[]>>, seen: Seen, opts: { noComposite?: boolean } = {}): EvoSDK {
  const rows = (c: string, t: string): Doc[] => store[c]?.[t] ?? []
  const composite = async (q: CompositeQuery) => {
    seen.composites.push(q)
    // Drive's `page_direction`: the page path query's outer `left_to_right`. A page with a range
    // (or an `in`) walks in its order's direction; an all-`==` page walks ascending whatever its
    // order asks. A bound documents sub-query (not a by-id join) whose outer ordering disagrees
    // is refused, with drive's message (bonsia refused Explore's later recent pages this way).
    const orderDir = (f: string): string | undefined => (q.orderBy as readonly (readonly [string, string])[] | undefined)?.find(([o]) => o === f)?.[1]
    const walked = (q.where ?? []).find(([f, op]) => op !== '==' && orderDir(f as string) !== undefined)
    const pageDir = walked === undefined ? 'asc' : orderDir(walked[0] as string)
    for (const s of q.subQueries) {
      const outer = (s.orderBy as readonly (readonly [string, string])[] | undefined)?.[0]?.[1]
      if (s.kind !== 'counts' && s.bind !== undefined && s.bind.field !== '$id' && outer !== undefined && outer !== pageDir) {
        throw new Error("unsupported error: a documents sub-query's outer ordering must match the page's direction; changing it for the merged proof would change its result")
      }
    }
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
      // Drive's ranked walk: count per group, highest first, equal counts by group key descending.
      ranked: async (q: { dataContractId: string; documentTypeName: string; groupBy: string; limit: number }) => {
        seen.ranked.push(q as unknown as Record<string, unknown>)
        const counts = new Map<string, number>()
        // A document without the grouped property falls in the null group (key "", value null), as on chain.
        for (const d of rows(q.dataContractId, q.documentTypeName)) counts.set(String(d[q.groupBy] ?? ''), (counts.get(String(d[q.groupBy] ?? '')) ?? 0) + 1)
        const entries = [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
          .slice(0, q.limit)
          .map(([g, n], i) => ({ groupKeyHex: Buffer.from(g).toString('hex'), groupValue: g === '' ? null : g, value: BigInt(n), rank: BigInt(i) }))
        return { startingRank: 0n, entries }
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
  return { $id: id(`R${name}${ownerId === OWNER_B ? 'B' : ''}`), $ownerId: ownerId, $createdAt: createdAt, name, visibility: 'public', description: '', ...extra }
}

/** 60 repos: `demo-00` … `demo-59`, one a second, plus ripgrep and jq (two owners each for jq). */
function store(): Record<string, Record<string, Doc[]>> {
  const repos: Doc[] = []
  for (let i = 0; i < 60; i++) repos.push(repo(`demo-${String(i).padStart(2, '0')}`, 1_000 + i * 1000))
  repos.push(repo('ripgrep', 500, OWNER_B), repo('jq', 400, OWNER_A), repo('jq', 400, OWNER_B))
  const star = (owner: string, target: string): Doc => ({ $id: id(`S${owner}${target}`), $ownerId: owner, repoId: target })
  const stars = [star('X1', id('RripgrepB')), star('X2', id('RripgrepB')), star('X3', id('RripgrepB')), star('X1', id('Rjq')), star('X2', id('Rdemo-05'))]
  const push = (target: string, at: number, n: number): Doc => ({ $id: id(`P${target}${n}`), $ownerId: OWNER_A, $createdAt: at, repoId: target })
  return {
    [FORGE.core]: {
      repo: repos,
      packManifest: [push(id('Rdemo-59'), NOW - 60_000, 1), push(id('RripgrepB'), NOW - 10_000, 1), push(id('Rdemo-58'), NOW - 30 * 86_400_000, 1)],
    },
    [FORGE.collab]: {
      star: stars,
      issue: [{ $id: id('I1'), repoId: id('RripgrepB') }, { $id: id('I2'), repoId: id('RripgrepB') }],
    },
    [DPNS]: {
      domain: [{ $id: id('D1'), label: 'burntsushi', normalizedParentDomainName: 'dash', records: { identity: OWNER_B } }],
    },
  }
}

const fresh = (): Seen => ({ composites: [], queries: [], counts: [], ranked: [] })
const names = (rs: readonly DiscoveredRepo[]): string[] => rs.map((r) => r.slug)
const requests = (s: Seen): number => s.composites.length + s.queries.length + s.counts.length + s.ranked.length

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
    // RC1 `repo.recent (visibility, $createdAt)`: public repos, paged on `$createdAt` within them.
    expect(seen.composites[0]?.where).toEqual([['visibility', '==', 'public']])
    expect(seen.composites[1]?.where).toEqual([['visibility', '==', 'public'], ['$createdAt', '<=', expect.any(Number)]])
    // The pushes lookup is ordered the way the node walks each page (drive's `page_direction`):
    // ascending on the all-`==` first page, the page's own `desc` once `$createdAt <=` bounds it.
    // Bonsia refused the later pages' composite when they were sent `asc` (a plain fallback,
    // without counts or names).
    const pushesOuter = (i: number) => seen.composites[i]?.subQueries.find((s) => s.documentType === 'packManifest')?.orderBy?.[0]
    expect(pushesOuter(0)).toEqual(['repoId', 'asc'])
    expect(pushesOuter(1)).toEqual(['repoId', 'desc'])
    expect(pushesOuter(2)).toEqual(['repoId', 'desc'])
  })
})

describe('pageWalk', () => {
  const recent = { field: '$createdAt', direction: 'desc' } as const
  it('walks ascending through an all-== prefix, whatever the order asks', () => {
    expect(pageWalk([['visibility', '==', 'public']], recent)).toBe('asc')
  })
  it('walks in the page order once the ordered field has a range', () => {
    expect(pageWalk([['visibility', '==', 'public'], ['$createdAt', '<=', 1]], recent)).toBe('desc')
    expect(pageWalk([['visibility', '==', 'public'], ['$createdAt', '<', 1]], recent)).toBe('desc')
    expect(pageWalk([['name', '>=', 'a'], ['name', '<', 'b']], { field: 'name', direction: 'asc' })).toBe('asc')
  })
})

describe('rankedRepos (C-1: proved ranked reads)', () => {
  it('most starred: one ranked read over every star, then the repos in ONE composite', async () => {
    const seen = fresh()
    const r = await rankedRepos(mockSdk(store(), seen), 'most-starred', { network: NET })
    // ripgrep 3; jq and demo-05 tie at 1, the larger repo id first (Rjq… > Rdemo…)
    expect(names(r.repos)).toEqual(['ripgrep', 'jq', 'demo-05'])
    expect(r.repos.map((x) => x.rankCount)).toEqual([3, 1, 1])
    expect(r.repos.map((x) => x.stars)).toEqual([3, 1, 1])
    expect(r.repos[0]?.pushedAt).toBe(NOW - 10_000)
    expect(r.missing).toBe(0)
    expect(requests(seen)).toBe(2)
    expect(seen.ranked[0]).toMatchObject({ documentTypeName: 'star', groupBy: 'repoId', aggregate: { type: 'count' }, direction: 'desc' })
    expect(seen.ranked[0]).not.toHaveProperty('timeRange')
    expect(seen.composites[0]).toMatchObject({ documentType: 'repo', where: [['$id', 'in', [id('RripgrepB'), id('Rjq'), id('Rdemo-05')]]] })
  })

  it('ranks past 100 stars (the bounded star read could not)', async () => {
    const s = store()
    const many = (target: string, n: number) => Array.from({ length: n }, (_, i) => ({ $id: id(`S${target}${i}`), $ownerId: id(`U${i}`), repoId: id(target) }))
    s[FORGE.collab]!['star'] = [...many('Rdemo-01', 150), ...many('RripgrepB', 120), ...many('Rjq', 3)]
    const r = await rankedRepos(mockSdk(s, fresh()), 'most-starred', { network: NET })
    expect(names(r.repos)).toEqual(['demo-01', 'ripgrep', 'jq'])
    expect(r.repos.map((x) => x.rankCount)).toEqual([150, 120, 3])
  })

  it('trending reads starBeat with the oldest (week) or newest (today) window', async () => {
    const s = store()
    s[FORGE.collab]!['starBeat'] = [{ $id: id('B1'), $ownerId: id('U1'), repoId: id('Rjq') }]
    const seen = fresh()
    const week = await rankedRepos(mockSdk(s, seen), 'week', { network: NET })
    await rankedRepos(mockSdk(s, seen), 'today', { network: NET })
    expect(names(week.repos)).toEqual(['jq'])
    expect(seen.ranked.map((q) => [q['documentTypeName'], (q['timeRange'] as { selector: string }[])[0]?.selector])).toEqual([
      ['starBeat', 'oldest'],
      ['starBeat', 'newest'],
    ])
  })

  it('most forked ranks repo.forkOf and drops the null group of repos that are not forks', async () => {
    const s = store()
    const fork = (name: string, of: string) => ({ $id: id(`F${name}`), $ownerId: OWNER_B, $createdAt: NOW - 1000, name, visibility: 'public', description: '', forkOf: id(of) })
    // Every stored repo without forkOf is the (largest) null group; jq has 2 forks, ripgrep 1.
    s[FORGE.core]!['repo'] = [...s[FORGE.core]!['repo']!, fork('jq-a', 'Rjq'), fork('jq-b', 'Rjq'), fork('rg-a', 'RripgrepB')]
    const seen = fresh()
    const r = await rankedRepos(mockSdk(s, seen), 'most-forked', { network: NET, limit: 2 })
    expect(names(r.repos)).toEqual(['jq', 'ripgrep'])
    expect(r.repos.map((x) => x.rankCount)).toEqual([2, 1])
    expect(seen.ranked[0]).toMatchObject({ documentTypeName: 'repo', groupBy: 'forkOf', limit: 3 })
    expect(requests(seen)).toBe(2)
  })

  it('an empty ranking costs one request and shows nothing', async () => {
    const s = store()
    s[FORGE.collab]!['starBeat'] = []
    const seen = fresh()
    const r = await rankedRepos(mockSdk(s, seen), 'week', { network: NET })
    expect(r.repos).toEqual([])
    expect(requests(seen)).toBe(1)
  })
})

describe('paging past a huge tie (review: a stall at >= 100 repos sharing a name)', () => {
  it('steps strictly past a boundary shared by more repos than one read, and says so', async () => {
    const s = store()
    const tie = Array.from({ length: 130 }, (_, i) => ({ ...repo('same', 1, id(`T${i}`)), $id: id(`RT${String(i).padStart(3, '0')}`) }))
    s[FORGE.core]!['repo'] = [...tie, repo('samf', 2), repo('samz', 3)]
    const seen = fresh()
    const sdk = mockSdk(s, seen)
    const all: string[] = []
    let skipped = false
    let page = await searchRepos(sdk, 'sam', { network: NET, limit: 24 })
    all.push(...names(page.repos))
    for (let i = 0; page.next !== null && i < 20; i++) {
      page = await searchRepos(sdk, 'sam', { network: NET, limit: 24, after: page.next })
      all.push(...names(page.repos))
      skipped ||= page.skippedTies
    }
    // It ends (no stall), reaches the names after the tie, and reports the skipped part.
    expect(page.next).toBeNull()
    expect(all).toContain('samf')
    expect(all).toContain('samz')
    expect(skipped).toBe(true)
    expect(new Set(all.filter((n) => n === 'same')).size).toBe(1)
    const last = seen.composites.find((c) => c.where?.some(([, op]) => op === '>'))
    expect(last?.where?.[0]).toEqual(['name', '>', 'same'])
  })
})

describe('the composite refused (an older node)', () => {
  function refusing(): EvoSDK {
    const base = mockSdk(store(), fresh()) as unknown as { documents: Record<string, unknown> }
    return {
      ...base,
      documents: {
        ...base.documents,
        composite: async () => {
          throw new Error("grpc error: code: 'Client specified an invalid argument'")
        },
      },
    } as unknown as EvoSDK
  }
  it('pages with one plain query, marked as the fallback', async () => {
    const page = await recentReposPage(refusing(), { network: NET })
    expect(page.repos).toHaveLength(24)
    expect(page.fallback).toBe(true)
    expect(page.repos[0]?.stars).toBeNull()
  })
  it('most starred still ranks, reading the ranked repos with one plain query', async () => {
    const r = await rankedRepos(refusing(), 'most-starred', { network: NET })
    expect(names(r.repos)).toEqual(['ripgrep', 'jq', 'demo-05'])
    expect(r.repos[0]?.stars).toBeNull()
  })
})

describe('recentlyUpdated', () => {
  it('keeps the copy with the newest push when a repo is in two lists', () => {
    const row = (key: string, pushedAt: number | null): DiscoveredRepo => ({ key, ownerId: OWNER_A, name: key, slug: key, description: '', createdAt: 0, visibility: 'public', pushedAt })
    const out = recentlyUpdated([[row('a', 5)], [row('a', 9)]])
    expect(out[0]?.pushedAt).toBe(9)
  })
  const row = (key: string, pushedAt: number | null): DiscoveredRepo => ({ key, ownerId: OWNER_A, name: key, slug: key, description: '', createdAt: 0, visibility: 'public', pushedAt })
  it('ranks the repos with a push, newest first, each once', () => {
    const out = recentlyUpdated([[row('a', 5), row('b', null), row('c', 9)], [row('a', 5), row('d', 7)]])
    expect(out.map((r) => r.key)).toEqual(['c', 'd', 'a'])
  })
})

describe('reposNamed (the jump box)', () => {
  it('says when more owners use a name than one read holds', async () => {
    const s = store()
    s[FORGE.core]!['repo'] = Array.from({ length: 25 }, (_, i) => repo('common', i, id(`Own${i}`)))
    const out = await reposNamed(mockSdk(s, fresh()), 'common', { network: NET })
    expect(out.repos).toHaveLength(20)
    expect(out.more).toBe(true)
  })
  it('finds every owner of a name in one composite', async () => {
    const seen = fresh()
    const out = await reposNamed(mockSdk(store(), seen), 'JQ', { network: NET })
    expect(out.repos.map((r) => r.ownerId).sort()).toEqual([OWNER_A, OWNER_B].sort())
    expect(out.more).toBe(false)
    expect(requests(seen)).toBe(1)
    expect(seen.composites[0]?.where).toEqual([['name', '==', 'jq']])
  })
  it('asks nothing for a word that cannot be a repo name', async () => {
    const seen = fresh()
    expect(await reposNamed(mockSdk(store(), seen), 'Not A Name!', { network: NET })).toEqual({ repos: [], more: false })
    expect(requests(seen)).toBe(0)
  })
})

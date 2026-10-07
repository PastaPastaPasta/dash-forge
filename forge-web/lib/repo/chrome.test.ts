/**
 * The repo chrome read (S-1): one composite resolves a repo and reads everything the chrome
 * shows; the append-only timelines are kept and re-read as deltas; a code page's pack list and a
 * PR list's base refs come from the same read. Against a Drive-shaped fake that serves both the
 * composite surface and plain queries, and counts every request.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The test build has no devnet deployment: give the devnet this file's forge ids.
vi.mock('../constants', async (importOriginal) => {
  const real = await importOriginal<typeof import('../constants')>()
  return { ...real, NETWORKS: { ...real.NETWORKS, devnet: { ...real.NETWORKS.devnet, v2: { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' } } } }
})

import type { ForgeIds } from '../deployments'
import { base64ToHex, bytesToBase64, hexToBase64, setPlatformVersion, type DocumentQuery } from '../sdk'
import { CHROME_KEYSET_SPLITS } from './refs'
import { loadRepoHome } from '../view/repo-view'
import { cachedDpnsName, clearDpnsCache } from '../view/dpns'
import { chromeFallbacks, readRepoChrome, repoTimelines, resetRepoTimelines, staleRepoTimelines } from './chrome'
import { baseRefReaders } from './issues'
import { invalidateMembers, readMembershipsCached } from './members'
import { noteTargetCreated } from './social'
import { readBrowseManifests } from './packs'
import { loadBrowseContextCached, peekBrowseState, resetBrowseCache, type BrowseState } from '../view/browse-source'
import { repoKey } from './contract'
import { readTargetCounts } from './social'
import type { RepoRef } from './contract'

type Doc = Record<string, unknown>
type Store = Record<string, Record<string, Doc[]>>

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const DPNS = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const TIP = 'ab'.repeat(20)
const mainHash = bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main')))

let seq = 0
const doc = (fields: Doc): Doc => {
  seq += 1
  return { $id: `id${String(seq).padStart(5, '0')}`, $createdAt: seq * 1000, ...fields }
}

/** A repo with `tags` tags (each one `refUpdate`), a config, one pack and one index fragment. */
function fixture(tags: number): Store {
  const ref = (name: string, oid: string): Doc =>
    doc({
      $ownerId: OWNER,
      repoId: REPO,
      refName: name,
      refNameHash: bytesToBase64(sha256(new TextEncoder().encode(name))),
      newOid: hexToBase64(oid),
    })
  return {
    CORE: {
      repo: [{ $id: REPO, $ownerId: OWNER, $createdAt: 1, name: 'demo', visibility: 'public', description: 'A repo' }],
      maintainer: [doc({ $ownerId: OWNER, repoId: REPO, memberId: OWNER })],
      writer: [],
      config: [doc({ $ownerId: OWNER, repoId: REPO, defaultBranch: 'main', protectedPatterns: [] })],
      refUpdate: [ref('refs/heads/main', TIP), ...Array.from({ length: tags }, (_, i) => ref(`refs/tags/v${i}`, 'cd'.repeat(20)))],
      protectedRefUpdate: [],
      packManifest: [
        doc({ $ownerId: OWNER, repoId: REPO, kind: 0, packHash: hexToBase64('11'.repeat(32)), sizeBytes: 10, objectCount: 3, chunkCount: 1, storage: 0 }),
      ],
    },
    COLLAB: {
      star: [doc({ $ownerId: OWNER, repoId: REPO }), doc({ $ownerId: 'x', repoId: REPO })],
      issue: [doc({ $ownerId: OWNER, repoId: REPO, number: 1 })],
      patch: [],
    },
    [DPNS]: { domain: [doc({ label: 'alice', normalizedParentDomainName: 'dash', records: { identity: OWNER } })] },
  }
}

const field = (d: Doc, f: string): unknown => f.split('.').reduce<unknown>((o, k) => (o as Doc | undefined)?.[k], d)

/** A byteArray field compares by its bytes (hex), as Drive's index does, not by its base64 text. */
const keyOf = (f: string, x: unknown): unknown => (f === 'refNameHash' && typeof x === 'string' ? base64ToHex(x) : x)

function filter(rows: Doc[], where: readonly (readonly unknown[])[] = []): Doc[] {
  return rows.filter((d) =>
    where.every(([f, op, v]) => {
      const x = keyOf(f as string, field(d, f as string)) as number
      const y = keyOf(f as string, v) as number
      if (op === '==') return x === y
      if (op === 'in') return (v as unknown[]).includes(x)
      if (op === '>=') return x >= y
      if (op === '>') return x > y
      throw new Error(`fake: ${String(op)}`)
    }),
  )
}

/** The `refState` index's order: `refNameHash` bytes, then `$createdAt`. */
const byHash = (a: Doc, b: Doc): number => {
  const x = base64ToHex(a['refNameHash'] as string)
  const y = base64ToHex(b['refNameHash'] as string)
  return x < y ? -1 : x > y ? 1 : byTime(a, b)
}

const byTime = (a: Doc, b: Doc): number => (a['$createdAt'] as number) - (b['$createdAt'] as number) || (String(a['$id']) < String(b['$id']) ? -1 : 1)

interface Fake {
  readonly sdk: EvoSDK
  readonly calls: string[]
  /** Set to a promise to hold every composite until it resolves (answers are computed after). */
  hold: Promise<void> | null
}

/** Plain queries and composites over `store`; `calls` records one entry per request. */
function fakeSdk(
  store: Store,
  {
    keyset = true,
    rangeAnswer,
  }: {
    readonly keyset?: boolean
    /** Rewrites (or throws on) the answer to a key-ordered (`refNameHash`) read. */
    readonly rangeAnswer?: (q: DocumentQuery, rows: Doc[]) => Doc[]
  } = {},
): Fake {
  const calls: string[] = []
  const fake: { hold: Promise<void> | null } = { hold: null }
  const rowsOf = (contract: string, type: string): Doc[] => [...(store[contract]?.[type] ?? [])]
  const plain = (q: DocumentQuery): Doc[] => {
    const keyed = q.orderBy?.[0]?.[0] === 'refNameHash'
    // `keyset: false`: a node that ignores a `refNameHash` order (answers in `$createdAt` order).
    const order = keyset && keyed ? byHash : byTime
    let rows = filter(rowsOf(q.dataContractId, q.documentTypeName), q.where).sort(order)
    if (q.startAfter !== undefined) rows = rows.slice(rows.findIndex((d) => d['$id'] === q.startAfter) + 1)
    rows = rows.slice(0, Math.min(q.limit ?? 100, 100))
    return keyed && rangeAnswer !== undefined ? rangeAnswer(q, rows) : rows
  }
  const wrap = (rows: Doc[]) => new Map(rows.map((d) => [String(d['$id']), d]))
  const sdk = {
    version: () => 14,
    documents: {
      query: async (q: DocumentQuery) => {
        calls.push(`query:${q.documentTypeName}`)
        return wrap(plain(q))
      },
      count: async (q: DocumentQuery) => {
        calls.push(`count:${q.documentTypeName}`)
        return new Map([['', BigInt(filter(rowsOf(q.dataContractId, q.documentTypeName), q.where).length)]])
      },
      composite: async (q: {
        dataContractId: string
        documentType: string
        where: unknown[][]
        limit: number
        subQueries: { dataContractId?: string; documentType: string; kind?: string; where?: unknown[][]; limit?: number; bind?: { sourceProperty: string; field: string } }[]
      }) => {
        calls.push(`composite:${q.documentType}`)
        expect(q.subQueries.length).toBeLessThanOrEqual(10)
        if (fake.hold !== null) await fake.hold
        const page = filter(rowsOf(q.dataContractId, q.documentType), q.where).slice(0, q.limit)
        const subResults = q.subQueries.map((s) => {
          const contract = s.dataContractId ?? q.dataContractId
          const values = s.bind ? page.map((d) => field(d, s.bind!.sourceProperty)) : []
          const rows = filter(rowsOf(contract, s.documentType), [...(s.where ?? []), ...(s.bind ? [[s.bind.field, 'in', values]] : [])]).sort(byTime)
          if (s.kind === 'counts') {
            const counts = new Map<string, bigint>()
            for (const v of values) {
              const n = rows.filter((d) => field(d, s.bind!.field) === v).length
              if (n > 0) counts.set(String(v), BigInt(n))
            }
            return { kind: 'counts', counts }
          }
          return { kind: 'documents', documents: rows.slice(0, s.limit ?? 100) }
        })
        return { pageDocuments: page, subResults }
      },
    },
    dpns: { resolveName: async () => undefined },
  } as unknown as EvoSDK
  return Object.assign(fake, { sdk, calls })
}

const REF: RepoRef = { forge: FORGE, repoId: REPO, ownerId: OWNER, name: 'demo', visibility: 'public' }

beforeEach(() => {
  setPlatformVersion(14)
  resetRepoTimelines()
  clearDpnsCache()
  invalidateMembers(REF, 'devnet')
})
afterEach(() => resetRepoTimelines())

describe('repo chrome: one composite for the whole chrome', () => {
  it('resolves the repo, counts, members, timelines and the owner name in ONE request', async () => {
    const { sdk, calls } = fakeSdk(fixture(3))
    const chrome = await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet')
    expect(chrome?.repo.repoId).toBe(REPO)
    expect(chrome?.starCount).toBe(2)
    const t = await chrome!.read!.all()
    expect(t.refUpdate).toHaveLength(4)
    expect(t.config).toHaveLength(1)
    expect(t.packManifest).toHaveLength(1)
    expect(calls).toEqual(['composite:repo'])
    // What it proved answers the header's totals and the member cache without another request.
    expect(await readTargetCounts(sdk, FORGE, REPO)).toEqual({ issues: 1, pulls: 0 })
    expect((await readMembershipsCached(sdk, REF, 'devnet')).map((m) => m.identity)).toEqual([OWNER])
    expect(calls).toEqual(['composite:repo'])
  })

  it('a missing repo is null', async () => {
    const { sdk } = fakeSdk(fixture(0))
    expect(await readRepoChrome(sdk, FORGE, OWNER, 'nope', 'devnet')).toBeNull()
  })

  it('a ref timeline past one page is read on as key ranges side by side (QW-087)', async () => {
    const { sdk, calls } = fakeSdk(fixture(250))
    const t = await (await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet'))!.read!.all()
    expect(t.refUpdate).toHaveLength(251)
    expect(new Set(t.refUpdate.map((d) => d['$id'])).size).toBe(251)
    // Oldest first, as the `$createdAt` pages were.
    const times = t.refUpdate.map((d) => d['$createdAt'] as number)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    // The composite's first page, then one page per key range, all sent at once: one round trip
    // where ⌈251/100⌉ − 1 = 2 continuation pages went one after the other (six on dashpay/dash).
    expect(calls).toEqual(['composite:repo', ...Array<string>(CHROME_KEYSET_SPLITS).fill('query:refUpdate')])
  })

  it('a node that does not honor the key ranges: read on to the end with plain pages', async () => {
    const { sdk, calls } = fakeSdk(fixture(250), { keyset: false })
    const t = await (await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet'))!.read!.all()
    expect(t.refUpdate).toHaveLength(251)
    expect(new Set(t.refUpdate.map((d) => d['$id'])).size).toBe(251)
    // The ranges were refused, then ⌈251/100⌉ − 1 = 2 continuation pages.
    expect(calls.slice(-2)).toEqual(['query:refUpdate', 'query:refUpdate'])
  })

  /**
   * `tags` tags each created then moved (the move's `prevOid` is the creation's `newOid`), so a
   * lost creation is a missing parent; plus `main` (one plain update, {@link TIP}). `protectedMoves`:
   * each move is a `protectedRefUpdate` whose parent is the plain creation.
   */
  function movedTags(tags: number, protectedMoves = false): { store: Store; creations: Doc[] } {
    const store = fixture(0)
    const creations: Doc[] = []
    for (let i = 0; i < tags; i++) {
      const refName = `refs/tags/m${i}`
      const refNameHash = bytesToBase64(sha256(new TextEncoder().encode(refName)))
      const first = hexToBase64(i.toString(16).padStart(40, '0'))
      const created = doc({ $ownerId: OWNER, repoId: REPO, refName, refNameHash, newOid: first })
      creations.push(created)
      store.CORE!.refUpdate!.push(created)
      const move = doc({ $ownerId: OWNER, repoId: REPO, refName, refNameHash, prevOid: first, newOid: hexToBase64('ee'.repeat(20)), force: true })
      store.CORE![protectedMoves ? 'protectedRefUpdate' : 'refUpdate']!.push(move)
    }
    return { store, creations }
  }

  it('key ranges that lost a row (in order, so not refused) fail the parent check: read the plain way', async () => {
    const { store, creations } = movedTags(120)
    // A creation the composite's first page does not hold, so only the ranges could have read it.
    const lost = creations[100]!['$id']
    const { sdk, calls } = fakeSdk(store, { rangeAnswer: (_q, rows) => rows.filter((d) => d['$id'] !== lost) })
    const t = await (await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet'))!.read!.all()
    expect(t.refUpdate).toHaveLength(241)
    expect(t.refUpdate.map((d) => d['$id'])).toContain(lost)
    // The ranges, then the `$createdAt` continuation of the composite's page: ⌈241/100⌉ − 1 = 2.
    expect(calls).toEqual(['composite:repo', ...Array<string>(CHROME_KEYSET_SPLITS + 2).fill('query:refUpdate')])
  })

  it('a key range that fails outright: read the plain way, not fail the timeline', async () => {
    let first = true
    const { sdk, calls } = fakeSdk(fixture(250), {
      rangeAnswer: (_q, rows) => {
        if (first) {
          first = false
          throw new Error('node down')
        }
        return rows
      },
    })
    const t = await (await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet'))!.read!.all()
    expect(t.refUpdate).toHaveLength(251)
    expect(new Set(t.refUpdate.map((d) => d['$id'])).size).toBe(251)
    expect(calls).toEqual(['composite:repo', ...Array<string>(CHROME_KEYSET_SPLITS + 2).fill('query:refUpdate')])
  })

  it('protected updates whose parents are plain updates are whole: the check groups both types, so no re-read', async () => {
    // Both types past a page, both read as ranges; checked per type, every move would lack its parent.
    const { store } = movedTags(120, true)
    const { sdk, calls } = fakeSdk(store)
    const t = await (await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet'))!.read!.all()
    expect(t.refUpdate).toHaveLength(121)
    expect(t.protectedRefUpdate).toHaveLength(120)
    expect([...calls].sort()).toEqual(
      ['composite:repo', ...Array<string>(CHROME_KEYSET_SPLITS).fill('query:protectedRefUpdate'), ...Array<string>(CHROME_KEYSET_SPLITS).fill('query:refUpdate')].sort(),
    )
  })

  it('a later read asks only for what is new, and keeps what it held', async () => {
    const store = fixture(250)
    const { sdk, calls } = fakeSdk(store)
    await (await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet'))!.read!.all()
    calls.length = 0
    store.CORE!.refUpdate!.push(doc({ $ownerId: OWNER, repoId: REPO, refName: 'refs/heads/main', refNameHash: mainHash, newOid: hexToBase64('ef'.repeat(20)) }))
    const t = await (await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet'))!.read!.all()
    expect(t.refUpdate).toHaveLength(252)
    // One request, whatever the history's size: the delta fits the composite's page.
    expect(calls).toEqual(['composite:repo'])
  })

  it('the home is built from the chrome read alone, the owner name cached with it', async () => {
    const { sdk, calls } = fakeSdk(fixture(3))
    const home = await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    expect(home?.defaultBranch).toBe('main')
    expect(home?.branches.map((b) => b.refName)).toEqual(['refs/heads/main'])
    expect(home?.tags).toHaveLength(3)
    expect(home?.starCount).toBe(2)
    expect(cachedDpnsName('devnet', OWNER)).toBe('alice.dash')
    expect(calls).toEqual(['composite:repo'])
  })
})

describe('repo chrome store: the pack list and base refs come from the same read', () => {
  it('a code page right after the home reads its pack list with no request', async () => {
    const { sdk, calls } = fakeSdk(fixture(3))
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    calls.length = 0
    const manifests = await readBrowseManifests(sdk, REF, { network: 'devnet' })
    expect(manifests).toHaveLength(1)
    expect(manifests[0]?.ownerRole).toBe('maintainer')
    expect(calls).toEqual([])
  })

  it('the browse prefetch the home starts on resolve joins the timelines still being read', async () => {
    // 250 tags: the ref timeline is still paging when the repo resolves.
    const { sdk, calls } = fakeSdk(fixture(250))
    let prefetch: Promise<unknown> | undefined
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' }, (repo) => {
      prefetch = readBrowseManifests(sdk, repo, { network: 'devnet' })
    })
    expect(await prefetch).toHaveLength(1)
    expect(calls.filter((c) => c.includes('packManifest') || c.startsWith('composite'))).toEqual(['composite:repo'])
  })

  it('a re-resolve of the list the last read gave reads again, for the delta only', async () => {
    const store = fixture(3)
    const { sdk, calls } = fakeSdk(store)
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    const checked = Date.now()
    calls.length = 0
    store.CORE!.packManifest!.push(newPack('22'))
    const manifests = await readBrowseManifests(sdk, REF, { after: checked, network: 'devnet' })
    expect(manifests).toHaveLength(2)
    expect(calls).toEqual(['composite:repo'])
  })

  it("this tab's write makes the store stale: the next reader reads again", async () => {
    const { sdk, calls } = fakeSdk(fixture(3))
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    staleRepoTimelines(REF)
    calls.length = 0
    await repoTimelines(sdk, REF, { network: 'devnet' })
    expect(calls).toEqual(['composite:repo'])
  })

  it('a PR page right after the home folds its base ref from the store; after its own write, from a delta read (L-77)', async () => {
    const { sdk, calls } = fakeSdk(fixture(3))
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    calls.length = 0
    const base = baseRefReaders(sdk, REF)
    expect(await base.refUpdates(mainHash)).toHaveLength(1)
    expect(await base.configHistory()).toHaveLength(1)
    expect(calls).toEqual([]) // no refUpdate, protectedRefUpdate or config read
    // The detail page re-reads after a merge with `fresh`: one delta composite, not three reads.
    const fresh = baseRefReaders(sdk, REF, { maxAgeMs: 0 })
    await Promise.all([fresh.refUpdates(mainHash), fresh.configHistory()])
    expect(calls).toEqual(['composite:repo'])
  })

  it('a repo never read through the chrome falls back to the plain reads', async () => {
    const { sdk } = fakeSdk(fixture(3))
    expect(await repoTimelines(sdk, REF, { network: 'devnet' })).toBeNull()
    expect(await readBrowseManifests(sdk, REF, { network: 'devnet' })).toHaveLength(1)
  })

  it('a name that now names another repo is read from the start, not merged into the old one', async () => {
    const store = fixture(3)
    const { sdk } = fakeSdk(store)
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    const NEW = 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h'
    store.CORE!.repo = [{ $id: NEW, $ownerId: OWNER, $createdAt: 2, name: 'demo', visibility: 'public' }]
    const chrome = await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet')
    expect(chrome?.repo.repoId).toBe(NEW)
    expect((await chrome!.read!.all()).refUpdate).toEqual([])
  })
})

describe('an issue or PR list reads the default branch alone, not every ref', () => {
  const devHash = bytesToBase64(sha256(new TextEncoder().encode('refs/heads/dev')))
  const branch = (name: string): Doc =>
    doc({ $ownerId: OWNER, repoId: REPO, refName: name, refNameHash: bytesToBase64(sha256(new TextEncoder().encode(name))), newOid: hexToBase64('fe'.repeat(20)) })
  const listHome = (sdk: EvoSDK) => loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' }, undefined, { refs: 'default' })

  it("a ref timeline past one page: the home folds the default branch from that ref's own read (1 request, not 8)", async () => {
    const { sdk, calls } = fakeSdk(fixture(250))
    const home = await listHome(sdk)
    // `main`'s own history (the protected page came back short, so it is whole): no key ranges.
    expect(calls).toEqual(['composite:repo', 'query:refUpdate'])
    expect(home?.defaultBranch).toBe('main')
    expect(home?.branches.map((b) => b.refName)).toEqual(['refs/heads/main'])
    expect(home?.tags).toEqual([])
    expect(home?.refsPartial).toBe(true)
    // The same fold the full home makes of it.
    const full = await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    expect(home?.branches[0]?.state).toEqual(full?.branches.find((b) => b.refName === 'refs/heads/main')?.state)
  })

  it("the PR list's base refs: the default branch costs nothing more, another base one read, each once", async () => {
    const store = fixture(250)
    store.CORE!.refUpdate!.push(branch('refs/heads/dev'))
    const { sdk, calls } = fakeSdk(store)
    await listHome(sdk)
    calls.length = 0
    const base = baseRefReaders(sdk, REF)
    expect(await base.refUpdates(mainHash)).toHaveLength(1)
    expect(await base.configHistory()).toHaveLength(1)
    expect(calls).toEqual([])
    expect(await base.refUpdates(devHash)).toHaveLength(1)
    expect(await baseRefReaders(sdk, REF).refUpdates(devHash)).toHaveLength(1)
    expect(calls).toEqual(['query:refUpdate'])
  })

  it('a PR list with many base branches reads four alone, then the whole timelines once', async () => {
    const store = fixture(250)
    const devs = [0, 1, 2, 3, 4].map((i) => `refs/heads/dev${i}`)
    for (const name of devs) store.CORE!.refUpdate!.push(branch(name))
    const { sdk, calls } = fakeSdk(store)
    await listHome(sdk) // `main`, read alone: the first of four
    calls.length = 0
    const base = baseRefReaders(sdk, REF)
    for (const name of devs) {
      expect(await base.refUpdates(bytesToBase64(sha256(new TextEncoder().encode(name))))).toHaveLength(1)
    }
    // dev0..dev2 alone; dev3 is the fifth: the key ranges, which dev4 then reads from too.
    expect(calls).toEqual(Array<string>(3 + CHROME_KEYSET_SPLITS).fill('query:refUpdate'))
  })

  it('a full page after the list: its home reads the whole timelines then (the cost moves, it is not saved)', async () => {
    const { sdk, calls } = fakeSdk(fixture(250))
    await listHome(sdk)
    calls.length = 0
    const home = await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    expect(home?.tags).toHaveLength(250)
    expect(calls).toEqual(['composite:repo', ...Array<string>(CHROME_KEYSET_SPLITS).fill('query:refUpdate')])
  })

  it('a long pack list but short ref timelines: every ref from the composite, the pack list not read on', async () => {
    const store = fixture(3)
    for (let i = 0; i < 120; i++) store.CORE!.packManifest!.push(newPack((i % 200).toString(16).padStart(2, '0')))
    const { sdk, calls } = fakeSdk(store)
    const home = await listHome(sdk)
    expect(home?.refsPartial).toBeUndefined()
    expect(home?.tags).toHaveLength(3)
    expect(calls).toEqual(['composite:repo'])
  })

  it('a short ref timeline: the full home, which costs no request either', async () => {
    const { sdk, calls } = fakeSdk(fixture(3))
    const home = await listHome(sdk)
    expect(home?.refsPartial).toBeUndefined()
    expect(home?.tags).toHaveLength(3)
    expect(calls).toEqual(['composite:repo'])
  })

  it('a default branch that does not resolve: the full home decides', async () => {
    const store = fixture(250)
    store.CORE!.config = [doc({ $ownerId: OWNER, repoId: REPO, defaultBranch: 'trunk', protectedPatterns: [] })]
    const { sdk, calls } = fakeSdk(store)
    const home = await listHome(sdk)
    expect(home?.refsPartial).toBeUndefined()
    expect(home?.tags).toHaveLength(250)
    expect(calls).toEqual(['composite:repo', ...Array<string>(1 + CHROME_KEYSET_SPLITS).fill('query:refUpdate')])
  })

  it('a code page after the list reads the rest on from the stored pages, with no second composite', async () => {
    const { sdk, calls } = fakeSdk(fixture(250))
    await listHome(sdk)
    calls.length = 0
    const t = await repoTimelines(sdk, REF, { network: 'devnet' })
    expect(t?.refUpdate).toHaveLength(251)
    expect(calls).toEqual(Array<string>(CHROME_KEYSET_SPLITS).fill('query:refUpdate'))
    // Once read on, a ref comes from the whole timelines.
    calls.length = 0
    expect((await (await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet'))!.read!.ref(mainHash)).refUpdate).toHaveLength(1)
    expect(calls).toEqual(['composite:repo'])
  })

  it('a failed ref read is not kept: the next reader reads again', async () => {
    const { sdk, calls } = fakeSdk(fixture(250))
    const chrome = (await readRepoChrome(sdk, FORGE, OWNER, 'demo', 'devnet'))!
    const query = (sdk.documents.query as unknown as (q: DocumentQuery) => Promise<unknown>).bind(sdk.documents)
    let fail = true
    ;(sdk as unknown as { documents: { query: unknown } }).documents.query = async (q: DocumentQuery) => {
      if (fail) {
        fail = false
        calls.push('query:failed')
        throw new Error('node down')
      }
      return query(q)
    }
    await expect(chrome.read!.ref(mainHash)).rejects.toThrow('node down')
    expect((await chrome.read!.ref(mainHash)).refUpdate).toHaveLength(1)
    expect(calls).toEqual(['composite:repo', 'query:failed', 'query:refUpdate'])
  })
})

/** A pack pushed since (another user's push). */
function newPack(hash: string): Doc {
  return doc({ $ownerId: OWNER, repoId: REPO, kind: 0, packHash: hexToBase64(hash.repeat(32)), sizeBytes: 5, objectCount: 1, chunkCount: 1, storage: 0 })
}

describe('a re-resolve takes a read issued after the list it checks (D-11)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    resetBrowseCache()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetBrowseCache()
  })

  it("the home's read of a moment ago, issued after the list was read, answers it with no request", async () => {
    const store = fixture(3)
    const { sdk, calls } = fakeSdk(store)
    const checked = Date.now()
    vi.setSystemTime(checked + 31_000)
    store.CORE!.packManifest!.push(newPack('22'))
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    vi.setSystemTime(Date.now() + 150)
    calls.length = 0
    expect(await readBrowseManifests(sdk, REF, { after: checked, network: 'devnet' })).toHaveLength(2)
    expect(calls).toEqual([])
  })

  it('the read issued in the same millisecond the list was checked is the one it checks: read again', async () => {
    const { sdk, calls } = fakeSdk(fixture(3))
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    const checked = Date.now()
    calls.length = 0
    await readBrowseManifests(sdk, REF, { after: checked, network: 'devnet' })
    expect(calls).toEqual(['composite:repo'])
  })

  it('a read issued after the list but older than the store keeps a read fresh is not taken', async () => {
    const { sdk, calls } = fakeSdk(fixture(3))
    const checked = Date.now()
    vi.setSystemTime(checked + 1)
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    vi.setSystemTime(Date.now() + 5_000)
    calls.length = 0
    await readBrowseManifests(sdk, REF, { after: checked, network: 'devnet' })
    expect(calls).toEqual(['composite:repo'])
  })

  it("after another user's push, the home's revalidation and the browse revalidation behind it cost ONE composite", async () => {
    const store = fixture(3)
    const { sdk, calls } = fakeSdk(store)
    const packs = (s: BrowseState | undefined): number | undefined => (s?.kind === 'unindexed' ? s.manifests.size : undefined)
    const reads = (): string[] => calls.filter((c) => c.startsWith('composite') || c.includes('packManifest'))
    // The tab opens the repo: the home's composite, and the browse context from the store.
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    expect(packs(await loadBrowseContextCached(sdk, REF))).toBe(1)
    expect(reads()).toEqual(['composite:repo'])
    // Someone else pushes; 31 s later the tab navigates: the home revalidates (one composite)...
    store.CORE!.packManifest!.push(newPack('22'))
    vi.setSystemTime(Date.now() + 31_000)
    calls.length = 0
    await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    vi.setSystemTime(Date.now() + 150)
    // ...and the page's browse context, served stale, re-resolves from that read, not a second one.
    expect(packs(await loadBrowseContextCached(sdk, REF))).toBe(1)
    await vi.waitFor(() => expect(packs(peekBrowseState(repoKey(REF)))).toBe(2))
    expect(reads()).toEqual(['composite:repo'])
  })
})

describe('the store never answers across this tab\'s own write (review M1, L1, L3)', () => {
  it('a composite in flight when this tab writes neither answers a later reader nor is kept', async () => {
    const store = fixture(3)
    const fake = fakeSdk(store)
    await loadRepoHome(fake.sdk, { network: 'devnet', owner: OWNER, name: 'demo' })
    // A revalidation goes out and is held...
    let release!: () => void
    fake.hold = new Promise((r) => (release = r))
    const before = readRepoChrome(fake.sdk, FORGE, OWNER, 'demo', 'devnet')
    await Promise.resolve()
    // ...this tab pushes a pack...
    store.CORE!.packManifest!.push(doc({ $ownerId: OWNER, repoId: REPO, kind: 0, packHash: hexToBase64('33'.repeat(32)), sizeBytes: 5, objectCount: 1, chunkCount: 1, storage: 0 }))
    staleRepoTimelines(REF)
    fake.calls.length = 0
    // ...and the browse context asks for the pack list: a new composite, not the held one.
    fake.hold = null
    const after = readBrowseManifests(fake.sdk, REF, { network: 'devnet' })
    release()
    await before
    expect(await after).toHaveLength(2)
    expect(fake.calls.filter((c) => c.startsWith('composite'))).toEqual(['composite:repo'])
    // And the held read did not become the store's answer.
    fake.calls.length = 0
    expect(await readBrowseManifests(fake.sdk, REF, { network: 'devnet' })).toHaveLength(2)
    expect(fake.calls).toEqual([])
  })

  it('a member change while the chrome read is out does not seed the old membership', async () => {
    const store = fixture(3)
    const fake = fakeSdk(store)
    let release!: () => void
    fake.hold = new Promise((r) => (release = r))
    const read = readRepoChrome(fake.sdk, FORGE, OWNER, 'demo', 'devnet')
    await Promise.resolve()
    store.CORE!.writer!.push(doc({ $ownerId: OWNER, repoId: REPO, memberId: 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h' }))
    invalidateMembers(REF, 'devnet')
    release()
    await read
    fake.hold = null
    fake.calls.length = 0
    expect(await readMembershipsCached(fake.sdk, REF, 'devnet')).toHaveLength(2)
    expect(fake.calls.some((c) => c === 'query:writer')).toBe(true)
  })

  it('a newer chrome read lands a revoked writer over a young cached membership', async () => {
    const store = fixture(3)
    const WRITER = 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h'
    store.CORE!.writer!.push(doc({ $ownerId: OWNER, repoId: REPO, memberId: WRITER }))
    const fake = fakeSdk(store)
    expect(await readMembershipsCached(fake.sdk, REF, 'devnet')).toHaveLength(2)
    // Revoked (its document deleted) a moment later, well inside the cache's lifetime.
    store.CORE!.writer = []
    await readRepoChrome(fake.sdk, FORGE, OWNER, 'demo', 'devnet')
    fake.calls.length = 0
    expect((await readMembershipsCached(fake.sdk, REF, 'devnet')).map((m) => m.identity)).toEqual([OWNER])
    expect(fake.calls).toEqual([])
  })

  it('an issue created after the chrome read was issued: the header counts again', async () => {
    const fake = fakeSdk(fixture(3))
    await readRepoChrome(fake.sdk, FORGE, OWNER, 'demo', 'devnet')
    noteTargetCreated(REF, 'issue')
    fake.calls.length = 0
    await readTargetCounts(fake.sdk, FORGE, REPO, { retryMs: 1 })
    expect(fake.calls).toContain('count:issue')
    expect(fake.calls).not.toContain('count:patch')
  })
})

describe('the store stays bounded, and refusals are counted', () => {
  it('keeps the 20 most recently read repos', async () => {
    const store = fixture(0)
    for (let i = 0; i < 25; i++) store.CORE!.repo!.push({ $id: `R${String(i).padStart(43, '1')}`, $ownerId: OWNER, $createdAt: 1, name: `r${i}`, visibility: 'public' })
    const fake = fakeSdk(store)
    for (let i = 0; i < 25; i++) await (await readRepoChrome(fake.sdk, FORGE, OWNER, `r${i}`, 'devnet'))!.read!.all()
    const oldest: RepoRef = { forge: FORGE, repoId: `R${'0'.padStart(43, '1')}`, ownerId: OWNER, name: 'r0', visibility: 'public' }
    const newest: RepoRef = { ...oldest, repoId: `R${'24'.padStart(43, '1')}`, name: 'r24' }
    expect(await repoTimelines(fake.sdk, oldest, { network: 'devnet' })).toBeNull()
    expect(await repoTimelines(fake.sdk, newest, { network: 'devnet' })).not.toBeNull()
  })

  it('a refused composite is answered by plain queries and counted', async () => {
    const fake = fakeSdk(fixture(3))
    ;(fake.sdk as unknown as { documents: { composite: unknown } }).documents.composite = async () => {
      throw new Error('invalid argument: unsupported sub-query')
    }
    const chrome = await readRepoChrome(fake.sdk, FORGE, OWNER, 'demo', 'devnet')
    expect(chrome?.repo.repoId).toBe(REPO)
    expect((await chrome!.read!.all()).refUpdate).toHaveLength(4)
    expect(chromeFallbacks()).toBe(1)
  })
})

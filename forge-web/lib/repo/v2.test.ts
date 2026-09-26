/**
 * forge-v2 read path against a mock SDK that behaves like Drive where it matters: it applies
 * every `where` clause (so a reader that forgets `repoId ==` reads another repo's documents
 * and fails here), honours `in`, caps pages at 100 and pages by `startAfter`.
 *
 * Covers: resolution (the `repo` document, DPNS owners, `?repo=` pins), the RepoSource
 * query shapes, the issue/PR folds over `event` + `authorEvent` (lists read the repo feed once
 * instead of per row), the well-formedness filter, membership-derived permissions and
 * approvals, pack-copy selection, and the chunk reads that must name the uploader.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Decode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { bytesToBase64, hexToBase64, type DocumentQuery } from '../sdk'
import { loadIssueThread, loadPullThread } from '../view/issues-view'
import {
  holdingsOfRole,
  invalidateMembers,
  invalidateRepoFeed,
  listIssues,
  listPulls,
  readConfigBundle,
  readRefs,
  readViewerPermissions,
  repoContractIds,
  repoKey,
  repoSource,
  resolveAnyRepo,
  resolveAnyRepoWith,
  packsOfKind,
  wellFormed,
  type PackManifest,
  type RepoRef,
} from './index'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', group: 'GROUP' }
// Real-shaped base58 ids (32 bytes): the resolver tells ids from DPNS names by decoding them.
const OWNER = '9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD'
const MAINT = 'GKBTXUdo3MpRYAUqgZvTZGTav9mXGqfJfR5822K2tp79'
const WRITER = '6jAyDGGcc6fgA7bsraQPriTAZ73Lkq5QgnenaRhqteHd'
const AUTHOR = 'Dd1m1JJM3M5DjBaXaCbC5hXBsU6248KHpGcBAtaHsqc7'
const STRANGER = 'A15PpcywDNf4KdQ5rmAqcYUHPJddahyXR33in5PsCE7j'
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OTHER_REPO = 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h'
const HEAD = 'ab'.repeat(20)
const REPO_ISSUE2 = 'EiaSVsG5gm6aLBXjodmJNmQRVcmwUbvon1YiFGKc64by'

const DEMO: RepoRef = {
  forge: FORGE,
  repoId: REPO,
  ownerId: OWNER,
  name: 'demo',
  visibility: 'public',
}

type Doc = Record<string, unknown>
type Store = Record<string, Record<string, Doc[]>>

function matches(doc: Doc, [field, op, value]: readonly [string, string, unknown]): boolean {
  const v = doc[field]
  switch (op) {
    case '==':
      return v === value
    case 'in':
      return Array.isArray(value) && value.includes(v)
    case '<=':
      return (v as number) <= (value as number)
    case '>':
      return typeof v === 'string' && typeof value === 'string' ? v > value : (v as number) > (value as number)
    default:
      throw new Error(`mock: unsupported operator ${op}`)
  }
}

/** A Drive-shaped mock over `store[contractId][documentType]`. */
function mockSdk(store: Store, seen: DocumentQuery[] = [], dpns: Record<string, string> = {}): EvoSDK {
  const query = (q: DocumentQuery): Promise<Map<string, Doc>> => {
    seen.push(q)
    let rows = [...(store[q.dataContractId]?.[q.documentTypeName] ?? [])]
    for (const w of q.where ?? []) rows = rows.filter((d) => matches(d, w as [string, string, unknown]))
    const order = q.orderBy ?? []
    const last = order[order.length - 1]
    rows.sort((a, b) => {
      for (const [field] of order) {
        const av = a[field] as number | string
        const bv = b[field] as number | string
        if (av !== bv) return av < bv ? -1 : 1
      }
      return String(a['$id']) < String(b['$id']) ? -1 : 1
    })
    if (last?.[1] === 'desc') rows.reverse()
    if (q.startAfter !== undefined) {
      const at = rows.findIndex((d) => d['$id'] === q.startAfter)
      rows = rows.slice(at + 1)
    }
    rows = rows.slice(0, Math.min(q.limit ?? 100, 100))
    return Promise.resolve(new Map(rows.map((d) => [String(d['$id']), d])))
  }
  return {
    documents: {
      query,
      count: async (q: DocumentQuery) => new Map([['', BigInt((await query({ ...q, limit: 100 })).size)]]),
    },
    dpns: { resolveName: async (name: string) => dpns[name] },
  } as unknown as EvoSDK
}

let seq = 0
function doc(fields: Doc): Doc {
  seq += 1
  return { $id: `id${String(seq).padStart(4, '0')}`, $createdAt: seq * 1000, ...fields }
}

function repoDoc(repoId: string, ownerId: string, name: string, extra: Doc = {}): Doc {
  return { $id: repoId, $ownerId: ownerId, $createdAt: 1, name, visibility: 'public', ...extra }
}

/** A small public repo with members, an issue per fold case, and a PR. */
function fixture(): Store {
  const member = (role: string, id: string, at: number): Doc =>
    doc({ $ownerId: OWNER, repoId: REPO, memberId: id, $createdAt: at, role })
  const issue = (n: number, author: string, extra: Doc = {}): Doc =>
    doc({ $id: `issue${n}`, $ownerId: author, repoId: REPO, number: n, title: `Issue ${n}`, ...extra })
  const ev = (targetId: string, n: number, actor: string, kind: number, extra: Doc = {}): Doc =>
    doc({ $ownerId: actor, repoId: REPO, targetId, targetNumber: n, kind, ...extra })
  return {
    CORE: {
      repo: [repoDoc(REPO, OWNER, 'demo'), repoDoc(OTHER_REPO, MAINT, 'other')],
      maintainer: [member('maintainer', OWNER, 5), member('maintainer', MAINT, 5)],
      writer: [member('writer', WRITER, 5)],
      config: [doc({ $ownerId: OWNER, repoId: REPO, defaultBranch: 'main', protectedPatterns: ['refs/heads/main'] })],
      protectedRefUpdate: [
        doc({
          $ownerId: OWNER,
          repoId: REPO,
          refName: 'refs/heads/main',
          refNameHash: bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main'))),
          newOid: hexToBase64(HEAD),
        }),
      ],
      // Another repo's ref under the same name: a reader without `repoId ==` would fold it.
      refUpdate: [
        doc({
          $ownerId: MAINT,
          repoId: OTHER_REPO,
          refName: 'refs/heads/main',
          refNameHash: bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main'))),
          newOid: hexToBase64('cd'.repeat(20)),
        }),
      ],
    },
    COLLAB: {
      issue: [
        issue(1, AUTHOR),
        issue(2, AUTHOR),
        issue(3, AUTHOR),
        // Not well-formed in a public repo (ciphertext): skipped everywhere.
        issue(4, STRANGER, { title: '', enc: bytesToBase64(new Uint8Array(32)), epoch: 0 }),
        doc({ $id: 'elsewhere', $ownerId: AUTHOR, repoId: OTHER_REPO, number: 1, title: 'not ours' }),
      ],
      event: [
        ev('issue1', 1, MAINT, 4, { value: 'bug' }),
        ev('issue3', 3, WRITER, 1),
        ev('patch1', 1, MAINT, 3, { oid: hexToBase64(HEAD) }),
      ],
      authorEvent: [
        ev('issue2', 2, AUTHOR, 1),
        // An author event by someone else cannot exist on chain; the fold ignores it anyway.
        ev('issue1', 1, STRANGER, 1),
      ],
      patch: [
        doc({
          $id: 'patch1',
          $ownerId: WRITER,
          repoId: REPO,
          number: 1,
          title: 'A PR',
          baseRefName: 'refs/heads/main',
          baseRefNameHash: bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main'))),
          headOid: hexToBase64(HEAD),
          sourceRepoId: REPO,
        }),
      ],
      review: [
        doc({ $ownerId: MAINT, repoId: REPO, patchId: 'patch1', verdict: 1, commitOid: hexToBase64(HEAD) }),
        doc({ $ownerId: STRANGER, repoId: REPO, patchId: 'patch1', verdict: 1, commitOid: hexToBase64(HEAD) }),
      ],
      comment: [doc({ $ownerId: MAINT, repoId: REPO, targetId: 'issue1', body: 'Seen.' })],
    },
  }
}

describe('RepoSource', () => {
  it('scopes v2 list queries by repoId and routes types to their contract', () => {
    const s = repoSource(DEMO)
    expect(s.repoQuery('refUpdate', { orderBy: [['$createdAt', 'asc']] })).toEqual({
      dataContractId: 'CORE',
      documentTypeName: 'refUpdate',
      where: [['repoId', '==', REPO]],
      orderBy: [['$createdAt', 'asc']],
    })
    expect(s.repoQuery('issue').dataContractId).toBe('COLLAB')
    expect(s.repoQuery('authorEvent').dataContractId).toBe('COLLAB')
    expect(s.repoQuery('maintainer').dataContractId).toBe('CORE')
    // Target-keyed reads carry no prefix: the target id already names one repo's document.
    expect(s.targetQuery('comment', { where: [['targetId', '==', 't']] }).where).toEqual([['targetId', '==', 't']])
  })

  it('names the uploader in a chunk read', () => {
    const q = repoSource(DEMO).chunkQuery('aa'.repeat(32), MAINT, [0, 1])
    expect(q.where).toEqual([
      ['repoId', '==', REPO],
      ['$ownerId', '==', MAINT],
      ['packHash', '==', hexToBase64('aa'.repeat(32))],
      ['seq', 'in', [0, 1]],
    ])
  })

  it('keys by repo id and preloads both forge contracts', () => {
    expect(repoKey(DEMO)).toBe(REPO)
    expect(repoContractIds(DEMO)).toEqual(['CORE', 'COLLAB'])
    expect(repoContractIds(null)).toEqual([])
  })
})

describe('resolveAnyRepo', () => {
  const params = { network: 'devnet' as const }

  // resolveAnyRepo reads the build's NETWORKS; these tests hand resolveAnyRepoWith the ids.
  it('resolves the repo document by (owner, normalized name)', async () => {
    const sdk = mockSdk(fixture())
    const found = await resolveAnyRepoWith(sdk, FORGE, { ...params, owner: OWNER, name: 'Demo' })
    expect(found?.repo).toMatchObject({ repoId: REPO, name: 'demo' })
    expect(await resolveAnyRepoWith(sdk, FORGE, { ...params, owner: OWNER, name: 'nope' })).toBeNull()
  })

  it('resolves a DPNS owner name and rejects a repo pin owned by someone else', async () => {
    const sdk = mockSdk(fixture(), [], { 'alice.dash': OWNER })
    const byName = await resolveAnyRepoWith(sdk, FORGE, { ...params, owner: 'Alice', name: 'demo' })
    expect(byName?.repo).toMatchObject({ ownerId: OWNER })
    const pinned = await resolveAnyRepoWith(sdk, FORGE, { ...params, owner: OWNER, name: 'x', repoId: REPO })
    expect(pinned?.repo).toMatchObject({ repoId: REPO })
    expect(await resolveAnyRepoWith(sdk, FORGE, { ...params, owner: MAINT, name: 'x', repoId: REPO })).toBeNull()
    expect(await resolveAnyRepoWith(sdk, FORGE, { ...params, owner: 'nobody', name: 'demo' })).toBeNull()
  })

  it('reads nothing on a network without forge-v2', async () => {
    const seen: DocumentQuery[] = []
    const sdk = mockSdk(fixture(), seen)
    expect(await resolveAnyRepoWith(sdk, null, { ...params, owner: OWNER, name: 'demo' })).toBeNull()
    expect(seen).toEqual([])
    // The exported entry point is the same function over the build's network config.
    expect(typeof resolveAnyRepo).toBe('function')
  })
})

describe('forge-v2 refs and config', () => {
  it('folds only this repo’s ref updates, and reads its config', async () => {
    const sdk = mockSdk(fixture())
    const refs = await readRefs(sdk, DEMO)
    expect(refs).toHaveLength(1)
    expect(refs[0]?.state).toMatchObject({ state: 'resolved', oid: HEAD })
    const { config } = await readConfigBundle(sdk, DEMO)
    expect(config?.protectedPatterns).toEqual(['refs/heads/main'])
  })
})

describe('forge-v2 issue and PR folds', () => {
  it('folds event + authorEvent from one feed read for a whole list page', async () => {
    const seen: DocumentQuery[] = []
    const sdk = mockSdk(fixture(), seen)
    const issues = await listIssues(sdk, DEMO)
    const by = new Map(issues.map((i) => [i.number, i]))
    expect([...by.keys()].sort()).toEqual([1, 2, 3]) // #4 (malformed) and the other repo's #1 are skipped
    expect(by.get(1)?.state).toMatchObject({ open: true, labels: ['bug'] }) // the stranger's authorEvent is inert
    expect(by.get(2)?.state.open).toBe(false) // the author closed it
    expect(by.get(3)?.state.open).toBe(false) // a writer closed it
    // No per-row event reads: the feed is read once per type.
    const eventReads = seen.filter((q) => q.documentTypeName === 'event' || q.documentTypeName === 'authorEvent')
    expect(eventReads.every((q) => q.where?.[0]?.[0] === 'repoId')).toBe(true)
    expect(eventReads).toHaveLength(2)
    // …and nothing outside the two forge contracts.
    expect(seen.some((q) => q.dataContractId !== 'CORE' && q.dataContractId !== 'COLLAB')).toBe(false)
  })

  it('groups the feed by target even when the SDK returns targetId as base64', async () => {
    // An identifier byteArray can serialize as base64; the feed must still key it by the
    // target's base58 $id, or every row folds an empty log (all open) with no error.
    const store = fixture()
    const ids = { issue2: REPO_ISSUE2 }
    store.COLLAB!.issue = store.COLLAB!.issue!.map((d) => (d['$id'] === 'issue2' ? { ...d, $id: ids.issue2 } : d))
    store.COLLAB!.authorEvent = [
      doc({
        $ownerId: AUTHOR,
        repoId: REPO,
        targetId: bytesToBase64(base58Decode(ids.issue2)),
        targetNumber: 2,
        kind: 1,
      }),
    ]
    invalidateRepoFeed(DEMO)
    const issues = await listIssues(mockSdk(store), DEMO)
    expect(issues.find((i) => i.number === 2)?.state.open).toBe(false)
    invalidateRepoFeed(DEMO)
  })

  it('pages past hidden rows to fill the page and reports how many it hid', async () => {
    const store = fixture()
    // Five newer malformed issues (ciphertext in a public repo) ahead of the real ones.
    for (let n = 10; n < 15; n++) {
      store.COLLAB!.issue!.push(
        doc({ $id: `spam${n}`, $ownerId: STRANGER, repoId: REPO, number: n, title: '', enc: bytesToBase64(new Uint8Array(32)), epoch: 0 }),
      )
    }
    invalidateRepoFeed(DEMO)
    const issues = await listIssues(mockSdk(store), DEMO, 3)
    expect(issues.map((i) => i.number).sort()).toEqual([1, 2, 3])
    expect(issues.hidden).toBe(6) // the five spam rows and the fixture's malformed #4
    invalidateRepoFeed(DEMO)
  })

  it('folds a merge by a member whose oid is the base tip', async () => {
    const sdk = mockSdk(fixture())
    const [pull] = await listPulls(sdk, DEMO)
    expect(pull?.state).toMatchObject({ merged: true, open: false })
    expect(pull?.sourceId).toBe(REPO)
    expect(pull?.headOnBase).toBe(true)
  })

  it('builds the issue timeline with author events marked, and counts member approvals only', async () => {
    const sdk = mockSdk(fixture())
    invalidateMembers(DEMO)
    const issue = await loadIssueThread(sdk, DEMO, 2)
    expect(issue?.timeline.filter((t) => t.kind === 'event' && t.byAuthor)).toHaveLength(1)
    const pr = await loadPullThread(sdk, DEMO, 1)
    expect(pr?.approvals?.approvers).toEqual([MAINT])
    expect(pr?.approvals?.roles.get(MAINT)).toBe('maintainer')
    // The stranger's review is shown in the timeline, not counted.
    expect(pr?.timeline.filter((t) => t.kind === 'review')).toHaveLength(2)
  })
})

describe('forge-v2 permissions', () => {
  it('derives the viewer’s controls from membership documents', async () => {
    const sdk = mockSdk(fixture())
    invalidateMembers(DEMO)
    expect(await readViewerPermissions(sdk, DEMO, MAINT)).toEqual({ write: true, maintain: true })
    expect(await readViewerPermissions(sdk, DEMO, WRITER)).toEqual({ write: true, maintain: false })
    expect(await readViewerPermissions(sdk, DEMO, STRANGER)).toEqual({ write: false, maintain: false })
    expect(holdingsOfRole(null)).toEqual({ write: false, maintain: false })
  })

  it('reports unknown (null), not "no access", when the members cannot be read', async () => {
    invalidateMembers(DEMO)
    const broken = {
      documents: { query: () => Promise.reject(new Error('DAPI down')) },
    } as unknown as EvoSDK
    expect(await readViewerPermissions(broken, DEMO, MAINT)).toBeNull()
  })
})

describe('wellFormed', () => {
  const PRIVATE: RepoRef = { ...DEMO, visibility: 'private' }
  const enc = bytesToBase64(new Uint8Array(32))
  it('applies plaintext-xor-enc by visibility', () => {
    expect(wellFormed(DEMO, 'issue', { title: 't' })).toBe(true)
    expect(wellFormed(DEMO, 'issue', { title: '' })).toBe(false)
    expect(wellFormed(PRIVATE, 'issue', { enc, epoch: 0 })).toBe(true)
    expect(wellFormed(PRIVATE, 'refUpdate', { enc, epoch: 0, refName: 'refs/heads/main' })).toBe(false)
  })
})

describe('packsOfKind (the v2 pack list over raw copies)', () => {
  const copy = (
    id: string,
    uploader: string,
    createdAt: number,
    over: Partial<PackManifest> = {},
  ): PackManifest => ({
    packHash: 'aa',
    kind: 0,
    sizeBytes: 1,
    objectCount: 1,
    chunkCount: 1,
    storage: 0,
    uris: [],
    tips: [],
    supersedes: [],
    createdAt,
    documentId: id,
    uploader,
    ownerRole: ({ [MAINT]: 'maintainer', [WRITER]: 'writer' } as Record<string, 'maintainer' | 'writer'>)[uploader] ?? null,
    ...over,
  })

  it('reads maintainers’ copies first but keeps the pack at its first upload’s position', () => {
    const [pack] = packsOfKind([copy('s', STRANGER, 1), copy('w', WRITER, 2), copy('m', MAINT, 3)], 0)
    expect(pack?.copies?.map((c) => c.documentId)).toEqual(['m', 'w', 's'])
    expect(pack?.uploader).toBe(MAINT)
    expect(pack?.createdAt).toBe(1)
    expect(pack?.documentId).toBe('s')
  })

  it('takes kind and metadata from the representative and drops copies that disagree', () => {
    const packs = [
      copy('w', WRITER, 1, { kind: 1, objectCount: 0 }), // an earlier writer claims kind 1
      copy('m', MAINT, 2, { objectCount: 17 }),
    ]
    const [pack] = packsOfKind(packs, 0)
    expect(pack?.objectCount).toBe(17)
    expect(pack?.copies?.map((c) => c.documentId)).toEqual(['m'])
    expect(pack?.documentId).toBe('w') // position still pinned to the first upload
    expect(packsOfKind(packs, 1)).toEqual([])
  })

  it('numbers packRefs within a kind, so index fragments do not shift git packs', () => {
    const packs = [
      copy('p1', MAINT, 1, { packHash: 'p1' }),
      copy('l1', MAINT, 2, { packHash: 'l1', kind: 1 }),
      copy('p2', MAINT, 3, { packHash: 'p2' }),
    ]
    expect(packsOfKind(packs, 0).map((p) => p.packHash)).toEqual(['p1', 'p2'])
    expect(packsOfKind(packs, 0, { createdAt: 2, id: 'l1' }).map((p) => p.packHash)).toEqual(['p1'])
  })
})

describe('BrowseReader copy failover', () => {
  it('reads an object from the next copy when the first copy’s bytes do not hash to it', async () => {
    const { BrowseReader } = await import('../browse')
    const { indexPacks, serializeLocator } = await import('../browse/indexer')
    const { ObjectLocator } = await import('../browse')
    const { packFrame, objHeader } = await import('../browse/pack-fixtures')
    const { zlibSync } = await import('fflate')
    const body = new TextEncoder().encode('hello forge-v2\n')
    const stored = new Uint8Array([...objHeader(3, body.length), ...zlibSync(body)])
    const good = packFrame(stored)
    const bad = good.map((b, i) => (i >= 12 && i < good.length - 20 ? b ^ 0xff : b))
    const objects = await indexPacks([good])
    const locator = ObjectLocator.parse(serializeLocator(objects))
    const served: number[] = []
    const reader = new BrowseReader(locator, {
      fetchRange: async (_ref, start, end, copy = 0) => {
        served.push(copy)
        return (copy === 0 ? bad : good).subarray(start, end)
      },
      copyCount: () => 2,
    })
    const oid = objects[0]?.oidHex as string
    const obj = await reader.readObject(oid)
    expect(new TextDecoder().decode(obj.bytes)).toBe('hello forge-v2\n')
    expect(served).toContain(1)
  })
})

describe('issue numbering (allocate_number over the live index)', () => {
  const issues = (...numbers: number[]): Store => ({
    COLLAB: { issue: numbers.map((n) => doc({ $ownerId: AUTHOR, repoId: REPO, number: n, title: `#${n}` })) },
  })
  it('claims base + 1, ignoring a far squatter', async () => {
    const { nextNumber } = await import('./writes')
    expect(await nextNumber(mockSdk(issues(1, 2, 3, 4_294_967_295)), DEMO, 'issue')).toBe(4)
  })
  it('starts at 1 in an empty repo', async () => {
    const { nextNumber } = await import('./writes')
    expect(await nextNumber(mockSdk(issues()), DEMO, 'issue')).toBe(1)
  })
  it('steps over squatters sitting on and just above the ceiling', async () => {
    const { nextNumber } = await import('./writes')
    // count 4 → ceiling 108; 108, 109, 110 are taken, 111 is free.
    expect(await nextNumber(mockSdk(issues(1, 108, 109, 110)), DEMO, 'issue')).toBe(111)
  })
})

/**
 * forge-v2 read path against a mock SDK that behaves like Drive where it matters: it applies
 * every `where` clause (so a reader that forgets `repoId ==` reads another repo's documents
 * and fails here), honours `in`, caps pages at 100 and pages by `startAfter`.
 *
 * Covers: resolution (the `repo` document, DPNS owners, `?repo=` pins), the RepoSource
 * query shapes, issue/PR state from `transition` sums (one sum query per list page) and the
 * label fold over `event` (lists read the repo feed once instead of per row), the proved counts, the well-formedness filter, membership-derived permissions and
 * approvals, pack-copy selection, and the chunk reads that must name the uploader.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Decode, base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { bytesToBase64, hexToBase64, type DocumentQuery } from '../sdk'
import { loadIssueThread, loadPullThread } from '../view/issues-view'
import {
  holdingsOfRole,
  invalidateMembers,
  invalidateRepoFeed,
  queryIssues,
  queryPulls,
  nextNumber,
  readRepoCounts,
  readTargetCounts,
  repoWriteGeneration,
  subscribeRepoLists,
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

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
// Real-shaped base58 ids (32 bytes): the resolver tells ids from DPNS names by decoding them.
const OWNER = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const MAINT = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const WRITER = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const AUTHOR = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
const STRANGER = 'BTJPjCLCnRaJQkqakpcdLYFsaHgFf5XSEBNxFCyYBteH'
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const OTHER_REPO = 'Ad88NKGHimxUgGHrTGpBJjKpnzrQe8Zh4V5q13mRh85h'
const HEAD = 'ab'.repeat(20)
const REPO_ISSUE2 = 'EiaSVsG5gm6aLBXjodmJNmQRVcmwUbvon1YiFGKc64by'
/** A real 32-byte document id for a fixture name (state sums key targets by their id bytes). */
const ID = (name: string): string => base58Encode(sha256(new TextEncoder().encode(name)))

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

/** The wasm SDK's group key: an identifier's 32 bytes, an unsigned integer big-endian with the top bit flipped. */
function groupKey(v: unknown): string {
  if (typeof v === 'number') return (v ^ 0x80).toString(16).padStart(2, '0')
  const s = String(v)
  try {
    const bytes = base58Decode(s)
    if (bytes.length === 32) return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    /* a test id */
  }
  return [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')
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
  // Counts and sums read every matching row; `groupBy` splits them by the grouped value.
  const rowsOf = (q: DocumentQuery): Doc[] => {
    seen.push(q)
    let rows = [...(store[q.dataContractId]?.[q.documentTypeName] ?? [])]
    for (const w of q.where ?? []) rows = rows.filter((d) => matches(d, w as [string, string, unknown]))
    return rows
  }
  const grouped = (q: DocumentQuery & { groupBy?: string[] }, value: (d: Doc) => number): Map<string, bigint> => {
    const by = q.groupBy?.[0]
    const out = new Map<string, bigint>()
    for (const d of rowsOf(q)) {
      const k = by === undefined ? '' : groupKey(d[by])
      out.set(k, (out.get(k) ?? 0n) + BigInt(value(d)))
    }
    return out
  }
  return {
    documents: {
      query,
      count: async (q: DocumentQuery) => {
        const m = grouped(q, () => 1)
        return (q as { groupBy?: string[] }).groupBy ? m : new Map([['', m.get('') ?? 0n]])
      },
      sum: async (q: DocumentQuery, property: string) => grouped(q, (d) => Number(d[property] ?? 0)),
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
    doc({ $id: ID(`issue${n}`), $ownerId: author, repoId: REPO, number: n, title: `Issue ${n}`, ...extra })
  const ev = (targetId: string, n: number, actor: string, kind: number, extra: Doc = {}): Doc =>
    doc({ $ownerId: actor, repoId: REPO, targetId, targetNumber: n, kind, ...extra })
  const tr = (targetId: string, n: number, actor: string, kind: number, delta: number, asAuthor = 0, extra: Doc = {}): Doc =>
    doc({ $ownerId: actor, repoId: REPO, targetId, targetNumber: n, targetKind: Math.floor(kind / 10), kind, delta, asAuthor, ...extra })
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
        ev(ID('issue1'), 1, MAINT, 4, { value: 'bug' }),
        // A state kind on an event cannot exist on the fresh contract; handed one, it is inert.
        ev(ID('issue1'), 1, MAINT, 1),
      ],
      authorEvent: [
        // A head update by the PR author (a review kind: still an author event).
        ev(ID('patch1'), 1, WRITER, 16, { oid: hexToBase64(HEAD) }),
      ],
      transition: [
        // #2 closed by its author (asAuthor = its number), #3 by a writer, PR #1 merged at the base tip.
        tr(ID('issue2'), 2, AUTHOR, 1, 1, 2),
        tr(ID('issue3'), 3, WRITER, 1, 1),
        tr(ID('patch1'), 1, MAINT, 13, 2, 0, { oid: hexToBase64(HEAD) }),
      ],
      patch: [
        doc({
          $id: ID('patch1'),
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
        doc({ $ownerId: MAINT, repoId: REPO, patchId: ID('patch1'), verdict: 1, commitOid: hexToBase64(HEAD) }),
        doc({ $ownerId: STRANGER, repoId: REPO, patchId: ID('patch1'), verdict: 1, commitOid: hexToBase64(HEAD) }),
      ],
      comment: [doc({ $ownerId: MAINT, repoId: REPO, targetId: ID('issue1'), body: 'Seen.' })],
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

/** Every issue / PR of `repo` through the list indexes (one page of 100, every state). */
const issuesOf = async (sdk: EvoSDK, repo: RepoRef = DEMO) => (await queryIssues(sdk, repo, { state: 'all', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 100 } as const, null, 'devnet')).rows
const pullsOf = async (sdk: EvoSDK, repo: RepoRef = DEMO) => (await queryPulls(sdk, repo, { state: 'all', labels: [], author: null, assignee: null, sort: 'newest', text: '', page: 1, pageSize: 100 } as const, null, 'devnet')).rows

describe('forge-v2 issue and PR folds', () => {
  it('reads a whole list page’s state in one sum query and its labels from one feed read', async () => {
    const seen: DocumentQuery[] = []
    const sdk = mockSdk(fixture(), seen)
    const issues = await issuesOf(sdk)
    const by = new Map(issues.map((i) => [i.number, i]))
    expect([...by.keys()].sort()).toEqual([1, 2, 3]) // #4 (malformed) and the other repo's #1 are skipped
    expect(by.get(1)?.state).toMatchObject({ open: true, labels: ['bug'] }) // a close kind on an event is inert
    expect(by.get(2)?.state.open).toBe(false) // the author closed it
    expect(by.get(3)?.state.open).toBe(false) // a writer closed it
    // State: one sum query naming the whole page, grouped by target.
    const sums = seen.filter((q) => q.documentTypeName === 'transition' && (q as { groupBy?: string[] }).groupBy?.[0] === 'targetId')
    expect(sums).toHaveLength(1)
    expect(sums[0]?.where).toEqual([['targetId', 'in', [ID('issue1'), ID('issue2'), ID('issue3')].sort()]])
    expect((sums[0] as { groupBy?: string[] }).groupBy).toEqual(['targetId'])
    // Labels and assignees: the repo's member-event feed, read once, never per row.
    const eventReads = seen.filter((q) => q.documentTypeName === 'event' || q.documentTypeName === 'authorEvent')
    expect(eventReads.every((q) => q.where?.[0]?.[0] === 'repoId')).toBe(true)
    expect(eventReads.map((q) => q.documentTypeName)).toEqual(['event'])
    // …and nothing outside the two forge contracts and DPNS (the authors' names).
    expect(seen.some((q) => q.dataContractId !== 'CORE' && q.dataContractId !== 'COLLAB' && q.documentTypeName !== 'domain')).toBe(false)
  })

  it('groups the feed by target even when the SDK returns targetId as base64', async () => {
    // An identifier byteArray can serialize as base64; the feed must still key it by the
    // target's base58 $id, or every row folds an empty log (no labels) with no error.
    const store = fixture()
    const ids = { issue2: REPO_ISSUE2 }
    store.COLLAB!.issue = store.COLLAB!.issue!.map((d) => (d['$id'] === ID('issue2') ? { ...d, $id: ids.issue2 } : d))
    store.COLLAB!.event = [
      doc({ $ownerId: MAINT, repoId: REPO, targetId: bytesToBase64(base58Decode(ids.issue2)), targetNumber: 2, kind: 4, value: 'bug' }),
    ]
    invalidateRepoFeed(DEMO)
    const issues = await issuesOf(mockSdk(store))
    expect(issues.find((i) => i.number === 2)?.state.labels).toEqual(['bug'])
    invalidateRepoFeed(DEMO)
  })

  it('keys a state sum by the target’s identifier bytes, as the SDK returns it', async () => {
    // A real base58 id: the sum map is keyed by its 32 bytes (hex), not by the string.
    const store = fixture()
    store.COLLAB!.issue = store.COLLAB!.issue!.map((d) => (d['$id'] === ID('issue2') ? { ...d, $id: REPO_ISSUE2 } : d))
    store.COLLAB!.transition = store.COLLAB!.transition!.map((t) => (t['targetId'] === ID('issue2') ? { ...t, targetId: REPO_ISSUE2 } : t))
    invalidateRepoFeed(DEMO)
    const issues = await issuesOf(mockSdk(store))
    expect(issues.find((i) => i.number === 2)?.state.open).toBe(false)
    invalidateRepoFeed(DEMO)
  })

  it('skips hidden rows and reports how many it hid', async () => {
    const store = fixture()
    // Five newer malformed issues (ciphertext in a public repo) ahead of the real ones.
    for (let n = 10; n < 15; n++) {
      store.COLLAB!.issue!.push(
        doc({ $id: `spam${n}`, $ownerId: STRANGER, repoId: REPO, number: n, title: '', enc: bytesToBase64(new Uint8Array(32)), epoch: 0 }),
      )
    }
    invalidateRepoFeed(DEMO)
    const page = await queryIssues(mockSdk(store), DEMO, { state: 'all', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 100 } as const, null, 'devnet')
    expect(page.rows.map((i) => i.number).sort()).toEqual([1, 2, 3])
    expect(page.hidden).toBe(6) // the five spam rows and the fixture's malformed #4
    invalidateRepoFeed(DEMO)
  })

  it('reads a merged PR from its sum on a list, and labels the merge on its page', async () => {
    const sdk = mockSdk(fixture())
    const [pull] = await pullsOf(sdk)
    // A list row knows the sum only: merged, and whether it is on the base is not asked.
    expect(pull?.state).toMatchObject({ merged: true, open: false, mergeOnBase: null })
    expect(pull?.sourceId).toBe(REPO)
    expect(pull?.headOnBase).toBe(true)
    // The PR page reads its transitions: the merge names the base tip, so it is on the base.
    const page = await loadPullThread(sdk, DEMO, 1)
    expect(page?.pull.state).toMatchObject({ merged: true, mergeOnBase: true })
    expect(page?.timeline.filter((t) => t.kind === 'transition')).toHaveLength(1)
  })

  it('reads a thread with more than 100 transitions on `perTarget` alone (no time order it cannot serve)', async () => {
    const store = fixture()
    const ping = Array.from({ length: 102 }, (_, i) =>
      doc({ $ownerId: AUTHOR, repoId: REPO, targetId: ID('issue2'), targetNumber: 2, targetKind: 0, kind: i % 2 === 0 ? 2 : 1, delta: i % 2 === 0 ? -1 : 1, asAuthor: 2 }),
    )
    store.COLLAB!.transition = [...store.COLLAB!.transition!, ...ping]
    const seen: DocumentQuery[] = []
    const thread = await loadIssueThread(mockSdk(store, seen), DEMO, 2)
    // The first close, then 51 reopen/close pairs: closed.
    expect(thread?.issue.state.open).toBe(false)
    expect(thread?.timeline.filter((t) => t.kind === 'transition')).toHaveLength(103)
    const reads = seen.filter((q) => q.documentTypeName === 'transition' && q.where?.[0]?.[1] === '==')
    expect(reads.length).toBeGreaterThan(0)
    for (const q of reads) expect(q.orderBy).toEqual([['targetId', 'asc']])
  })

  it('labels a merge whose commit never was a base tip (D-9), but still reads it merged', async () => {
    const store = fixture()
    store.COLLAB!.transition = store.COLLAB!.transition!.map((t) => (t['kind'] === 13 ? { ...t, oid: hexToBase64('ef'.repeat(20)) } : t))
    const page = await loadPullThread(mockSdk(store), DEMO, 1)
    expect(page?.pull.state).toMatchObject({ merged: true, open: false, mergeOnBase: false })
  })

  it('builds the issue timeline with state changes, and counts member approvals only', async () => {
    const sdk = mockSdk(fixture())
    invalidateMembers(DEMO)
    const issue = await loadIssueThread(sdk, DEMO, 2)
    expect(issue?.issue.state.open).toBe(false)
    expect(issue?.timeline.filter((t) => t.kind === 'transition').map((t) => (t.kind === 'transition' ? t.transition.asAuthor : -1))).toEqual([2])
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

describe('issue numbering (dense: one sequence for issues and PRs)', () => {
  const targets = (issues: number, patches: number): Store => ({
    COLLAB: {
      issue: Array.from({ length: issues }, (_, i) => doc({ $ownerId: AUTHOR, repoId: REPO, number: i + 1, title: `#${i + 1}` })),
      patch: Array.from({ length: patches }, (_, i) => doc({ $ownerId: AUTHOR, repoId: REPO, number: issues + i + 1 })),
    },
  })
  it('starts at 1 in an empty repo', async () => {
    expect(await nextNumber(mockSdk(targets(0, 0)), DEMO)).toBe(1)
  })
  it('counts issues and PRs together: 3 issues and 2 PRs, the next is #6', async () => {
    const seen: DocumentQuery[] = []
    expect(await nextNumber(mockSdk(targets(3, 2), seen), DEMO)).toBe(6)
    // Two proved counts on `perRepo`, nothing else: no probe, no trust reads.
    expect(seen.map((q) => [q.documentTypeName, q.where])).toEqual([
      ['issue', [['repoId', '==', REPO]]],
      ['patch', [['repoId', '==', REPO]]],
    ])
  })
  it('ignores a high number anyone wrote: the count decides, not the numbers taken', async () => {
    // A mirror's upstream numbers live in `upstreamNumber` now; `number` is dense.
    const store = targets(2, 0)
    store.COLLAB!.issue!.push(doc({ $ownerId: OWNER, repoId: REPO, number: 3, upstreamNumber: 7761, title: 'imported' }))
    expect(await nextNumber(mockSdk(store), DEMO)).toBe(4)
  })
})

describe('open counts for the Issues / Pull requests tabs', () => {
  it('reads the totals by state in three proved requests: two totals and one grouped count', async () => {
    const seen: DocumentQuery[] = []
    const counts = await readRepoCounts(mockSdk(fixture(), seen), DEMO)
    // #1 open, #2 and #3 closed; the malformed #4 is still a document (open, never closed). PR #1 merged.
    expect(counts).toMatchObject({ issues: 4, patches: 1, issuesOpen: 2, issuesClosed: 2, prsOpen: 0, prsMerged: 1, prsClosed: 0, prsDraft: 0 })
    expect(seen).toHaveLength(3)
    const byKind = seen.find((q) => q.documentTypeName === 'transition') as DocumentQuery & { groupBy?: string[] }
    expect(byKind.where).toEqual([['repoId', '==', REPO], ['kind', 'in', [1, 2, 11, 12, 13, 14, 15, 16, 17]]])
    expect(byKind.groupBy).toEqual(['kind'])
  })

  it('counts drafts and closed drafts from their kinds', async () => {
    const store = fixture()
    const main = store.COLLAB!.patch![0]!
    store.COLLAB!.patch!.push({ ...main, $id: ID('patch2'), number: 5 }, { ...main, $id: ID('patch3'), number: 6 })
    const t = (targetId: string, kind: number, delta: number): Doc => doc({ $ownerId: MAINT, repoId: REPO, targetId, targetNumber: 5, targetKind: 1, kind, delta, asAuthor: 0 })
    store.COLLAB!.transition!.push(t(ID('patch2'), 14, 8), t(ID('patch3'), 14, 8), t(ID('patch3'), 16, 1))
    const counts = await readRepoCounts(mockSdk(store), DEMO)
    expect(counts).toMatchObject({ patches: 3, prsMerged: 1, prsClosed: 1, prsDraft: 1, prsOpen: 1 })
  })

  it('reads each base ref’s history once per PR list, however many PRs target it', async () => {
    invalidateRepoFeed(DEMO)
    const store = fixture()
    const main = store.COLLAB!.patch![0]!
    store.COLLAB!.patch!.push({ ...main, $id: ID('patch2'), number: 2 }, { ...main, $id: ID('patch3'), number: 3 })
    const seen: DocumentQuery[] = []
    const pulls = await pullsOf(mockSdk(store, seen))
    expect(pulls).toHaveLength(3)
    const refReads = seen.filter((q) => q.documentTypeName === 'protectedRefUpdate')
    expect(refReads).toHaveLength(1)
    invalidateRepoFeed(DEMO)
  })

  it('a write drops the lists and tells the header, whose counts then read the new state', async () => {
    invalidateRepoFeed(DEMO)
    const store = fixture()
    const sdk = mockSdk(store)
    expect((await readRepoCounts(sdk, DEMO)).issuesOpen).toBe(2)
    let told = 0
    const unsubscribe = subscribeRepoLists(() => told++)
    const generation = repoWriteGeneration(DEMO)
    // A maintainer closes #1 (the write path calls invalidateRepoFeed).
    store.COLLAB!.transition!.push(doc({ $ownerId: MAINT, repoId: REPO, targetId: ID('issue1'), targetNumber: 1, targetKind: 0, kind: 1, delta: 1, asAuthor: 0 }))
    invalidateRepoFeed(DEMO)
    expect(told).toBe(1)
    expect(repoWriteGeneration(DEMO)).toBe(generation + 1)
    expect((await readRepoCounts(sdk, DEMO)).issuesOpen).toBe(1)
    unsubscribe()
    invalidateRepoFeed(DEMO)
  })

  it('reads the totals behind the counts', async () => {
    expect(await readTargetCounts(mockSdk(fixture()), FORGE, REPO)).toEqual({ issues: 4, pulls: 1 })
  })

  it('bumps the count generation only for writes that can change a count', () => {
    const generation = repoWriteGeneration(DEMO)
    invalidateRepoFeed(DEMO, { counts: false }) // a comment, review or release
    expect(repoWriteGeneration(DEMO)).toBe(generation)
    invalidateRepoFeed(DEMO)
    expect(repoWriteGeneration(DEMO)).toBe(generation + 1)
  })
})

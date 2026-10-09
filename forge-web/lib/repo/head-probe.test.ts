/**
 * The PR page's head probe (#453), against the Drive-shaped mock: one composite per probe (no
 * plain read), every component newest first, and only what is newer than the page counts as news.
 */

import { describe, expect, it } from 'vitest'

import type { ForgeIds } from '../deployments'
import type { RefState } from '../rules'
import { bytesToBase64, hexToBase64 } from '../sdk'
import type { RepoRef } from './contract'
import { mockSdk, newSeen, type Doc } from './drive-mock'
import { eventMarkOf, headProbeQuery, interpretProbe, probeBranch, probeHead, refStateKey, PROBE_EVENTS, type ProbeBase } from './head-probe'
import { refNameHash } from './push'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const REPO = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const FORK = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const PR = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const AUTHOR = 'author-identity'
const MAINTAINER = 'maintainer-identity'
const repo: RepoRef = { forge: FORGE, repoId: REPO, ownerId: MAINTAINER, name: 'demo', visibility: 'public' }
const REF = 'refs/heads/feature'
const HASH = bytesToBase64(refNameHash(REF))

const HEAD = 'a'.repeat(40)
const TIP = 'b'.repeat(40)
const NEWER = 'c'.repeat(40)
const ZERO = '0'.repeat(40)

const event = (id: string, at: number, kind: number, owner = MAINTAINER, oid?: string): Doc => ({
  $id: id,
  $ownerId: owner,
  $createdAt: at,
  targetId: PR,
  repoId: REPO,
  kind,
  ...(oid !== undefined ? { oid: hexToBase64(oid) } : {}),
})
const refUpdate = (id: string, at: number, newOid: string, repoId = REPO): Doc => ({
  $id: id,
  $ownerId: AUTHOR,
  $createdAt: at,
  repoId,
  refName: REF,
  refNameHash: HASH,
  newOid: hexToBase64(newOid),
})
const resolved = (oid: string, createdAt: number): RefState => ({ state: 'resolved', oid, author: AUTHOR, createdAt })

function base(over: Partial<ProbeBase> = {}): ProbeBase {
  return {
    repo,
    pullId: PR,
    author: AUTHOR,
    headOid: HEAD,
    events: { at: 100, ids: ['e1'] },
    branch: { repo, refName: REF, known: resolved(HEAD, 90) },
    ...over,
  }
}

function store(events: Doc[] = [], authorEvents: Doc[] = [], refs: Doc[] = [], protectedRefs: Doc[] = []) {
  return {
    COMMUNITY: { event: events, authorEvent: authorEvents },
    CORE: { refUpdate: refs, protectedRefUpdate: protectedRefs },
  }
}

describe('eventMarkOf: the newest event the page read, with every id of that block', () => {
  it('takes the newest $createdAt and the ids created then', () => {
    expect(eventMarkOf([event('e1', 100, 4), event('e2', 120, 4), event('e3', 120, 16)])).toEqual({ at: 120, ids: ['e2', 'e3'] })
  })
  it('is 0 and empty for a PR with no events yet', () => {
    expect(eventMarkOf([])).toEqual({ at: 0, ids: [] })
  })
})

describe('headProbeQuery: one composite, every component newest first', () => {
  it('pages the PR events since the mark, with the author events and the branch updates as siblings', () => {
    const q = headProbeQuery(base())!
    expect(q.dataContractId).toBe('COMMUNITY')
    expect(q.documentType).toBe('event')
    expect(q.where).toEqual([['targetId', '==', PR], ['$createdAt', '>=', 100]])
    expect(q.orderBy).toEqual([['$createdAt', 'desc']])
    expect(q.limit).toBe(PROBE_EVENTS)
    expect(q.subQueries.map((s) => [s.dataContractId, s.documentType, s.limit])).toEqual([
      ['COMMUNITY', 'authorEvent', PROBE_EVENTS],
      ['CORE', 'refUpdate', 1],
      ['CORE', 'protectedRefUpdate', 1],
    ])
    // A composite merges only components that walk one way (rs-drive composite "Direction"), and
    // Drive walks an all-`==` query ascending whatever its order says: every component descends
    // on a `$createdAt` range.
    for (const s of q.subQueries) {
      expect(s.orderBy).toEqual([['$createdAt', 'desc']])
      expect(s.where?.some(([f, op]) => f === '$createdAt' && (op === '>' || op === '>='))).toBe(true)
    }
    // The branch's updates past the one the page's state came from.
    expect(q.subQueries[1]!.where).toEqual([['repoId', '==', REPO], ['refNameHash', '==', HASH], ['$createdAt', '>', 90]])
    expect(headProbeQuery(base({ branch: { repo, refName: REF, known: null } }))!.subQueries[1]!.where?.at(-1)).toEqual(['$createdAt', '>', 0])
  })

  it('reads the fork for a fork PR, and leaves out what cannot be read', () => {
    const fork: RepoRef = { ...repo, repoId: FORK }
    expect(headProbeQuery(base({ branch: { repo: fork, refName: REF, known: null } }))!.subQueries[1]!.where).toEqual([['repoId', '==', FORK], ['refNameHash', '==', HASH], ['$createdAt', '>', 0]])
    // No branch: the events alone (a page and one sibling).
    expect(headProbeQuery(base({ branch: null }))!.subQueries).toHaveLength(1)
    // No mark: the branch alone.
    const branchOnly = headProbeQuery(base({ events: null }))!
    expect([branchOnly.documentType, ...branchOnly.subQueries.map((s) => s.documentType)]).toEqual(['refUpdate', 'protectedRefUpdate'])
    expect(headProbeQuery(base({ events: null, branch: null }))).toBeNull()
  })
})

describe('probeBranch: only a branch readBranchState could read', () => {
  it('is null for a private repo, a mirror head, or no source', () => {
    expect(probeBranch({ ...repo, visibility: 'private' }, REF, null)).toBeNull()
    expect(probeBranch(repo, 'refs/mirror/pull/3/head', null)).toBeNull()
    expect(probeBranch(null, REF, null)).toBeNull()
    expect(probeBranch(repo, null, null)).toBeNull()
    expect(probeBranch(repo, REF, null)).toEqual({ repo, refName: REF, known: null })
  })
})

describe('probeHead: what counts as a new push', () => {
  const probe = async (b: ProbeBase, s: ReturnType<typeof store>) => {
    const seen = newSeen()
    const out = await probeHead(mockSdk(s, seen), b)
    return { out, seen }
  }

  it('costs one composite and no plain read', async () => {
    const { out, seen } = await probe(base(), store([event('e1', 100, 4)], [], [refUpdate('r1', 90, HEAD)]))
    expect(out.found).toBeNull()
    expect(seen.composites).toHaveLength(1)
    expect(seen.queries).toHaveLength(0)
  })

  it('finds the author’s head update after a push (git-remote-dash pr_sync), with the branch’s tip', async () => {
    const { out } = await probe(base(), store([], [event('h1', 130, 16, AUTHOR, TIP)], [refUpdate('r1', 90, HEAD), refUpdate('r2', 128, TIP)]))
    expect(out.found).toEqual({ tip: TIP, headMoved: true, refUpdateId: 'r2' })
  })

  it('finds a maintainer’s head update (an event), but not one the fold would not apply', async () => {
    const member = await probe(base({ branch: null }), store([event('h1', 130, 16, MAINTAINER, TIP)]))
    expect(member.out.found).toEqual({ tip: TIP, headMoved: true, refUpdateId: null })
    // An authorEvent by someone other than the PR's author never applies (foldPrReviewV2).
    const stranger = await probe(base({ branch: null }), store([], [event('h1', 130, 16, 'someone', TIP)]))
    expect(stranger.out.found).toBeNull()
  })

  it('takes the fold’s newest head update: a move away and back again is no move', async () => {
    const { out } = await probe(base({ branch: null }), store([event('h1', 130, 16, MAINTAINER, TIP)], [event('h2', 140, 16, AUTHOR, HEAD)]))
    expect(out.found).toBeNull()
    const moved = await probe(base({ branch: null }), store([event('h1', 140, 16, MAINTAINER, TIP)], [event('h2', 130, 16, AUTHOR, HEAD)]))
    expect(moved.out.found?.tip).toBe(TIP)
  })

  it('ignores the events the page read, other kinds, and a head update naming the head shown', async () => {
    const { out } = await probe(base({ branch: null }), store([event('e1', 100, 16, MAINTAINER, TIP), event('e2', 140, 4)], [event('h2', 150, 16, AUTHOR, HEAD)]))
    expect(out.found).toBeNull()
    // The mark moves up to the newest event read.
    expect(out.events).toEqual({ at: 150, ids: ['h2'] })
  })

  it('keeps the mark when the page of events was full (what lay past it was not read)', async () => {
    const many = Array.from({ length: PROBE_EVENTS }, (_, i) => event(`n${i}`, 200 + i, 4))
    const { out } = await probe(base({ branch: null }), store(many))
    expect(out.found).toBeNull()
    expect(out.events).toEqual({ at: 100, ids: ['e1'] })
  })

  it('a same-block event the mark already holds is skipped; a new one of that block is read', async () => {
    const { out } = await probe(base({ branch: null }), store([event('e1', 100, 4), event('e9', 100, 16, MAINTAINER, TIP)]))
    expect(out.found).toEqual({ tip: TIP, headMoved: true, refUpdateId: null })
  })

  it('finds a push the PR did not follow (prAutoSync off): the branch moved, the head did not', async () => {
    const { out } = await probe(base(), store([], [], [refUpdate('r1', 90, HEAD), refUpdate('r2', 140, TIP)]))
    expect(out.found).toEqual({ tip: TIP, headMoved: false, refUpdateId: 'r2' })
  })

  it('takes the newer of the two update types (a protected branch’s updates are protectedRefUpdate)', async () => {
    const { out } = await probe(base(), store([], [], [refUpdate('r2', 140, TIP)], [refUpdate('p1', 150, NEWER)]))
    expect(out.found?.tip).toBe(NEWER)
  })

  it('no news: a tip the page read, the PR head, a deletion, an update no newer than the state read, one announced before', async () => {
    const at = (b: ProbeBase, refs: Doc[]) => probe(b, store([], [], refs)).then((r) => r.out.found)
    // The branch the page read is already ahead of the head (the head-sync banner says so).
    expect(await at(base({ branch: { repo, refName: REF, known: resolved(TIP, 140) } }), [refUpdate('r2', 140, TIP)])).toBeNull()
    expect(await at(base(), [refUpdate('r2', 140, HEAD)])).toBeNull()
    expect(await at(base(), [refUpdate('r2', 140, ZERO)])).toBeNull()
    // Older than the update the page's state came from: the resolver chose that state over it.
    expect(await at(base({ branch: { repo, refName: REF, known: resolved(HEAD, 150) } }), [refUpdate('r2', 140, TIP)])).toBeNull()
    expect(await at(base({ announced: new Set(['r2']) }), [refUpdate('r2', 140, TIP)])).toBeNull()
  })

  it('a diverged branch: news only past every head the page read', async () => {
    const diverged: RefState = { state: 'diverged', heads: [{ id: 'x', oid: TIP, author: AUTHOR, createdAt: 120 }, { id: 'y', oid: HEAD, author: AUTHOR, createdAt: 110 }] }
    const at = (refs: Doc[]) => probe(base({ branch: { repo, refName: REF, known: diverged } }), store([], [], refs)).then((r) => r.out.found)
    expect(await at([refUpdate('r3', 120, TIP)])).toBeNull()
    expect(await at([refUpdate('r3', 130, NEWER)])).toEqual({ tip: NEWER, headMoved: false, refUpdateId: 'r3' })
  })

  it('a branch never recorded (state unknown): its first push is news', async () => {
    const { out } = await probe(base({ branch: { repo, refName: REF, known: null } }), store([], [], [refUpdate('r1', 140, TIP)]))
    expect(out.found?.tip).toBe(TIP)
  })
})

describe('interpretProbe on a composite answered by the plain fallback (same shape)', () => {
  it('reads the sibling results by position', () => {
    const res = { page: [], subs: [{ kind: 'documents' as const, documents: [event('h1', 130, 16, AUTHOR, TIP)] }, { kind: 'documents' as const, documents: [] }, { kind: 'documents' as const, documents: [] }] }
    expect(interpretProbe(base(), res as never).found).toEqual({ tip: TIP, headMoved: true, refUpdateId: null })
  })
})

describe('refStateKey', () => {
  it('names each state', () => {
    expect(refStateKey(null)).toBe('none')
    expect(refStateKey({ state: 'unborn' })).toBe('unborn')
    expect(refStateKey(resolved(TIP, 5))).toBe(`${TIP}@5`)
  })
})

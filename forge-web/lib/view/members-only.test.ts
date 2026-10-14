/**
 * What an outsider reads of a public repo's members-only content (DESIGN D14, D19, §4.1; stream
 * 1D): a members-only issue is a row and a "#N · members-only" page, never "not found"; a member's
 * members-only comment or review is a placeholder (a review keeps its public verdict); a
 * stranger's encrypted bytes are counted, never shown; a full list labels its members-only share.
 * Nothing of the encrypted text reaches what the outsider gets.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Decode, base58Encode } from '../auth/base58'
import { EpochKeys, sealDoc, sealMembersDoc, type PrivateDoc } from '../private'
import { bytesToBase64, hexToBase64, type DocumentQuery } from '../sdk'
import { asIdentifierString, type RepoRef } from '../repo/contract'
import { invalidateRepoFeed, queryIssues, queryPulls } from '../repo'
import { membersOnlyOf } from '../repo/members-only-counts'
import { isMembersOnlyTarget, loadIssueOrMembersOnly, loadIssueThread, loadPullOrMembersOnly, readTargetUntil, repliesNotShown, targetShowsComment } from './issues-view'

const ID = (name: string): string => base58Encode(sha256(new TextEncoder().encode(name)))
const OWNER = ID('owner')
const MEMBER = ID('member')
const STRANGER = ID('stranger')
const REPO = ID('repo')
const HEAD = 'ab'.repeat(20)
const SECRET = 'MEMBERS-SECRET-TEXT'
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
const PUBLIC: RepoRef = { forge: FORGE, repoId: REPO, ownerId: OWNER, name: 'mixed', visibility: 'public' }
const KEY = Uint8Array.from({ length: 32 }, (_, i) => 0x60 + i)

type Doc = Record<string, unknown>
type Store = Record<string, Record<string, Doc[]>>

const idOf = (v: unknown): unknown => (typeof v === 'string' ? asIdentifierString(v) : v)

/** A Drive-shaped mock over `store[contractId][documentType]` (as `lib/repo/v2.test.ts`'s). */
function mockSdk(store: Store): EvoSDK {
  const filtered = (q: DocumentQuery): Doc[] => {
    let rows = [...(store[q.dataContractId]?.[q.documentTypeName] ?? [])]
    for (const [field, op, value] of (q.where ?? []) as [string, string, unknown][]) {
      rows = rows.filter((d) => (op === 'in' ? Array.isArray(value) && value.map(idOf).includes(idOf(d[field])) : idOf(d[field]) === idOf(value)))
    }
    return rows
  }
  const groupKey = (v: unknown): string => [...base58Decode(String(v))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const grouped = (q: DocumentQuery & { groupBy?: string[] }, value: (d: Doc) => number): Map<string, bigint> => {
    const by = q.groupBy?.[0]
    const out = new Map<string, bigint>()
    for (const d of filtered(q)) {
      const k = by === undefined ? '' : groupKey(d[by])
      out.set(k, (out.get(k) ?? 0n) + BigInt(value(d)))
    }
    return out
  }
  return {
    documents: {
      query: async (q: DocumentQuery) => {
        const rows = filtered(q).sort((a, b) => (a['$createdAt'] as number) - (b['$createdAt'] as number))
        const desc = (q.orderBy ?? []).some(([, dir]) => dir === 'desc')
        return new Map((desc ? rows.reverse() : rows).slice(0, q.limit ?? 100).map((d) => [String(d['$id']), d]))
      },
      count: async (q: DocumentQuery) => {
        const m = grouped(q, () => 1)
        return (q as { groupBy?: string[] }).groupBy ? m : new Map([['', m.get('') ?? 0n]])
      },
      sum: async (q: DocumentQuery, property: string) => grouped(q, (d) => Number(d[property] ?? 0)),
    },
    dpns: { resolveName: async () => undefined },
  } as unknown as EvoSDK
}

let at = 0
const next = (): number => (at += 1000)

async function sealed(doc: PrivateDoc, fields: Record<string, unknown>): Promise<string> {
  const keys = await EpochKeys.import(base58Decode(REPO), 0, new Uint8Array(KEY))
  return bytesToBase64(await sealMembersDoc(keys, doc, fields))
}

const bytes = (id: string): Uint8Array => base58Decode(id)

/** A public issue #1 with a public comment, a member's members-only comment and a stranger's encrypted one; a members-only issue #2 (closed); a public PR #3 with a member's members-only approval. */
async function fixture(): Promise<Store> {
  const issue1 = { $id: ID('issue1'), $ownerId: STRANGER, $createdAt: next(), repoId: REPO, number: 1, vis: 'public', title: 'Public issue', body: 'public body' }
  const issue2 = {
    $id: ID('issue2'),
    $ownerId: MEMBER,
    $createdAt: next(),
    $createdAtBlockHeight: 20,
    repoId: REPO,
    number: 2,
    vis: 'public',
    epoch: 0,
    asMember: MEMBER,
    enc: await sealed({ type: 'issue', vis: 'public', ownerId: bytes(MEMBER), epoch: 0, number: 2 }, { title: SECRET, body: SECRET }),
  }
  const comment = async (owner: string, asMember: boolean): Promise<Doc> => ({
    $id: ID(`c${next()}`),
    $ownerId: owner,
    $createdAt: at,
    $createdAtBlockHeight: 20,
    repoId: REPO,
    targetId: ID('issue1'),
    vis: 'public',
    epoch: 0,
    ...(asMember ? { asMember: owner } : {}),
    enc: await sealed({ type: 'comment', vis: 'public', ownerId: bytes(owner), epoch: 0, targetId: bytes(ID('issue1')) }, { body: SECRET }),
  })
  const patch = {
    $id: ID('patch3'),
    $ownerId: STRANGER,
    $createdAt: next(),
    repoId: REPO,
    number: 3,
    vis: 'public',
    title: 'A PR',
    baseRefName: 'refs/heads/main',
    baseRefNameHash: bytesToBase64(sha256(new TextEncoder().encode('refs/heads/main'))),
    headOid: hexToBase64(HEAD),
    sourceRepoId: REPO,
  }
  const review = {
    $id: ID('review'),
    $ownerId: MEMBER,
    $createdAt: next(),
    $createdAtBlockHeight: 20,
    repoId: REPO,
    patchId: ID('patch3'),
    verdict: 1,
    commitOid: hexToBase64(HEAD),
    vis: 'public',
    epoch: 0,
    asMember: MEMBER,
    enc: await sealed({ type: 'review', vis: 'public', ownerId: bytes(MEMBER), epoch: 0, patchId: bytes(ID('patch3')) }, { body: SECRET }),
  }
  return {
    CORE: {
      repo: [{ $id: REPO, $ownerId: OWNER, $createdAt: 1, name: 'mixed', visibility: 'public' }],
      maintainer: [{ $id: ID('m1'), $ownerId: OWNER, $createdAt: 2, repoId: REPO, memberId: OWNER }],
      writer: [{ $id: ID('m2'), $ownerId: OWNER, $createdAt: 3, repoId: REPO, memberId: MEMBER, role: 1 }],
    },
    COLLAB: {
      issue: [issue1, issue2],
      patch: [patch],
      review: [review],
      comment: [
        { $id: ID('plain'), $ownerId: STRANGER, $createdAt: next(), repoId: REPO, targetId: ID('issue1'), vis: 'public', body: 'a public comment' },
        await comment(MEMBER, true),
        await comment(STRANGER, false),
      ],
      transition: [{ $id: ID('t1'), $ownerId: MEMBER, $createdAt: next(), repoId: REPO, targetId: ID('issue2'), targetNumber: 2, targetKind: 0, kind: 1, delta: 1, asAuthor: 2 }],
      event: [],
      authorEvent: [],
    },
  }
}

const ALL = { labels: [], author: null, assignee: null, sort: 'newest', text: '', page: 1, pageSize: 100 } as const

describe('an outsider reads a public repo with members-only content', () => {
  it('opens a members-only issue as "#N · members-only": who, when and its state, never "not found"', async () => {
    const sdk = mockSdk(await fixture())
    const t = await loadIssueOrMembersOnly(sdk, PUBLIC, 2)
    expect(isMembersOnlyTarget(t)).toBe(true)
    if (!isMembersOnlyTarget(t)) return
    expect(t).toMatchObject({ number: 2, open: false, merged: false, comments: 0 })
    expect(t.placeholder).toMatchObject({ type: 'issue', author: MEMBER, asMember: true, number: 2 })
    expect(JSON.stringify(t)).not.toContain(SECRET)
    // The plain loader keeps its contract: no thread to read.
    expect(await loadIssueThread(sdk, PUBLIC, 2)).toBeNull()
  })

  it("shows a member's members-only comment as a placeholder and only counts a stranger's", async () => {
    const thread = await loadIssueThread(mockSdk(await fixture()), PUBLIC, 1)
    expect(thread?.timeline.filter((x) => x.kind === 'comment').map((x) => (x.kind === 'comment' ? x.comment.body : ''))).toEqual(['a public comment'])
    expect(thread?.membersOnly.map((e) => [e.item.type, e.item.author])).toEqual([['comment', MEMBER]])
    // Both encrypted comments are counted; the page subtracts the one it shows.
    expect(thread?.hidden.membersOnly).toBe(2)
    expect(JSON.stringify(thread)).not.toContain(SECRET)
  })

  it("shows a members-only review as its public verdict, and counts it (D15)", async () => {
    const t = await loadPullOrMembersOnly(mockSdk(await fixture()), PUBLIC, 3)
    expect(isMembersOnlyTarget(t)).toBe(false)
    if (t === null || isMembersOnlyTarget(t)) return
    expect(t.membersOnly).toEqual([expect.objectContaining({ verdict: 'approve', item: expect.objectContaining({ type: 'review', author: MEMBER }) })])
    expect(t.reviews).toEqual([])
    expect(t.approvals?.approvers).toEqual([MEMBER])
    expect(JSON.stringify(t)).not.toContain(SECRET)
  })

  it('lists a members-only issue as a row, and labels the members-only share once every issue is read', async () => {
    invalidateRepoFeed(PUBLIC)
    const page = await queryIssues(mockSdk(await fixture()), PUBLIC, { ...ALL, state: 'all', mentions: null }, null, 'devnet')
    const row = page.rows.find((r) => r.number === 2)
    expect(row).toMatchObject({ audience: 'members', membersOnly: true, title: 'Members-only issue', author: MEMBER })
    expect(row?.state.open).toBe(false)
    expect(page.hidden).toBe(0)
    expect(page.membersOnly).toEqual({ open: 0, closed: 1 })
    expect(membersOnlyOf(PUBLIC, 'issue')).toEqual({ open: 0, closed: 1 })
    expect(JSON.stringify(page)).not.toContain(SECRET)
    invalidateRepoFeed(PUBLIC)
  })

  it('lists public PRs with no members-only share', async () => {
    invalidateRepoFeed(PUBLIC)
    const page = await queryPulls(mockSdk(await fixture()), PUBLIC, { ...ALL, state: 'all' }, null, 'devnet')
    expect(page.rows.map((r) => [r.number, r.membersOnly ?? false])).toEqual([[3, false]])
    expect(page.membersOnly).toEqual({ open: 0, closed: 0 })
    invalidateRepoFeed(PUBLIC)
  })
})

/**
 * A repository made public with Code only (DESIGN §4.10): issue #4 and PR #5 were written while it
 * was private (sealed v0x01, stamped `vis: "private"`), and each took a public reply (plaintext)
 * and a member's members-only one (v0x03) since. Issue #2 is members-only, written since.
 */
async function converted(): Promise<Store> {
  const store = await fixture()
  const keys = await EpochKeys.import(base58Decode(REPO), 0, new Uint8Array(KEY))
  const old = async (type: 'issue' | 'patch', name: string, number: number, extra: Doc): Promise<Doc> => ({
    $id: ID(name),
    $ownerId: MEMBER,
    $createdAt: next(),
    $createdAtBlockHeight: 10,
    repoId: REPO,
    number,
    vis: 'private',
    epoch: 0,
    ...extra,
    enc: bytesToBase64(await sealDoc(keys, { type, ownerId: bytes(MEMBER), epoch: 0, number }, { title: SECRET, body: SECRET })),
  })
  const replies = async (target: string): Promise<Doc[]> => [
    { $id: ID(`${target}-public`), $ownerId: STRANGER, $createdAt: next(), repoId: REPO, targetId: ID(target), vis: 'public', body: 'P5B public reply' },
    {
      $id: ID(`${target}-members`),
      $ownerId: MEMBER,
      $createdAt: next(),
      $createdAtBlockHeight: 30,
      repoId: REPO,
      targetId: ID(target),
      vis: 'public',
      epoch: 0,
      asMember: MEMBER,
      enc: await sealed({ type: 'comment', vis: 'public', ownerId: bytes(MEMBER), epoch: 0, targetId: bytes(ID(target)) }, { body: SECRET }),
    },
  ]
  const collab = store['COLLAB'] as Record<string, Doc[]>
  collab['issue'] = [...(collab['issue'] ?? []), await old('issue', 'issue4', 4, {})]
  collab['patch'] = [
    ...(collab['patch'] ?? []),
    await old('patch', 'patch5', 5, {}),
  ]
  collab['comment'] = [...(collab['comment'] ?? []), ...(await replies('issue4')), ...(await replies('patch5'))]
  return store
}

describe('an outsider reads the replies under a thread it cannot open', () => {
  it('a thread written while private: its public replies in full, its members-only ones as placeholders, marked as taking public replies', async () => {
    const t = await loadIssueOrMembersOnly(mockSdk(await converted()), PUBLIC, 4)
    expect(isMembersOnlyTarget(t)).toBe(true)
    if (!isMembersOnlyTarget(t)) return
    expect(t).toMatchObject({ number: 4, comments: 2, writtenWhilePrivate: true, locked: false })
    expect(t.timeline?.map((x) => (x.kind === 'comment' ? [x.comment.author, x.comment.body] : x.kind))).toEqual([[STRANGER, 'P5B public reply']])
    expect(t.membersOnly?.map((e) => [e.item.type, e.item.author])).toEqual([['comment', MEMBER]])
    expect(t.moderation).toBeDefined()
    expect(targetShowsComment(t, ID('issue4-public'))).toBe(true)
    expect(JSON.stringify(t)).not.toContain(SECRET)
  })

  it('the same for a PR written while private', async () => {
    const t = await loadPullOrMembersOnly(mockSdk(await converted()), PUBLIC, 5)
    expect(isMembersOnlyTarget(t)).toBe(true)
    if (!isMembersOnlyTarget(t)) return
    expect(t.writtenWhilePrivate).toBe(true)
    expect(t.timeline?.map((x) => (x.kind === 'comment' ? x.comment.body : x.kind))).toEqual(['P5B public reply'])
    expect(t.membersOnly?.map((e) => e.item.author)).toEqual([MEMBER])
    expect(JSON.stringify(t)).not.toContain(SECRET)
  })

  it('a members-only thread written since the conversion is not marked: it takes no public reply', async () => {
    const t = await loadIssueOrMembersOnly(mockSdk(await converted()), PUBLIC, 2)
    if (!isMembersOnlyTarget(t)) throw new Error('expected a members-only target')
    expect(t.writtenWhilePrivate).toBeUndefined()
    expect(t.timeline).toEqual([])
  })

  it('re-reads a target until a reply posted from it shows, and keeps the target when a re-read fails', async () => {
    const store = await converted()
    const sdk = mockSdk(store)
    const first = await loadIssueOrMembersOnly(sdk, PUBLIC, 4)
    if (!isMembersOnlyTarget(first)) throw new Error('expected a members-only target')
    const id = ID('issue4-new')
    let reads = 0
    const load = async () => {
      reads += 1
      if (reads === 1) throw new Error('node down')
      const collab = store['COLLAB'] as Record<string, Doc[]>
      collab['comment'] = [...(collab['comment'] ?? []), { $id: id, $ownerId: STRANGER, $createdAt: next(), repoId: REPO, targetId: ID('issue4'), vis: 'public', body: 'just posted' }]
      return loadIssueOrMembersOnly(sdk, PUBLIC, 4)
    }
    expect(repliesNotShown(first, [id])).toEqual([id])
    const t = await readTargetUntil(first, load, [id], { aborted: false })
    expect(isMembersOnlyTarget(t) && targetShowsComment(t, id)).toBe(true)
    expect(repliesNotShown(t, [id])).toEqual([])
    // nothing posted: nothing re-read
    expect(await readTargetUntil(first, load, [], { aborted: false })).toBe(first)
  }, 10_000)
})

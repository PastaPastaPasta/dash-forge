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
import { EpochKeys, sealMembersDoc, type PrivateDoc } from '../private'
import { bytesToBase64, hexToBase64, type DocumentQuery } from '../sdk'
import { asIdentifierString, type RepoRef } from '../repo/contract'
import { invalidateRepoFeed, queryIssues, queryPulls } from '../repo'
import { membersOnlyOf } from '../repo/members-only-counts'
import { isMembersOnlyTarget, loadIssueOrMembersOnly, loadIssueThread, loadPullOrMembersOnly } from './issues-view'

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

/**
 * The events of a members-only issue a maintainer made public with a bundle (DESIGN §4.6, §4.7):
 * the bundle opens the issue for everyone, and covers posts only (issue, comment, review, PR),
 * never an event. Its label, assignee and milestone changes and its publication-date records
 * (kind 28) stay members-only: a member who holds the members key reads them all, labels folded
 * and the publication date shown; an outsider reads the issue the bundle published, and none of
 * its members-only events. Parity: forge-core `Collab::readable_events_of` (a public repository's
 * sealed event values open with `lane_keys`, the members key, whatever its target's bundle).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let maintainers: string[] = []
let bundles: { owner: Uint8Array; bytes: Uint8Array }[] = []

vi.mock('../repo/members', async (orig) => ({ ...(await orig<typeof import('../repo/members')>()), readMaintainers: vi.fn(async () => maintainers) }))
vi.mock('../repo/converted', async (orig) => ({
  ...(await orig<typeof import('../repo/converted')>()),
  readMakePublicBundles: vi.fn(async (_sdk: unknown, _repo: unknown, uploaders: ReadonlySet<string>) => bundles.filter((b) => uploaders.has(base58Encode(b.owner)))),
}))

import { base58Decode, base58Encode } from '../auth/base58'
import { EpochKeys, sealMembersDoc, type OpenContext } from '../private'
import { asIdentifierString, type RepoRef } from '../repo/contract'
import { invalidateRepoBundles } from '../repo/made-public'
import { invalidateMembers } from '../repo/members'
import { laneGate } from '../repo/private-content'
import type { PrivateSession } from '../repo/private-session'
import { encodeEmbargo, EMBARGO_KIND } from '../rules/embargo'
import type { DocumentQuery } from '../sdk'
import { isMembersOnlyTarget, loadIssueOrMembersOnly, type IssueThread } from './issues-view'

const VECTORS = join(__dirname, '..', '..', '..', 'forge-contracts', 'vectors')
const FORGE = { core: 'CORE', collab: 'COLLAB', community: 'COLLAB', group: 'GROUP' }
/** The members key the issue's events were written under (not the issue's: the bundle opens that). */
const MEMBERS_KEY = Uint8Array.from({ length: 32 }, (_, i) => 0x60 + i)
const COMMIT = 'c0'.repeat(20)

const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16))
const b58 = (h: string): string => base58Encode(hex(h))

interface ThreadVector {
  readonly input: {
    readonly repoId: string
    readonly maintainers: readonly string[]
    readonly bundles: readonly { readonly owner: string; readonly bytes: string }[]
    readonly docs: readonly { readonly doc: { readonly type: string; readonly ownerId: string; readonly epoch: number; readonly id: string; readonly number?: number; readonly vis?: string }; readonly enc: string; readonly revision: number }[]
  }
}

type Doc = Record<string, unknown>
type Store = Record<string, Record<string, Doc[]>>
const idOf = (v: unknown): unknown => (typeof v === 'string' ? asIdentifierString(v) : v)

/** A Drive-shaped mock over `store[contractId][documentType]` (as `./members-only.test.ts`'s). */
function mockSdk(store: Store): EvoSDK {
  const filtered = (q: DocumentQuery): Doc[] => {
    let rows = [...(store[q.dataContractId]?.[q.documentTypeName] ?? [])]
    for (const [field, op, value] of (q.where ?? []) as [string, string, unknown][]) {
      rows = rows.filter((d) => (op === 'in' ? Array.isArray(value) && value.map(idOf).includes(idOf(d[field])) : idOf(d[field]) === idOf(value)))
    }
    return rows
  }
  return {
    documents: {
      query: async (q: DocumentQuery) => {
        const rows = filtered(q).sort((a, b) => (a['$createdAt'] as number) - (b['$createdAt'] as number))
        return new Map(rows.slice(0, q.limit ?? 100).map((d) => [String(d['$id']), d]))
      },
      count: async () => new Map([['', 0n]]),
      sum: async () => new Map(),
    },
    dpns: { resolveName: async () => undefined },
  } as unknown as EvoSDK
}

/**
 * The `make_public__bundle_read_thread` vector's issue #7 (members-only, made public by maintainer
 * b0's bundle) with its members-only events: a label, an assignee, a milestone, and the publication
 * date set by the maintainer then recorded done by the release bot.
 */
async function setUp(): Promise<{ repo: RepoRef; sdk: EvoSDK; issueId: string; maintainer: string }> {
  const v = (JSON.parse(readFileSync(join(VECTORS, 'make_public__bundle_read_thread.json'), 'utf8')) as ThreadVector).input
  maintainers = v.maintainers.map(b58)
  bundles = v.bundles.map((b) => ({ owner: hex(b.owner), bytes: hex(b.bytes) }))
  const repo: RepoRef = { forge: FORGE, repoId: b58(v.repoId), ownerId: maintainers[0] as string, name: 'mixed', visibility: 'public' }
  invalidateRepoBundles(repo)
  invalidateMembers(repo, 'devnet')
  const { doc: d, enc, revision } = v.docs.find((x) => x.doc.type === 'issue')!
  const issueId = b58(d.id)
  const maintainer = maintainers[1] as string
  const keys = await EpochKeys.import(base58Decode(repo.repoId), 0, new Uint8Array(MEMBERS_KEY))
  let at = 10_000
  const event = async (kind: number, value: string, extra: Doc = {}): Promise<Doc> => {
    at += 1000
    return {
      $id: base58Encode(new Uint8Array(32).fill(at / 1000)),
      $ownerId: maintainer,
      $createdAt: at,
      repoId: repo.repoId,
      targetId: issueId,
      targetNumber: d.number,
      kind,
      vis: 'public',
      epoch: 0,
      enc: await sealMembersDoc(keys, { type: 'event', vis: 'public', ownerId: base58Decode(maintainer), epoch: 0, targetId: base58Decode(issueId) }, { eventValue: value }),
      ...extra,
    }
  }
  const store: Store = {
    CORE: {
      maintainer: maintainers.map((m, i) => ({ $id: base58Encode(new Uint8Array(32).fill(0xe0 + i)), $ownerId: repo.ownerId, $createdAt: 1 + i, repoId: repo.repoId, memberId: m })),
      writer: [],
    },
    COLLAB: {
      issue: [{ $id: issueId, $ownerId: b58(d.ownerId), $revision: revision, $createdAt: 5000, $createdAtBlockHeight: 20, repoId: repo.repoId, vis: d.vis ?? 'public', epoch: d.epoch, number: d.number, enc: hex(enc) }],
      comment: [],
      transition: [],
      label: [],
      event: [
        await event(4, 'security'),
        await event(6, maintainer),
        await event(17, 'v1.0.1'),
        await event(EMBARGO_KIND, encodeEmbargo({ type: 'schedule', at: 1_792_504_800, branch: 'sec/cve-1', onto: 'main', tag: 'v1.0.1' }), { refId: repo.repoId }),
        await event(EMBARGO_KIND, encodeEmbargo({ type: 'done', commit: COMMIT }), { refId: repo.repoId }),
      ],
      authorEvent: [],
    },
  }
  return { repo, sdk: mockSdk(store), issueId, maintainer }
}

/** A member's members-key session (`repo.lane`): only its gate is read on this path. */
async function memberLane(repo: RepoRef): Promise<PrivateSession> {
  const ctx: OpenContext = {
    keys: new Map([[0, await EpochKeys.import(base58Decode(repo.repoId), 0, new Uint8Array(MEMBERS_KEY))]]),
    anchors: new Map([[0, { id: new Uint8Array(32).fill(0x71), height: 10, statedHeight: 10 }]]),
    members: { has: () => true },
  }
  return { id: 'member-lane', closed: false, ctx, gate: laneGate(repo, ctx) } as unknown as PrivateSession
}

async function thread(sdk: EvoSDK, repo: RepoRef): Promise<IssueThread> {
  const t = await loadIssueOrMembersOnly(sdk, repo, 7, 'devnet')
  if (t === null || isMembersOnlyTarget(t)) throw new Error('the bundle did not open the issue')
  return t
}

beforeEach(() => {
  maintainers = []
  bundles = []
})

describe('a members-only issue a maintainer made public: its events', () => {
  it('a member reads every members-only event: labels, assignee, milestone and the publication date', async () => {
    const { repo, sdk, maintainer } = await setUp()
    const t = await thread(sdk, { ...repo, lane: await memberLane(repo) })
    // the issue reads public, made public by the maintainer's bundle
    expect(t.issue.title).toBe('Rotate the signing key')
    expect(t.issue.madePublicBy).toBe(maintainer)
    expect(t.eventValues).toEqual({ hidden: 0, plaintext: 0 })
    expect(t.issue.state.labels).toEqual(['security'])
    expect(t.issue.state.assignees).toEqual([maintainer])
    expect(t.meta.milestone).toBe('v1.0.1')
    expect(t.embargo).toMatchObject({ setBy: maintainer, plan: { branch: 'sec/cve-1', tag: 'v1.0.1' }, state: { state: 'done', commit: COMMIT } })
  })

  it('an outsider reads the issue the bundle published, and none of its members-only events', async () => {
    const { repo, sdk, maintainer } = await setUp()
    const t = await thread(sdk, repo)
    expect(t.issue.title).toBe('Rotate the signing key')
    expect(t.issue.madePublicBy).toBe(maintainer)
    // every event is kept (its kind stands), none of their values
    expect(t.eventValues).toEqual({ hidden: 5, plaintext: 0 })
    expect(t.issue.state.labels).toEqual([])
    expect(t.issue.state.assignees).toEqual([])
    expect(t.meta.milestone).toBeNull()
    expect(t.embargo).toBeNull()
    expect(JSON.stringify(t)).not.toContain('sec/cve-1')
  })
})

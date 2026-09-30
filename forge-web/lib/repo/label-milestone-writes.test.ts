/**
 * QW-019: deleting a label or a milestone. Both documents are owner-deletable only and "newest
 * definition wins", so a delete removes the signer's definitions, and when another member also
 * defined the name: a label is retired first (parity with forge-core `delete_label`), a
 * milestone is refused (its older definition would come back).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from './contract'

const ME = 'MeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe'
const OTHER = 'OtherOtherOtherOtherOtherOtherOtherOtherOthe'
/** The documents a query answers, by document type. */
let stored: Record<string, Record<string, unknown>[]> = {}
const created: { type: string; data: Record<string, unknown> }[] = []
const deleted: { type: string; id: string }[] = []

vi.mock('../sdk', async (orig) => ({
  ...(await orig<typeof import('../sdk')>()),
  queryAllDocuments: async (_sdk: unknown, q: { documentTypeName: string; where?: [string, string, unknown][] }) => {
    let docs = stored[q.documentTypeName] ?? []
    for (const [field, , v] of q.where ?? []) if (field !== 'repoId') docs = docs.filter((d) => d[field] === v)
    return docs
  },
  createDocumentIdempotent: async (_sdk: unknown, _auth: unknown, p: { documentType: string; data: Record<string, unknown> }) => {
    created.push({ type: p.documentType, data: p.data })
    return { documentId: 'new', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: 0 }
  },
  deleteDocumentIdempotent: async (_sdk: unknown, _auth: unknown, p: { documentType: string; documentId: string }) => {
    deleted.push({ type: p.documentType, id: p.documentId })
    return { deleted: true, actualCredits: 0 }
  },
}))
vi.mock('./writes', async (orig) => ({
  ...(await orig<typeof import('./writes')>()),
  writeRepoDoc: async (_sdk: unknown, _auth: unknown, _repo: unknown, type: string, data: Record<string, unknown>) => {
    created.push({ type, data })
    return { documentId: 'new', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: 0 }
  },
}))

const { deleteLabel } = await import('./labels')
const { dayOf, defineMilestone, deleteMilestone, dueOnOf } = await import('./milestones')

const REPO: RepoRef = {
  forge: { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' },
  repoId: 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd',
  ownerId: ME,
  name: 'repo',
  visibility: 'public',
}
const AUTH = { identityId: ME, network: 'devnet' as const, getSigningKeyWif: () => 'W' }
const sdk = {} as EvoSDK

beforeEach(() => {
  stored = {}
  created.length = 0
  deleted.length = 0
})

describe('deleteLabel', () => {
  it('deletes every definition when all are the signer\'s', async () => {
    stored['label'] = [
      { $id: 'l1', $ownerId: ME, $createdAt: 1, name: 'bug' },
      { $id: 'l2', $ownerId: ME, $createdAt: 2, name: 'bug' },
      { $id: 'x', $ownerId: OTHER, $createdAt: 3, name: 'docs' },
    ]
    expect(await deleteLabel(sdk, AUTH, REPO, 'bug')).toEqual({ retired: false, deleted: 2 })
    expect(deleted.map((d) => d.id)).toEqual(['l1', 'l2'])
    expect(created).toEqual([])
  })

  it("retires it first when another member also defined it, then deletes the signer's", async () => {
    stored['label'] = [
      { $id: 'o1', $ownerId: OTHER, $createdAt: 1, name: 'bug' },
      { $id: 'l2', $ownerId: ME, $createdAt: 2, name: 'bug' },
    ]
    expect(await deleteLabel(sdk, AUTH, REPO, 'bug')).toEqual({ retired: true, deleted: 1 })
    expect(created).toHaveLength(1)
    expect(created[0]?.data).toMatchObject({ name: 'bug', retired: true })
    expect(deleted.map((d) => d.id)).toEqual(['l2'])
  })

  it("keeps the signer's own newest retirement on a retry instead of writing or deleting it", async () => {
    stored['label'] = [
      { $id: 'o1', $ownerId: OTHER, $createdAt: 1, name: 'bug' },
      { $id: 'l2', $ownerId: ME, $createdAt: 2, name: 'bug' },
      { $id: 'r3', $ownerId: ME, $createdAt: 3, name: 'bug', retired: true },
    ]
    expect(await deleteLabel(sdk, AUTH, REPO, 'bug')).toEqual({ retired: false, deleted: 1 })
    expect(created).toEqual([])
    expect(deleted.map((d) => d.id)).toEqual(['l2'])
  })

  it('never deletes the retirement it just wrote, even when the write replays an existing document', async () => {
    // The node has not indexed the replayed retirement's position yet: it still reads as older
    // than the other member's definition, so the plan retires, and the replay answers its id.
    stored['label'] = [
      { $id: 'new', $ownerId: ME, $createdAt: 1, name: 'bug', retired: true },
      { $id: 'o2', $ownerId: OTHER, $createdAt: 2, name: 'bug' },
    ]
    expect(await deleteLabel(sdk, AUTH, REPO, 'bug')).toEqual({ retired: true, deleted: 0 })
    expect(deleted).toEqual([])
  })

  it('writes nothing for a label that is not defined', async () => {
    expect(await deleteLabel(sdk, AUTH, REPO, 'nope')).toEqual({ retired: false, deleted: 0 })
    expect(created).toEqual([])
    expect(deleted).toEqual([])
  })
})

describe('milestones', () => {
  it('reads a due day as UTC midnight and back', () => {
    expect(dueOnOf('2026-12-01')).toBe(1_796_083_200_000) // the CLI's parse_day
    expect(dayOf(1_796_083_200_000)).toBe('2026-12-01')
    for (const bad of ['2026-02-30', '1969-12-31', '2026-13-01', 'soon', '']) expect(dueOnOf(bad)).toBeNull()
  })

  it('defines a milestone with what the schema allows, and refuses a private repo', async () => {
    await defineMilestone(sdk, AUTH, REPO, { title: ' v1.0 ', description: 'First', dueOn: 1_796_083_200_000, closed: false })
    expect(created).toEqual([{ type: 'milestone', data: { title: 'v1.0', closed: false, description: 'First', dueOn: 1_796_083_200_000 } }])
    await expect(defineMilestone(sdk, AUTH, { ...REPO, visibility: 'private' }, { title: 'v1' })).rejects.toThrow(/sealed/)
    await expect(defineMilestone(sdk, AUTH, REPO, { title: 'x'.repeat(64) })).rejects.toThrow(/63/)
  })

  it("deletes the signer's definitions, and refuses when another member also defined the title", async () => {
    stored['milestone'] = [
      { $id: 'm1', $ownerId: ME, $createdAt: 1, title: 'v1.0' },
      { $id: 'm2', $ownerId: ME, $createdAt: 2, title: 'v1.0', closed: true },
      { $id: 'm3', $ownerId: OTHER, $createdAt: 3, title: 'v2.0' },
      { $id: 'm4', $ownerId: ME, $createdAt: 4, title: 'v2.0' },
    ]
    expect(await deleteMilestone(sdk, AUTH, REPO, 'v1.0')).toBe(2)
    expect(deleted.map((d) => d.id)).toEqual(['m1', 'm2'])
    await expect(deleteMilestone(sdk, AUTH, REPO, 'v2.0')).rejects.toThrow(/another member/)
    expect(deleted.map((d) => d.id)).toEqual(['m1', 'm2'])
  })
})

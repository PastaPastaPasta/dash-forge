import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ForgeIds } from '../deployments'
import type { Ban } from '../rules/bans'

const OWNER = 'Own1111111111111111111111111111111111111111'
const ME = 'Me11111111111111111111111111111111111111111'
const BANNED = 'Ban1111111111111111111111111111111111111111'
const SPAMMER = 'Spm1111111111111111111111111111111111111111'
const FRIEND = 'Fri1111111111111111111111111111111111111111'
const MAINT = 'Mnt1111111111111111111111111111111111111111'

const forge = { core: 'core', collab: 'collab', community: 'community', group: 'g' } as unknown as ForgeIds
const repo = { id: 'repo1', ownerId: OWNER, name: 'proj', private: false }

let docs: Record<string, unknown[]> = {}
let bans: Ban[] = []
let proved = false
const reads: string[] = []
let banReads = 0

vi.mock('../sdk', () => ({
  queryDocumentsWithProof: async (_sdk: unknown, q: { documentTypeName: string }) => {
    reads.push(q.documentTypeName)
    return { documents: docs[q.documentTypeName] ?? [] }
  },
}))
vi.mock('../repo/bans', () => ({
  readBanState: async () => {
    banReads++
    const standing = new Map(bans.map((b) => [b.identity, b]))
    return { raw: bans, members: [{ identity: MAINT, role: 'maintainer' }], standing }
  },
}))
vi.mock('../repo/contract-shape', () => ({ contractHasProperty: async () => proved }))

const { scanAssignedAndMentions } = await import('./mine')

const issue = (n: number, author: string, body: string): Record<string, unknown> => ({
  $id: `issue${n}`,
  $ownerId: author,
  $createdAt: 1000 + n,
  repoId: repo.id,
  number: n,
  title: `Issue ${n}`,
  body,
})
// Event kinds 24 and 25 are hide and unhide (`EVENT_KIND_BY_INT`).
const hide = (target: string, actor: string, kind: 24 | 25 = 24, at = 5000): Record<string, unknown> => ({
  $id: `hide-${target}-${actor}-${kind}-${at}`,
  $ownerId: actor,
  $createdAt: at,
  targetId: target,
  kind,
})

const scan = async (): Promise<string[]> => {
  const r = await scanAssignedAndMentions({} as never, forge, 'testnet', ME, null, [repo])
  return r.mentioned.map((m) => m.id)
}

beforeEach(() => {
  docs = {
    issue: [issue(1, FRIEND, `hello ${ME}`), issue(2, BANNED, `hello ${ME}`), issue(3, SPAMMER, `hello ${ME}`), issue(4, FRIEND, 'no mention')],
    patch: [],
    event: [],
  }
  bans = []
  proved = false
  reads.length = 0
  banReads = 0
})

describe('scanAssignedAndMentions: moderation (Q5)', () => {
  it('lists every mention when nothing is banned or hidden', async () => {
    expect((await scan()).sort()).toEqual(['issue1', 'issue2', 'issue3'])
  })

  it('leaves out what a banned identity wrote', async () => {
    bans = [{ id: 'b1', identity: BANNED, by: OWNER, reason: null, createdAt: 1 }]
    expect((await scan()).sort()).toEqual(['issue1', 'issue3'])
  })

  it('leaves out a thread the owner hid, and lists it again after an unhide', async () => {
    docs['event'] = [hide('issue3', OWNER)]
    expect((await scan()).sort()).toEqual(['issue1', 'issue2'])
    docs['event'] = [hide('issue3', OWNER, 24, 5000), hide('issue3', OWNER, 25, 6000)]
    expect((await scan()).sort()).toEqual(['issue1', 'issue2', 'issue3'])
  })

  it('counts a maintainer hide, and a stranger hide only when the contract proves the hider', async () => {
    docs['event'] = [hide('issue3', MAINT), hide('issue1', FRIEND)]
    expect((await scan()).sort()).toEqual(['issue1', 'issue2'])
    proved = true
    expect((await scan()).sort()).toEqual(['issue2'])
  })

  it('does not take a hide of one comment as a hide of the thread', async () => {
    docs['event'] = [{ ...hide('issue3', OWNER), refId: 'some-comment' }]
    expect((await scan()).sort()).toEqual(['issue1', 'issue2', 'issue3'])
  })

  it('reads the bans once for a repo with a mention, and none for one without', async () => {
    await scan()
    expect(banReads).toBe(1)
    banReads = 0
    docs['issue'] = [issue(4, FRIEND, 'no mention')]
    expect(await scan()).toEqual([])
    expect(banReads).toBe(0)
  })
})

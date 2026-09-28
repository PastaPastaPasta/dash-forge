import { describe, expect, it } from 'vitest'

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEPLOYMENTS, groupTrust, type GroupTrust } from '../deployments'
import { MAX_PAGES, MAX_UNKNOWN_CONTRACTS, assertGroupHolds, checkMembers, checkOwnership, unknownMemberContracts, type GroupMemberSet } from './group-trust'

const DEPLOYER = 'E24SPCssqYzFQmjcQ1hNmiLXrzz1o9AqTv54tuWNkgHz'
const STRANGER = 'H1DBHnGmX3tMrsnMjtjXr9fZzPRAyfnLXzqy78THTPxS'

const TRUST: GroupTrust = { group: 'GROUP', core: 'CORE', collab: 'COLLAB', owner: DEPLOYER, superseded: ['OLDCOLLAB'] }

function members(contracts: string[], extra: Partial<GroupMemberSet> = {}): GroupMemberSet {
  return { contracts, documentTypes: [], tokens: [], ...extra }
}

describe('group trust: the pinned owner', () => {
  it('passes the pinned owner with no admins', () => {
    expect(() => checkOwnership(TRUST, 'GROUP', { ownerId: DEPLOYER, adminIds: [] })).not.toThrow()
  })

  it('refuses a changed group owner', () => {
    expect(() => checkOwnership(TRUST, 'GROUP', { ownerId: STRANGER, adminIds: [] })).toThrow(/refusing to bind.*owned by H1DB.*pins the Forge deployer E24S/)
  })

  it('refuses any admin', () => {
    expect(() => checkOwnership(TRUST, 'GROUP', { ownerId: DEPLOYER, adminIds: [STRANGER] })).toThrow(/refusing to bind.*H1DB/)
  })

  it('refuses a missing group, another group, or a deployment with no owner', () => {
    expect(() => checkOwnership(TRUST, 'GROUP', undefined)).toThrow(/does not exist/)
    expect(() => checkOwnership(TRUST, 'OTHER', { ownerId: DEPLOYER, adminIds: [] })).toThrow(/OTHER/)
    expect(() => checkOwnership({ ...TRUST, owner: null }, 'GROUP', { ownerId: DEPLOYER, adminIds: [] })).toThrow(/records no owner/)
  })
})

describe('group trust: members', () => {
  it('passes the known set without a notice', () => {
    expect(checkMembers(TRUST, members(['CORE', 'COLLAB', 'OLDCOLLAB']), new Map())).toEqual({ unknown: [], unchecked: [], notice: null })
  })

  it('accepts an unknown member owned by the deployer, with a notice naming it', () => {
    const r = checkMembers(TRUST, members(['CORE', 'COLLAB', 'NEWCOLLAB']), new Map([['NEWCOLLAB', DEPLOYER]]))
    expect(r.unknown).toEqual(['NEWCOLLAB'])
    expect(r.notice).toMatch(/newer Forge contract revision\(s\).*NEWCOLLAB/)
    expect(r.notice).not.toMatch(/could not read/i)
  })

  it('refuses an unknown member with another owner', () => {
    expect(() => checkMembers(TRUST, members(['CORE', 'COLLAB', 'EVIL']), new Map([['EVIL', STRANGER]]))).toThrow(/refusing to bind.*EVIL.*H1DB/)
  })

  it('accepts an unknown member whose owner was not read, and says so', () => {
    const r = checkMembers(TRUST, members(['CORE', 'COLLAB', 'FUTURE']), new Map())
    expect(r.unchecked).toEqual(['FUTURE'])
    expect(r.notice).toMatch(/Could not read contract FUTURE; accepted because the group owner is pinned/)
  })

  it('refuses a group without the current pair', () => {
    expect(() => checkMembers(TRUST, members(['CORE', 'OLDCOLLAB']), new Map())).toThrow(/does not hold forge-core/)
  })

  it('applies the owner rule to document-type and token members too', () => {
    const m = members(['CORE', 'COLLAB'], { documentTypes: [{ contractId: 'TREND', documentTypeName: 'trend' }] })
    expect(unknownMemberContracts(TRUST, m)).toEqual(['TREND'])
    const r = checkMembers(TRUST, m, new Map([['TREND', DEPLOYER]]))
    expect(r.unknown).toEqual(['TREND (document type trend)'])
    expect(r.notice).toMatch(/newer Forge contract revision/)
    expect(() => checkMembers(TRUST, m, new Map([['TREND', STRANGER]]))).toThrow(/TREND/)
  })

  it('calls a part of a known contract an additional group member', () => {
    const r = checkMembers(TRUST, members(['CORE', 'COLLAB'], { tokens: [{ contractId: 'CORE', tokenPosition: 0 }] }), new Map())
    expect(r.unknown).toEqual(['CORE (token 0)'])
    expect(r.unchecked).toEqual([])
    expect(r.notice).toMatch(/additional group member\(s\)/)
  })
})

describe('group trust: the deployment file', () => {
  it('pins moutai’s deployer as the group owner, and its superseded contracts in the group', () => {
    const file = DEPLOYMENTS['devnet-moutai']
    const trust = groupTrust(file)
    expect(trust?.owner).toBe(DEPLOYER)
    expect(trust?.group).toBe(file?.v2?.contractGroupId)
    for (const id of trust?.superseded ?? []) expect(id).not.toBe(trust?.collab)
  })

  it('falls back to forge-core’s owner when no verified group record matches', () => {
    const trust = groupTrust({
      v2: {
        forgeCore: { contractId: 'C', ownerId: 'O', status: 'registered' },
        forgeCollab: { contractId: 'L', status: 'registered' },
        contractGroupId: 'G',
        contractGroup: { id: 'OLD', owner: 'X' },
      },
    })
    expect(trust?.owner).toBe('O')
  })
})

type Member = { contractId: string; documentTypeName?: string; tokenPosition?: number }

/**
 * A fake SDK over a fixed chain state. Pages hold `pageSize` members and carry
 * `nextStartAfter` (the last entry) whenever non-empty, as the wasm SDK does. Records every
 * members query and every contract read.
 */
function fakeSdk(state: {
  owner?: string
  contracts: string[]
  documentTypes?: { contractId: string; documentTypeName: string }[]
  tokens?: { contractId: string; tokenPosition: number }[]
  contractOwners: Record<string, string>
  unreadable?: string[]
  pageSize?: number
  endless?: boolean
}) {
  const log = { pages: [] as string[], reads: [] as string[] }
  const size = state.pageSize ?? 100
  const lists: Record<string, Member[]> = {
    contracts: state.contracts.map((contractId) => ({ contractId })),
    documentTypes: state.documentTypes ?? [],
    tokens: state.tokens ?? [],
  }
  const same = (a: Member, b: Member): boolean => a.contractId === b.contractId && a.documentTypeName === b.documentTypeName && a.tokenPosition === b.tokenPosition
  const sdk = {
    contractGroups: {
      info: async () => ({ ownerId: state.owner ?? DEPLOYER, adminIds: [] }),
      members: async (q: { kind: 'contracts' | 'documentTypes' | 'tokens'; startAfter?: Member }) => {
        log.pages.push(q.kind)
        const list = lists[q.kind] ?? []
        if (state.endless && q.kind === 'contracts') return { kind: q.kind, contracts: ['CORE'], nextStartAfter: { contractId: 'CORE' } }
        const from = q.startAfter ? list.findIndex((m) => same(m, q.startAfter as Member)) + 1 : 0
        const page = list.slice(from, from + size)
        const body = q.kind === 'contracts' ? { contracts: page.map((m) => m.contractId) } : { [q.kind]: page }
        return { kind: q.kind, ...body, ...(page.length ? { nextStartAfter: page[page.length - 1] } : {}) }
      },
    },
    contracts: {
      fetch: async (id: string) => {
        log.reads.push(id)
        if (state.unreadable?.includes(id)) throw new Error('unknown contract format version')
        return state.contractOwners[id] ? { ownerId: { toBase58: () => state.contractOwners[id] } } : undefined
      },
    },
  } as unknown as EvoSDK
  return { sdk, log }
}

describe('assertGroupHolds (on a fake chain)', () => {
  it('accepts a widened group the deployer owns, reading every page and each unknown owner', async () => {
    const { sdk, log } = fakeSdk({ contracts: ['CORE', 'COLLAB', 'NEW1', 'NEW2'], contractOwners: { NEW1: DEPLOYER, NEW2: DEPLOYER }, pageSize: 1 })
    const r = await assertGroupHolds(sdk, 'GROUP', TRUST)
    expect(r.unknown).toEqual(['NEW1', 'NEW2'])
    expect(r.notice).toContain('NEW1, NEW2')
    expect(log.pages.filter((k) => k === 'contracts')).toHaveLength(5)
  })

  it('pages through document-type and token members', async () => {
    const { sdk, log } = fakeSdk({
      contracts: ['CORE', 'COLLAB'],
      documentTypes: [
        { contractId: 'DT', documentTypeName: 'a' },
        { contractId: 'DT', documentTypeName: 'b' },
        { contractId: 'DT', documentTypeName: 'c' },
      ],
      tokens: [
        { contractId: 'CORE', tokenPosition: 0 },
        { contractId: 'CORE', tokenPosition: 1 },
      ],
      contractOwners: { DT: DEPLOYER },
      pageSize: 2,
    })
    const r = await assertGroupHolds(sdk, 'GROUP', TRUST)
    expect(r.unknown).toEqual(['CORE (token 0)', 'CORE (token 1)', 'DT (document type a)', 'DT (document type b)', 'DT (document type c)'])
    expect(log.pages.filter((k) => k === 'documentTypes')).toHaveLength(3)
    expect(log.pages.filter((k) => k === 'tokens')).toHaveLength(2)
    expect(log.reads).toEqual(['DT'])
  })

  it(`refuses a group whose members run past ${MAX_PAGES} pages`, async () => {
    const { sdk, log } = fakeSdk({ contracts: [], contractOwners: {}, endless: true })
    await expect(assertGroupHolds(sdk, 'GROUP', TRUST)).rejects.toThrow(/more members than this app checks/)
    expect(log.pages).toHaveLength(MAX_PAGES)
  })

  it(`cross-checks at most ${MAX_UNKNOWN_CONTRACTS} unknown owners and accepts the rest unchecked`, async () => {
    const ids = Array.from({ length: MAX_UNKNOWN_CONTRACTS + 2 }, (_, i) => `N${String(i).padStart(3, '0')}`)
    const { sdk, log } = fakeSdk({ contracts: ['CORE', 'COLLAB', ...ids], contractOwners: Object.fromEntries(ids.map((id) => [id, DEPLOYER])) })
    const r = await assertGroupHolds(sdk, 'GROUP', TRUST)
    expect(log.reads).toHaveLength(MAX_UNKNOWN_CONTRACTS)
    expect(r.unchecked).toEqual(ids.slice(MAX_UNKNOWN_CONTRACTS))
  })

  it('accepts a member contract it cannot decode, and names it', async () => {
    const { sdk } = fakeSdk({ contracts: ['CORE', 'COLLAB', 'FUTURE'], contractOwners: {}, unreadable: ['FUTURE'] })
    const r = await assertGroupHolds(sdk, 'GROUP', TRUST)
    expect(r.unchecked).toEqual(['FUTURE'])
    expect(r.notice).toMatch(/Could not read contract FUTURE/)
  })

  it('checks the pair before reading any member owner', async () => {
    const { sdk, log } = fakeSdk({ contracts: ['CORE', 'NEW'], contractOwners: { NEW: DEPLOYER } })
    await expect(assertGroupHolds(sdk, 'GROUP', TRUST)).rejects.toThrow(/does not hold forge-core/)
    expect(log.reads).toEqual([])
  })

  it('refuses a member another identity owns, and a changed group owner', async () => {
    await expect(assertGroupHolds(fakeSdk({ contracts: ['CORE', 'COLLAB', 'EVIL'], contractOwners: { EVIL: STRANGER } }).sdk, 'GROUP', TRUST)).rejects.toThrow(/EVIL/)
    await expect(assertGroupHolds(fakeSdk({ owner: STRANGER, contracts: ['CORE', 'COLLAB'], contractOwners: {} }).sdk, 'GROUP', TRUST)).rejects.toThrow(/owned by H1DB/)
  })
})

/** RC2 member roles: a gate refusal of a role-gated write drops the cached membership (a stale role). */

import { describe, expect, it, vi } from 'vitest'

const { invalidate, roleOf, declares } = vi.hoisted(() => ({
  invalidate: vi.fn(),
  roleOf: { current: 'writer' as string | null },
  // contract shape: (documentType, property) -> declared
  declares: { current: (_t: string, _p: string): boolean => true },
}))
vi.mock('./members', async (orig) => ({
  ...(await orig<typeof import('./members')>()),
  invalidateMembers: invalidate,
  readRoleOracle: async () => ({ currentRole: () => roleOf.current }),
}))
vi.mock('./contract-shape', async (orig) => ({
  ...(await orig<typeof import('./contract-shape')>()),
  contractHasProperty: async (_sdk: unknown, _id: string, t: string, p: string) => declares.current(t, p),
}))
vi.mock('./source', async (orig) => ({ ...(await orig<typeof import('./source')>()), contractOf: () => 'contract' }))

import { ConsensusRefusal } from '../sdk'
import type { RepoRef } from './contract'
import { RoleRefusedError } from '../rules/roles'
import { isMemberGateRefusal, refreshRoleOnRefusal, roleClaim } from './role-claim'

const REPO = { repoId: 'r' } as unknown as RepoRef
const AUTH = { network: 'devnet' } as const
const refusal = (code: number): ConsensusRefusal => new ConsensusRefusal(code, `refused ${code}`)

describe('refreshRoleOnRefusal', () => {
  it('drops the membership on 40120 or 40127 for a role-gated type, and rethrows', async () => {
    for (const code of [40120, 40127]) {
      invalidate.mockClear()
      await expect(refreshRoleOnRefusal(REPO, AUTH, 'refUpdate', () => Promise.reject(refusal(code)))).rejects.toBeInstanceOf(ConsensusRefusal)
      expect(invalidate).toHaveBeenCalledWith(REPO, 'devnet')
    }
  })

  it('drops it too for a post whose membership proof restates a role (mainnet mRole)', async () => {
    for (const type of ['issue', 'patch', 'comment', 'review']) {
      invalidate.mockClear()
      await expect(refreshRoleOnRefusal(REPO, AUTH, type, () => Promise.reject(refusal(40127)))).rejects.toBeInstanceOf(ConsensusRefusal)
      expect(invalidate).toHaveBeenCalledWith(REPO, 'devnet')
    }
  })

  it('keeps it on another refusal, an ungated type, or success', async () => {
    invalidate.mockClear()
    await expect(refreshRoleOnRefusal(REPO, AUTH, 'event', () => Promise.reject(refusal(40105)))).rejects.toBeInstanceOf(ConsensusRefusal)
    await expect(refreshRoleOnRefusal(REPO, AUTH, 'star', () => Promise.reject(refusal(40120)))).rejects.toBeInstanceOf(ConsensusRefusal)
    expect(await refreshRoleOnRefusal(REPO, AUTH, 'event', async () => 7)).toBe(7)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('isMemberGateRefusal names exactly the two gate codes', () => {
    expect([40120, 40127, 40105, 10422].map((c) => isMemberGateRefusal(refusal(c)))).toEqual([true, true, false, false])
    expect(isMemberGateRefusal(new Error('x'))).toBe(false)
  })
})

describe('roleClaim: a chunk on the four-contract set (R-19, no r)', () => {
  const sdk = {} as never
  const auth = { network: 'devnet', identityId: 'me' } as never
  const chunk = { repoId: 'r', seq: 0 }

  it('claims nothing, and still refuses triage and readers before signing', async () => {
    declares.current = (t, p) => !(t === 'chunk' && p === 'r')
    roleOf.current = 'writer'
    expect(await roleClaim(sdk, auth, REPO, 'chunk', chunk)).toEqual({})
    roleOf.current = 'maintainer'
    expect(await roleClaim(sdk, auth, REPO, 'chunk', chunk)).toEqual({})
    for (const role of ['triage', 'reader']) {
      roleOf.current = role
      await expect(roleClaim(sdk, auth, REPO, 'chunk', chunk)).rejects.toBeInstanceOf(RoleRefusedError)
    }
  })

  it('claims r 1 where the contract declares it, and nothing on a contract without member roles', async () => {
    roleOf.current = 'writer'
    declares.current = () => true
    expect(await roleClaim(sdk, auth, REPO, 'chunk', chunk)).toEqual({ r: 1 })
    declares.current = () => false
    roleOf.current = 'reader'
    expect(await roleClaim(sdk, auth, REPO, 'chunk', chunk)).toEqual({})
  })
})

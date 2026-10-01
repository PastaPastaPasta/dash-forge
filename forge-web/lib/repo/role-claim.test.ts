/** RC2 member roles: a gate refusal of a role-gated write drops the cached membership (a stale role). */

import { describe, expect, it, vi } from 'vitest'

const { invalidate } = vi.hoisted(() => ({ invalidate: vi.fn() }))
vi.mock('./members', async (orig) => ({ ...(await orig<typeof import('./members')>()), invalidateMembers: invalidate }))

import { ConsensusRefusal } from '../sdk'
import type { RepoRef } from './contract'
import { isMemberGateRefusal, refreshRoleOnRefusal } from './role-claim'

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

  it('keeps it on another refusal, an ungated type, or success', async () => {
    invalidate.mockClear()
    await expect(refreshRoleOnRefusal(REPO, AUTH, 'event', () => Promise.reject(refusal(40105)))).rejects.toBeInstanceOf(ConsensusRefusal)
    await expect(refreshRoleOnRefusal(REPO, AUTH, 'comment', () => Promise.reject(refusal(40120)))).rejects.toBeInstanceOf(ConsensusRefusal)
    expect(await refreshRoleOnRefusal(REPO, AUTH, 'event', async () => 7)).toBe(7)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('isMemberGateRefusal names exactly the two gate codes', () => {
    expect([40120, 40127, 40105, 10422].map((c) => isMemberGateRefusal(refusal(c)))).toEqual([true, true, false, false])
    expect(isMemberGateRefusal(new Error('x'))).toBe(false)
  })
})

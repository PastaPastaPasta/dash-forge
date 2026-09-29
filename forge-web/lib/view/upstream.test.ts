/**
 * Mirrors' upstream numbers (D-2, ISS-02): shown and resolved only from the owner or a current
 * member.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it } from 'vitest'

import type { RepoRef } from '../repo'
import type { DocumentQuery } from '../sdk'
import type { Membership } from '../rules/v2'
import { bodyRefsUpstream, numberLabel, resolveUpstreamNumber, shownUpstreamNumber } from './upstream'

const REPO: RepoRef = { forge: { core: 'CORE', collab: 'COLLAB', group: 'GROUP' }, repoId: 'R', ownerId: 'owner', name: 'r', visibility: 'public' }
const MEMBERS: Membership[] = [{ identity: 'maint', role: 'maintainer', createdAt: 1 }]

describe('shownUpstreamNumber', () => {
  it('shows a trusted writer’s upstream number, and hides a stranger’s', () => {
    expect(shownUpstreamNumber({ upstreamNumber: 7761, author: 'owner', number: 12 }, REPO, MEMBERS)).toBe(7761)
    expect(shownUpstreamNumber({ upstreamNumber: 7761, author: 'maint', number: 12 }, REPO, MEMBERS)).toBe(7761)
    expect(shownUpstreamNumber({ upstreamNumber: 7761, author: 'mallory', number: 12 }, REPO, MEMBERS)).toBeNull()
    expect(shownUpstreamNumber({ upstreamNumber: null, author: 'owner', number: 12 }, REPO, MEMBERS)).toBeNull()
  })
  it('says nothing when the mirror numbered it identically', () => {
    expect(shownUpstreamNumber({ upstreamNumber: 12, author: 'owner', number: 12 }, REPO, MEMBERS)).toBeNull()
  })
  it('labels "#12 · upstream #7761"', () => {
    expect(numberLabel(12, 7761)).toBe('#12 · upstream #7761')
    expect(numberLabel(12, null)).toBe('#12')
  })
})

describe('bodyRefsUpstream', () => {
  it('reads #n as the source’s number only in text a trusted writer imported', () => {
    expect(bodyRefsUpstream({ imported: true, author: 'owner' }, REPO, MEMBERS)).toBe(true)
    expect(bodyRefsUpstream({ imported: true, author: 'maint' }, REPO, MEMBERS)).toBe(true)
    expect(bodyRefsUpstream({ imported: true, author: 'mallory' }, REPO, MEMBERS)).toBe(false)
    expect(bodyRefsUpstream({ imported: false, author: 'owner' }, REPO, MEMBERS)).toBe(false)
  })
})

describe('resolveUpstreamNumber', () => {
  const sdk = (rows: Record<string, Record<string, unknown>[]>, seen: DocumentQuery[] = []): EvoSDK =>
    ({
      documents: {
        query: async (q: DocumentQuery) => {
          seen.push(q)
          const want = (q.where ?? []).find(([f]) => f === 'upstreamNumber')?.[2]
          return new Map((rows[q.documentTypeName] ?? []).filter((d) => d['upstreamNumber'] === want).map((d) => [String(d['$id']), d]))
        },
      },
    }) as unknown as EvoSDK

  it('finds the trusted item on the upstream index, skipping a stranger’s claim', async () => {
    const seen: DocumentQuery[] = []
    const found = await resolveUpstreamNumber(
      sdk(
        {
          issue: [
            { $id: 'a', $ownerId: 'mallory', $createdAt: 1, number: 2, upstreamNumber: 7761 },
            { $id: 'b', $ownerId: 'owner', $createdAt: 5, number: 12, upstreamNumber: 7761 },
          ],
        },
        seen,
      ),
      REPO,
      7761,
      MEMBERS,
    )
    expect(found).toEqual({ type: 'issue', number: 12 })
    expect(seen.map((q) => [q.documentTypeName, q.where])).toEqual([
      ['issue', [['repoId', '==', 'R'], ['upstreamNumber', '==', 7761]]],
      ['patch', [['repoId', '==', 'R'], ['upstreamNumber', '==', 7761]]],
    ])
  })

  it('finds a PR, and nothing when no trusted writer recorded the number', async () => {
    expect(await resolveUpstreamNumber(sdk({ patch: [{ $id: 'p', $ownerId: 'maint', $createdAt: 1, number: 4, upstreamNumber: 88 }] }), REPO, 88, MEMBERS)).toEqual({ type: 'patch', number: 4 })
    expect(await resolveUpstreamNumber(sdk({ issue: [{ $id: 'a', $ownerId: 'mallory', $createdAt: 1, number: 2, upstreamNumber: 5 }] }), REPO, 5, MEMBERS)).toBeNull()
    expect(await resolveUpstreamNumber(sdk({}), REPO, 0, MEMBERS)).toBeNull()
  })
})

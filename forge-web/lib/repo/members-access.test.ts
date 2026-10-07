/**
 * How a signed-in viewer reads a public repo's members-only content (DESIGN §4.1, §12 item 6): a
 * member removed since reads what was written under the epochs they held, and nothing else
 * changes for current members or outsiders; a repo without members-only content costs a
 * non-member no read.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it, vi } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { RepoRef } from './contract'
import { membersAccessOf, type MembersAccessSource } from './members-access'
import { recordConfigTimeline } from './members-key-cache'
import { repoHasMembersKey } from './members-writes'
import type { PrivateSession } from './private-session'

const ME = base58Encode(new Uint8Array(32).fill(7))

/** A session whose reader holds keys for `epochs` (and a wrap to them when `mine`). */
function sessionWith(epochs: number[], mine = false): PrivateSession {
  return {
    resolution: { keys: new Map(epochs.map((e) => [e, {}])) },
    wraps: mine ? [{ row: { memberId: new Uint8Array(32).fill(7) } }] : [],
  } as unknown as PrivateSession
}

function source(over: Partial<MembersAccessSource<object>>): MembersAccessSource<object> & { calls: string[] } {
  const calls: string[] = []
  return {
    identity: ME,
    isMember: false,
    hasMembersKey: async () => (calls.push('hasMembersKey'), true),
    ops: async () => (calls.push('ops'), {}),
    locked: () => false,
    session: async () => (calls.push('session'), sessionWith([])),
    ...over,
    calls,
  } as MembersAccessSource<object> & { calls: string[] }
}

describe('a member removed since (DESIGN §12 item 6, as dg)', () => {
  it('reads through the key shares they still hold: a session with the earlier epochs', async () => {
    const s = sessionWith([0])
    const access = await membersAccessOf(source({ session: async () => s }))
    expect(access).toEqual({ access: 'former', session: s })
  })

  it('gets nothing when the tab is locked or holds no key (an outsider’s view, no unlock offer)', async () => {
    expect(await membersAccessOf(source({ locked: () => true }))).toBeNull()
    expect(await membersAccessOf(source({ ops: async () => null }))).toBeNull()
  })
})

describe('an outsider', () => {
  it('holds no key share: no lane at all, the same page as before', async () => {
    expect(await membersAccessOf(source({}))).toBeNull()
  })

  it('reads nothing more on a repo without members-only content: the page’s config read already said so', async () => {
    const repo = { repoId: 'R-plain', visibility: 'public', forge: {} } as unknown as RepoRef
    recordConfigTimeline(repo.repoId, [{ $id: 'c1', defaultBranch: 'main' }])
    const query = vi.fn(async () => {
      throw new Error('no read expected')
    })
    const sdk = { documents: { query } } as unknown as EvoSDK
    const src = source({ hasMembersKey: () => repoHasMembersKey(sdk, repo) })
    expect(await membersAccessOf(src)).toBeNull()
    expect(query).not.toHaveBeenCalled()
    expect(src.calls).toEqual([])
  })

  it('a sealed config in the timeline says the repo has a members key', async () => {
    const repo = { repoId: 'R-keyed', visibility: 'public', forge: {} } as unknown as RepoRef
    recordConfigTimeline(repo.repoId, [{ $id: 'c1' }, { $id: 'c2', enc: new Uint8Array(80) }])
    const sdk = { documents: { query: vi.fn() } } as unknown as EvoSDK
    expect(await repoHasMembersKey(sdk, repo)).toBe(true)
  })
})

describe('a current member (unchanged)', () => {
  const member = (over: Partial<MembersAccessSource<object>> = {}): MembersAccessSource<object> => source({ isMember: true, ...over })
  it('reads with their session, or is told why not', async () => {
    const s = sessionWith([0, 1])
    expect(await membersAccessOf(member({ session: async () => s }))).toEqual({ access: 'member', session: s })
    expect(await membersAccessOf(member({ hasMembersKey: async () => false }))).toEqual({ access: 'none' })
    expect(await membersAccessOf(member({ ops: async () => null }))).toEqual({ access: 'no-key' })
    expect(await membersAccessOf(member({ locked: () => true }))).toEqual({ access: 'locked' })
    expect(await membersAccessOf(member({ session: async () => sessionWith([]) }))).toEqual({ access: 'no-key-shared' })
    // Shared with them, but this browser's key isn't the one it was shared to.
    expect(await membersAccessOf(member({ session: async () => sessionWith([], true) }))).toEqual({ access: 'no-key' })
  })
})

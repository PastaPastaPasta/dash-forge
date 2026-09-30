/**
 * L-09: after a browser merge the repo home must not settle on the pre-merge tip that a DAPI node
 * a block behind still serves. The merge's ref update records the move; a home read that does not
 * show it is re-read; the expectation clears once shown, and lapses so another writer's later move
 * is never fought.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { repoContentWritten, type RepoRef, type ResolvedRef } from '../repo'
import { OWN_MOVE_WAIT_MS, awaitingOwnRefMoves, forgetOwnRefMoves, resetOwnRefMoves, showsOwnRefMoves } from './own-ref-moves'
import { retryUntil } from './retry'

const REPO: RepoRef = { forge: { core: 'C', collab: 'L', community: 'L', group: 'G' }, repoId: 'MOVES', ownerId: 'o', name: 'n', visibility: 'public' }
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const main = (oid: string): ResolvedRef => ({ refName: 'refs/heads/main', refNameHash: 'x', state: { state: 'resolved', oid, author: 'id', createdAt: 1 } })

beforeEach(() => resetOwnRefMoves())
afterEach(() => vi.useRealTimers())

describe('own ref moves (L-09)', () => {
  it('a write that moved no ref (a pack, a release) expects nothing', () => {
    repoContentWritten(REPO)
    expect(awaitingOwnRefMoves()).toBe(false)
    expect(showsOwnRefMoves(REPO, [main(OLD)])).toBe(true)
  })

  it('a merge moved main: the pre-merge tip does not count, the new one does and clears it', () => {
    repoContentWritten(REPO, { refName: 'refs/heads/main', newOid: NEW })
    expect(awaitingOwnRefMoves()).toBe(true)
    expect(showsOwnRefMoves(REPO, [main(OLD)])).toBe(false)
    expect(showsOwnRefMoves({ ...REPO, repoId: 'OTHER' }, [main(OLD)])).toBe(true)
    expect(showsOwnRefMoves(REPO, [main(NEW)])).toBe(true)
    expect(awaitingOwnRefMoves()).toBe(false)
  })

  it('a diverged ref counts as shown once one of its heads is the move; a deletion once it reads unborn', () => {
    repoContentWritten(REPO, { refName: 'refs/heads/main', newOid: NEW })
    const diverged: ResolvedRef = {
      refName: 'refs/heads/main',
      refNameHash: 'x',
      state: { state: 'diverged', heads: [{ oid: OLD, author: 'a', createdAt: 1 }, { oid: NEW, author: 'b', createdAt: 2 }] } as never,
    }
    expect(showsOwnRefMoves(REPO, [diverged])).toBe(true)
    repoContentWritten(REPO, { refName: 'refs/heads/gone', newOid: '0'.repeat(40) })
    expect(showsOwnRefMoves(REPO, [{ refName: 'refs/heads/gone', refNameHash: 'y', state: { state: 'unborn' } }])).toBe(true)
  })

  it('forgetOwnRefMoves drops what a full run of re-reads never saw', () => {
    repoContentWritten(REPO, { refName: 'refs/heads/main', newOid: NEW })
    forgetOwnRefMoves(REPO)
    expect(awaitingOwnRefMoves()).toBe(false)
    expect(showsOwnRefMoves(REPO, [main(OLD)])).toBe(true)
  })

  it('lapses, so a ref another writer moved since is taken as it is', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    repoContentWritten(REPO, { refName: 'refs/heads/main', newOid: NEW })
    vi.setSystemTime(Date.now() + OWN_MOVE_WAIT_MS + 1)
    expect(showsOwnRefMoves(REPO, [main(OLD)])).toBe(true)
  })

  it('the home read is retried past a lagging node until it shows the move', async () => {
    repoContentWritten(REPO, { refName: 'refs/heads/main', newOid: NEW })
    const answers = [OLD, OLD, NEW]
    let reads = 0
    const tip = await retryUntil(
      async () => answers[reads++] as string,
      (oid) => showsOwnRefMoves(REPO, [main(oid)]),
      8,
      0,
    )
    expect(tip).toBe(NEW)
    expect(reads).toBe(3)
  })
})

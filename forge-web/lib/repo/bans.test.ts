import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import { withoutBanned, type InboxItem } from '../view/inbox'
import { banOf, standingOf } from './bans'
import type { RepoRef } from './contract'

const id = (b: number): string => base58Encode(new Uint8Array(32).fill(b))
const repo = { repoId: 'R', ownerId: 'own' } as unknown as RepoRef

describe('bans (web reader)', () => {
  it('reads a ban document, and skips one that names nobody', () => {
    expect(banOf({ $id: 'b1', $ownerId: 'm1', $createdAt: 5, identityId: id(1), reason: 2 })).toEqual({ id: 'b1', identity: id(1), by: 'm1', reason: 2, createdAt: 5 })
    expect(banOf({ $id: 'b2', $ownerId: 'm1', $createdAt: 5 })).toBeNull()
  })

  it('counts the bans of the owner and current maintainers only', () => {
    const bans = [
      { id: 'b1', identity: 's', by: 'm1', reason: null, createdAt: 1 },
      { id: 'b2', identity: 't', by: 'gone', reason: null, createdAt: 2 },
    ]
    const got = standingOf(repo, bans, [{ identity: 'm1', role: 'maintainer', createdAt: 0 }])
    expect([...got.keys()]).toEqual(['s'])
    expect(standingOf(repo, [], [])).toEqual(new Map())
  })

  it("leaves a banned identity's items out of the inbox, in the repo that banned it only", () => {
    const item = (i: string, repoId: string, actor: string) => ({ id: i, kind: 'comment', repo: { id: repoId, ownerId: 'o', name: 'n', private: false }, what: '', actor, at: 1, read: false }) as InboxItem
    const items = [item('1', 'R', 's'), item('2', 'S', 's'), item('3', 'R', 'ok')]
    expect(withoutBanned(items, new Map([['R', new Set(['s'])]])).map((i) => i.id)).toEqual(['2', '3'])
  })
})

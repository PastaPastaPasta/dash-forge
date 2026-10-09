/**
 * #451: whether a recently pushed branch already has an open PR, in ONE composite (the branches'
 * PRs on the `sourceRef` index, their transitions as a bound lookup), against the Drive-shaped mock.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { bytesToBase64 } from '../sdk'
import { branchesWithOpenPulls } from './branch-pulls'
import type { RepoRef } from './contract'
import { mockSdk, newSeen, type Doc, type Store } from './drive-mock'

const FORGE: ForgeIds = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' }
const FORK = '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z'
const UPSTREAM = 'C8XSf6R4shR1kqFKUZQnuaEZ5DkW7uoe9qtQYZpS5SRd'
const AUTHOR = '7Ej2YTftCL23mVwvhviak8ZJMmpqcsVj7CU5KPxzyy4h'
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const hashOf = (name: string): string => bytesToBase64(sha256(enc(name)))
const PID = (n: number): string => base58Encode(sha256(enc(`p${n}`)))

const repo = (visibility: 'public' | 'private' = 'public'): RepoRef => ({ forge: FORGE, repoId: FORK, ownerId: AUTHOR, name: 'fork', visibility })

/** A PR `n` from `name` of the fork, filed in `repoId`. */
const patch = (n: number, name: string, repoId = FORK, extra: Doc = {}): Doc => ({
  $id: PID(n),
  $ownerId: AUTHOR,
  $createdAt: 1_000 + n,
  repoId,
  number: n,
  sourceRepoId: FORK,
  sourceRefName: name,
  sourceRefNameHash: hashOf(name),
  ...extra,
})
/** A transition of PR `n` by `delta` (close +1, reopen −1, merge +2: `rules/transition.ts`). */
const move = (n: number, delta: number, i = 0): Doc => ({ $id: `t${n}-${i}`, $ownerId: AUTHOR, $createdAt: 5_000 + n * 10 + i, targetId: PID(n), kind: 11, delta })

function store(patches: Doc[], transitions: Doc[] = []): Store {
  return { COLLAB: { patch: patches, transition: transitions } }
}

describe('branchesWithOpenPulls', () => {
  it('names the branches with an open PR, filed here or upstream, in one composite', async () => {
    const seen = newSeen()
    const sdk = mockSdk(
      store(
        [
          patch(1, 'refs/heads/open-here'),
          patch(2, 'refs/heads/open-upstream', UPSTREAM),
          patch(3, 'refs/heads/closed', FORK),
          patch(4, 'refs/heads/reopened', FORK),
          patch(5, 'refs/heads/merged', UPSTREAM),
          patch(6, 'refs/heads/not-asked'),
        ],
        [move(3, 1), move(4, 1, 0), move(4, -1, 1), move(5, 2)],
      ),
      seen,
    )
    const asked = ['refs/heads/open-here', 'refs/heads/open-upstream', 'refs/heads/closed', 'refs/heads/reopened', 'refs/heads/merged', 'refs/heads/none']
    const open = await branchesWithOpenPulls(sdk, repo(), asked)
    expect([...(open ?? [])].sort()).toEqual(['refs/heads/open-here', 'refs/heads/open-upstream', 'refs/heads/reopened'])
    expect(seen.composites).toHaveLength(1)
    expect(seen.queries).toHaveLength(0)
    expect(seen.sums).toHaveLength(0)
    const q = seen.composites[0]!
    expect(q.documentType).toBe('patch')
    const values = (q.where?.[1]?.[2] ?? []) as string[]
    expect(q.where?.[0]).toEqual(['sourceRepoId', '==', FORK])
    expect(values).toHaveLength(asked.length)
    expect(q.subQueries).toEqual([expect.objectContaining({ documentType: 'transition', bind: { sourceProperty: '$id', field: 'targetId' } })])
  })

  it('ignores a PR whose name disagrees with its hash, and keeps a members-only one (sealed name)', async () => {
    const sdk = mockSdk(
      store([
        patch(1, 'refs/heads/other', FORK, { sourceRefNameHash: hashOf('refs/heads/f') }),
        patch(2, '', FORK, { sourceRefNameHash: hashOf('refs/heads/g'), enc: bytesToBase64(enc('sealed')) }),
      ]),
      newSeen(),
    )
    expect([...((await branchesWithOpenPulls(sdk, repo(), ['refs/heads/f', 'refs/heads/g'])) ?? [])]).toEqual(['refs/heads/g'])
  })

  it('answers null (unknown) when a page came back full, and reads nothing for none or a private repo', async () => {
    const full = Array.from({ length: 100 }, (_, i) => patch(i + 1, 'refs/heads/busy'))
    expect(await branchesWithOpenPulls(mockSdk(store(full), newSeen()), repo(), ['refs/heads/busy'])).toBeNull()
    const moves = Array.from({ length: 100 }, (_, i) => move(1, i % 2 === 0 ? 1 : -1, i))
    expect(await branchesWithOpenPulls(mockSdk(store([patch(1, 'refs/heads/busy')], moves), newSeen()), repo(), ['refs/heads/busy'])).toBeNull()
    const seen = newSeen()
    expect([...((await branchesWithOpenPulls(mockSdk(store([]), seen), repo(), [])) ?? ['x'])]).toEqual([])
    expect(await branchesWithOpenPulls(mockSdk(store([]), seen), repo('private'), ['refs/heads/f'])).toBeNull()
    expect(seen.composites).toHaveLength(0)
  })
})

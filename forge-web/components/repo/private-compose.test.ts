/**
 * The compose gate and the composer's cost on a private repo (`private-compose.tsx`): only a
 * member holding the current, writable key may compose (issue, comment, inline comment, PR,
 * review), and the cost shown is the sealed document's.
 */

import { describe, expect, it } from 'vitest'

import type { RepoRef } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { composeCost, privateWriteBlock } from './private-compose'

const FORGE = { core: 'C', collab: 'L', group: 'G' }
const PRIV: RepoRef = { forge: FORGE, repoId: 'R', ownerId: 'O', name: 'r', visibility: 'private' }
const PUB: RepoRef = { ...PRIV, visibility: 'public' }

function member(res: Partial<{ writeEpoch: number | null; currentEpoch: number | null; burned: number[]; nonMembers: number; keys: number[] }>): RepoHome['private'] {
  const resolution = {
    writeEpoch: res.writeEpoch ?? null,
    currentEpoch: res.currentEpoch ?? null,
    burned: new Set(res.burned ?? []),
    keys: new Map((res.keys ?? []).map((e) => [e, {}])),
    repair: { rotate: false, nonMembers: Array.from({ length: res.nonMembers ?? 0 }, () => new Uint8Array(32)), missingWraps: [] },
  }
  return { access: 'member', session: { resolution } } as unknown as RepoHome['private']
}

describe('the private compose gate', () => {
  it('a public repo is never blocked', () => {
    expect(privateWriteBlock(PUB, undefined)).toBeNull()
  })

  it('non-members, members without a key, and unwritable epochs are blocked with the reason', () => {
    expect(privateWriteBlock(PRIV, undefined)).toMatch(/Only members/)
    expect(privateWriteBlock(PRIV, { access: 'no-key' } as RepoHome['private'])).toMatch(/encryption key/)
    expect(privateWriteBlock(PRIV, member({ currentEpoch: 1, burned: [1], keys: [0, 1] }))).toMatch(/epoch 1 is closed/)
    expect(privateWriteBlock(PRIV, member({ currentEpoch: 0, nonMembers: 1, keys: [0] }))).toMatch(/no longer a member/)
    expect(privateWriteBlock(PRIV, member({ currentEpoch: 1, keys: [0] }))).toMatch(/current key/)
    expect(privateWriteBlock(PRIV, member({ writeEpoch: 0, currentEpoch: 0, keys: [0] }))).toBeNull()
  })
})

describe('the composer cost on a private repo', () => {
  it('is the sealed document’s: it grows with the text and the path, and differs from the plaintext price', () => {
    const small = composeCost(PRIV, 'comment', { body: 'hi' })
    const withPath = composeCost(PRIV, 'comment', { body: 'hi', path: 'src/a/very/long/path.rs' })
    expect(withPath.credits).toBeGreaterThan(small.credits)
    expect(composeCost(PUB, 'comment', { body: 'hi' }).credits).not.toBe(small.credits)
  })
})

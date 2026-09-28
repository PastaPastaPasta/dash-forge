/**
 * The jump box (L-25): what a typed text means, and a bare word looked up both as a repo name
 * and as a DPNS name, so "ripgrep" finds the repo instead of a missing profile.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { describe, expect, it, vi } from 'vitest'

import type { DiscoveredRepo } from './discovery'
import { parseJump, resolveWord, wordTarget, type WordMatches } from './jump'

// The unit-test build targets testnet, which has no forge-v2 deployment: read moutai's ids.
vi.mock('../constants', async (orig) => {
  const real = await orig<typeof import('../constants')>()
  const { DEPLOYMENTS, forgeV2Ids } = await import('../deployments')
  const devnet = { ...real.NETWORKS.devnet, key: 'devnet-moutai', v2: forgeV2Ids(DEPLOYMENTS['devnet-moutai']) }
  return { ...real, NETWORKS: { ...real.NETWORKS, devnet } }
})


const ME = '5999iJiaZLMEb6KbjXYFDDYjwGWssatToUTJbXvXhxBp'
const OTHER = '8unje8KNimvQ15NJeNTM15m7Dc4o7QJs4ZstWrbXdGxv'

describe('parseJump', () => {
  it('reads owner/name, owner/name#n, @name, an identity id and #n', () => {
    expect(parseJump('alice/project', false)).toEqual({ kind: 'repo', owner: 'alice', name: 'project' })
    expect(parseJump('@alice/project#12', false)).toEqual({ kind: 'repo', owner: 'alice', name: 'project', number: 12 })
    expect(parseJump('@alice', false)).toEqual({ kind: 'profile', name: 'alice' })
    expect(parseJump(ME, false)).toEqual({ kind: 'profile', name: ME })
    expect(parseJump(' #42 ', true)).toEqual({ kind: 'number', number: 42 })
    expect(parseJump('', true)).toBeNull()
  })
  it('reads a bare word as a repo-or-profile word, not a profile (L-25)', () => {
    expect(parseJump('ripgrep', false)).toEqual({ kind: 'word', word: 'ripgrep' })
    expect(parseJump(' alice ', true)).toEqual({ kind: 'word', word: 'alice' })
  })
  it('explains #n outside a repo and junk', () => {
    expect(parseJump('#3', false)).toMatchObject({ kind: 'invalid' })
    expect(parseJump('a b', false)).toMatchObject({ kind: 'invalid' })
    expect(parseJump('a/b/c', false)).toMatchObject({ kind: 'invalid' })
  })
})

const repo = (name: string, ownerId: string): DiscoveredRepo => ({
  key: `${name}-${ownerId.slice(0, 4)}`,
  ownerId,
  name,
  slug: name,
  description: '',
  createdAt: 0,
  visibility: 'public',
})

describe('wordTarget', () => {
  const m = (repos: DiscoveredRepo[], profile: string | null): WordMatches => ({ repos, profile })
  it('goes straight to the one match', () => {
    expect(wordTarget(m([repo('ripgrep', ME)], null))).toEqual({ kind: 'repo', repo: repo('ripgrep', ME) })
    expect(wordTarget(m([], OTHER))).toEqual({ kind: 'profile', identityId: OTHER })
  })
  it('offers a choice when the word names several things', () => {
    expect(wordTarget(m([repo('jq', ME), repo('jq', OTHER)], null)).kind).toBe('choose')
    expect(wordTarget(m([repo('alice', ME)], OTHER)).kind).toBe('choose')
  })
  it('says when it names nothing', () => {
    expect(wordTarget(m([], null))).toEqual({ kind: 'none' })
  })
})

describe('resolveWord', () => {
  type Doc = Record<string, unknown>
  /** A mock answering the repo-name composite and DPNS `resolveName`, counting both. */
  function sdk(repos: Doc[], dpns: Record<string, string>, fail: { repos?: boolean; dpns?: boolean } = {}): { sdk: EvoSDK; calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      sdk: {
        documents: {
          composite: async (q: { where: [string, string, unknown][]; subQueries: unknown[] }) => {
            calls.push(`composite ${JSON.stringify(q.where)}`)
            if (fail.repos) throw new Error('node down')
            const name = q.where[0]?.[2]
            return { pageDocuments: repos.filter((d) => d['name'] === name), subResults: q.subQueries.map(() => ({ kind: 'documents', documents: [] })) }
          },
        },
        dpns: {
          resolveName: async (full: string) => {
            calls.push(`dpns ${full}`)
            if (fail.dpns) throw new Error('dpns down')
            return dpns[full]
          },
        },
      } as unknown as EvoSDK,
    }
  }
  const doc = (name: string, owner: string): Doc => ({ $id: `${name}${owner}`.slice(0, 44), $ownerId: owner, $createdAt: 1, name, visibility: 'public' })

  it('finds a repo named the word, not a missing profile: two requests, in parallel', async () => {
    const { sdk: s, calls } = sdk([doc('ripgrep', OTHER)], {})
    const m = await resolveWord(s, 'ripgrep', 'devnet')
    expect(m.repos.map((r) => [r.slug, r.ownerId])).toEqual([['ripgrep', OTHER]])
    expect(m.profile).toBeNull()
    expect(wordTarget(m)).toMatchObject({ kind: 'repo' })
    expect(calls).toEqual([`composite [["name","==","ripgrep"]]`, 'dpns ripgrep.dash'])
  })

  it('shows both when the word is a repo and a name', async () => {
    const { sdk: s } = sdk([doc('alice', ME)], { 'alice.dash': OTHER })
    const m = await resolveWord(s, 'alice', 'devnet')
    expect(m.repos).toHaveLength(1)
    expect(m.profile).toBe(OTHER)
    expect(wordTarget(m).kind).toBe('choose')
  })

  it('keeps one side when the other fails, and fails only when both do', async () => {
    const repoDown = await resolveWord(sdk([], { 'bob.dash': ME }, { repos: true }).sdk, 'bob', 'devnet')
    expect(repoDown).toEqual({ repos: [], profile: ME })
    const dpnsDown = await resolveWord(sdk([doc('bob', OTHER)], {}, { dpns: true }).sdk, 'bob', 'devnet')
    expect(dpnsDown.repos).toHaveLength(1)
    await expect(resolveWord(sdk([], {}, { repos: true, dpns: true }).sdk, 'carol', 'devnet')).rejects.toThrow()
  })
})

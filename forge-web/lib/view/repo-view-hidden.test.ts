/**
 * A repo this build hides (docs/hosted-curation.md) resolves to a home that says so, and nothing
 * of its content is read: no refs, no config, no browse prefetch (`onResolved` is not called).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Hidden } from './curation'

const hiddenNow = vi.hoisted(() => ({ value: { repos: new Set<string>(), identities: new Set<string>() } as Hidden }))
vi.mock('./curation', async (orig) => {
  const real = await orig<typeof import('./curation')>()
  return { ...real, isHiddenRepo: (repoId: string, ownerId: string, hidden: Hidden = hiddenNow.value) => real.isHiddenRepo(repoId, ownerId, hidden) }
})

const OWNER = 'Amc7FjA3CJLae4stwztokTumqCX8KfDCkA3zNwVVYRZB'
const REPO_ID = 'Hynz8VtPiEBXn7VcMLCLCPgNo4uVK2KKveGn5P4CvinW'
const FORGE = { core: 'core', collab: 'collab', community: 'community', group: 'group' }
const doc = { repoId: REPO_ID, ownerId: OWNER, name: 'thing', displayName: '', description: 'secret words', visibility: 'public', defaultBranch: 'trunk', topics: [], forkOf: null, createdAt: 1 }
const repo = { forge: FORGE, repoId: REPO_ID, ownerId: OWNER, name: 'thing', visibility: 'public' }

const reads = vi.hoisted(() => ({ refs: 0, config: 0, stars: 0 }))
vi.mock('../constants', async (orig) => {
  const real = await orig<typeof import('../constants')>()
  return { ...real, NETWORKS: { ...real.NETWORKS, testnet: { ...real.NETWORKS.testnet, v2: FORGE } } }
})
vi.mock('../repo', async (orig) => {
  const real = await orig<typeof import('../repo')>()
  return {
    ...real,
    resolveOwner: async () => OWNER,
    readRepoChrome: async () => ({ repo, doc, read: null, starCount: 3, ownerDomains: [] }),
    resolveAnyRepo: async () => ({ repo, doc }),
    readConfigBundle: async () => {
      reads.config++
      return { config: null, history: [] }
    },
    readRefs: async () => {
      reads.refs++
      return []
    },
    readStarCount: async () => {
      reads.stars++
      return 3
    },
  }
})

const { loadRepoHome } = await import('./repo-view')

const sdk = {} as EvoSDK
beforeEach(() => {
  hiddenNow.value = { repos: new Set(), identities: new Set() }
  reads.refs = reads.config = reads.stars = 0
})

describe('loadRepoHome and hosted curation', () => {
  it('returns a hidden home for a hidden repo, reading no content and not starting a browse prefetch', async () => {
    hiddenNow.value = { repos: new Set([REPO_ID]), identities: new Set() }
    const onResolved = vi.fn()
    const home = await loadRepoHome(sdk, { network: 'testnet', owner: OWNER, name: 'thing' }, onResolved)
    expect(home).toMatchObject({ hidden: true, branches: [], tags: [], config: null, description: '' })
    expect(home?.repo.repoId).toBe(REPO_ID)
    expect(onResolved).not.toHaveBeenCalled()
  })

  it('does the same for a repo of a hidden identity, however it is addressed (?repo=)', async () => {
    hiddenNow.value = { repos: new Set(), identities: new Set([OWNER]) }
    const onResolved = vi.fn()
    const home = await loadRepoHome(sdk, { network: 'testnet', owner: OWNER, name: 'thing', repoId: REPO_ID }, onResolved)
    expect(home?.hidden).toBe(true)
    expect(reads).toEqual({ refs: 0, config: 0, stars: 0 })
    expect(onResolved).not.toHaveBeenCalled()
  })

  it('opens a repo that is not hidden as before', async () => {
    hiddenNow.value = { repos: new Set(['someone-else']), identities: new Set() }
    const onResolved = vi.fn()
    const home = await loadRepoHome(sdk, { network: 'testnet', owner: OWNER, name: 'thing', repoId: REPO_ID }, onResolved)
    expect(home?.hidden).toBeUndefined()
    expect(onResolved).toHaveBeenCalledOnce()
    expect(home?.description).toBe('secret words')
    expect(reads.refs).toBe(1)
  })
})

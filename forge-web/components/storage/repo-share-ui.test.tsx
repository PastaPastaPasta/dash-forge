// @vitest-environment jsdom
/**
 * Maintainers get only storage the owner set for the repo: the owner's one action, the shared card,
 * the maintainer's line, the one-time notice, and nothing of it on a network without sync.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_STORAGE_CONFIG, type StorageConfig } from '@/lib/storage'

const state = vi.hoisted(() => ({ config: null as StorageConfig | null }))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: state.config, storable: true, save: vi.fn(), error: null, needsUnlock: false }) }))

import { LOCAL_PUSHES_HINT, SHARE_ACTION, storageCardView } from './repo-share-notes'
import { RepoStoragePolicy } from './repo-storage-policy'
import { OWNER_STORAGE_UNSET, StorageRow } from '@/components/repo/merge-upload'
import { noteStopped, stoppedDefaultKey, takeStoppedNotice } from '@/hooks/use-repo-share'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const kubo = { name: 'kubo', settings: { kind: 'ipfs-kubo', provider: 'kubo', api: 'http://127.0.0.1:5001', gateway: '', publicGateway: '', pinningEndpoint: '' }, secrets: {} } as StorageConfig['profiles'][number]
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  state.config = { ...EMPTY_STORAGE_CONFIG, profiles: [kubo] }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  localStorage.clear()
})

describe('the "Your browser pushes" card by case', () => {
  it('without sync (mainnet) it is master’s card: its hint, no action, no details', () => {
    for (const owner of [true, false]) for (const hasRepoStorage of [true, false]) {
      expect(storageCardView({ syncOn: false, owner, hasRepoStorage, repoStorageShareable: hasRepoStorage, maintainers: 2 })).toEqual({ hint: LOCAL_PUSHES_HINT, details: false })
    }
    expect(LOCAL_PUSHES_HINT).toBe('Only you see this: it stays in this browser.')
  })

  it('offers the owner the one action only with sync, maintainers, and no storage of the repo’s own', () => {
    expect(storageCardView({ syncOn: true, owner: true, hasRepoStorage: false, repoStorageShareable: false, maintainers: 1 }).shareAction).toBe(SHARE_ACTION)
    expect(storageCardView({ syncOn: true, owner: true, hasRepoStorage: false, repoStorageShareable: false, maintainers: 0 }).shareAction).toBeUndefined()
    expect(storageCardView({ syncOn: true, owner: false, hasRepoStorage: false, repoStorageShareable: false, maintainers: 1 }).shareAction).toBeUndefined()
    expect(storageCardView({ syncOn: true, owner: true, hasRepoStorage: true, repoStorageShareable: true, maintainers: 1 })).toEqual({ hint: "Shared with this repo's maintainers.", details: true })
  })

  it('says shared only with maintainers and a place that is not Platform', () => {
    const alone = { hint: 'Only you see this.', details: false }
    expect(storageCardView({ syncOn: true, owner: true, hasRepoStorage: true, repoStorageShareable: true, maintainers: 0 })).toEqual(alone)
    expect(storageCardView({ syncOn: true, owner: true, hasRepoStorage: true, repoStorageShareable: false, maintainers: 3 })).toEqual(alone)
  })
})

describe('the per-repo editor', () => {
  it('opens from the share action, and is the editor as before without it', async () => {
    await act(async () => root.render(<RepoStoragePolicy repoId="r" shareAction={SHARE_ACTION} />))
    const button = host.querySelector('[data-testid="share-repo-storage"]') as HTMLButtonElement
    expect(button.textContent).toBe(SHARE_ACTION)
    expect(host.querySelector('[data-testid="repo-storage-policy"]')).toBeNull()
    await act(async () => button.click())
    expect(host.querySelector('[data-testid="repo-storage-policy"]')).not.toBeNull()
    await act(async () => root.render(<RepoStoragePolicy repoId="other" />))
    expect(host.querySelector('[data-testid="share-repo-storage"]')).toBeNull()
    expect(host.querySelector('[data-testid="repo-storage-policy"]')).not.toBeNull()
  })

  it('shows the editor at once when the repo already has its own storage', async () => {
    state.config = { ...EMPTY_STORAGE_CONFIG, profiles: [kubo], repoPolicies: { r: { targets: ['kubo'], replicas: 1, platformFallback: false } } }
    await act(async () => root.render(<RepoStoragePolicy repoId="r" shareAction={SHARE_ACTION} />))
    expect(host.querySelector('[data-testid="share-repo-storage"]')).toBeNull()
    expect(host.querySelector('[data-testid="repo-storage-policy"]')).not.toBeNull()
  })
})

describe('the maintainer line', () => {
  const choice = { label: 'kubo', platform: { kind: 'never' }, platformCredits: null } as unknown as Parameters<typeof StorageRow>[0]['choice']

  it('says the owner set no storage, only when told to', async () => {
    await act(async () => root.render(<StorageRow choice={choice} allowed={false} onAllow={() => undefined} ownerUnset />))
    expect(host.querySelector('[data-testid="owner-storage-unset"]')?.textContent).toBe(OWNER_STORAGE_UNSET)
    await act(async () => root.render(<StorageRow choice={choice} allowed={false} onAllow={() => undefined} />))
    expect(host.querySelector('[data-testid="owner-storage-unset"]')).toBeNull()
  })
})

describe('the stopped-sharing notice', () => {
  it('says the default-storage stop once per repo, recorded under its own key', () => {
    expect(takeStoppedNotice('testnet', 'r')).toBeNull()
    noteStopped('testnet', 'r', 'default')
    expect(localStorage.getItem(stoppedDefaultKey('testnet', 'r'))).toBe('pending')
    expect(takeStoppedNotice('testnet', 'r')).toBe('default')
    expect(Number(localStorage.getItem(stoppedDefaultKey('testnet', 'r')))).toBeGreaterThan(0)
    expect(takeStoppedNotice('testnet', 'r')).toBeNull()
    noteStopped('testnet', 'r', 'default')
    expect(takeStoppedNotice('testnet', 'r')).toBeNull()
    noteStopped('testnet', 'other', 'default')
    expect(takeStoppedNotice('testnet', 'other')).toBe('default')
  })

  it('keeps a default-storage stop not yet said across a reload (its key waits)', () => {
    localStorage.setItem(stoppedDefaultKey('testnet', 'reloaded'), 'pending')
    expect(takeStoppedNotice('testnet', 'reloaded')).toBe('default')
    expect(takeStoppedNotice('testnet', 'reloaded')).toBeNull()
  })

  it('says an explicit stop plainly, each time, and records nothing', () => {
    noteStopped('testnet', 'stop', 'removed')
    expect(takeStoppedNotice('testnet', 'stop')).toBe('removed')
    expect(takeStoppedNotice('testnet', 'stop')).toBeNull()
    expect(localStorage.getItem(stoppedDefaultKey('testnet', 'stop'))).toBeNull()
    noteStopped('testnet', 'stop', 'removed')
    expect(takeStoppedNotice('testnet', 'stop')).toBe('removed')
  })
})

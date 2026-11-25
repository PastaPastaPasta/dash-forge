// @vitest-environment jsdom
/** A maintainer's grant status: none set, one there that does not open here, and reads that settle. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '@/lib/repo/contract'

const fake = vi.hoisted(() => ({ maintainers: vi.fn(), granted: vi.fn(), grantFor: vi.fn(), sdk: {} }))
vi.mock('@/lib/constants', async (load) => {
  const real = await load<typeof import('@/lib/constants')>()
  const v2 = { ...(real.ACTIVE_NETWORK.v2 ?? {}), user: 'forge-user' }
  return { ...real, ACTIVE_NETWORK: { ...real.ACTIVE_NETWORK, key: 'testnet', v2 } }
})
vi.mock('./use-sdk', () => ({ useSdk: () => ({ sdk: fake.sdk, ready: true, network: 'testnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'maintainer', signer: null, controller: null }) }))
vi.mock('@/lib/repo/members', () => ({ readMaintainers: fake.maintainers }))
vi.mock('@/lib/auth/vault', async (load) => ({
  ...(await load<typeof import('@/lib/auth/vault')>()),
  heldSyncKeyId: () => 1,
  onSyncKeyChange: () => () => undefined,
  onVaultLock: () => () => undefined,
  withSyncKey: async (_n: unknown, _id: unknown, f: (keyId: number, E: Uint8Array) => Promise<unknown>) => f(1, new Uint8Array(32)),
}))
vi.mock('@/lib/user-sync/platform', () => ({ forgeUserPort: () => ({ grantFor: fake.grantFor }) }))
vi.mock('@/lib/user-sync/maintainers', async (load) => {
  const real = await load<typeof import('@/lib/user-sync/maintainers')>()
  return { ...real, readGrantedStorage: fake.granted }
})

import { noteStopped, stoppedDefaultKey, useRepoGrant, useStoppedShareNotice } from './use-repo-share'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const repo = { forge: { core: 'core' }, repoId: 'r', ownerId: 'owner', name: 'repo', visibility: 'public' } as RepoRef
let host: HTMLDivElement
let root: Root
let status = ''
let renders = 0
function Probe(): null {
  renders += 1
  status = useRepoGrant(repo).status
  return null
}

beforeEach(() => {
  fake.maintainers.mockReset().mockResolvedValue(['maintainer'])
  fake.granted.mockReset().mockResolvedValue(null)
  fake.grantFor.mockReset().mockResolvedValue(null)
  renders = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useRepoGrant with forge-user', () => {
  it('is none when the owner shared nothing, and settles', async () => {
    await act(async () => root.render(<Probe />))
    expect(status).toBe('none')
    const settled = renders
    await act(async () => root.render(<Probe />))
    await act(async () => root.render(<Probe />))
    expect(status).toBe('none')
    expect(renders).toBeLessThanOrEqual(settled + 2)
  })

  it('is unusable, not none, when a grant is there but does not open here', async () => {
    fake.grantFor.mockResolvedValue({ id: 'g' })
    await act(async () => root.render(<Probe />))
    expect(status).toBe('unusable')
  })

  it('is not-maintainer for anyone else (and reads no grant)', async () => {
    fake.maintainers.mockResolvedValue([])
    await act(async () => root.render(<Probe />))
    expect(status).toBe('not-maintainer')
    expect(fake.granted).not.toHaveBeenCalled()
  })
})

describe('the stopped-sharing notice on the page', () => {
  let line: string | null = null
  function Notice({ visible }: { readonly visible: boolean }): null {
    line = useStoppedShareNotice(repo, visible)
    return null
  }

  it('waits while the Storage section is hidden, then is said once it shows', async () => {
    localStorage.clear()
    await act(async () => root.render(<Notice visible={false} />))
    await act(async () => noteStopped('testnet', repo.repoId, 'default'))
    expect(line).toBeNull()
    expect(localStorage.getItem(stoppedDefaultKey('testnet', repo.repoId))).toBe('pending')
    await act(async () => root.render(<Notice visible />))
    expect(line).toBe('default')
    expect(localStorage.getItem(stoppedDefaultKey('testnet', repo.repoId))).not.toBe('pending')
  })

  it('says a stop made while the section shows', async () => {
    localStorage.clear()
    await act(async () => root.render(<Notice visible />))
    expect(line).toBeNull()
    await act(async () => noteStopped('testnet', repo.repoId, 'removed'))
    expect(line).toBe('removed')
  })
})

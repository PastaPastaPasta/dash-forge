// @vitest-environment jsdom
/** On a network without forge-user (mainnet), a maintainer's grant is never read and no line shows. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '@/lib/repo/contract'

const reads = vi.hoisted(() => ({ maintainers: vi.fn() }))
vi.mock('@/lib/constants', async (load) => {
  const real = await load<typeof import('@/lib/constants')>()
  const v2 = real.ACTIVE_NETWORK.v2 === null ? null : { ...real.ACTIVE_NETWORK.v2, user: undefined }
  return { ...real, ACTIVE_NETWORK: { ...real.ACTIVE_NETWORK, v2 } }
})
vi.mock('./use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'mainnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'maintainer', signer: null, controller: null }) }))
vi.mock('@/lib/repo/members', () => ({ readMaintainers: reads.maintainers }))

import { useRepoGrant } from './use-repo-share'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const repo = { forge: { core: 'core' }, repoId: 'r', ownerId: 'owner', name: 'repo', visibility: 'public' } as RepoRef
let host: HTMLDivElement
let root: Root
let status = ''
function Probe(): null {
  status = useRepoGrant(repo).status
  return null
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useRepoGrant without forge-user', () => {
  it('is off and reads nothing', async () => {
    await act(async () => root.render(<Probe />))
    expect(status).toBe('off')
    expect(reads.maintainers).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
/**
 * A private repo's Settings → Collaborators for a member whose tab has not opened the encryption
 * key: after a reload (the tab kept only the signing key) it offers the inline unlock; a browser
 * with no encryption key at all keeps the "add your encryption key" note (D-9).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'

const unlockMore = vi.fn(async () => undefined)
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: 'owner',
    signer: { identityId: 'owner' },
    vaults: [{ identityId: 'owner', methods: ['passphrase'] }],
    controller: { unlockMore },
    isLoading: false,
  }),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ disabledReason: null, check: () => true }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role: 'maintainer' }) }))
vi.mock('@/lib/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/repo')>()),
  readMembershipsCached: async () => [{ identity: 'owner', role: 'maintainer' }],
}))
vi.mock('@/components/repo/repo-settings-sections', () => ({
  SettingsNav: () => null,
  GeneralSettings: () => null,
  BranchSettings: () => null,
  DangerZone: () => null,
  Section: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}))
vi.mock('@/components/storage/repo-storage-policy', () => ({ RepoStoragePolicy: () => null }))
vi.mock('@/components/repo/invite-banner', () => ({ Invitations: () => null }))
vi.mock('@/components/repo/private-members', () => ({ PrivateMembers: () => <div data-testid="private-members" /> }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))
vi.mock('@/components/ui/backend-badge', () => ({ BackendBadge: () => null }))

import { SettingsContent } from './settings-content'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function privateHome(access: 'locked' | 'no-key'): RepoHome {
  return {
    repo: { repoId: 'R', name: 'secret', ownerId: 'owner', visibility: 'private', forge: { core: 'C', collab: 'L', community: 'M' } },
    backend: { kind: 'platform', uris: [] },
    private: { access },
  } as unknown as RepoHome
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  unlockMore.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(home: RepoHome): Promise<void> {
  await act(async () => {
    root.render(<SettingsContent home={home} reload={() => undefined} />)
  })
}

describe('private repo Settings → Collaborators before this tab opened the encryption key', () => {
  it('offers the inline unlock when the key is in the vault but this tab is signing-only', async () => {
    await render(privateHome('locked'))
    const unlock = host.querySelector('[data-testid="members-unlock"]')
    expect(unlock).not.toBeNull()
    expect(unlock?.textContent).toMatch(/Unlock this tab to add or remove members/)
    expect(host.textContent).not.toMatch(/add your encryption key to this browser/)
    // The passphrase unlocks this tab (the page then re-resolves the repo as a member).
    const input = host.querySelector<HTMLInputElement>('#members-unlock-passphrase')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'hunter2')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.form!.requestSubmit()
    })
    expect(unlockMore).toHaveBeenCalledWith({ passphrase: 'hunter2' })
  })

  it('keeps the "add your encryption key" note when this browser holds none', async () => {
    await render(privateHome('no-key'))
    expect(host.querySelector('[data-testid="members-unlock"]')).toBeNull()
    expect(host.textContent).toMatch(/add your encryption key to this browser/)
  })
})

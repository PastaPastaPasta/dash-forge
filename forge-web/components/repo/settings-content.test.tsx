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
const viewer: { id: string | null; locked: string | null } = { id: 'owner', locked: null }
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    identity: viewer.id,
    signer: viewer.id === null ? null : { identityId: viewer.id },
    locked: viewer.locked !== null,
    lockedIdentity: viewer.locked,
    vaults: [{ identityId: viewer.id, methods: ['passphrase'] }],
    controller: { unlockMore },
    isLoading: false,
  }),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ disabledReason: null, check: () => true }) }))
const role: { value: 'maintainer' | 'writer' | null } = { value: 'maintainer' }
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role: role.value, known: true }) }))
vi.mock('@/lib/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/repo')>()),
  readMembershipsCached: async () => [{ identity: 'owner', role: 'maintainer' }],
}))
vi.mock('@/components/repo/repo-settings-sections', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  GeneralSettings: () => null,
  BranchSettings: () => null,
  DangerZone: () => null,
  Section: ({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) => (
    <section id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}))
vi.mock('@/components/storage/repo-storage-policy', () => ({
  RepoStoragePolicy: ({ unlockAbove }: { unlockAbove?: boolean }) => <div data-testid="storage-policy" data-unlock-above={String(unlockAbove === true)} />,
}))
/** Whether the identity typed into Add a member accepted (null: still checking). */
const consent: { accepted: boolean | null; error: string | null } = { accepted: true, error: null }
vi.mock('@/components/repo/invite-banner', () => ({
  mayAdd: (c: { accepted: boolean | null; error: string | null }) => c.accepted === true || (c.accepted === null && c.error !== null),
  Invitations: () => null,
  useInviteAccepted: (_repo: unknown, id: string | null) => ({ accepted: id === null ? null : consent.accepted, checking: false, error: id === null ? null : consent.error, recheck: () => undefined }),
  ConsentCheck: ({ identity, check }: { identity: string | null; check: { accepted: boolean | null } }) =>
    identity !== null && check.accepted === false ? <p data-testid="consent-missing">not accepted</p> : null,
}))
vi.mock('@/components/repo/webhook-settings', () => ({ WebhookSettings: () => null }))
vi.mock('@/components/repo/private-members', () => ({ PrivateMembers: () => <div data-testid="private-members" /> }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))
vi.mock('@/components/ui/backend-badge', () => ({ BackendBadge: () => null }))
vi.mock('@/components/repo/private-repo-state', () => ({ PrivateRepoState: ({ access }: { access: string }) => <div data-testid="private-repo" data-access={access} /> }))

import { SettingsContent } from './settings-content'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function repoHome(visibility: 'private' | 'public', access?: 'locked' | 'no-key' | 'member' | 'outsider' | 'signed-out'): RepoHome {
  return {
    repo: { repoId: 'R', name: 'secret', ownerId: 'owner', visibility, forge: { core: 'C', collab: 'L', community: 'M' } },
    backend: { kind: 'platform', uris: [] },
    private: access === undefined ? undefined : access === 'member' ? { access, session: {} } : { access },
  } as unknown as RepoHome
}
const privateHome = (access: 'locked' | 'no-key' | 'member' | 'outsider' | 'signed-out'): RepoHome => repoHome('private', access)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  unlockMore.mockClear()
  viewer.id = 'owner'
  viewer.locked = null
  role.value = 'maintainer'
  consent.accepted = true
  consent.error = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Renders the page on the section `hash` names (the page shows one section at a time). */
async function render(home: RepoHome, hash = 'collaborators'): Promise<void> {
  window.location.hash = hash
  await act(async () => {
    root.render(<SettingsContent home={home} reload={() => undefined} />)
  })
}

describe('private repo Settings for a non-member (QW-079)', () => {
  for (const access of ['outsider', 'signed-out'] as const) {
    it(`shows a ${access} viewer the private-repo state, not settings that claim no branches`, async () => {
      await render(privateHome(access))
      expect(host.querySelector('[data-testid="private-repo"]')?.getAttribute('data-access')).toBe(access)
      expect(host.querySelector('nav[aria-label="Settings sections"]')).toBeNull()
      expect(host.textContent).not.toMatch(/Members/)
    })
  }
})

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

  it('offers a locked member who is not the owner the unlock for the key epoch', async () => {
    viewer.id = 'writer'
    await render(privateHome('locked'))
    expect(host.querySelector('[data-testid="members-unlock"]')?.textContent).toMatch(/Unlock this tab to see the repo's key epoch/)
    expect(host.textContent).toMatch(/Only the owner can add or remove members/)
  })

  it('an unlocked member gets the private member view, without the unlock', async () => {
    await render(privateHome('member'))
    expect(host.querySelector('[data-testid="private-members"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="members-unlock"]')).toBeNull()
  })

  it("a public repo's owner still gets the add form", async () => {
    await render(repoHome('public'))
    expect(host.querySelector('#member-id')).not.toBeNull()
    expect(host.querySelector('[data-testid="members-unlock"]')).toBeNull()
  })
})

describe('one unlock per Settings page', () => {
  const unlockAbove = (): string | null | undefined => host.querySelector('[data-testid="storage-policy"]')?.getAttribute('data-unlock-above')

  it('a locked private repo: the Storage section defers to the unlock under Collaborators', async () => {
    await render(privateHome('locked'))
    expect(host.querySelectorAll('[data-testid="members-unlock"]')).toHaveLength(1)
    await render(privateHome('locked'), 'storage')
    expect(host.querySelectorAll('[data-testid="members-unlock"]')).toHaveLength(1)
    expect(unlockAbove()).toBe('true')
  })

  it('anywhere else the Storage section offers its own unlock when it needs one', async () => {
    for (const home of [repoHome('public'), privateHome('member'), privateHome('no-key')]) {
      await render(home, 'storage')
      expect(unlockAbove()).toBe('false')
    }
  })
})

describe('a non-maintainer on Settings (QW3-055)', () => {
  it('says the page is read-only and never asks an outsider to unlock storage for a repo they cannot push to', async () => {
    viewer.id = 'outsider'
    role.value = null
    await render(repoHome('public'), 'storage')
    expect(host.querySelector('[data-testid="settings-read-only"]')?.textContent).toMatch(/read-only: only its maintainers can change them/)
    expect(host.querySelector('[data-testid="storage-policy"]')).toBeNull()
  })

  it('tells a writer the same, and keeps their own push storage', async () => {
    viewer.id = 'writer'
    role.value = 'writer'
    await render(repoHome('public'), 'storage')
    expect(host.querySelector('[data-testid="settings-read-only"]')?.textContent).toMatch(/You're a writer here/)
    expect(host.querySelector('[data-testid="storage-policy"]')).not.toBeNull()
  })

  it('a maintainer gets no read-only note', async () => {
    await render(repoHome('public'))
    expect(host.querySelector('[data-testid="settings-read-only"]')).toBeNull()
  })
})

describe('a viewer whose session is locked, or who is signed out, on Settings (QW4-035)', () => {
  const note = (): Element | null => host.querySelector('[data-testid="settings-read-only"]')

  it('tells a locked owner to unlock, not to sign in as a maintainer', async () => {
    viewer.id = null
    viewer.locked = 'owner'
    role.value = null
    await render(repoHome('public'))
    expect(note()?.textContent).toMatch(/Your session is locked, so these settings are read-only for now\. Unlock to change them\./)
    expect(note()?.textContent).not.toMatch(/Sign in as one of its maintainers/)
    expect(host.querySelector('[data-testid="settings-read-only-sign-in"]')?.textContent).toBe('Unlock')
  })

  it("tells a locked viewer who isn't the owner to unlock if they maintain it", async () => {
    viewer.id = null
    viewer.locked = 'someone'
    role.value = null
    await render(repoHome('public'))
    expect(note()?.textContent).toMatch(/Unlock to change them if you're one of its maintainers/)
  })

  it('asks a signed-out viewer to sign in as a maintainer', async () => {
    viewer.id = null
    role.value = null
    await render(repoHome('public'))
    expect(note()?.textContent).toMatch(/Sign in as one of its maintainers to change them/)
    expect(host.querySelector('[data-testid="settings-read-only-sign-in"]')?.textContent).toBe('Sign in')
  })
})

describe('Add a member checks the acceptance before pricing the add (QW4-036)', () => {
  const ID = 'EA8HsynH63cw1i8xQLoARwk43sDf74HrKut1D4RV3L35'
  const add = (): HTMLButtonElement => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement
  async function type(value: string): Promise<void> {
    const input = host.querySelector<HTMLInputElement>('#member-id')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it("keeps Add off and says why when they haven't accepted", async () => {
    consent.accepted = false
    await render(repoHome('public'))
    await type(ID)
    expect(add().disabled).toBe(true)
    expect(host.querySelector('[data-testid="consent-missing"]')).not.toBeNull()
  })

  it('turns Add on once they have', async () => {
    await render(repoHome('public'))
    await type(ID)
    expect(add().disabled).toBe(false)
    expect(host.querySelector('[data-testid="consent-missing"]')).toBeNull()
  })

  it('keeps Add off while the check is still running', async () => {
    consent.accepted = null
    await render(repoHome('public'))
    await type(ID)
    expect(add().disabled).toBe(true)
  })

  it('leaves it to the add when the check could not be read (the add checks before signing)', async () => {
    consent.accepted = null
    consent.error = 'network down'
    await render(repoHome('public'))
    await type(ID)
    expect(add().disabled).toBe(false)
  })
})

describe('one section at a time, picked by the URL hash', () => {
  const heading = (): string | null | undefined => host.querySelector('[data-settings-pane]:not([hidden]) section h2')?.textContent

  it('opens the section an old bookmark names, keeping the others mounted but hidden', async () => {
    await render(repoHome('public'), 'storage')
    expect(heading()).toBe('Storage')
    expect(host.querySelector('[data-settings-pane="collaborators"]')?.hasAttribute('hidden')).toBe(true)
    expect(host.querySelector('#member-id')).not.toBeNull()
    expect(host.querySelector('nav[aria-label="Settings sections"] [aria-current="page"]')?.getAttribute('href')).toBe('#storage')
  })

  it('opens Members for its unlock anchor', async () => {
    await render(privateHome('locked'), 'members-unlock')
    expect(heading()).toBe('Members')
  })

  it('follows the hash as the nav changes it', async () => {
    await render(repoHome('public'), 'collaborators')
    expect(heading()).toBe('Members')
    await act(async () => {
      window.location.hash = 'storage'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(heading()).toBe('Storage')
  })

  it('keeps the section on a hash that names none (the skip link) and on a malformed one', async () => {
    await render(repoHome('public'), 'storage')
    for (const hash of ['main', '%']) {
      await act(async () => {
        window.location.hash = hash
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      expect(heading()).toBe('Storage')
    }
  })

  it('follows a click on a link to this page before the router changes the URL', async () => {
    await render(repoHome('public'), 'collaborators')
    const link = document.createElement('a')
    link.href = `${window.location.pathname}${window.location.search}#storage`
    link.addEventListener('click', (e) => e.preventDefault())
    document.body.appendChild(link)
    await act(async () => {
      link.click()
    })
    expect(heading()).toBe('Storage')
    expect(window.location.hash).toBe('#collaborators')
    link.remove()
  })

  it('stays put when a link to this page opens in another tab', async () => {
    await render(repoHome('public'), 'collaborators')
    const link = document.createElement('a')
    link.href = `${window.location.pathname}${window.location.search}#storage`
    link.addEventListener('click', (e) => e.preventDefault())
    document.body.appendChild(link)
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    })
    expect(heading()).toBe('Members')
    link.target = '_blank'
    await act(async () => {
      link.click()
    })
    expect(heading()).toBe('Members')
    link.remove()
  })

  it('goes back to the default section when the hash is cleared', async () => {
    await render(repoHome('public'), 'storage')
    await act(async () => {
      history.pushState(null, '', `${window.location.pathname}${window.location.search}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(host.querySelector('[data-settings-pane="general"]')?.hasAttribute('hidden')).toBe(false)
    expect(host.querySelector('[data-settings-pane="storage"]')?.hasAttribute('hidden')).toBe(true)
  })

  it("keeps a writer out of the Danger zone a link names, on their default section", async () => {
    viewer.id = 'writer'
    role.value = 'writer'
    await render(repoHome('public'), 'danger')
    expect(heading()).toBe('Members')
    expect(host.querySelector('nav a[href="#danger"]')).toBeNull()
  })
})

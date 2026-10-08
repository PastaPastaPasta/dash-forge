// @vitest-environment jsdom
/**
 * The New repository form's "Turn on members-only content now" (DESIGN §11 Q3, §10 "Creating a
 * repo"): ticked by default for a public repo with its measured cost; unticking creates without
 * it; no encryption key in this browser turns it off with the way to set one up; a locked tab asks
 * for an unlock (or untick) before Create; a create whose members-only step failed opens the repo
 * with the notice that offers to turn it on.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/components/app-shell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/ui/network-badge', () => ({ isForgeDeployed: () => true, NotDeployedState: () => null }))
vi.mock('@/components/sign-in-button', () => ({ SignInButton: () => null }))
vi.mock('@/components/auth/unlock-more', () => ({ UnlockMore: ({ title, testId }: { title: string; testId: string }) => <div data-testid={testId}>{title}</div> }))
vi.mock('@/components/ui/cost-preview', () => ({ CostPreview: ({ cost }: { cost: { credits: number } }) => <div data-testid="cost">{cost.credits}</div> }))
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({ open, description, onConfirm }: { open: boolean; description: string; onConfirm: () => Promise<void> }) =>
    open ? (
      <div data-testid="confirm">
        <p>{description}</p>
        <button type="button" data-testid="sign" onClick={() => void onConfirm()}>
          Sign
        </button>
      </div>
    ) : null,
}))
vi.mock('@/lib/constants', async (orig) => ({
  ...(await orig<typeof import('@/lib/constants')>()),
  ACTIVE_NETWORK: { v2: { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'GROUP' } },
  DEFAULT_NETWORK: 'devnet',
  networkName: () => 'devnet',
}))
let unlockScope: 'full' | 'signing' = 'full'
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'me', signer: { identityId: 'me' }, unlockScope }) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ disabledReason: null, check: () => true }) }))
const ops = { keyId: 4, keyIds: [4] }
let held: typeof ops | null | Error = ops
vi.mock('@/lib/auth/encryption-key', () => ({
  encryptionOps: async () => {
    if (held instanceof Error) throw held
    return held
  },
}))
const toast = vi.fn()
vi.mock('@/hooks/use-toasts', () => ({ toast: (t: unknown) => toast(t) }))
vi.mock('@/lib/auth/vault', () => ({ onEncryptionKeyChange: () => () => undefined }))
const createRepo = vi.fn()
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  createRepo: (...args: unknown[]) => createRepo(...args),
  pendingRepoCreations: async () => [],
  repoCreationFirsts: async () => ({ first: {}, rest: {} }),
}))

import NewRepoPage from './page'
import { aboutDash, enableEstimate } from '@/lib/view/audience'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  held = ops
  unlockScope = 'full'
  push.mockReset()
  toast.mockReset()
  createRepo.mockReset()
  createRepo.mockResolvedValue({ repoId: 'R', name: 'demo', membersOnly: { on: true } })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`)
const box = (): HTMLInputElement => q('repo-members-only') as HTMLInputElement
const createButton = (): HTMLButtonElement => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Create repository') as HTMLButtonElement
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}
async function render(): Promise<void> {
  act(() => root.render(<NewRepoPage />))
  await flush()
  const name = host.querySelector('#repo-name') as HTMLInputElement
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'demo')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}
async function createIt(): Promise<void> {
  act(() => createButton().click())
  await flush()
  act(() => q('sign')!.click())
  await flush()
}

describe('/new: members-only content at creation', () => {
  it('is ticked by default for a public repo, with the Turn on sheet’s cost, and the create turns it on', async () => {
    await render()
    expect(box().checked).toBe(true)
    expect(box().disabled).toBe(false)
    expect(q('members-only-create')?.textContent).toContain(`Turn on members-only content now (about ${aboutDash(enableEstimate(1))})`)
    const withIt = Number(q('cost')?.textContent)
    act(() => box().click())
    expect(box().checked).toBe(false)
    expect(Number(q('cost')?.textContent)).toBe(withIt - enableEstimate(1))
    act(() => box().click())
    act(() => createButton().click())
    await flush()
    expect(q('confirm')?.textContent).toContain('Members-only content will be on')
    act(() => q('sign')!.click())
    await flush()
    const [, , , input, , privateCreate] = createRepo.mock.calls[0] as unknown[]
    expect(input).toMatchObject({ name: 'demo', membersOnly: true })
    expect(typeof (privateCreate as { membersOnly?: unknown }).membersOnly).toBe('function')
    expect(push.mock.calls[0]?.[0]).not.toContain('membersOnly=failed')
  })

  it('unticked: the create leaves it off', async () => {
    await render()
    act(() => box().click())
    await createIt()
    const input = createRepo.mock.calls[0]?.[3] as Record<string, unknown>
    expect(input['membersOnly']).toBeUndefined()
  })

  it('is off for a private repo (always members-only) and absent from the form', async () => {
    await render()
    act(() => q('visibility-private')!.click())
    await flush()
    expect(q('repo-members-only')).toBeNull()
  })

  it('without an encryption key in this browser: off, disabled, with the way to set one up', async () => {
    held = null
    await render()
    expect(box().checked).toBe(false)
    expect(box().disabled).toBe(true)
    expect(q('members-only-create')?.querySelector('a')?.textContent).toBe('Set up your encryption key')
    expect(createButton().disabled).toBe(false)
  })

  it('a locked tab asks for an unlock before Create; unticking lets the create go ahead', async () => {
    unlockScope = 'signing'
    await render()
    expect(q('new-members-unlock')).not.toBeNull()
    expect(createButton().disabled).toBe(true)
    act(() => box().click())
    expect(createButton().disabled).toBe(false)
  })

  it('a failed members-only step says why and opens the repo with the notice', async () => {
    createRepo.mockResolvedValue({ repoId: 'R', name: 'demo', membersOnly: { on: false, error: 'quorum not found' } })
    await render()
    await createIt()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ detail: 'quorum not found', tone: 'warn' }))
    expect(push.mock.calls[0]?.[0]).toContain('&membersOnly=failed')
  })

  it('a key read that fails never holds up a public create', async () => {
    held = new Error('forge-collab could not be read')
    await render()
    expect(box().checked).toBe(true)
    expect(q('members-key-error')?.textContent).toContain('forge-collab could not be read')
    expect(createButton().disabled).toBe(false)
  })
})

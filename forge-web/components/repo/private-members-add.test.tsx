// @vitest-environment jsdom
/**
 * QW-075: on a private repo, "Add as writer" on an accepted invitation opens the confirm, as it
 * does on a public repo, once the form has checked their encryption key; it used to only fill the
 * form. An identity with no encryption key gets the form's note, and nothing opens.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'
import type { PrivateSession } from '@/lib/repo/private-session'

const { keyOk } = vi.hoisted(() => ({ keyOk: { value: true } }))
vi.mock('@/lib/repo/private-members', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo/private-members')>()),
  hasUsableEncryptionKey: async () => keyOk.value,
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'O' }, identity: 'O' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-private-write', () => ({ usePrivateWrite: () => ({ context: {}, done: () => undefined }) }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))
vi.mock('@/components/repo/invite-banner', () => ({
  Invitations: ({ onPick }: { onPick: (id: string, role: 'writer' | 'maintainer') => void }) => (
    <button type="button" data-testid="pick" onClick={() => onPick(INVITEE, 'writer')}>
      Add as writer
    </button>
  ),
}))
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({ open, title }: { open: boolean; title: string }) => (open ? <div data-testid="confirm">{title}</div> : null),
}))

import { base58Encode } from '@/lib/auth/base58'
import { PrivateMembers } from './private-members'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const INVITEE = base58Encode(new Uint8Array(32).fill(7))
const home = { repo: { repoId: 'R', name: 'secret', ownerId: 'O', visibility: 'private', forge: { core: 'C', collab: 'L', community: 'M' } } } as unknown as RepoHome
const session = {
  members: [{ identity: 'O', role: 'maintainer' }],
  resolution: { currentEpoch: 0, writeEpoch: 0 },
  anchors: new Map(),
} as unknown as PrivateSession

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const pick = async (): Promise<void> => {
  await act(async () => {
    root.render(<PrivateMembers home={home} session={session} />)
  })
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="pick"]')!.click()
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('private repo: Add as … on an accepted invitation', () => {
  it('opens the confirm once their encryption key checks out', async () => {
    keyOk.value = true
    await pick()
    expect(host.querySelector('[data-testid="confirm"]')?.textContent).toBe('Add writer')
    expect(host.querySelector<HTMLInputElement>('#member-id')!.value).toBe(INVITEE)
  })

  it('opens nothing for an identity with no encryption key, and the form says why', async () => {
    keyOk.value = false
    await pick()
    expect(host.querySelector('[data-testid="confirm"]')).toBeNull()
    expect(host.querySelector('[data-testid="member-no-key"]')).not.toBeNull()
  })
})

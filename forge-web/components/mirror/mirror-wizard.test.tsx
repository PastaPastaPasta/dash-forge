// @vitest-environment jsdom
/**
 * The runner key's `dfk1:` value is held only for the identity it was made on: a switch (or a
 * sign-out) drops the value itself, so switching back does not bring it back.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MirrorProgress } from '@/lib/mirror/progress'

const { A, B, FORGE, auth } = vi.hoisted(() => ({
  A: 'IdentityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  B: 'IdentityBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  FORGE: { core: 'CoreContract111', collab: 'CollabContract111', community: 'CommunityContract111', group: 'Group111' },
  auth: { identity: null as string | null },
}))
const FAKE_KEY = 'dfk1:testnet:fake-runner-key-not-real'

vi.mock('@/lib/constants', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/constants')>()
  return { ...m, ACTIVE_NETWORK: { ...m.ACTIVE_NETWORK, v2: FORGE } }
})
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: auth.identity }) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: null }) }))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: null, needsUnlock: false }) }))
vi.mock('@/lib/mirror/progress', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/mirror/progress')>()
  // Every identity has answered up to the key step.
  const saved: MirrorProgress = {
    ...m.EMPTY_PROGRESS,
    github: { owner: 'octo', name: 'repo', sizeKib: 1 } as MirrorProgress['github'],
    repo: { name: 'repo', repoId: 'Repo111' } as MirrorProgress['repo'],
    storage: 'platform',
    startedAt: 1,
  }
  return { ...m, loadMirrorProgress: async () => saved, saveMirrorProgress: async () => undefined }
})
vi.mock('@/components/mirror/mirror-steps', () => ({
  storageChoice: () => ({ ok: true, kind: 'platform' }),
  GithubStep: () => null,
  RepoStep: () => null,
  StorageStep: () => null,
  WorkflowStep: () => null,
  WaitStep: () => null,
  KeyStep: ({ secret, onCreated }: { secret: string | null; onCreated: (r: unknown, value: string) => void }) => (
    <div data-testid="key-step" data-has-secret={secret !== null}>
      <button type="button" onClick={() => onCreated({ keyId: 3, budgetCredits: '1', expiresAt: 0, saved: false }, FAKE_KEY)}>
        make
      </button>
    </div>
  ),
}))

const { MirrorWizard } = await import('./mirror-wizard')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

async function renderAs(identity: string | null): Promise<void> {
  auth.identity = identity
  act(() => root.render(<MirrorWizard />))
  for (let i = 0; i < 5; i++) await act(async () => Promise.resolve())
}
const keyStep = (): HTMLElement | null => host.querySelector('[data-testid="key-step"]')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('MirrorWizard: the runner key value', () => {
  it('is dropped on an identity switch, and switching back does not restore it', async () => {
    await renderAs(A)
    act(() => keyStep()!.querySelector('button')!.click())
    expect(keyStep()!.dataset['hasSecret']).toBe('true')

    await renderAs(B)
    expect(keyStep()!.dataset['hasSecret']).toBe('false')

    await renderAs(A)
    expect(keyStep()!.dataset['hasSecret']).toBe('false')
  })

  it('is dropped on sign-out', async () => {
    await renderAs(A)
    act(() => keyStep()!.querySelector('button')!.click())
    await renderAs(null)
    await renderAs(A)
    expect(keyStep()!.dataset['hasSecret']).toBe('false')
  })
})

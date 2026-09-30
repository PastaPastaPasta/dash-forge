// @vitest-environment jsdom
/**
 * The runner key's `dfk1:` value is held only for the identity it was made on: a switch (or a
 * sign-out) drops the value itself, so switching back does not bring it back, not even for one
 * render. A key that finishes after a switch leaves the page alone and is recorded (without
 * its value) in its own identity's saved progress.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MirrorProgress } from '@/lib/mirror/progress'

type OnCreated = (r: unknown, value: string) => void

const { A, B, FORGE, auth, created, shownTo, saves } = vi.hoisted(() => ({
  A: 'IdentityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  B: 'IdentityBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  FORGE: { core: 'CoreContract111', collab: 'CollabContract111', community: 'CommunityContract111', group: 'Group111' },
  auth: { identity: null as string | null },
  // The last onCreated each identity's key step was rendered with (a key made in flight).
  created: {} as Record<string, OnCreated>,
  // Every render of the key step that was handed the value, by identity.
  shownTo: [] as string[],
  // Every saveMirrorProgress call: [identity, progress].
  saves: [] as [string, unknown][],
}))
const FAKE_KEY = 'dfk1:testnet:fake-runner-key-not-real'
const RECORD = { keyId: 3, budgetCredits: '1', expiresAt: 0, saved: false }

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
  return {
    ...m,
    loadMirrorProgress: async () => saved,
    saveMirrorProgress: async (_net: string, id: string, p: MirrorProgress) => void saves.push([id, p]),
  }
})
vi.mock('@/components/mirror/mirror-steps', () => ({
  storageChoice: () => ({ ok: true, kind: 'platform' }),
  GithubStep: () => null,
  RepoStep: () => null,
  StorageStep: () => null,
  WorkflowStep: () => null,
  WaitStep: () => null,
  KeyStep: ({ identity, record, secret, onCreated }: { identity: string; record: { keyId: number } | null; secret: string | null; onCreated: OnCreated }) => {
    created[identity] = onCreated
    if (secret !== null) shownTo.push(identity)
    return <div data-testid="key-step" data-has-secret={secret !== null} data-key-id={record?.keyId ?? ''} />
  },
}))

const { MirrorWizard } = await import('./mirror-wizard')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => Promise.resolve())
}
async function renderAs(identity: string | null): Promise<void> {
  auth.identity = identity
  act(() => root.render(<MirrorWizard />))
  await flush()
}
const keyStep = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="key-step"]')!
const hasSecret = (): string | undefined => keyStep().dataset['hasSecret']

beforeEach(() => {
  shownTo.length = 0
  saves.length = 0
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
    act(() => created[A]!(RECORD, FAKE_KEY))
    expect(hasSecret()).toBe('true')
    shownTo.length = 0

    await renderAs(B)
    expect(hasSecret()).toBe('false')
    await renderAs(A)
    expect(hasSecret()).toBe('false')
    expect(shownTo).toEqual([])
  })

  it('arriving after a switch: B is untouched, A gets the record (never the value)', async () => {
    await renderAs(A)
    const inFlight = created[A]!
    await renderAs(B)
    await act(async () => inFlight(RECORD, FAKE_KEY))
    await flush()
    expect(keyStep().dataset['keyId']).toBe('')
    expect(hasSecret()).toBe('false')
    expect(saves).toEqual([[A, expect.objectContaining({ runnerKey: RECORD, storage: 'platform', github: expect.objectContaining({ owner: 'octo' }) })]])
    expect(JSON.stringify(saves)).not.toContain(FAKE_KEY)

    await renderAs(A)
    expect(hasSecret()).toBe('false')
    expect(shownTo).toEqual([])
  })

  it('arriving after sign-out: the signed-out page is untouched, A gets the record', async () => {
    await renderAs(A)
    const inFlight = created[A]!
    await renderAs(null)
    await act(async () => inFlight(RECORD, FAKE_KEY))
    await flush()
    expect(host.querySelector('[data-testid="key-step"]')).toBeNull()
    // Merged into A's own saved answers, not written over them from the signed-out page's.
    expect(saves).toEqual([[A, expect.objectContaining({ runnerKey: RECORD, storage: 'platform' })]])
  })

  it('is dropped on sign-out', async () => {
    await renderAs(A)
    act(() => created[A]!(RECORD, FAKE_KEY))
    shownTo.length = 0
    await renderAs(null)
    await renderAs(A)
    expect(hasSecret()).toBe('false')
    expect(shownTo).toEqual([])
  })
})

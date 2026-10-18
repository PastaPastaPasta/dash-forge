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

const { A, B, FORGE, auth, created, shownTo, saves, ack, savedAnswers } = vi.hoisted(() => ({
  A: 'IdentityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  B: 'IdentityBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  FORGE: { core: 'CoreContract111', collab: 'CollabContract111', community: 'CommunityContract111', group: 'Group111' },
  auth: { identity: null as string | null, resuming: false },
  // Whether the saved record has the rights acknowledgement (a record saved before it has none).
  ack: { value: true },
  savedAnswers: { patch: {} as Partial<MirrorProgress> },
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
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => auth }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: null }) }))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: null, needsUnlock: false }) }))
vi.mock('@/lib/mirror/progress', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/lib/mirror/progress')>()
  // Every identity has answered up to the key step.
  const saved: MirrorProgress = {
    ...m.EMPTY_PROGRESS,
    way: 'action',
    actionLater: false,
    github: { owner: 'octo', name: 'repo', sizeKib: 1, description: '', defaultBranch: 'main', archived: false, fork: false, htmlUrl: '' } as MirrorProgress['github'],
    repo: { name: 'repo', repoId: 'Repo111' } as MirrorProgress['repo'],
    storage: 'platform',
    startedAt: 1,
  }
  return {
    ...m,
    loadMirrorProgress: async () => ({ ...saved, rightsAcknowledged: ack.value, ...savedAnswers.patch }),
    saveMirrorProgress: async (_net: string, id: string, p: MirrorProgress) => void saves.push([id, p]),
  }
})
vi.mock('@/components/mirror/mirror-steps', async (orig) => ({
  ...(await orig<typeof import('@/components/mirror/mirror-steps')>()),
  storageChoice: () => ({ ok: true, kind: 'platform' }),
  GithubStep: ({ initial, way, onDone }: { initial: MirrorProgress['github']; way: string; onDone: (github: NonNullable<MirrorProgress['github']>) => void }) => (
    <button data-testid="github-answer" data-way={way} onClick={() => onDone(initial ?? { owner: 'octo', name: 'repo', sizeKib: 1, description: '', defaultBranch: 'main', archived: false, fork: false, htmlUrl: '' } as NonNullable<MirrorProgress['github']>)}>Answer GitHub</button>
  ),
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
  window.history.replaceState(null, '', '/mirror/')
  auth.resuming = false
  savedAnswers.patch = {}
  ack.value = true
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

describe('MirrorWizard: the rights acknowledgement (LEG-10)', () => {
  it('holds every step after GitHub back for a record saved without it', async () => {
    ack.value = false
    await renderAs(A)
    expect(host.querySelector('[data-testid="key-step"]')).toBeNull()
    // The GitHub step is the open one, not the key step the record's other answers point at.
    expect(host.querySelector('[data-testid="mirror-step-github"]')?.getAttribute('data-state')).toBe('active')
  })

  it('goes on to the answered steps once it is there', async () => {
    await renderAs(A)
    expect(host.querySelector('[data-testid="key-step"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="mirror-step-github"]')?.getAttribute('data-state')).toBe('done')
  })
})

const button = (text: string): HTMLButtonElement => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!
const state = (id: string): string | null | undefined => host.querySelector(`[data-testid="mirror-step-${id}"]`)?.getAttribute('data-state')

describe('MirrorWizard: paths', () => {
  it('starts with only the entry question, and shows the CLI without signing in', async () => {
    await renderAs(null)
    expect(state('way')).toBe('active')
    expect(state('github')).toBeUndefined()
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[name="mirror-way"]')[1]!.click())
    await act(async () => button('Continue').click())
    expect(state('way')).toBe('done')
    expect(state('github')).toBe('active')
    await act(async () => button('Answer GitHub').click())
    expect(state('cli')).toBe('active')
    expect(host.querySelector('[data-testid="mirror-signin"]')).toBeNull()
    expect(host.textContent).toContain('What you need')
    expect(window.location.search).toContain('way=cli')
    expect(saves).toEqual([])
  })

  it('restores CLI URL settings and still waits for the GitHub answer', async () => {
    window.history.replaceState(null, '', '/mirror/?way=cli&repo=octo/repo&name=my-copy&collab=1&cap=0.5')
    await renderAs(null)
    expect(state('github')).toBe('active')
    expect(state('cli')).toBe('todo')
    await act(async () => button('Answer GitHub').click())
    expect(host.textContent).toContain('--repo my-copy --sync all --max-spend 0.5 --state my-copy.sync.json')
    expect(host.textContent).toContain('--budget 0.5')
    await act(async () => button('Start over').click())
    expect(window.location.search).toBe('')
    expect(state('way')).toBe('active')
  })

  it('holds URL choices until auth has finished resuming and gives saved answers precedence', async () => {
    auth.resuming = true
    window.history.replaceState(null, '', '/mirror/?way=cli&repo=other/source')
    await renderAs(null)
    expect(state('way')).toBe('active')
    await renderAs(A)
    expect(state('key')).toBe('active')
    expect(state('cli')).toBeUndefined()
    expect(host.textContent).toContain('github.com/octo/repo')
  })

  it('switching CLI to the Action asks for rights, and switching back keeps GitHub done', async () => {
    window.history.replaceState(null, '', '/mirror/?way=cli')
    await renderAs(null)
    await act(async () => button('Answer GitHub').click())
    await act(async () => button('Maintain it on GitHub? Keep it in sync automatically instead.').click())
    expect(state('github')).toBe('active')
    expect(host.querySelector('[data-testid="github-answer"]')?.getAttribute('data-way')).toBe('action')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Change: Do you maintain the repo on GitHub?"]')!.click())
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[name="mirror-way"]')[1]!.click())
    await act(async () => button('Continue').click())
    expect(state('github')).toBe('done')
    expect(state('cli')).toBe('active')
  })

  it('Not now keeps answers, shows the ready card, and resumes the first unanswered Action step', async () => {
    await renderAs(A)
    expect(state('key')).toBe('active')
    expect(host.textContent).toContain('Optional')
    await act(async () => button('Not now').click())
    expect(host.querySelector('[data-testid="mirror-ready"]')).not.toBeNull()
    expect(state('action')).toBe('done')
    expect(host.textContent).toContain(`--repo ${A}/repo`)
    expect(host.textContent).not.toContain('Still to sign here')
    await act(async () => button('Set up the Action').click())
    expect(state('key')).toBe('active')
    expect(state('storage')).toBe('done')
    expect(host.querySelector('[data-testid="mirror-ready"]')).toBeNull()
  })
})

describe('MirrorWizard: Action timing and pending CLI source', () => {
  it('does not save an empty default name before the URL source is answered', async () => {
    window.history.replaceState(null, '', '/mirror/?way=cli&repo=octo/repo')
    await renderAs(null)
    expect(new URLSearchParams(window.location.search).has('name')).toBe(false)
    await act(async () => button('Answer GitHub').click())
    expect(new URLSearchParams(window.location.search).get('name')).toBe('repo')
  })

  it('Later opens a done choice and Change reopens only the choice', async () => {
    savedAnswers.patch = { actionLater: null }
    await renderAs(A)
    expect(state('action')).toBe('active')
    expect(host.textContent).not.toContain('Still to sign here')
    await act(async () => button('Later').click())
    expect(state('action')).toBe('done')
    expect(host.querySelector('[data-testid="mirror-ready"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Change: The GitHub Action"]')!.click())
    expect(state('action')).toBe('active')
    expect(host.querySelector('[data-testid="mirror-ready"]')).toBeNull()
    await act(async () => button('Set it up now').click())
    expect(state('key')).toBe('active')
    expect(host.textContent).toContain('Still to sign here')
  })

  it.each([
    ['storage', { storage: null }],
    ['workflow', { runnerKey: { keyId: -1, saved: true, budgetCredits: '0', expiresAt: 0 } }],
    ['wait', { runnerKey: { keyId: -1, saved: true, budgetCredits: '0', expiresAt: 0 }, workflowAdded: true }],
  ] as const)('Not now in %s returns to the ready card without losing answers', async (id, patch) => {
    savedAnswers.patch = patch
    await renderAs(A)
    expect(state(id)).toBe('active')
    await act(async () => button('Not now').click())
    expect(host.querySelector('[data-testid="mirror-ready"]')).not.toBeNull()
    expect(saves.at(-1)?.[1]).toMatchObject({ ...patch, actionLater: true })
  })
})

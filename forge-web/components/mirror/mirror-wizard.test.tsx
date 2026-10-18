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
import { FIAT_RATES_KEY, FIAT_SETTINGS_KEY } from '@/lib/fiat/store'

type OnCreated = (r: unknown, value: string) => void

const { A, B, FORGE, auth, created, shownTo, saves, ack, savedAnswers } = vi.hoisted(() => ({
  A: 'IdentityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  B: 'IdentityBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  FORGE: { core: 'CoreContract111', collab: 'CollabContract111', community: 'CommunityContract111', group: 'Group111' },
  auth: { identity: null as string | null, resuming: false },
  // Whether the saved record has the rights acknowledgement (a record saved before it has none).
  ack: { value: true },
  savedAnswers: { patch: {} as Partial<MirrorProgress>, realGithub: false },
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
vi.mock('@/components/mirror/mirror-steps', async (orig) => {
  const original = await orig<typeof import('@/components/mirror/mirror-steps')>()
  return {
    ...original,
    storageChoice: () => ({ ok: true, kind: 'platform' }),
    GithubStep: (props: Parameters<typeof original.GithubStep>[0]) => savedAnswers.realGithub ? <original.GithubStep {...props} /> : (
      <button data-testid="github-answer" data-way={props.way} onClick={() => props.onDone(props.initial ?? { owner: 'octo', name: 'repo', sizeKib: 1, description: '', defaultBranch: 'main', archived: false, fork: false, htmlUrl: '' })}>Answer GitHub</button>
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
  }
})

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
  vi.useFakeTimers()
  savedAnswers.realGithub = false
  window.history.replaceState({ __NA: true, tree: 'router-tree' }, '', '/mirror/')
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MirrorWizard: the runner key value', () => {
  it('shows the saved key budget as a fiat bound in the completed step summary', async () => {
    localStorage.setItem(FIAT_RATES_KEY, JSON.stringify({ v: 1, source: 'ctx', fetchedAt: Date.now(), rates: { USD: 40 } }))
    localStorage.setItem(FIAT_SETTINGS_KEY, JSON.stringify({ v: 1, enabled: true, currency: 'USD' }))
    window.dispatchEvent(new StorageEvent('storage', { key: FIAT_SETTINGS_KEY }))
    window.dispatchEvent(new StorageEvent('storage', { key: FIAT_RATES_KEY }))
    savedAnswers.patch = { runnerKey: { ...RECORD, budgetCredits: '50000000000', saved: true } }
    await renderAs(A)
    const summary = host.querySelector('[data-testid="mirror-step-key"]')!
    expect(summary.textContent).toContain('Key 3: 0.5 DASH (≤ $20.00 on mainnet) until')
    expect(summary.querySelector('button')?.getAttribute('aria-label')).toBe('Change: The runner key')
  })

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
    expect(button('Continue').disabled).toBe(true)
    expect(host.querySelector('input[name="mirror-way"]:checked')).toBeNull()
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[name="mirror-way"]')[1]!.click())
    await act(async () => button('Continue').click())
    expect(state('way')).toBe('done')
    expect(state('github')).toBe('active')
    await act(async () => button('Answer GitHub').click())
    expect(state('cli')).toBe('active')
    expect(host.querySelector('[data-testid="mirror-signin"]')).toBeNull()
    expect(host.textContent).toContain('What you need')
    await act(async () => vi.advanceTimersByTime(300))
    expect(window.location.search).toContain('way=cli')
    expect(saves).toEqual([])
  })

  it('keeps a GitHub address prefill in the URL until a way is chosen', async () => {
    window.history.replaceState({ __NA: true, tree: 'router-tree' }, '', '/mirror/?repo=octo/repo')
    await renderAs(null)
    await act(async () => vi.advanceTimersByTime(300))
    expect(state('way')).toBe('active')
    expect(new URLSearchParams(window.location.search).get('repo')).toBe('octo/repo')
  })

  it('restores CLI URL settings and still waits for the GitHub answer', async () => {
    window.history.replaceState({ __NA: true, tree: 'router-tree' }, '', '/mirror/?way=cli&repo=octo/repo&name=my-copy&collab=1&cap=0.5')
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
    window.history.replaceState({ __NA: true, tree: 'router-tree' }, '', '/mirror/?way=cli&repo=other/source')
    await renderAs(null)
    expect(state('way')).toBe('active')
    await renderAs(A)
    expect(state('key')).toBe('active')
    expect(state('cli')).toBeUndefined()
    expect(host.textContent).toContain('github.com/octo/repo')
  })

  it('switching CLI to the Action asks for rights, and switching back keeps GitHub done', async () => {
    window.history.replaceState({ __NA: true, tree: 'router-tree' }, '', '/mirror/?way=cli')
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
    window.history.replaceState({ __NA: true, tree: 'router-tree' }, '', '/mirror/?way=cli&repo=octo/repo')
    await renderAs(null)
    await act(async () => vi.advanceTimersByTime(300))
    expect(new URLSearchParams(window.location.search).has('name')).toBe(false)
    expect(new URLSearchParams(window.location.search).get('repo')).toBe('octo/repo')
    await act(async () => button('Answer GitHub').click())
    await act(async () => vi.advanceTimersByTime(300))
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


describe('MirrorWizard: identity and URL boundaries', () => {
  it('signing out of the Action drops URL answers and leaves the GitHub box empty', async () => {
    window.history.replaceState({ __NA: true }, '', '/mirror/?way=action&repo=octo/repo&name=old&cap=3&collab=1&keep=yes')
    await renderAs(A)
    expect(state('key')).toBe('active')
    await renderAs(null)
    expect(state('way')).toBe('active')
    expect(window.location.search).toBe('?keep=yes')
    savedAnswers.realGithub = true
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[name="mirror-way"]')[0]!.click())
    await act(async () => button('Continue').click())
    expect(host.querySelector<HTMLInputElement>('#mirror-github')!.value).toBe('')
    savedAnswers.realGithub = false
    await renderAs(null)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Change: Do you maintain the repo on GitHub?"]')!.click())
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[name="mirror-way"]')[1]!.click())
    await act(async () => button('Continue').click())
    await act(async () => button('Answer GitHub').click())
    expect(host.querySelector<HTMLInputElement>('#mirror-cli-name')!.value).toBe('repo')
    expect(host.querySelector<HTMLInputElement>('#mirror-cli-cap')!.value).toBe('0.2')
    expect(host.querySelector<HTMLInputElement>('[data-testid="mirror-cli"] input[type="checkbox"]')!.checked).toBe(false)
  })

  it('a direct switch uses only the new identity’s saved answers', async () => {
    window.history.replaceState({ __NA: true }, '', '/mirror/?way=action&repo=octo/repo&cap=3')
    await renderAs(A)
    savedAnswers.patch = { way: 'cli', github: { owner: 'bob', name: 'other', sizeKib: 1, description: '', defaultBranch: 'main', archived: false, fork: false, htmlUrl: '' } }
    await renderAs(B)
    expect(state('cli')).toBe('active')
    expect(host.textContent).toContain('github.com/bob/other')
    expect(host.textContent).not.toContain('github.com/octo/repo')
    expect(host.querySelector<HTMLInputElement>('#mirror-cli-cap')!.value).toBe('0.2')
  })

  it('keeps a signed-out person’s answers when they sign in', async () => {
    await renderAs(null)
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[name="mirror-way"]')[1]!.click())
    await act(async () => button('Continue').click())
    await act(async () => button('Answer GitHub').click())
    savedAnswers.patch = { github: null }
    await renderAs(A)
    expect(state('cli')).toBe('active')
    expect(host.textContent).toContain('github.com/octo/repo')
  })

  it('offers no Not now when the mirror is live', async () => {
    savedAnswers.patch = { runnerKey: { keyId: -1, saved: true, budgetCredits: '0', expiresAt: 0 }, workflowAdded: true, mirroredAt: 123 }
    await renderAs(A)
    expect(state('wait')).toBe('active')
    expect(host.textContent).not.toContain('Not now')
  })

  it('resets a URL name when the answered source differs from its prefill', async () => {
    window.history.replaceState({ __NA: true }, '', '/mirror/?way=cli&repo=alice/old&name=stale')
    await renderAs(null)
    await act(async () => button('Answer GitHub').click())
    expect(host.querySelector<HTMLInputElement>('#mirror-cli-name')!.value).toBe('repo')
  })

  it('debounces typing and preserves Next’s history state', async () => {
    window.history.replaceState({ __NA: true, tree: 'router-tree' }, '', '/mirror/?way=cli')
    await renderAs(null)
    await act(async () => button('Answer GitHub').click())
    const replace = vi.spyOn(window.history, 'replaceState')
    const input = host.querySelector<HTMLInputElement>('#mirror-cli-cap')!
    const fill = (value: string): void => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    act(() => fill('0.3'))
    await act(async () => vi.advanceTimersByTime(200))
    act(() => fill('0.4'))
    await act(async () => vi.advanceTimersByTime(299))
    expect(replace).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    expect(replace).toHaveBeenCalledOnce()
    expect(new URLSearchParams(window.location.search).get('cap')).toBe('0.4')
    expect(window.history.state).toEqual({ __NA: true, tree: 'router-tree' })
  })

  it('keeps the CLI usable if Safari refuses a history update', async () => {
    window.history.replaceState({ __NA: true }, '', '/mirror/?way=cli')
    await renderAs(null)
    await act(async () => button('Answer GitHub').click())
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => { throw new DOMException('Too many calls', 'SecurityError') })
    await act(async () => vi.advanceTimersByTime(300))
    expect(state('cli')).toBe('active')
    expect(host.textContent).toContain('dg import github.com/octo/repo')
  })
})


it('does not apply an old URL way when switching to an identity without saved choices', async () => {
  window.history.replaceState({ __NA: true }, '', '/mirror/?way=action&repo=octo/repo')
  await renderAs(A)
  savedAnswers.patch = { way: null, github: null }
  await renderAs(B)
  expect(state('way')).toBe('active')
  expect(state('github')).toBeUndefined()
})

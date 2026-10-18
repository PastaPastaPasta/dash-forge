// @vitest-environment jsdom
/**
 * Settings → Danger zone → "Make this repo public" (DESIGN §10, §4.10): the row for the owner, a
 * maintainer and a network that can't; the dialog with nothing chosen, the typed words, the
 * secret acknowledgements and E812 blocking Everything only; the step list from the run's
 * progress; an aborted run leaving the interrupted panel; and Finish with and without this
 * browser's record, for the owner and for a maintainer; a step still signing after its dialog
 * closed holding Finish back; and Everything after Code only, the owner's alone. The engine is
 * mocked.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'
import type { MakePublicCheck, MakePublicProgress, MakePublicStatus, MakePublicStep, StepState } from '@/lib/repo/make-public'

const viewer: { id: string | null; scope: 'signing' | 'full' | null; context: boolean } = { id: 'owner', scope: 'signing', context: true }
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ unlockScope: viewer.scope, identity: viewer.id, signer: viewer.id === null ? null : { identityId: viewer.id } }),
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/hooks/use-dpns-name', () => ({ useSettledDpnsName: (id: string) => (id === 'owner' ? 'carol' : null) }))
vi.mock('@/hooks/use-private-write', () => ({
  usePrivateWrite: () => ({ context: viewer.context ? { sdk: {}, auth: { identityId: viewer.id }, repo: {}, network: 'devnet', ops: {} } : null, done: () => undefined, loading: false }),
}))
const storage: { upload: (() => Promise<unknown>) | null; error: string | null; needsUnlock: boolean } = { upload: async () => ({}), error: null, needsUnlock: false }
vi.mock('@/components/repo/merge-upload', () => ({
  useMergeUpload: () => ({ get upload() { return storage.upload }, question: null, begin: () => undefined, storageNeedsUnlock: storage.needsUnlock, get storageError() { return storage.error } }),
}))
vi.mock('@/components/auth/unlock-more', () => ({ UnlockMore: ({ testId, then }: { testId: string; then?: () => void }) => <button data-testid={testId} onClick={then}>Unlock</button> }))
vi.mock('@/lib/repo', () => ({ repoContractIds: () => [] }))
const converted = { value: false }
vi.mock('@/components/repo/conversion-status', () => ({ madePublic: () => converted.value }))

const oneWay = { value: true }
vi.mock('@/lib/repo/contract-shape', () => ({ contractVisibilityOneWay: async () => oneWay.value }))

const makePublicCheck = vi.fn()
vi.mock('@/lib/repo/make-public-check', () => ({ makePublicCheck: (...a: unknown[]) => makePublicCheck(...a), publicViewOf: (r: unknown) => r }))
const runMakePublic = vi.fn()
vi.mock('@/lib/repo/make-public-run', () => ({ runMakePublic: (...a: unknown[]) => runMakePublic(...a) }))
const readMakePublicStatus = vi.fn()
vi.mock('@/lib/repo/make-public-status', () => ({ readMakePublicStatus: (...a: unknown[]) => readMakePublicStatus(...a) }))

import { EncryptionKeyLockedError, VaultLockedError } from '@/lib/auth/vault'
import { COPY, MakePublicError } from '@/lib/repo/make-public'
import { MakeRepoPublic } from './make-repo-public'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ref = (name: string, oid = name.length.toString(16).padStart(40, '0')) => ({ name, oid })
const MAIN = ref('refs/heads/main')
const V1 = ref('refs/tags/v1')
const FEAT = ref('refs/heads/feature')

function aCheck(over: Partial<MakePublicCheck> = {}): MakePublicCheck {
  return {
    blockers: [],
    notes: [],
    allRefs: [FEAT, MAIN, V1],
    codeRefs: [MAIN, V1],
    deleted: 2,
    forced: 0,
    census: { issues: 3, prs: 1, comments: 0, reviews: 0, revisions: 0, hidden: 0, botRequests: 0, releases: 0, letters: 5, unread: 0, authors: ['a', 'b', 'c'], imported: [] },
    former: ['c'],
    codeSecrets: [],
    everythingSecrets: [],
    environments: 3,
    oldFormat: [],
    oldFormatUnreadable: false,
    unfetched: 0,
    missingObjects: { codeOnly: 0, everything: 0 },
    size: { codeOnly: { bytes: 1000, objects: 10 }, everything: { bytes: 2000, objects: 20 } },
    estimate: { codeOnly: { credits: 2_000_000_000, storageCredits: 30_000_000_000 }, everything: { credits: 3_000_000_000, storageCredits: 40_000_000_000 } },
    narrowerBranches: 0,
    minClientVersion: '0.9',
    defaultBranch: 'main',
    ...over,
  }
}

const STEPS: readonly MakePublicStep[] = ['sealOff', 'flip', 'config', 'code', 'notify', 'history']
function aStatus(over: Partial<Omit<MakePublicStatus, 'steps'>> & { steps?: Partial<Record<MakePublicStep, StepState>> } = {}): MakePublicStatus {
  const steps = Object.fromEntries(STEPS.map((s) => [s, over.steps?.[s] ?? 'todo'])) as Record<MakePublicStep, StepState>
  return { phase: 'private', converted: false, doneCount: 0, totalSteps: 7, lastStepAt: null, record: null, sealOffPassed: false, mode: null, ...over, steps }
}

function home(visibility: 'private' | 'public' = 'private'): RepoHome {
  return { repo: { repoId: 'R', name: 'ledger', ownerId: 'owner', visibility, forge: { core: 'C', collab: 'L', community: 'M' } } } as unknown as RepoHome
}

let host: HTMLDivElement
let root: Root
const onSaved = vi.fn()
beforeEach(() => {
  viewer.id = 'owner'
  viewer.scope = 'signing'
  viewer.context = true
  oneWay.value = true
  converted.value = false
  storage.upload = async () => ({})
  storage.error = null
  storage.needsUnlock = false
  makePublicCheck.mockReset()
  runMakePublic.mockReset()
  readMakePublicStatus.mockReset()
  readMakePublicStatus.mockResolvedValue(aStatus())
  onSaved.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => undefined)
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel)
const tid = <T extends Element = HTMLElement>(id: string): T | null => q<T>(`[data-testid="${id}"]`)
const click = async (el: Element | null): Promise<void> => {
  expect(el).not.toBeNull()
  await act(async () => (el as HTMLElement).click())
  await flush()
}
function type(el: HTMLInputElement | null, value: string): void {
  expect(el).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const confirmButton = (): HTMLButtonElement => tid<HTMLButtonElement>('make-public-confirm')!

async function renderRow(opts: { maintainer?: boolean; visibility?: 'private' | 'public' } = {}): Promise<void> {
  act(() => root.render(<MakeRepoPublic home={home(opts.visibility)} maintainer={opts.maintainer ?? true} onSaved={onSaved} />))
  await flush()
}

async function openDialog(check: MakePublicCheck): Promise<void> {
  makePublicCheck.mockImplementation(async (_c: unknown, o: { onProgress?: (w: string) => void }) => {
    o.onProgress?.('Reading the code written while private')
    return check
  })
  await renderRow()
  await click(tid('make-public-open'))
}

describe('the Danger zone row', () => {
  it('the owner of a private repo gets "Make public…"', async () => {
    await renderRow()
    expect(tid('make-public-row')?.textContent).toContain('Make this repo public')
    expect(tid<HTMLButtonElement>('make-public-open')?.disabled).toBe(false)
  })

  it("on a network whose Forge can't, says so and the button is disabled", async () => {
    oneWay.value = false
    await renderRow()
    expect(tid('make-public-row')?.textContent).toContain("This network's Forge can't make a private repository public yet.")
    expect(tid<HTMLButtonElement>('make-public-open')?.disabled).toBe(true)
  })

  it('a maintainer reads who can, and gets no button', async () => {
    viewer.id = 'maint'
    await renderRow()
    expect(tid('make-public-row')?.textContent).toContain('Only the owner (@carol) can make this repo public.')
    expect(tid('make-public-open')).toBeNull()
  })

  it('anyone else sees nothing, and a public repo never made public shows nothing', async () => {
    viewer.id = 'writer'
    await renderRow({ maintainer: false })
    expect(tid('make-public-row')).toBeNull()
    viewer.id = 'owner'
    await renderRow({ visibility: 'public' })
    expect(tid('make-public-row')).toBeNull()
    expect(readMakePublicStatus).not.toHaveBeenCalled()
  })
})

describe('the dialog', () => {
  it('suppresses the encryption prompt once another route has unlocked this tab, or context is locked', async () => {
    makePublicCheck.mockRejectedValue(new EncryptionKeyLockedError())
    await renderRow()
    await click(tid('make-public-open'))
    expect(tid('make-public-encryption-unlock')).not.toBeNull()
    viewer.scope = 'full'
    await renderRow()
    expect(tid('make-public-encryption-unlock')).toBeNull()
    viewer.scope = 'signing'
    viewer.context = false
    await renderRow()
    expect(tid('make-public-encryption-unlock')).toBeNull()
    expect(tid('make-public-unlock')).not.toBeNull()
  })

  it('shows only the storage unlock when both keys need the same unlock', async () => {
    makePublicCheck.mockRejectedValue(new EncryptionKeyLockedError())
    storage.needsUnlock = true
    await renderRow()
    await click(tid('make-public-open'))
    expect(tid('make-public-storage-unlock')).not.toBeNull()
    expect(tid('make-public-encryption-unlock')).toBeNull()
  })

  it.each([null, 'Could not read storage settings.'])('refuses a stale Make public click when storage becomes unavailable: %s', async (error) => {
    await openDialog(aCheck())
    await click(tid('make-public-mode-codeOnly'))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    expect(confirmButton().disabled).toBe(false)
    // Storage becomes unavailable after the button rendered, before its handler starts.
    storage.upload = null
    storage.error = error
    await click(confirmButton())
    expect(runMakePublic).not.toHaveBeenCalled()
    expect(tid('make-public-run-error')?.textContent).toContain(error ?? 'Reading your storage settings.')
  })

  it('offers an inline encryption unlock and checks again after unlocking', async () => {
    makePublicCheck.mockRejectedValueOnce(new EncryptionKeyLockedError()).mockResolvedValue(aCheck())
    await renderRow()
    await click(tid('make-public-open'))
    expect(tid('make-public-check-error')?.textContent).toContain('unlock to use your encryption key in this tab')
    expect(makePublicCheck).toHaveBeenCalledTimes(1)
    await click(tid('make-public-encryption-unlock'))
    expect(makePublicCheck).toHaveBeenCalledTimes(2)
    expect(tid('make-public-check-error')).toBeNull()
    expect(tid('make-public-dialog')?.getAttribute('data-checked')).toBe('yes')
  })

  it.each([new VaultLockedError('no encryption key is stored in this browser'), new VaultLockedError('unlock to use your encryption key in this tab'), new Error('unlock to use your encryption key in this tab')])('keeps an error that unlocking cannot fix as text', async (error) => {
    makePublicCheck.mockRejectedValue(error)
    await renderRow()
    await click(tid('make-public-open'))
    expect(tid('make-public-check-error')?.textContent).toContain(error.message)
    expect(tid('make-public-encryption-unlock')).toBeNull()
  })

  it('shows the check running, then nothing chosen: Make public waits for a mode and the exact words', async () => {
    let finish: (c: MakePublicCheck) => void = () => undefined
    makePublicCheck.mockImplementation((_c: unknown, o: { onProgress?: (w: string) => void }) => {
      o.onProgress?.('Checking for secrets')
      return new Promise((r) => (finish = r))
    })
    await renderRow()
    await click(tid('make-public-open'))
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Make carol/ledger public?')
    expect(tid('make-public-check-progress')?.textContent).toBe('Checking for secrets…')
    expect(confirmButton().disabled).toBe(true)
    await act(async () => finish(aCheck()))
    await flush()
    const code = tid<HTMLInputElement>('make-public-mode-codeOnly')!
    const all = tid<HTMLInputElement>('make-public-mode-everything')!
    expect(code.checked).toBe(false)
    expect(all.checked).toBe(false)
    expect(confirmButton().disabled).toBe(true)
    expect(tid('make-public-dialog')?.textContent).toContain("Everyone will be able to see what you choose below. This can't be undone: the repo can never be private again.")
    // the default branch and its tags are ticked, other branches not
    expect(tid<HTMLInputElement>('make-public-ref-default')?.checked).toBe(true)
    expect(tid('make-public-ref-default')?.parentElement?.textContent).toBe('main and its 1 tag')
    expect(q<HTMLInputElement>('[data-testid="make-public-ref"][data-ref="refs/heads/feature"]')?.checked).toBe(false)
    expect(tid('make-public-everything-counts')?.textContent).toBe('That is 3 issues, 1 pull request, 3 live branches and tags, 2 deleted branches.')
    expect(tid('make-public-words-by')?.textContent).toBe('Words by 3 people, including 1 former member, become public.')
    expect(tid('make-public-stays-private')?.textContent).toBe('Stays private: 5 messages to specific people, 3 environments, and everything members write from now on.')
    await click(code)
    expect(tid('make-public-scan')?.textContent).toBe("No secrets found in what you're publishing.")
    expect(tid('make-public-cost')?.textContent).toBe('Costs about 0.02 DASH, plus storing the code: about 0.3 DASH on Platform, or nothing extra with your own storage.')
    expect(confirmButton().disabled).toBe(true)
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger publi')
    expect(confirmButton().disabled).toBe(true)
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    expect(confirmButton().disabled).toBe(false)
  })

  it('Cancel aborts the check', async () => {
    let signal: AbortSignal | undefined
    makePublicCheck.mockImplementation((_c: unknown, o: { signal: AbortSignal }) => {
      signal = o.signal
      return new Promise(() => undefined)
    })
    await renderRow()
    await click(tid('make-public-open'))
    await click(tid('make-public-cancel'))
    expect(signal?.aborted).toBe(true)
    expect(tid('make-public-dialog')).toBeNull()
  })

  it('a possible secret needs its "Publish anyway", and its fingerprint goes to the run', async () => {
    await openDialog(aCheck({ codeSecrets: [{ place: '.env line 1', rule: 'dotenv', fingerprint: 'ABC123', refuses: true }] }))
    await click(tid('make-public-mode-codeOnly'))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    expect(tid('make-public-secret')?.textContent).toContain('Possible secret in .env line 1')
    expect(confirmButton().disabled).toBe(true)
    await click(tid('make-public-secret-allow'))
    expect(confirmButton().disabled).toBe(false)
    runMakePublic.mockResolvedValue({ finished: true, notPublished: [] })
    await click(confirmButton())
    const choice = runMakePublic.mock.calls[0]![1] as { mode: string; refs: string[]; allowSecrets: string[]; confirmation: string; repoLabel: string }
    expect(choice).toMatchObject({ mode: 'codeOnly', allowSecrets: ['abc123'], confirmation: 'make carol/ledger public', repoLabel: 'carol/ledger' })
    expect([...choice.refs].sort()).toEqual(['refs/heads/main', 'refs/tags/v1'])
  })

  it('E812 blocks Everything only, with the fix commands', async () => {
    await openDialog(aCheck({ oldFormat: ['production'] }))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    const blocker = q('[data-testid="make-public-blocker"][data-code="E812"]')
    expect(blocker?.textContent).toContain("Can't make everything public: environment production has values saved in the old format, which would become public.")
    expect(blocker?.textContent).toContain('dg env resave --env production')
    expect(blocker?.textContent).toContain('dg env mark-changed --env production')
    await click(tid('make-public-mode-everything'))
    expect(confirmButton().disabled).toBe(true)
    await click(tid('make-public-mode-codeOnly'))
    expect(confirmButton().disabled).toBe(false)
  })

  it('a changed choice of branches checks again before Make public', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await openDialog(aCheck())
      // the boxes are Code only's: live once it is chosen
      expect(q<HTMLInputElement>('[data-testid="make-public-ref"][data-ref="refs/heads/feature"]')?.disabled).toBe(true)
      await click(tid('make-public-mode-codeOnly'))
      await click(q('[data-testid="make-public-ref"][data-ref="refs/heads/feature"]'))
      expect(tid('make-public-rechecking')).not.toBeNull()
      await act(async () => vi.advanceTimersByTime(700))
      await flush()
      const last = makePublicCheck.mock.calls.at(-1)![1] as { refs?: string[] }
      expect([...(last.refs ?? [])].sort()).toEqual(['refs/heads/feature', 'refs/heads/main', 'refs/tags/v1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the storage settings, so the code goes where they say', async () => {
    storage.upload = null
    storage.error = 'the vault could not be read'
    await openDialog(aCheck())
    await click(tid('make-public-mode-codeOnly'))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    expect(confirmButton().disabled).toBe(true)
    expect(tid('make-public-storage-error')?.textContent).toContain('the vault could not be read')
    expect(tid('make-public-why')?.textContent).toBe('the vault could not be read')
  })

  it('turns into the step list as the run reports, and says what is public at the end', async () => {
    await openDialog(aCheck())
    await click(tid('make-public-mode-everything'))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    let report: (p: MakePublicProgress) => void = () => undefined
    let finish: (o: unknown) => void = () => undefined
    runMakePublic.mockImplementation((_c: unknown, _choice: unknown, onProgress: (p: MakePublicProgress) => void) => {
      report = onProgress
      return new Promise((r) => (finish = r))
    })
    await click(confirmButton())
    const state = (step: string): string | null | undefined => q(`[data-testid="make-public-step"][data-step="${step}"]`)?.getAttribute('data-state')
    expect(state('confirm')).toBe('running')
    await act(async () => {
      report({ step: 'sealOff', state: 'running' })
    })
    expect(state('confirm')).toBe('done')
    expect(state('sealOff')).toBe('running')
    await act(async () => {
      report({ step: 'sealOff', state: 'done' })
      report({ step: 'flip', state: 'done' })
    })
    expect(tid('make-public-progress')?.textContent).toContain('Making carol/ledger public: 3 of 7 steps done. You can close this page and continue later.')
    expect(state('history')).toBe('todo')
    await act(async () => finish({ finished: true, notPublished: ['refs/heads/feature'] }))
    await flush()
    expect(tid('make-public-done')?.textContent).toContain('carol/ledger is public (Everything).')
    expect(tid('make-public-not-published')?.textContent).toBe('Not published: feature: members-only commits were pushed to it after the repo was made public.')
    // the page re-reads the repo once the outcome is closed
    expect(onSaved).not.toHaveBeenCalled()
    await click(tid('make-public-close'))
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('closing mid-run aborts it, and the interrupted panel offers Finish', async () => {
    await openDialog(aCheck())
    await click(tid('make-public-mode-codeOnly'))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    let signal: AbortSignal | undefined
    runMakePublic.mockImplementation((_c: unknown, _choice: unknown, onProgress: (p: MakePublicProgress) => void, s: AbortSignal) => {
      signal = s
      onProgress({ step: 'sealOff', state: 'done' })
      return new Promise((_r, reject) => s.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError'))))
    })
    await click(confirmButton())
    readMakePublicStatus.mockResolvedValue(
      aStatus({ phase: 'private', record: { mode: 'codeOnly', refs: [MAIN], sealOff: 4 }, doneCount: 2, steps: { sealOff: 'done', history: 'skipped' } }),
    )
    await click(tid('make-public-close'))
    expect(signal?.aborted).toBe(true)
    expect(tid('make-public-progress')).toBeNull()
    const panel = tid('make-public-interrupted')
    expect(panel?.textContent).toContain('Making carol/ledger public was interrupted.')
    expect(panel?.textContent).toContain('or: dg repo make-public carol/ledger --resume')
    expect(tid('make-public-finish')).not.toBeNull()
    // a step landed: the page reads the repo again
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('a failed re-check keeps the chosen branches, and runs again over them', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await openDialog(aCheck())
      await click(tid('make-public-mode-codeOnly'))
      makePublicCheck.mockRejectedValueOnce(new Error('a node timed out'))
      await click(q('[data-testid="make-public-ref"][data-ref="refs/heads/feature"]'))
      await act(async () => vi.advanceTimersByTime(700))
      await flush()
      expect(tid('make-public-check-error')?.textContent).toContain('a node timed out')
      expect(tid('make-public-rechecking')).toBeNull()
      expect(q<HTMLInputElement>('[data-testid="make-public-ref"][data-ref="refs/heads/feature"]')?.checked).toBe(true)
      await click(q('[data-testid="make-public-check-error"] [data-testid="make-public-recheck"]'))
      const last = makePublicCheck.mock.calls.at(-1)![1] as { refs?: string[] }
      expect([...(last.refs ?? [])].sort()).toEqual(['refs/heads/feature', 'refs/heads/main', 'refs/tags/v1'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Finish', () => {
  it('does not auto-resume until storage is ready', async () => {
    converted.value = true
    storage.upload = null
    readMakePublicStatus.mockResolvedValue(aStatus({ phase: 'made', converted: true, record: { mode: 'codeOnly', refs: [MAIN], sealOff: 4 }, doneCount: 3, steps: { sealOff: 'done', flip: 'done', history: 'skipped' } }))
    await renderRow({ visibility: 'public' })
    await click(tid('make-public-finish'))
    expect(runMakePublic).not.toHaveBeenCalled()
  })

  it('unlocks a stopped resumed run without publishing until Try again', async () => {
    converted.value = true
    readMakePublicStatus.mockResolvedValue(aStatus({ phase: 'made', converted: true, record: { mode: 'codeOnly', refs: [MAIN], sealOff: 4 }, doneCount: 3, steps: { sealOff: 'done', flip: 'done', history: 'skipped' } }))
    runMakePublic.mockRejectedValueOnce(new EncryptionKeyLockedError()).mockResolvedValue({ finished: true, notPublished: [] })
    await renderRow({ visibility: 'public' })
    await click(tid('make-public-finish'))
    expect(tid('make-public-encryption-unlock')).not.toBeNull()
    await click(tid('make-public-encryption-unlock'))
    expect(runMakePublic).toHaveBeenCalledTimes(1)
    viewer.scope = 'full'
    storage.upload = null
    await renderRow({ visibility: 'public' })
    expect(tid('make-public-encryption-unlock')).toBeNull()
    expect(tid<HTMLButtonElement>('make-public-retry')?.disabled).toBe(true)
    await click(tid('make-public-retry'))
    expect(runMakePublic).toHaveBeenCalledTimes(1)
    storage.upload = async () => ({})
    await renderRow({ visibility: 'public' })
    await click(tid('make-public-retry'))
    expect(runMakePublic).toHaveBeenCalledTimes(2)
    expect(runMakePublic.mock.calls[1]![1]).toMatchObject({ resume: true, confirmation: '', mode: 'codeOnly' })
    expect(tid('make-public-done')).not.toBeNull()
  })

  it('with this browser’s record: runs it again with resume, straight to the steps', async () => {
    converted.value = true
    readMakePublicStatus.mockResolvedValue(
      aStatus({ phase: 'made', converted: true, record: { mode: 'codeOnly', refs: [MAIN], sealOff: 4 }, doneCount: 3, steps: { sealOff: 'done', flip: 'done', history: 'skipped' } }),
    )
    runMakePublic.mockResolvedValue({ finished: true, notPublished: [] })
    await renderRow({ visibility: 'public' })
    expect(tid('make-public-interrupted')?.getAttribute('data-phase')).toBe('made')
    await click(tid('make-public-finish'))
    expect(makePublicCheck).not.toHaveBeenCalled()
    expect(runMakePublic.mock.calls[0]![1]).toMatchObject({ mode: 'codeOnly', resume: true, confirmation: '' })
    expect(tid('make-public-done')?.textContent).toContain('carol/ledger is public (Code only).')
  })

  it('with a record, waits for the storage settings before it runs', async () => {
    converted.value = true
    storage.upload = null
    readMakePublicStatus.mockResolvedValue(
      aStatus({ phase: 'made', converted: true, record: { mode: 'codeOnly', refs: [MAIN], sealOff: 4 }, doneCount: 3, steps: { sealOff: 'done', flip: 'done', history: 'skipped' } }),
    )
    await renderRow({ visibility: 'public' })
    await click(tid('make-public-finish'))
    expect(runMakePublic).not.toHaveBeenCalled()
    expect(tid('make-public-progress')?.textContent).toContain('Reading your storage settings…')
  })

  it('without a record: the owner chooses again, either mode', async () => {
    converted.value = true
    readMakePublicStatus.mockResolvedValue(aStatus({ phase: 'made', converted: true, doneCount: 3, steps: { sealOff: 'done', flip: 'done' } }))
    makePublicCheck.mockResolvedValue(aCheck())
    await renderRow({ visibility: 'public' })
    await click(tid('make-public-finish'))
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Finish making carol/ledger public')
    expect(tid<HTMLInputElement>('make-public-mode-codeOnly')?.disabled).toBe(false)
    expect(tid<HTMLInputElement>('make-public-mode-everything')?.disabled).toBe(false)
    expect(tid<HTMLInputElement>('make-public-mode-everything')?.checked).toBe(false)
  })

  it('without a record, a maintainer finishes Code only (Everything is the owner’s), stalled said first', async () => {
    viewer.id = 'maint'
    converted.value = true
    readMakePublicStatus.mockResolvedValue(
      aStatus({ phase: 'made', converted: true, doneCount: 3, lastStepAt: Date.now() - 3 * 24 * 3600_000, steps: { sealOff: 'done', flip: 'done' } }),
    )
    makePublicCheck.mockResolvedValue(aCheck())
    await renderRow({ visibility: 'public' })
    expect(tid('make-public-stalled')?.textContent).toBe('Making this repo public stalled 3d ago.')
    await click(tid('make-public-finish'))
    expect(tid<HTMLInputElement>('make-public-mode-everything')?.disabled).toBe(true)
    expect(tid<HTMLInputElement>('make-public-mode-codeOnly')?.disabled).toBe(false)
  })

  it('a maintainer sees the history waiting for the owner, and no Finish when only it is left', async () => {
    viewer.id = 'maint'
    converted.value = true
    readMakePublicStatus.mockResolvedValue(
      aStatus({ phase: 'made', converted: true, mode: 'everything', doneCount: 6, steps: { sealOff: 'done', flip: 'done', config: 'done', code: 'done', notify: 'done', history: 'owner' } }),
    )
    await renderRow({ visibility: 'public' })
    expect(q('[data-testid="make-public-step"][data-step="history"]')?.getAttribute('data-state')).toBe('owner')
    expect(q('[data-testid="make-public-step"][data-step="history"]')?.textContent).toContain('Waiting for the owner')
    expect(tid('make-public-owner-history')?.textContent).toBe('The owner publishes the history: they finish it here or with dg repo make-public carol/ledger --resume.')
    expect(tid('make-public-finish')).toBeNull()
  })
})

describe('a recorded run whose own key change another rotation followed', () => {
  const passed = (): MakePublicStatus =>
    aStatus({ phase: 'private', record: { mode: 'everything', refs: [MAIN], sealOff: 4, sealOffAt: Date.UTC(2026, 9, 1) }, sealOffPassed: true, doneCount: 1, steps: { sealOff: 'todo' } })

  it('offers no Finish; the owner starts again: what it adds said, its own words typed', async () => {
    readMakePublicStatus.mockResolvedValue(passed())
    makePublicCheck.mockResolvedValue(aCheck())
    runMakePublic.mockResolvedValue({ finished: true, notPublished: [] })
    await renderRow()
    expect(tid('make-public-finish')).toBeNull()
    expect(tid('make-public-seal-off-passed')?.textContent).toBe(COPY.sealOffPassed('everything'))
    expect(tid('make-public-interrupted')?.textContent).not.toContain('continue later')
    expect(tid('make-public-interrupted')?.textContent).toContain('or: dg repo make-public carol/ledger --everything --start-over')
    await click(tid('make-public-start-over'))
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Make carol/ledger public?')
    await click(tid('make-public-mode-everything'))
    expect(tid('make-public-start-over-line')?.textContent).toBe(COPY.startOver(Date.UTC(2026, 9, 1), 'everything'))
    expect(tid('make-public-start-over-line')?.textContent).toContain('(2026-10-01)')
    // the usual words don't start over
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    expect(confirmButton().disabled).toBe(true)
    type(tid<HTMLInputElement>('make-public-words'), 'start over making carol/ledger public')
    await click(confirmButton())
    expect(runMakePublic.mock.calls[0]![1]).toMatchObject({ mode: 'everything', startOver: true, confirmation: 'start over making carol/ledger public' })
    expect(runMakePublic.mock.calls[0]![1]).not.toHaveProperty('resume')
  })

  it('a maintainer reads why, with nothing to run', async () => {
    viewer.id = 'maint'
    readMakePublicStatus.mockResolvedValue(passed())
    await renderRow()
    expect(tid('make-public-seal-off-passed')).not.toBeNull()
    expect(tid('make-public-finish')).toBeNull()
    expect(tid('make-public-start-over')).toBeNull()
  })

  it('a run that kept its boundary record says so when done', async () => {
    converted.value = true
    readMakePublicStatus.mockResolvedValue(
      aStatus({ phase: 'made', converted: true, record: { mode: 'codeOnly', refs: [MAIN], sealOff: 4 }, doneCount: 3, steps: { sealOff: 'done', flip: 'done', history: 'skipped' } }),
    )
    runMakePublic.mockResolvedValue({ finished: true, notPublished: [], boundaryKept: true })
    await renderRow({ visibility: 'public' })
    await click(tid('make-public-finish'))
    expect(tid('make-public-boundary-kept')?.textContent).toBe(COPY.boundaryKept)
  })
})

describe('a maintainer without a record (M3)', () => {
  it("starts with nothing ticked and asks for the owner's branches and tags", async () => {
    viewer.id = 'maint'
    converted.value = true
    readMakePublicStatus.mockResolvedValue(aStatus({ phase: 'made', converted: true, doneCount: 3, steps: { sealOff: 'done', flip: 'done' } }))
    makePublicCheck.mockResolvedValue(aCheck())
    await renderRow({ visibility: 'public' })
    await click(tid('make-public-finish'))
    expect(tid<HTMLInputElement>('make-public-ref-default')?.checked).toBe(false)
    expect(tid('make-public-refs-hint')?.textContent).toBe('This browser has no record of the run that made it public: choose the branches and tags the owner chose.')
    await click(tid('make-public-mode-codeOnly'))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    expect(confirmButton().disabled).toBe(true)
    expect(tid('make-public-why')?.textContent).toBe('Choose at least one branch or tag to make public.')
  })

  it('the owner without a record still starts from the default branch and its tags', async () => {
    converted.value = true
    readMakePublicStatus.mockResolvedValue(aStatus({ phase: 'made', converted: true, doneCount: 3, steps: { sealOff: 'done', flip: 'done' } }))
    makePublicCheck.mockResolvedValue(aCheck())
    await renderRow({ visibility: 'public' })
    await click(tid('make-public-finish'))
    expect(tid<HTMLInputElement>('make-public-ref-default')?.checked).toBe(true)
    expect(tid('make-public-refs-hint')).toBeNull()
  })
})

describe('a step still signing after its dialog closed (M4)', () => {
  it('holds Finish back, says so, and lets it go once the step settles', async () => {
    await openDialog(aCheck())
    await click(tid('make-public-mode-codeOnly'))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    // the seal-off step keeps signing after the dialog asks it to stop
    let settle: () => void = () => undefined
    runMakePublic.mockImplementation((_c: unknown, _choice: unknown, onProgress: (p: MakePublicProgress) => void) => {
      onProgress({ step: 'sealOff', state: 'running' })
      return new Promise((_r, reject) => (settle = () => reject(new DOMException('stopped', 'AbortError'))))
    })
    await click(confirmButton())
    readMakePublicStatus.mockResolvedValue(
      aStatus({ phase: 'private', record: { mode: 'codeOnly', refs: [MAIN], sealOff: 4 }, doneCount: 2, steps: { sealOff: 'done', history: 'skipped' } }),
    )
    await click(tid('make-public-close'))
    expect(tid('make-public-still-working')?.textContent).toBe('Still working on the last step…')
    expect(tid<HTMLButtonElement>('make-public-finish')?.disabled).toBe(true)
    await act(async () => settle())
    await flush()
    expect(tid('make-public-still-working')).toBeNull()
    expect(tid<HTMLButtonElement>('make-public-finish')?.disabled).toBe(false)
    expect(runMakePublic).toHaveBeenCalledTimes(1)
  })
})

describe('Everything after Code only (M5)', () => {
  const codeOnlyDone = (): MakePublicStatus => aStatus({ phase: 'public', converted: true, doneCount: 7, steps: { sealOff: 'done', flip: 'done', config: 'done', code: 'done', notify: 'done', history: 'skipped' } })

  it("the owner gets the row and a dialog with Everything fixed; the run publishes everything after the typed words", async () => {
    converted.value = true
    readMakePublicStatus.mockResolvedValue(codeOnlyDone())
    makePublicCheck.mockResolvedValue(aCheck({ oldFormat: [] }))
    await renderRow({ visibility: 'public' })
    expect(tid('make-public-everything-row')?.textContent).toContain('Make everything public')
    await click(tid('make-public-everything-open'))
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Make everything in carol/ledger public?')
    expect(tid('make-public-mode-codeOnly')).toBeNull()
    expect(tid<HTMLInputElement>('make-public-mode-everything')?.checked).toBe(true)
    expect(tid('make-public-everything-counts')?.textContent).toBe('That is 3 issues, 1 pull request, 3 live branches and tags, 2 deleted branches.')
    expect(tid('make-public-stays-private')).not.toBeNull()
    expect(tid('make-public-cost')?.textContent).toContain('Costs about 0.03 DASH')
    expect(confirmButton().disabled).toBe(true)
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    runMakePublic.mockResolvedValue({ finished: true, notPublished: [] })
    await click(confirmButton())
    const choice = runMakePublic.mock.calls[0]![1] as { mode: string; refs?: string[]; confirmation: string; resume?: boolean }
    expect(choice).toMatchObject({ mode: 'everything', confirmation: 'make carol/ledger public' })
    expect(choice.refs).toBeUndefined()
    expect(choice.resume).toBeUndefined()
    expect(tid('make-public-done')?.textContent).toContain('carol/ledger is public (Everything).')
  })

  it('E812 blocks it, as it blocks Everything', async () => {
    converted.value = true
    readMakePublicStatus.mockResolvedValue(codeOnlyDone())
    makePublicCheck.mockResolvedValue(aCheck({ oldFormat: ['production'] }))
    await renderRow({ visibility: 'public' })
    await click(tid('make-public-everything-open'))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    expect(q('[data-testid="make-public-blocker"][data-code="E812"]')).not.toBeNull()
    expect(confirmButton().disabled).toBe(true)
  })

  it('nobody else sees it, nor the owner once the history is published', async () => {
    converted.value = true
    viewer.id = 'maint'
    readMakePublicStatus.mockResolvedValue(codeOnlyDone())
    await renderRow({ visibility: 'public' })
    expect(tid('make-public-everything-row')).toBeNull()
    viewer.id = 'owner'
    readMakePublicStatus.mockResolvedValue({ ...codeOnlyDone(), mode: 'everything', steps: { ...codeOnlyDone().steps, history: 'done' } })
    await renderRow({ visibility: 'public' })
    expect(tid('make-public-everything-row')).toBeNull()
  })
})

describe('a run that stops says it in plain words (L6)', () => {
  it('unlocks and rechecks a run stopped before any writes without publishing automatically', async () => {
    await openDialog(aCheck())
    await click(tid('make-public-mode-codeOnly'))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    runMakePublic.mockRejectedValueOnce(new EncryptionKeyLockedError())
    await click(confirmButton())
    await click(tid('make-public-encryption-unlock'))
    expect(makePublicCheck).toHaveBeenCalledTimes(2)
    expect(runMakePublic).toHaveBeenCalledTimes(1)
    expect(tid('make-public-run-error')).toBeNull()
    expect(tid<HTMLInputElement>('make-public-words')?.value).toBe('make carol/ledger public')
  })

  it('renders one encryption prompt when both the form and check failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await openDialog(aCheck())
      await click(tid('make-public-mode-codeOnly'))
      type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
      runMakePublic.mockRejectedValue(new EncryptionKeyLockedError())
      await click(confirmButton())
      makePublicCheck.mockRejectedValue(new EncryptionKeyLockedError())
      await click(q('[data-testid="make-public-ref"][data-ref="refs/heads/feature"]'))
      await act(async () => vi.advanceTimersByTime(700))
      await flush()
      expect(tid('make-public-check-error')).not.toBeNull()
      expect(tid('make-public-run-error')).not.toBeNull()
      expect(document.querySelectorAll('[data-testid="make-public-encryption-unlock"]')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rotation lost to another maintainer, and a raw error with internal words', async () => {
    await openDialog(aCheck())
    await click(tid('make-public-mode-codeOnly'))
    type(tid<HTMLInputElement>('make-public-words'), 'make carol/ledger public')
    const lost = Object.assign(new Error('another maintainer rotated to epoch 5 first; their key is the repo\'s key'), { name: 'PrivateMembersError', code: 'E310', outcome: 'lost' })
    runMakePublic.mockRejectedValueOnce(lost)
    await click(confirmButton())
    const said = tid('make-public-run-error')?.textContent ?? ''
    expect(said).toBe("Another maintainer changed the repo's key at the same time. The repo is still private. Run it again to continue.")
    runMakePublic.mockRejectedValueOnce(new Error('the anchor of epoch 4 is not visible yet'))
    await click(confirmButton())
    expect(tid('make-public-run-error')?.textContent).toBe("That step didn't finish. Try again.")
  })
})


it('qualifies the members-only notice after a passed boundary and warns after replacement', async () => {
  readMakePublicStatus.mockResolvedValue(aStatus({ sealOffPassed: true, sealOffMarker: {
    kind: 'active', epoch: 3, highestEpoch: 3, replacesThrough: 1, height: 30,
    marker: { mode: 'codeOnly', boundaryEpoch: 3, conversionId: new Uint8Array(16), startedAtMs: 1n, replacesEpoch: 1 },
  } }))
  await renderRow()
  expect(tid('make-public-interrupted')?.textContent).toContain('unless the owner starts the conversion over.')
  expect(tid('make-public-interrupted')?.textContent).toContain('Earlier writing may now be published.')
})

it('offers Start again after a refused run and refreshed member session without reloading the page', async () => {
  const pending = aStatus({ record: { mode: 'codeOnly', refs: [MAIN], sealOff: 4 }, sealOffPassed: false })
  readMakePublicStatus.mockResolvedValue(pending)
  runMakePublic.mockRejectedValue(new MakePublicError(COPY.sealOffPassed('codeOnly'), 'E310'))
  await renderRow()
  await click(tid('make-public-finish'))
  expect(tid('make-public-progress')?.textContent).toContain(COPY.sealOffPassed('codeOnly'))
  await click(tid('make-public-close'))
  expect(onSaved).toHaveBeenCalledTimes(1)
  // The parent's requested read finishes after the dialog's status reload, with a fresh session.
  readMakePublicStatus.mockResolvedValue({ ...pending, sealOffPassed: true })
  const h = home()
  const freshHome = { ...h, repo: { ...h.repo, session: { id: 'fresh-after-refusal' } } } as unknown as RepoHome
  act(() => root.render(<MakeRepoPublic home={freshHome} maintainer onSaved={onSaved} />))
  await flush()
  expect(tid('make-public-start-over')?.textContent).toBe('Start again…')
  expect(tid('make-public-finish')).toBeNull()
})

// @vitest-environment jsdom
/**
 * A commit to the PR branch from the browser (suggestions, "Update branch") after a reload
 * (QW-007): stored storage settings are sealed in a resumed tab, so the run asks for the unlock
 * where it was started, never failing its upload step with "your storage settings are not
 * unlocked yet" and nothing to unlock with. Once they open, the very action goes on. A step that
 * fails offers a real Retry, which resumes the same commit, and never on a PR head that moved.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PullView, RepoRef } from '@/lib/repo'
import type { BranchCommit } from '@/lib/merge/branch-commit'
import type { ObjectReader } from '@/lib/view'
import { useBranchCommit, type BranchRunAt } from './branch-commit-panel'

// The tab's storage settings: sealed until `unlockMore`, then read (the upload appears).
const store: { sealed: boolean; reading: boolean; error: string | null } = { sealed: true, reading: false, error: null }
const rerender: { current: () => void } = { current: () => undefined }
const uploadFn = vi.fn(async () => ({ storage: 0, chunkCount: 1, uris: [] as string[] }))
const unlockMore = vi.fn(async () => {
  store.sealed = false
  rerender.current()
})

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ signer: { identityId: 'me' }, identity: 'me', isLoading: false, vaults: [{ identityId: 'me', methods: ['passphrase'] }], controller: { unlockMore } }),
}))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/components/repo/merge-upload', () => ({
  useMergeUpload: () => ({
    upload: store.sealed || store.reading || store.error !== null ? null : uploadFn,
    question: null,
    questionStep: 'upload',
    begin: () => undefined,
    choiceFor: () => null,
    storageNeedsUnlock: store.sealed,
    storageError: store.error,
  }),
}))
// The chain itself is `branch-runner`'s (tested there): record what each run was given.
const runs: { key: string; upload: unknown }[] = []
let failNext = false
vi.mock('@/lib/merge/branch-runner', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/merge/branch-runner')>()
  return {
    ...real,
    runKeyedBranchCommit: async (
      _runs: unknown,
      key: string,
      build: () => Promise<BranchCommit>,
      deps: (b: BranchCommit) => { upload: unknown },
      onBuilt: (b: BranchCommit) => void,
    ): Promise<BranchCommit> => {
      const built = await build()
      onBuilt(built)
      runs.push({ key, upload: deps(built).upload })
      if (failNext) {
        failNext = false
        throw new real.BranchStepError('upload', 'the gateway timed out', { commit: built.commit, done: [] })
      }
      return built
    },
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { repoId: 'R', name: 'repo', visibility: 'public' } as unknown as RepoRef
const PULL = { id: 'P', number: 2, author: 'me', headOid: 'a'.repeat(40), sourceRefName: 'refs/heads/feature', baseRefName: 'refs/heads/main', state: { open: true } } as unknown as PullView
const built: BranchCommit = { commit: 'c'.repeat(40), files: ['src/greet.sh'], pack: { bytes: new Uint8Array(4), packHash: 'h', objectCount: 3 } } as unknown as BranchCommit
const build = vi.fn(async () => built)
const onDone = vi.fn()

const current = { pull: PULL }
let host: HTMLDivElement
let root: Root
let hook: ReturnType<typeof useBranchCommit>
function Harness(): JSX.Element {
  hook = useBranchCommit({ repo, source: repo, pull: current.pull, isMember: true, verifyReader: {} as ObjectReader, onDone })
  return <div>{hook.view}</div>
}
const render = (): void => root.render(<Harness />)

beforeEach(() => {
  store.sealed = true
  store.reading = false
  store.error = null
  current.pull = PULL
  runs.length = 0
  failNext = false
  build.mockClear()
  onDone.mockClear()
  unlockMore.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  rerender.current = render
  act(render)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function start(at: BranchRunAt): Promise<void> {
  await act(async () => {
    await hook.run('suggest:k', 'Apply 3 suggestions', build, at)
  })
}

describe('a branch commit in a tab resumed after a reload', () => {
  it('asks for the unlock where it was started instead of failing the upload', async () => {
    await start('batch')
    expect(build).not.toHaveBeenCalled()
    expect(runs).toEqual([])
    expect(hook.at).toBe('batch')
    const ask = host.querySelector('[data-testid="branch-storage-unlock"]')
    expect(ask).not.toBeNull()
    expect(ask!.textContent).toContain('Apply 3 suggestions goes on once they open')
    // No step list failing "Upload the pack to storage" behind it.
    expect(host.querySelector('[data-step="upload"]')).toBeNull()
    expect(host.textContent).not.toContain('not unlocked')
  })

  it('goes on with the very action once the unlock opens the settings', async () => {
    await start('comment:c1')
    const input = host.querySelector<HTMLInputElement>('#branch-storage-unlock-passphrase')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-testid="branch-storage-unlock"] form')!.requestSubmit()
    })
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(unlockMore).toHaveBeenCalledOnce()
    expect(build).toHaveBeenCalledOnce()
    expect(runs).toEqual([{ key: 'suggest:k', upload: uploadFn }])
    expect(onDone).toHaveBeenCalledWith(built.commit)
    expect(hook.at).toBe('comment:c1')
    expect(host.querySelector('[data-testid="branch-storage-unlock"]')).toBeNull()
    expect(host.textContent).toContain(`Committed ${built.commit.slice(0, 9)}`)
  })

  it('offers a Retry that resumes the same action after a step fails', async () => {
    store.sealed = false
    act(render)
    failNext = true
    await start('batch')
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('the upload failed: the gateway timed out')
    const retry = [...alert.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
    expect(retry).toBeDefined()
    await act(async () => {
      retry!.click()
    })
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(runs.map((r) => r.key)).toEqual(['suggest:k', 'suggest:k'])
    expect(onDone).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('never retries on a PR head that moved since: the commit was built on the old one', async () => {
    store.sealed = false
    act(render)
    failNext = true
    await start('batch')
    act(() => {
      current.pull = { ...PULL, headOid: 'b'.repeat(40) } as unknown as PullView
      render()
    })
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
    await act(async () => {
      retry.click()
    })
    expect(runs).toHaveLength(1)
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('The PR head moved to bbbbbbbbb')
  })

  it('waits for "Continue" when the settings were unlocked elsewhere on the page', async () => {
    await start('comment:c1')
    act(() => {
      store.sealed = false
      render()
    })
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(build).not.toHaveBeenCalled()
    const go = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Continue: Apply 3 suggestions')!
    await act(async () => {
      go.click()
    })
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(runs.map((r) => r.key)).toEqual(['suggest:k'])
  })

  it('goes on by itself once settings still being read are, and says so when they cannot be', async () => {
    store.sealed = false
    store.reading = true
    act(render)
    await start('batch')
    expect(host.textContent).toContain('Opening your storage settings')
    expect(build).not.toHaveBeenCalled()
    act(() => {
      store.reading = false
      render()
    })
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(runs).toHaveLength(1)

    store.error = 'the vault record is unreadable'
    act(render)
    await start('batch')
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('could not be opened (the vault record is unreadable)')
    expect(host.textContent).not.toContain('Opening your storage settings')
  })
})

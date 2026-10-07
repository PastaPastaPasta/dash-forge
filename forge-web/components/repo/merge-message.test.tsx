// @vitest-environment jsdom
/**
 * Review-parity M2: a merge commit's message is editable in the merge box, as GitHub's "Create a
 * merge commit" is (and as `dg pr merge --message` sets it). The box shows the default
 * (`Merge pull request #<n> from <branch>` and the PR title); an edited message is what the merge
 * writes; an empty one disables the merge and says why.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PullView, RepoRef } from '@/lib/repo'
import type { MergeInput } from '@/lib/merge/engine'
import type { RepoHome } from '@/lib/view'
import { PullMerge } from './pull-merge'

const HEAD = 'aa'.repeat(20)
const BASE = 'bb'.repeat(20)
const reader = { readObject: vi.fn() }

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'me' }, identity: 'me' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-prefs', () => ({
  usePrefs: () => [{ mergeName: 'Merger', mergeEmail: 'm@example.invalid', diffLayout: 'split' }, () => undefined],
  useMinWidth: () => true,
}))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: { profiles: [], policies: [] }, usable: { profiles: [], policies: [] }, needsUnlock: false, sealed: false, error: null, storedSince: async () => false }) }))
vi.mock('@/lib/storage', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/storage')>()), policyForRepo: () => null }))
// The check: the two sides diverged and merge cleanly, so the merge writes a commit.
vi.mock('@/lib/merge/client', () => ({
  checkMergeInWorker: async () => ({ check: 'merge', conflictPaths: [] as string[], packEstimate: { bytes: 4000, objectCount: 4 } }),
  runMergeInWorker: vi.fn(),
}))
// The run: records the merge input it was started with.
const started: MergeInput[] = []
vi.mock('@/lib/merge/runner', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/merge/runner')>()
  return {
    ...real,
    runMergeSteps: async (deps: { input: MergeInput }, from: import('@/lib/merge/runner').MergeRun) => {
      started.push(deps.input)
      return { ...from, done: real.MERGE_STEPS.map((s) => s.id), result: { newTip: 'cc'.repeat(20) } }
    },
  }
})
vi.mock('@/components/repo/pull-diff', () => ({
  useComparisonSides: () => ({ sides: { base: reader, head: reader }, baseOnly: reader, sidesKey: 'k' }),
  pullBase: () => ({ baseRefName: 'refs/heads/main', baseTipOid: BASE, baseOidAtOpen: BASE }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { repoId: 'R', name: 'repo', visibility: 'public' } as unknown as RepoRef
const home = { repo, branches: [{ refName: 'refs/heads/main', state: { state: 'resolved', oid: BASE } }], config: { protectedPatterns: [] } } as unknown as RepoHome
const pull = {
  id: 'P',
  number: 7,
  title: 'Greet',
  body: '',
  author: 'someone',
  headOid: HEAD,
  baseRefName: 'refs/heads/main',
  mergeBaseRefName: 'refs/heads/main',
  baseTipOid: BASE,
  sourceId: 'R',
  sourceRefName: 'refs/heads/feature',
  state: { open: true, merged: false, draft: false, baseRef: 'refs/heads/main' },
} as unknown as PullView

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  started.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const box = (): HTMLTextAreaElement => host.querySelector('[data-testid="merge-message"]') as HTMLTextAreaElement
const submit = (): HTMLButtonElement => host.querySelector('[data-testid="merge-submit"]') as HTMLButtonElement
function type(el: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the merge commit message (review-parity M2)', () => {
  it('shows the default, writes an edited message, and refuses an empty one', async () => {
    await act(async () => root.render(<PullMerge recheckMembers={async () => null} repo={repo} home={home} pull={pull} canMerge isMaintainer checkout="dg pr checkout 7" onMerged={() => undefined} />))
    await act(async () => undefined)
    expect(box().value).toBe('Merge pull request #7 from feature\n\nGreet')
    expect(host.querySelector('label[for="merge-message"]')?.textContent).toBe('Commit message')

    await act(async () => type(box(), '   '))
    expect(submit().disabled).toBe(true)
    expect(host.querySelector('[data-testid="merge-message-problem"]')?.textContent).toBe('Write a commit message to merge.')

    await act(async () => type(box(), 'Release the greeting\n\nCloses the loop.'))
    expect(submit().disabled).toBe(false)
    await act(async () => submit().click())
    await act(async () => undefined)
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ message: 'Release the greeting\n\nCloses the loop.' })
  })

  it('passes no message when the default is kept (the engine writes the default)', async () => {
    await act(async () => root.render(<PullMerge recheckMembers={async () => null} repo={repo} home={home} pull={pull} canMerge isMaintainer checkout="dg pr checkout 7" onMerged={() => undefined} />))
    await act(async () => undefined)
    await act(async () => submit().click())
    await act(async () => undefined)
    expect(started[0]).not.toHaveProperty('message')
  })
})

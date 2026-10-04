// @vitest-environment jsdom
/**
 * Review-parity M1 (P1-2): "Rebase and merge" in the merge box. A rebase is checked on its own (it
 * can stop where a merge would not): the button runs the rebase when its check is clean, and is
 * disabled with the reason and the paths when it is not, pointing at `dg pr merge --rebase`.
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
// The check: the two sides diverged and merge cleanly; the rebase's verdict is set per test.
const verdict = vi.hoisted(() => ({ rebase: { check: 'merge', conflictPaths: [] as string[], reason: null as string | null } }))
vi.mock('@/lib/merge/client', () => ({
  checkMergeInWorker: async (_r: unknown, input: { rebase?: true }) =>
    input.rebase ? { ...verdict.rebase, packEstimate: verdict.rebase.check === 'merge' ? { bytes: 5000, objectCount: 6 } : null } : { check: 'merge', conflictPaths: [] as string[], reason: null, packEstimate: { bytes: 4000, objectCount: 4 } },
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
  baseTipOid: BASE,
  sourceId: 'R',
  sourceRefName: 'refs/heads/feature',
  state: { open: true, merged: false, draft: false, baseRef: 'refs/heads/main' },
} as unknown as PullView

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  started.length = 0
  verdict.rebase = { check: 'merge', conflictPaths: [], reason: null }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const submit = (): HTMLButtonElement => host.querySelector('[data-testid="merge-submit"]') as HTMLButtonElement
function choose(value: string): void {
  const el = host.querySelector('#merge-method') as HTMLSelectElement
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
const render = async (): Promise<void> => {
  await act(async () => root.render(<PullMerge repo={repo} home={home} pull={pull} canMerge isMaintainer checkout="dg pr checkout 7" onMerged={() => undefined} />))
  await act(async () => undefined)
}

describe('rebase and merge (review-parity M1)', () => {
  it('rebases when its own check is clean: no message box, the run is a rebase', async () => {
    await render()
    await act(async () => choose('rebase'))
    await act(async () => undefined)
    expect(submit().textContent).toBe('Rebase and merge')
    expect(submit().disabled).toBe(false)
    expect(host.querySelector('[data-testid="merge-message"]')).toBeNull()
    await act(async () => submit().click())
    await act(async () => undefined)
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ rebase: true })
    expect(started[0]).not.toHaveProperty('message')
  })

  it('says why it cannot rebase, and where, when the rebase stops although the merge is clean', async () => {
    verdict.rebase = { check: 'conflict', conflictPaths: ['src/a.rs'], reason: 'commit 1234567 does not apply cleanly on the base branch' }
    await render()
    await act(async () => choose('rebase'))
    await act(async () => undefined)
    expect(submit().disabled).toBe(true)
    // git's rebase stops at the same commit: the box does not send the merger to dg for it.
    expect(host.querySelector('[data-testid="rebase-problem"]')?.textContent).toBe(
      "Can't rebase: commit 1234567 does not apply cleanly on the base branch (src/a.rs). git's rebase stops there too: pick another method, or rebase the PR's branch yourself (`dg pr checkout`).",
    )
    // The merge commit is still offered.
    await act(async () => choose('merge'))
    expect(submit().disabled).toBe(false)
  })

  it('sends a refusal only the browser makes (no conflict) to `dg pr merge --rebase`', async () => {
    verdict.rebase = { check: 'conflict', conflictPaths: [], reason: "the PR's history holds a merge commit (abcdef1), which only git's rebase flattens" }
    await render()
    await act(async () => choose('rebase'))
    await act(async () => undefined)
    expect(submit().disabled).toBe(true)
    expect(host.querySelector('[data-testid="rebase-problem"]')?.textContent).toBe(
      "Can't rebase in the browser: the PR's history holds a merge commit (abcdef1), which only git's rebase flattens. Rebase with `dg pr merge --rebase`, or pick another method.",
    )
  })
})

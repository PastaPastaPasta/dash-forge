// @vitest-environment jsdom
/**
 * The merge box in a DOM, through its own merge: the merge refreshes the PR, which then reads
 * merged (the page stops offering the merge and the branch deletion), while the box still has
 * its last step to show and the source branch to delete. Seen live twice (review round trip r6):
 * the box unmounted and the branch stayed; then it reported a successful deletion as failed.
 */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PullView, RepoRef } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { PullMerge } from './pull-merge'

// ---- the merge's collaborators: a merge that lands at once, a check that says "merge" -------
const HEAD = 'aa'.repeat(20)
const BASE = 'bb'.repeat(20)
const NEW_TIP = 'cc'.repeat(20)
const reader = { readObject: vi.fn() }

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'me' }, identity: 'me' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-prefs', () => ({
  usePrefs: () => [{ mergeName: 'Merger', mergeEmail: 'm@example.invalid', diffLayout: 'split' }, () => undefined],
  useMinWidth: () => true,
}))
vi.mock('@/components/repo/merge-upload', () => ({ useMergeUpload: () => ({ upload: null, dialog: null, storageLabel: '', begin: () => undefined }) }))
// A check after the merge compares the head with a base that already holds it: seen live as a
// conflict on '/'. The first check says "merge"; any later one says what that live one did.
let checkCount = 0
const checks = vi.fn(async () => (++checkCount === 1 ? { check: 'merge', conflictPaths: [] as string[] } : { check: 'conflict', conflictPaths: ['/'] }))
vi.mock('@/lib/merge/client', () => ({
  checkMergeInWorker: () => checks(),
  runMergeInWorker: vi.fn(),
}))
vi.mock('@/lib/merge/runner', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/merge/runner')>()
  return {
    ...real,
    // Every step lands; the run reports the new tip.
    runMergeSteps: async (_deps: unknown, from: import('@/lib/merge/runner').MergeRun, onStep: (e: { step: string; state: string }) => void) => {
      for (const s of real.MERGE_STEPS) onStep({ step: s.id, state: 'done' })
      return { ...from, done: real.MERGE_STEPS.map((s) => s.id), result: { newTip: NEW_TIP } }
    },
  }
})
vi.mock('@/components/repo/pull-diff', () => ({
  useComparisonSides: () => ({ sides: { base: reader, head: reader }, baseOnly: reader, sidesKey: 'k' }),
  pullBase: () => ({ baseRefName: 'refs/heads/main', baseTipOid: BASE, baseOidAtOpen: BASE }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { repoId: 'R', name: 'repo', visibility: 'public' } as unknown as RepoRef
/** The repo home: after the merge the page reloads it, and main is at the new tip. */
const homeAt = (tip: string): RepoHome =>
  ({ repo, branches: [{ refName: 'refs/heads/main', state: { state: 'resolved', oid: tip } }], config: { protectedPatterns: [] } }) as unknown as RepoHome
const pullOf = (merged: boolean): PullView =>
  ({
    id: 'P',
    number: 1,
    title: 'Greet',
    body: '',
    author: 'someone',
    headOid: HEAD,
    baseRefName: 'refs/heads/main',
    baseTipOid: BASE,
    sourceId: 'FORK',
    sourceRefName: 'refs/heads/feature',
    state: { open: !merged, merged, draft: false, baseRef: 'refs/heads/main' },
  }) as unknown as PullView

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** The PR page's part: the merge refreshes the PR to merged, and the page then stops offering the deletion. */
function Page({ onDelete }: { onDelete: () => Promise<void> }): JSX.Element {
  const [merged, setMerged] = useState(false)
  return (
    <PullMerge
      repo={repo}
      home={homeAt(merged ? NEW_TIP : BASE)}
      pull={pullOf(merged)}
      canMerge={!merged}
      isMaintainer
      checkout="dg pr checkout …"
      onMerged={() => setMerged(true)}
      extras={{ deleteBranch: merged ? null : { label: 'fork:feature', run: onDelete } }}
    />
  )
}

describe('the merge box through its own merge', () => {
  it('stays on screen after the PR flips to merged, deletes the branch and says so', async () => {
    const onDelete = vi.fn(async () => undefined)
    await act(async () => root.render(<Page onDelete={onDelete} />))
    // The worker's check resolves: the merge button shows.
    await act(async () => undefined)
    const button = [...host.querySelectorAll('button')].find((b) => /merge/i.test(b.textContent ?? '') && !b.disabled)
    expect(button, host.querySelector('[data-testid="merge-button-state"]')?.outerHTML ?? host.textContent ?? '').toBeDefined()
    await act(async () => {
      button!.click()
    })
    await act(async () => undefined)
    // The PR now reads merged (canMerge false): the box is still there, with its last step done.
    const panel = host.querySelector('[data-testid="merge-panel"]')
    expect(panel).not.toBeNull()
    expect(panel!.querySelector('[data-step="event"]')?.getAttribute('data-state')).toBe('done')
    // The deletion ran, and is reported as done, with the label it ran for.
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-testid="branch-deleted"]')?.textContent).toBe('Deleted fork:feature.')
    expect(host.textContent).not.toMatch(/deleting .* failed/)
    // The merge is not checked again against the base it just moved (it would report conflicts).
    expect(checks).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-testid="conflict-paths"]')).toBeNull()
    expect(host.textContent).not.toMatch(/Conflicts or overlapping changes/)
  })
})

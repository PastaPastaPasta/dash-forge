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
// The storage answer the run was started with (what "Allow storing on Platform" passed).
const begun: (number | null | undefined)[] = []
vi.mock('@/components/repo/merge-upload', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/repo/merge-upload')>()
  const { storageChoice } = await import('@/lib/storage/merge-choice')
  return {
    ...real,
    useMergeUpload: () => ({
      upload: null,
      // A repo whose storage policy lists Platform: allowed up front by default.
      choiceFor: (estimate: { bytes: number; objectCount: number } | null) =>
        storageChoice({ targets: ['chain'], replicas: 1, platformFallback: false }, [{ name: 'chain', settings: { kind: 'platform', provider: 'platform' }, secrets: {} } as never], estimate),
      question: null,
      questionStep: 'upload',
      begin: (credits?: number | null) => void begun.push(credits),
      storageNeedsUnlock: false,
    }),
  }
})
// A check after the merge compares the head with a base that already holds it: seen live as a
// conflict on '/'. The first check says "merge"; any later one says what that live one did.
let checkCount = 0
const checks = vi.fn(async (_input?: unknown) =>
  ++checkCount === 1 ? { check: 'merge', conflictPaths: [] as string[], packEstimate: { bytes: 4000, objectCount: 4 } } : { check: 'conflict', conflictPaths: ['/'], packEstimate: null },
)
vi.mock('@/lib/merge/client', () => ({
  checkMergeInWorker: (_reader: unknown, input: unknown) => checks(input),
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
function Page({ onDelete, closeIssues = null }: { onDelete: () => Promise<void>; closeIssues?: import('./merge-panel').CloseIssuesOption | null }): JSX.Element {
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
      extras={{ deleteBranch: merged ? null : { label: 'fork:feature', run: onDelete }, closeIssues }}
    />
  )
}

describe('the merge box through its own merge', () => {
  it('offers to close the issues "Fixes #n" names, and closes the ticked ones after the merge (QW-015)', async () => {
    checkCount = 0
    checks.mockClear()
    const close = vi.fn(async (n: number) => {
      if (n === 7) throw new Error('refused')
    })
    const issues = [
      { number: 3, title: 'Greeting should shout' },
      { number: 5, title: 'Keep open' },
      { number: 7, title: 'Fails' },
    ]
    await act(async () => root.render(<Page onDelete={async () => undefined} closeIssues={{ issues, close }} />))
    await act(async () => undefined)
    const offer = host.querySelector('[data-testid="close-linked-issues"]')
    expect(offer?.textContent).toContain('Close #3 Greeting should shout after merging')
    const boxes = [...offer!.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([true, true, true])
    // The merger keeps #5 open.
    await act(async () => boxes[1]!.click())
    const button = [...host.querySelectorAll('button')].find((b) => /merge/i.test(b.textContent ?? '') && !b.disabled)
    await act(async () => button!.click())
    await act(async () => undefined)
    expect(close.mock.calls.map((c) => c[0])).toEqual([3, 7])
    const outcome = host.querySelector('[data-testid="linked-issues-closed"]')?.textContent ?? ''
    expect(outcome).toContain('Closed #3.')
    expect(outcome).toContain('The merge stands; closing #7 failed: refused')
    // Merged: the offer is gone.
    expect(host.querySelector('[data-testid="close-linked-issues"]')).toBeNull()
    // The next test starts from a fresh first check.
    checkCount = 0
    checks.mockClear()
  })

  it('stays on screen after the PR flips to merged, deletes the branch and says so', async () => {
    const onDelete = vi.fn(async () => undefined)
    await act(async () => root.render(<Page onDelete={onDelete} />))
    // The worker's check resolves: the merge button shows.
    await act(async () => undefined)
    const button = [...host.querySelectorAll('button')].find((b) => /merge/i.test(b.textContent ?? '') && !b.disabled)
    expect(button, host.querySelector('[data-testid="merge-button-state"]')?.outerHTML ?? host.textContent ?? '').toBeDefined()
    // Before the merge: the Storage row names where the pack goes and allows Platform up front
    // (the policy lists it), priced from the check's estimate.
    expect(host.querySelector('[data-testid="storage-row"]')?.textContent).toMatch(/Storage: chain/)
    expect((host.querySelector('[data-testid="allow-platform"]') as HTMLInputElement).checked).toBe(true)
    await act(async () => {
      button!.click()
    })
    // The run started with that pre-answer: a positive credit cap, so it asks nothing mid-run.
    expect(begun.at(-1)).toBeGreaterThan(0)
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
    expect(host.textContent).not.toMatch(/Can't merge in the browser/)
    // Nothing is left to merge: the header says Merged, with no method menu, button or cost.
    expect(host.querySelector('[data-testid="merge-done"]')?.textContent).toBe('Merged')
    expect(host.querySelector('#merge-method')).toBeNull()
    expect([...host.querySelectorAll('button')].some((b) => /merge/i.test(b.textContent ?? ''))).toBe(false)
  })

  it('a method switch re-sizes the pack without taking the controls away (the menu keeps focus)', async () => {
    checkCount = 0
    checks.mockClear()
    // Every check says "merge"; the squash one sizes a smaller pack, and answers only when told.
    let answer: () => void = () => undefined
    const later = new Promise<void>((r) => (answer = r))
    checks.mockImplementation(async () => {
      const first = checks.mock.calls.length === 1
      if (!first) await later
      return { check: 'merge', conflictPaths: [] as string[], packEstimate: { bytes: first ? 4000 : 1000, objectCount: 4 } }
    })
    await act(async () => root.render(<Page onDelete={async () => undefined} />))
    await act(async () => undefined)
    const select = host.querySelector('#merge-method') as HTMLSelectElement
    expect(select).not.toBeNull()
    select.focus()
    const price = (): string => host.querySelector('[data-testid="storage-row"] [data-testid="cost-preview"]')?.textContent ?? ''
    const before = price()
    await act(async () => {
      select.value = 'squash'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // The same select is still mounted and focused; no "Checking the merge…" in between.
    expect(host.querySelector('#merge-method')).toBe(select)
    expect(document.activeElement).toBe(select)
    expect(host.textContent).not.toMatch(/Checking the merge/)
    await act(async () => answer())
    // Sized again, for the squash.
    expect(checks).toHaveBeenCalledTimes(2)
    expect(price()).not.toBe(before)
    expect(price()).toMatch(/DASH/)
  })

  it('switching away and back before the new size is in keeps a price for the method shown', async () => {
    checkCount = 0
    checks.mockClear()
    const never = new Promise<never>(() => undefined)
    checks.mockImplementation(async () => {
      if (checks.mock.calls.length > 1) return never
      return { check: 'merge', conflictPaths: [] as string[], packEstimate: { bytes: 4000, objectCount: 4 } }
    })
    await act(async () => root.render(<Page onDelete={async () => undefined} />))
    await act(async () => undefined)
    const select = host.querySelector('#merge-method') as HTMLSelectElement
    const price = (): string => host.querySelector('[data-testid="storage-row"] [data-testid="cost-preview"]')?.textContent ?? ''
    const before = price()
    expect(before).toMatch(/DASH/)
    const pick = async (v: string): Promise<void> => {
      await act(async () => {
        select.value = v
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    await pick('squash')
    // Not sized for squash yet: no price rather than the merge's.
    expect(price()).toBe('')
    await pick('merge')
    // Back on merge: its own size still stands.
    expect(price()).toBe(before)
  })
})

describe('--no-ff where a fast-forward is possible (QW-069)', () => {
  const ff = async (): Promise<{ check: string; conflictPaths: string[]; packEstimate: { bytes: number; objectCount: number } }> => ({ check: 'fast-forward', conflictPaths: [], packEstimate: { bytes: 900, objectCount: 3 } })
  const render = async (allowedMethods: number): Promise<void> => {
    checks.mockReset()
    checks.mockImplementation(ff)
    await act(async () =>
      root.render(
        <PullMerge
          repo={repo}
          home={homeAt(BASE)}
          pull={pullOf(false)}
          canMerge
          isMaintainer
          checkout="dg pr checkout …"
          onMerged={() => undefined}
          extras={{ deleteBranch: null, allowedMethods }}
        />,
      ),
    )
    await act(async () => undefined)
  }
  const options = (): string[] => [...host.querySelectorAll<HTMLOptionElement>('#merge-method option')].map((o) => `${o.value}${o.disabled ? '(off)' : ''}`)
  const mergeButton = (): HTMLButtonElement | undefined => [...host.querySelectorAll('button')].find((b) => /merge/i.test(b.textContent ?? '') && b.id !== 'merge-method')

  it('offers "Create a merge commit" beside the fast-forward, and sizes it as a merge commit', async () => {
    await render(0)
    expect(options()).toEqual(['merge', 'no-ff', 'squash'])
    const select = host.querySelector('#merge-method') as HTMLSelectElement
    expect(select.value).toBe('merge')
    await act(async () => {
      select.value = 'no-ff'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => undefined)
    expect(mergeButton()?.textContent).toMatch(/Create merge commit and merge/)
    // The verdict was checked as the history's; the size, with --no-ff.
    expect(checks.mock.calls[0]?.[0]).not.toHaveProperty('noFastForward')
    expect(checks.mock.calls.at(-1)?.[0]).toMatchObject({ noFastForward: true })
  })

  it('merges under a merge-commits-only policy instead of refusing the fast-forward', async () => {
    await render(2)
    expect(options()).toEqual(['merge(off)', 'no-ff', 'squash(off)'])
    expect((host.querySelector('#merge-method') as HTMLSelectElement).value).toBe('no-ff')
    expect(mergeButton()?.disabled).toBe(false)
    expect(host.textContent).not.toMatch(/does not allow this merge method/)
  })

  it('names the merge-commit option the same whether or not a fast-forward is possible (QW2-051)', async () => {
    const label = (value: string): string | undefined => [...host.querySelectorAll<HTMLOptionElement>('#merge-method option')].find((o) => o.value === value)?.textContent ?? undefined
    await render(0)
    expect(label('no-ff')).toBe('Create a merge commit')
    checks.mockReset()
    checks.mockImplementation(async () => ({ check: 'merge', conflictPaths: [], packEstimate: { bytes: 900, objectCount: 3 } }))
    act(() => root.unmount())
    root = createRoot(host)
    await act(async () =>
      root.render(
        <PullMerge repo={repo} home={homeAt(BASE)} pull={pullOf(false)} canMerge isMaintainer checkout="dg pr checkout …" onMerged={() => undefined} extras={{ deleteBranch: null, allowedMethods: 0 }} />,
      ),
    )
    await act(async () => undefined)
    expect(label('merge')).toBe('Create a merge commit')
    expect(label('no-ff')).toBeUndefined()
  })
})

describe('a source branch past the PR head (QW3-013)', () => {
  const mergeCheck = async (): Promise<{ check: string; conflictPaths: string[]; packEstimate: { bytes: number; objectCount: number } }> => ({ check: 'fast-forward', conflictPaths: [], packEstimate: { bytes: 900, objectCount: 3 } })
  const render = async (extras: import('./pull-merge').MergeExtras, onMerged: () => void = () => undefined): Promise<void> => {
    checks.mockReset()
    checks.mockImplementation(mergeCheck)
    await act(async () =>
      root.render(<PullMerge repo={repo} home={homeAt(BASE)} pull={pullOf(false)} canMerge isMaintainer checkout="dg pr checkout …" onMerged={onMerged} extras={{ deleteBranch: null, ...extras }} />),
    )
    await act(async () => undefined)
  }
  const submit = (): HTMLButtonElement => host.querySelector('[data-testid="merge-submit"]') as HTMLButtonElement

  it('keeps the merge disabled until the PR head is updated, and says why', async () => {
    await render({ branchAhead: { branch: 'feature', tip: 'dd'.repeat(20) } })
    expect(submit().disabled).toBe(true)
    expect(host.querySelector('[data-testid="merge-gate-reason"]')?.textContent).toBe(
      `feature is at ${'dd'.repeat(20).slice(0, 7)}, ahead of this PR's head ${HEAD.slice(0, 7)}. Update the PR head first, so the merge includes those commits.`,
    )
  })

  it('re-reads the branch on click and stops, merging nothing, when it moved since the page read it', async () => {
    const onMerged = vi.fn()
    const checkSourceBranch = vi.fn(async () => 'feature moved to ddddddd since this page read it')
    await render({ checkSourceBranch }, onMerged)
    expect(submit().disabled).toBe(false)
    await act(async () => submit().click())
    await act(async () => undefined)
    expect(checkSourceBranch).toHaveBeenCalledTimes(1)
    expect(onMerged).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Merge stopped: feature moved to ddddddd since this page read it')
  })

  it('tells the page once "Delete … after merging" deleted the branch (QW3-053)', async () => {
    const onBranchDeleted = vi.fn()
    const run = vi.fn(async () => undefined)
    await render({ deleteBranch: { label: 'feature', run }, onBranchDeleted, checkSourceBranch: async () => null })
    await act(async () => submit().click())
    await act(async () => undefined)
    expect(run).toHaveBeenCalledTimes(1)
    expect(onBranchDeleted).toHaveBeenCalledTimes(1)
  })
})

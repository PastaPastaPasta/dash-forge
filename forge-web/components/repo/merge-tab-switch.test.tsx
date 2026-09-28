// @vitest-environment jsdom
/**
 * A merge waiting for the merger's storage choice survives a tab switch: the PR page keeps the
 * merge box mounted (and on screen) on every tab while its merge runs, so the question can be
 * answered from anywhere, and the merge completes. Before, the box lived only on the
 * Conversation tab: switching tabs unmounted it and the waiting run could never finish.
 */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PullView, RepoRef } from '@/lib/repo'
import type { StoreOptions } from '@/lib/storage'
import type { RepoHome } from '@/lib/view'
import { PullMerge, useMergeSlot } from './pull-merge'

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
// No storage configured: Platform, and the merger unticks "Allow" so the run has to ask.
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: { profiles: [], policies: [] }, needsUnlock: false }) }))
const stored: number[] = []
vi.mock('@/lib/storage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/storage')>()
  return {
    ...real,
    policyForRepo: () => null,
    storeArtifact: async (_sdk: unknown, _auth: unknown, _repo: unknown, bytes: Uint8Array, opts: StoreOptions) => {
      if (!(await opts.confirmPlatform({ bytes: bytes.length, estimateCredits: 1_000_000, reason: 'No storage is configured.' }))) throw new real.PlatformDeclinedError()
      stored.push(bytes.length)
      return { packHash: 'h', sizeBytes: bytes.length, storage: 0, chunkCount: 1, uris: ['platform://x'], confirmed: ['platform'], failures: [] }
    },
  }
})
vi.mock('@/lib/merge/client', () => ({
  checkMergeInWorker: async () => ({ check: 'merge', conflictPaths: [] as string[], packEstimate: { bytes: 4000, objectCount: 4 } }),
  runMergeInWorker: vi.fn(),
}))
// The run: its upload step stores through the panel's real upload (which asks), then the rest lands.
vi.mock('@/lib/merge/runner', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/merge/runner')>()
  return {
    ...real,
    runMergeSteps: async (deps: import('@/lib/merge/runner').MergeRunDeps, from: import('@/lib/merge/runner').MergeRun, onStep: (e: { step: string; state: string }) => void) => {
      for (const s of ['fetch', 'merge', 'pack']) onStep({ step: s, state: 'done' })
      onStep({ step: 'upload', state: 'running' })
      await deps.upload!(new Uint8Array(4000), { packHash: 'p', objectCount: 4 })
      for (const s of real.MERGE_STEPS.slice(3)) onStep({ step: s.id, state: 'done' })
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

type Tab = 'conversation' | 'commits' | 'checks' | 'files'
let goTo: (t: Tab) => void = () => undefined

/** The PR page's part, as pull-content wires it: tabs, and the merge box in its slot. */
function Page(): JSX.Element {
  const [tab, setTab] = useState<Tab>('conversation')
  goTo = setTab
  const [merged, setMerged] = useState(false)
  const { slot, onRunning } = useMergeSlot(tab, false)
  return (
    <div>
      <div data-testid="tab">{tab}</div>
      {tab === 'conversation' ? <p>The conversation</p> : <p>The {tab} tab</p>}
      {slot === 'none' ? null : (
        <div hidden={slot === 'kept'} data-testid="merge-slot">
          <PullMerge repo={repo} home={homeAt(merged ? NEW_TIP : BASE)} pull={pullOf(merged)} canMerge={!merged} isMaintainer checkout="dg pr checkout 1" onMerged={() => setMerged(true)} extras={{ onRunning }} />
        </div>
      )}
    </div>
  )
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  stored.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const slot = (): HTMLElement | null => host.querySelector('[data-testid="merge-slot"]')
const question = (): Element | null => host.querySelector('[data-testid="storage-question"]')

describe('a merge waiting for the storage choice, across tabs', () => {
  it('stays answerable after a tab switch and back, and the merge completes', async () => {
    await act(async () => root.render(<Page />))
    await act(async () => undefined)
    // Untick "Allow storing on Platform": the run will ask when it gets to the upload.
    const allow = host.querySelector('[data-testid="allow-platform"]') as HTMLInputElement
    await act(async () => allow.click())
    expect(allow.checked).toBe(false)
    const merge = [...host.querySelectorAll('button')].find((b) => /merge/i.test(b.textContent ?? '') && !b.disabled)!
    await act(async () => merge.click())
    expect(question()).not.toBeNull()
    expect(host.querySelector('[data-step="upload"]')?.getAttribute('data-state')).toBe('waiting')

    // Away to Commits, then Checks: the waiting merge is still there, on screen.
    await act(async () => goTo('commits'))
    expect(host.textContent).toContain('The commits tab')
    expect(slot()?.hidden).toBe(false)
    expect(question()).not.toBeNull()
    await act(async () => goTo('checks'))
    expect(question()).not.toBeNull()

    // Back to the conversation, and answer there.
    await act(async () => goTo('conversation'))
    const sign = [...question()!.querySelectorAll('button')].find((b) => /sign & store/i.test(b.textContent ?? ''))!
    await act(async () => sign.click())
    await act(async () => undefined)

    // The pack was stored and the merge ran to the end.
    expect(stored).toEqual([4000])
    expect(host.querySelector('[data-step="event"]')?.getAttribute('data-state')).toBe('done')
    expect(host.querySelector('[data-testid="merge-done"]')?.textContent).toBe('Merged')
  })

  it('can be answered on the tab the merger switched to, and the outcome stays there', async () => {
    await act(async () => root.render(<Page />))
    await act(async () => undefined)
    await act(async () => (host.querySelector('[data-testid="allow-platform"]') as HTMLInputElement).click())
    const merge = [...host.querySelectorAll('button')].find((b) => /merge/i.test(b.textContent ?? '') && !b.disabled)!
    await act(async () => merge.click())
    await act(async () => goTo('files'))
    const sign = [...question()!.querySelectorAll('button')].find((b) => /sign & store/i.test(b.textContent ?? ''))!
    await act(async () => sign.click())
    await act(async () => undefined)
    expect(stored).toEqual([4000])
    // Finished on Files: the outcome is still on screen there.
    expect(slot()?.hidden).toBe(false)
    expect(host.querySelector('[data-testid="merge-done"]')?.textContent).toBe('Merged')
    // Moving on to another tab hides it (kept mounted); the conversation shows it again.
    await act(async () => goTo('commits'))
    expect(slot()?.hidden).toBe(true)
    await act(async () => goTo('conversation'))
    expect(slot()?.hidden).toBe(false)
    expect(host.querySelector('[data-testid="merge-done"]')?.textContent).toBe('Merged')
  })
})

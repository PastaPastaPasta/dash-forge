// @vitest-environment jsdom
/**
 * QW4-027: a merge commit needs the merger's commit name and email. With none set, the merge box
 * asks for them in place (as the suggestion batch and "Update branch" do), never by sending the
 * merger to Settings and away from the box; once saved, the merge button enables.
 */

import { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PullView, RepoRef } from '@/lib/repo'
import type { RepoHome } from '@/lib/view'
import { PullMerge } from './pull-merge'

const HEAD = 'aa'.repeat(20)
const BASE = 'bb'.repeat(20)
const reader = { readObject: vi.fn() }

type Prefs = { mergeName: string; mergeEmail: string; diffLayout: string }
const prefs: { value: Prefs; subs: Set<() => void> } = { value: { mergeName: '', mergeEmail: '', diffLayout: 'split' }, subs: new Set() }
function setPrefs(patch: Partial<Prefs>): void {
  prefs.value = { ...prefs.value, ...patch }
  for (const f of prefs.subs) f()
}

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet', status: { phase: 'ready' } }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'me' }, identity: 'me' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-prefs', () => ({
  usePrefs: () => {
    const value = useSyncExternalStore(
      (f) => {
        prefs.subs.add(f)
        return () => prefs.subs.delete(f)
      },
      () => prefs.value,
    )
    return [value, setPrefs]
  },
  useMinWidth: () => true,
}))
vi.mock('@/hooks/use-storage-config', () => ({ useStorageConfig: () => ({ config: { profiles: [], policies: [] }, usable: { profiles: [], policies: [] }, needsUnlock: false, sealed: false, error: null, storedSince: async () => false }) }))
vi.mock('@/lib/storage', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/storage')>()), policyForRepo: () => null }))
// The check: the two sides changed different files, so the merge makes a commit (authored).
vi.mock('@/lib/merge/client', () => ({
  checkMergeInWorker: async () => ({ check: 'merge', conflictPaths: [] as string[], packEstimate: { bytes: 4000, objectCount: 4 } }),
  runMergeInWorker: vi.fn(),
}))
vi.mock('@/components/repo/pull-diff', () => ({
  useComparisonSides: () => ({ sides: { base: reader, head: reader }, baseOnly: reader, sidesKey: 'k' }),
  pullBase: () => ({ baseRefName: 'refs/heads/main', baseTipOid: BASE, baseOidAtOpen: BASE }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { repoId: 'R', name: 'repo', visibility: 'public' } as unknown as RepoRef
const home = { repo, branches: [{ refName: 'refs/heads/main', state: { state: 'resolved', oid: BASE } }], config: { protectedPatterns: [] } } as unknown as RepoHome
const pull = {
  id: 'P',
  number: 1,
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
  setPrefs({ mergeName: '', mergeEmail: '' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll('button')]
const mergeButton = (): HTMLButtonElement | undefined => buttons().find((b) => /merge/i.test(b.textContent ?? '') && b.closest('[data-testid="merge-identity"]') === null)
function type(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the merge box with no commit name and email (QW4-027)', () => {
  it('sets them in place, and then the merge can start', async () => {
    await act(async () => root.render(<PullMerge repo={repo} home={home} pull={pull} canMerge isMaintainer checkout="dg pr checkout 1" onMerged={() => undefined} />))
    await act(async () => undefined)
    const ask = host.querySelector('[data-testid="merge-identity"]')
    expect(ask).not.toBeNull()
    expect(ask!.textContent).toContain('set them to merge')
    expect(mergeButton()?.disabled).toBe(true)
    await act(async () => buttons().find((b) => b.textContent === 'Set name and email')!.click())
    const form = host.querySelector<HTMLFormElement>('[data-testid="commit-identity-form"]')!
    const [name, email] = [...form.querySelectorAll('input')]
    await act(async () => type(name!, 'QA Owner'))
    await act(async () => type(email!, 'owner@example.invalid'))
    await act(async () => form.requestSubmit())
    expect(prefs.value).toMatchObject({ mergeName: 'QA Owner', mergeEmail: 'owner@example.invalid' })
    expect(host.querySelector('[data-testid="merge-identity"]')).toBeNull()
    expect(mergeButton()?.disabled).toBe(false)
  })
})

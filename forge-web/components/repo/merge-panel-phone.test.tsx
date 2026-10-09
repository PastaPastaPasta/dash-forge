// @vitest-environment jsdom
/**
 * Q5-B14: on a phone the merge box points to a desktop browser, but still says which branch rules
 * are unmet (code owner approvals included), above that pointer, so a maintainer knows what waits.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PullView, RepoRef } from '@/lib/repo'

let wide = false
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'me' }, identity: 'me', locked: false }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-prefs', () => ({ usePrefs: () => [{ mergeName: '', mergeEmail: '' }, () => undefined], useMinWidth: () => wide }))
vi.mock('@/components/repo/merge-upload', () => ({
  useMergeUpload: () => ({ upload: null, question: null, questionStep: 'upload', begin: () => undefined, choiceFor: () => null, storageNeedsUnlock: false }),
  StorageRow: () => null,
}))
// No merge check runs on a phone; any call would be a bug.
vi.mock('@/lib/merge/client', () => ({
  checkMergeInWorker: () => {
    throw new Error('no merge check on a phone')
  },
  runMergeInWorker: () => {
    throw new Error('no merge on a phone')
  },
}))

import { MergePanel } from './merge-panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { forge: { core: 'C', collab: 'C', community: 'C', group: 'G' }, repoId: 'R', ownerId: 'alice', name: 'demo', visibility: 'public' } as unknown as RepoRef
const pull = {
  id: 'P',
  number: 1,
  title: 'Change',
  author: 'bob',
  audience: 'public',
  sourceId: '',
  sourceRefName: 'refs/heads/feature',
  baseRefName: 'refs/heads/main',
  mergeBaseRefName: 'refs/heads/main',
  headOid: 'b'.repeat(40),
  headOnBase: false,
  createdAt: 0,
  state: { open: true, merged: false, draft: false },
} as unknown as PullView

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  wide = false
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(unmetRules: readonly string[]): void {
  act(() =>
    root.render(
      <MergePanel
        repo={repo}
        pull={pull}
        sides={null}
        baseOnly={{} as never}
        sidesKey="k"
        baseTipOid={'a'.repeat(40)}
        protectedPatterns={[]}
        canMerge
        isMaintainer
        checkout="dg pr checkout alice/demo 1"
        onMerged={() => undefined}
        unmetRules={unmetRules}
        canBypass
        recheckMembers={async () => null}
      />,
    ),
  )
}

describe('the merge box on a phone (Q5-B14)', () => {
  it('lists the unmet branch rules, code owners included, above "Use a desktop browser"', () => {
    render(['required approvals: 0 of 1', 'code owner approval: src/a.rs (@carol)'])
    expect(host.querySelector('[data-testid="merge-button-state"]')?.getAttribute('data-state')).toBe('mobile')
    const rules = host.querySelector('[data-testid="merge-rules-unmet"]')
    expect(rules?.textContent).toContain('code owner approval: src/a.rs (@carol)')
    expect(rules?.textContent).toContain('required approvals: 0 of 1')
    const pointer = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Use a desktop browser for this step')
    expect(pointer?.disabled).toBe(true)
    // The rules come first.
    expect(rules!.compareDocumentPosition(pointer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // A phone offers no bypass: that is the desktop merge's.
    expect(host.querySelector('[data-testid="merge-bypass"]')).toBeNull()
  })

  it('shows only the pointer when the rules are met', () => {
    render([])
    expect(host.querySelector('[data-testid="merge-rules-unmet"]')).toBeNull()
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Use a desktop browser for this step')).toBe(true)
  })
})

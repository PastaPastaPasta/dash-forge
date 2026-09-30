// @vitest-environment jsdom
/**
 * RC1 R-08 on the Checks tab: a required check pinned to a source names it ("build · from ci"),
 * a run by any other reporter is marked "not from the required source" and not counted, and a
 * required check nothing reported yet is listed as expected.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { expectedChecks, newestCheckRuns, requiredSources, summarizeChecks } from '@/lib/repo/checks'
import { ChecksTab } from './pull-tabs'

vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span data-testid="author">{identityId}</span> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const HEAD = 'ab'.repeat(20)
const run = (id: string, name: string, owner: string, at: number) => ({ $id: id, $ownerId: owner, $createdAt: at, name, status: 'completed', conclusion: 'success' })

describe('the Checks tab with pinned sources', () => {
  it('names each pinned source and marks a run from anyone else', () => {
    const policy = { requiredChecks: ['build', 'lint', 'test'], requiredCheckSources: ['ci', 'ci', 'm'] }
    const runs = newestCheckRuns([run('1', 'build', 'ci', 1), run('2', 'lint', 'w', 2), run('3', 'other', 'w', 3)], () => true, requiredSources(policy))
    act(() =>
      root.render(<ChecksTab runs={runs} summary={summarizeChecks(runs, true)} headOid={HEAD} error={null} onRetry={() => undefined} expected={expectedChecks(runs, policy)} />),
    )
    const row = (name: string) => host.querySelector(`[data-name="${name}"]`)!
    expect(row('build').querySelector('[data-testid="check-source"]')!.textContent).toBe('· from ci')
    expect(row('build').querySelector('[data-testid="check-off-source"]')).toBeNull()
    expect(row('lint').querySelector('[data-testid="check-source"]')!.textContent).toBe('· from ci')
    expect(row('lint').querySelector('[data-testid="check-off-source"]')!.textContent).toContain('not from the required source')
    // An unpinned check names no source.
    expect(row('other').querySelector('[data-testid="check-source"]')).toBeNull()
    const expected = host.querySelector('[data-testid="check-expected"]')!
    expect(expected.getAttribute('data-name')).toBe('test')
    expect(expected.textContent).toContain('from m')
    expect(expected.textContent).toContain('Expected')
    expect(host.textContent).toContain('2 passed (1 not from the required source)')
  })

  it('lists expected checks even before any run is reported', () => {
    const policy = { requiredChecks: ['build'] }
    act(() => root.render(<ChecksTab runs={[]} summary={summarizeChecks([], true)} headOid={HEAD} error={null} onRetry={() => undefined} expected={expectedChecks([], policy)} />))
    expect(host.querySelector('[data-testid="check-expected"]')!.getAttribute('data-name')).toBe('build')
    expect(host.querySelector('[data-testid="check-source"]')).toBeNull()
  })
})

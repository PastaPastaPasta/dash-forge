// @vitest-environment jsdom
/**
 * CI re-runs on the Checks tab (event kind 26): a maintainer or writer gets "Re-run" on each
 * completed forge-runner check and "Re-run all checks"; a check from elsewhere (a GitHub Actions
 * mirror), a run still in progress and a viewer who may not ask get none; a request no newer run
 * answers is shown as requested, to everyone.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { newestCheckRuns, summarizeChecks } from '@/lib/repo/checks'
import { pendingReruns, type RerunRequest } from '@/lib/rules/ci-rerun'
import { ChecksTab, type RerunControls } from './pull-tabs'

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
const NOW = Date.now()
/** `ago` ms before now. */
const at = (ago: number): number => NOW - ago
const doc = (id: string, name: string, at: number, extra: Record<string, unknown> = {}) => ({
  $id: id,
  $ownerId: 'runner',
  $createdAt: at,
  name,
  status: 'completed',
  conclusion: 'failure',
  externalId: `forge-runner:${id}`,
  ...extra,
})
const runs = newestCheckRuns(
  [
    doc('1', 'CI / build (pull_request)', at(60_000)),
    doc('2', 'CI / test', at(50_000)),
    doc('3', 'gh / lint', at(40_000), { externalId: '123456' }),
    doc('4', 'CI / slow', at(30_000), { status: 'in_progress', conclusion: undefined }),
  ],
  () => true,
)
const req = (id: string, check: string | null, at: number): RerunRequest => ({ id, targetId: 'pr', number: 4, sha: HEAD, check, requester: 'w', createdAt: at })

function render(rerun: Partial<RerunControls> & { onRerun?: (c: string | null) => void }): void {
  const controls: RerunControls = { runners: new Set(['runner']), pending: new Map(), canRequest: true, onRerun: () => undefined, ...rerun }
  act(() => root.render(<ChecksTab runs={runs} summary={summarizeChecks(runs, true)} headOid={HEAD} error={null} onRetry={() => undefined} rerun={controls} />))
}
const row = (name: string) => host.querySelector(`[data-name="${name}"]`)!

describe('CI re-runs on the Checks tab', () => {
  it('offers Re-run on completed forge-runner checks only, and Re-run all checks', () => {
    const asked: (string | null)[] = []
    render({ onRerun: (c) => asked.push(c) })
    expect(row('CI / build (pull_request)').querySelector('[data-testid="check-rerun"]')).not.toBeNull()
    expect(row('CI / test').querySelector('[data-testid="check-rerun"]')!.getAttribute('aria-label')).toBe('Re-run CI / test')
    expect(row('gh / lint').querySelector('[data-testid="check-rerun"]'), 'a mirrored check is re-run where it ran').toBeNull()
    expect(row('CI / slow').querySelector('[data-testid="check-rerun"]'), 'not before it completes').toBeNull()
    act(() => (row('CI / test').querySelector('[data-testid="check-rerun"]') as HTMLButtonElement).click())
    act(() => (host.querySelector('[data-testid="checks-rerun-all"]') as HTMLButtonElement).click())
    expect(asked).toEqual(['CI / test', null])
  })

  it('offers nothing to a viewer who may not ask', () => {
    render({ canRequest: false })
    expect(host.querySelector('[data-testid="check-rerun"]')).toBeNull()
    expect(host.querySelector('[data-testid="checks-rerun-all"]')).toBeNull()
  })

  it('shows a request no newer run answers as requested, to everyone', () => {
    const pending = pendingReruns([req('e1', 'CI / test', at(1_000)), req('e2', 'CI / build (pull_request)', at(90_000))], runs, HEAD)
    expect([...pending.keys()]).toEqual(['CI / test'])
    render({ pending, canRequest: false })
    expect(row('CI / test').querySelector('[data-testid="check-rerun-pending"]')!.textContent).toContain('Re-run requested')
    expect(row('CI / build (pull_request)').querySelector('[data-testid="check-rerun-pending"]'), 'answered by a newer run').toBeNull()
  })

  it('a pending request for every check replaces every Re-run', () => {
    render({ pending: pendingReruns([req('e1', null, at(1_000))], runs, HEAD) })
    expect(host.querySelector('[data-testid="checks-rerun-all-pending"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="checks-rerun-all"]')).toBeNull()
    expect(host.querySelector('[data-testid="check-rerun"]')).toBeNull()
  })

  it('a request no run answered in 10 minutes offers Re-run again, saying so', () => {
    render({ pending: new Map([['CI / test', req('e1', 'CI / test', at(11 * 60_000))]]) })
    expect(row('CI / test').querySelector('[data-testid="check-rerun-pending"]')!.textContent).toContain('no run yet')
    expect(row('CI / test').querySelector('[data-testid="check-rerun"]')).not.toBeNull()
  })

  it('a run stuck in progress for hours is offered again', () => {
    const stuck = newestCheckRuns([doc('8', 'CI / hung', at(3 * 60 * 60_000), { status: 'in_progress', conclusion: undefined })], () => true)
    act(() =>
      root.render(
        <ChecksTab runs={stuck} summary={summarizeChecks(stuck, true)} headOid={HEAD} error={null} onRetry={() => undefined} rerun={{ runners: new Set(['runner']), pending: new Map(), canRequest: true, onRerun: () => undefined }} />,
      ),
    )
    expect(host.querySelector('[data-testid="check-rerun"]')).not.toBeNull()
  })

  it('on a private repository (no run ids), an enrolled runner’s runs are offered', () => {
    const priv = newestCheckRuns([doc('9', 'CI / test', 1, { externalId: undefined })], () => true)
    act(() =>
      root.render(
        <ChecksTab runs={priv} summary={summarizeChecks(priv, true)} headOid={HEAD} error={null} onRetry={() => undefined} rerun={{ runners: new Set(['runner']), pending: new Map(), canRequest: true, onRerun: () => undefined }} />,
      ),
    )
    expect(host.querySelector('[data-testid="check-rerun"]')).not.toBeNull()
  })
})

describe('pendingReruns', () => {
  it('keeps the newest request per check on the head until a newer run answers it', () => {
    const other = 'cd'.repeat(20)
    const p = pendingReruns([req('a', 'x', 1), req('b', 'x', 30), { ...req('c', 'y', 40), sha: other }], [{ name: 'x', createdAt: 20 }], HEAD)
    expect(p.get('x')?.id).toBe('b')
    expect(p.has('y'), 'another commit').toBe(false)
    expect(pendingReruns([req('d', null, 5)], [{ name: 'z', createdAt: 6 }], HEAD).size, 'any newer run answers every check').toBe(0)
  })
})

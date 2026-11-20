// @vitest-environment jsdom
/**
 * A repo page while it resolves names the step it is on ("Finding … on Dash Platform") over a
 * skeleton, and once it has waited past SLOW_AFTER_MS says the network is slow and offers Try
 * again. LoadingBlock does the same for whole-view reads.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/repo/repo-shell-header', () => ({ RepoShellHeader: () => <h1>shell</h1> }))

import { RepoLoading, currentStep, stepLabel } from './repo-loading'
import { ListLoading, LoadingBlock, SLOW_AFTER_MS } from '@/components/ui/states'
import type { SdkStatus } from '@/lib/sdk'

const addr = { owner: 'pasta', name: 'pocket-wallet' }
const connected = { phase: 'ready' } as unknown as SdkStatus

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.useRealTimers()
})

describe('RepoLoading', () => {
  it('names each step of the read', () => {
    expect(stepLabel('connect', addr)).toBe('Connecting to Dash Platform')
    expect(stepLabel('owner', addr)).toBe('Looking up pasta')
    expect(stepLabel('repo', addr)).toBe('Finding pocket-wallet on Dash Platform')
    expect(stepLabel('refs', addr)).toBe('Loading branches and settings')
    expect(currentStep(false, 'repo')).toBe('connect')
    expect(currentStep(true, undefined)).toBe('owner')
    expect(currentStep(true, 'refs')).toBe('refs')
  })

  it('marks the steps done before the current one, and shows a skeleton', () => {
    act(() => root.render(<RepoLoading addr={addr} ready stage="repo" sdkStatus={connected} onRetry={() => undefined} />))
    const loading = el.querySelector('[data-testid=repo-loading]')!
    expect(loading.getAttribute('data-step')).toBe('repo')
    expect(el.textContent!.match(/\(done\)/g)).toHaveLength(2)
    expect(el.querySelector('[aria-current=step]')!.textContent).toContain('Finding pocket-wallet on Dash Platform')
    expect(el.querySelector('[data-testid=list-skeleton]')).not.toBeNull()
  })

  it('counts the seconds and offers Try again once slow', () => {
    const retry = vi.fn()
    act(() => root.render(<RepoLoading addr={addr} ready stage="refs" sdkStatus={connected} onRetry={retry} />))
    expect(el.querySelector('[data-testid=repo-loading-slow]')).toBeNull()
    act(() => vi.advanceTimersByTime(3_000))
    expect(el.querySelector('[data-testid=repo-loading-elapsed]')!.textContent).toBe('3 s')
    act(() => vi.advanceTimersByTime(SLOW_AFTER_MS))
    expect(el.querySelector('[data-testid=repo-loading-slow]')!.textContent).toMatch(/longer than usual/)
    act(() => (el.querySelector('[data-testid=repo-loading-slow] button') as HTMLButtonElement).click())
    expect(retry).toHaveBeenCalledTimes(1)
    // The clock restarts with the new attempt.
    expect(el.querySelector('[data-testid=repo-loading-slow]')).toBeNull()
    expect(el.querySelector('[data-testid=repo-loading-elapsed]')!.textContent).toBe('0 s')
  })

  it('offers no Try again while the SDK still connects', () => {
    act(() => root.render(<RepoLoading addr={addr} ready={false} stage={undefined} sdkStatus={{ phase: 'connecting' } as unknown as SdkStatus} onRetry={() => undefined} />))
    act(() => vi.advanceTimersByTime(SLOW_AFTER_MS))
    expect(el.querySelector('[data-testid=repo-loading-slow]')).not.toBeNull()
    expect(el.querySelector('[data-testid=repo-loading-slow] button')).toBeNull()
  })
})

describe('LoadingBlock and ListLoading', () => {
  it('say the network is slow past SLOW_AFTER_MS, with Try again when given', () => {
    const retry = vi.fn()
    act(() =>
      root.render(
        <>
          <LoadingBlock label="Loading issue" onRetry={retry} />
          <ListLoading label="Reading issues" />
        </>,
      ),
    )
    expect(el.querySelector('[data-testid=loading-slow]')).toBeNull()
    act(() => vi.advanceTimersByTime(SLOW_AFTER_MS))
    const notes = el.querySelectorAll('[data-testid=loading-slow]')
    expect(notes).toHaveLength(2)
    expect(notes[0]!.querySelector('button')).not.toBeNull()
    expect(notes[1]!.querySelector('button')).toBeNull()
    act(() => notes[0]!.querySelector('button')!.click())
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

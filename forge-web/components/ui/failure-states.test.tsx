// @vitest-environment jsdom
/**
 * The failure states name what failed (QW-056, QW-057): a proof that failed reads as a
 * verification failure with the verifier's hashes behind Details, and a connect that failed on
 * the quorum key service does not say Platform is down.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-ui-store', () => ({ useUiStore: (pick: (s: { loginOpen: boolean }) => unknown) => pick({ loginOpen: false }) }))

const { ErrorState } = await import('./states')
const { UnreachableBanner } = await import('./platform-status')

const GROVEDB =
  'grovedb: invalid proof: V1 mismatch in lower layer hash, expected 0a77b19486fb1d5cadbb2bb3f042ccc49cd3defcc8d0d2bafd57353446342d43, got c071e547e3f178bdb4f8b46aae0dde36368d766b5d77e0c3dbe26a4cbc7c90cf'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

/** The visible text: everything outside the collapsed Details. */
function visibleText(): string {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('details').forEach((d) => d.remove())
  return clone.textContent ?? ''
}

describe('ErrorState on a failed proof (QW-057)', () => {
  it('says verification failed, keeps the hashes behind Details, and offers Try again', () => {
    const retry = vi.fn()
    act(() => root.render(<ErrorState message={GROVEDB} onRetry={retry} />))
    expect(el.querySelector('[data-testid="read-proof-failed"]')).not.toBeNull()
    expect(el.querySelector('[role="alert"]')!.textContent).toMatch(/^Verification failed/)
    expect(visibleText()).not.toMatch(/grovedb|0a77b19486|That read did not land/i)
    expect(el.querySelector('details')!.textContent).toContain(GROVEDB)
    act(() => el.querySelector<HTMLButtonElement>('button')!.click())
    expect(retry).toHaveBeenCalledOnce()
  })

  it('classifies by the thrown value too', () => {
    act(() => root.render(<ErrorState message="Couldn't read the repo" cause={new Error(GROVEDB)} />))
    expect(el.querySelector('[data-testid="read-proof-failed"]')).not.toBeNull()
  })

  it('leaves any other error as it was', () => {
    act(() => root.render(<ErrorState message="repo config is malformed" />))
    expect(el.querySelector('[data-testid="read-proof-failed"]')).toBeNull()
    expect(el.textContent).toContain('That read did not land')
    expect(el.textContent).toContain('repo config is malformed')
  })
})

describe('UnreachableBanner (QW-056)', () => {
  const status = (message: string) => ({ phase: 'error' as const, message, retryAt: null })

  it('names the quorum key service when the key prefetch failed', () => {
    act(() => root.render(<UnreachableBanner status={status('Failed to prefetch quorums: HTTP request error: error sending request')} onRetry={() => undefined} />))
    const alert = el.querySelector('[role="alert"]')!.textContent ?? ''
    expect(alert).toContain("Can't reach the quorum key service right now")
    expect(alert).not.toContain("Can't reach Dash Platform")
  })

  it('keeps the Platform wording for a Platform outage', () => {
    act(() => root.render(<UnreachableBanner status={status('Connecting to Platform timed out after 45 s')} onRetry={() => undefined} />))
    expect(el.querySelector('[role="alert"]')!.textContent).toContain("Can't reach Dash Platform right now")
  })
})

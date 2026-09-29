// @vitest-environment jsdom
/**
 * Blame's run state in React's StrictMode (F-5): the mount-time effect runs twice, and the first
 * run is aborted by its cleanup. That aborted run must settle into nothing: before the fix it set
 * "Blame stopped" after the second run had started, so the page said it was cancelled until the
 * second run's first progress (or for good, when the second run finished first).
 */

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('next/navigation', () => ({ usePathname: () => '/repo/blame/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: () => undefined, push: () => undefined }) }))

/** Each call's deferred result; the test settles them in the order it wants. */
const calls: { signal: AbortSignal; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
vi.mock('@/lib/view/blame', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/view/blame')>()
  return {
    ...real,
    blameFile: (_r: unknown, _t: string, _p: string, { signal }: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        calls.push({ signal, resolve, reject })
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
  }
})

import { BlameBody } from './blame-content'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

describe('BlameBody in StrictMode', () => {
  it('never shows "Blame stopped" for the run StrictMode aborted', async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <BlameBody reader={{} as never} tipOid={'a'.repeat(40)} path="f" addr={{ owner: 'o', name: 'n' }} repo={{ repoId: 'r' } as never} />
        </StrictMode>,
      )
    })
    // StrictMode ran the effect twice: the first run aborted, the second still going.
    expect(calls).toHaveLength(2)
    expect(calls[0]?.signal.aborted).toBe(true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(el.textContent).not.toContain('Blame stopped')
    expect(el.querySelector('[data-testid="blame-progress"]')).not.toBeNull()
  })

  it('Cancel still stops the current run and says so', async () => {
    await act(async () => {
      root.render(<BlameBody reader={{} as never} tipOid={'a'.repeat(40)} path="f" addr={{ owner: 'o', name: 'n' }} repo={{ repoId: 'r' } as never} />)
    })
    await act(async () => {
      ;(el.querySelector('[data-testid="blame-cancel"]') as HTMLButtonElement).click()
    })
    expect(el.textContent).toContain('Blame stopped')
  })

  it('Cancel after some versions keeps the partial table, marked stopped, with Run again (L-23)', async () => {
    const { BlameStoppedError } = await import('@/lib/view/blame')
    await act(async () => {
      root.render(<BlameBody reader={{} as never} tipOid={'a'.repeat(40)} path="f" addr={{ owner: 'o', name: 'n' }} />)
    })
    const c = 'c'.repeat(40)
    const partial = {
      lines: ['one\n', 'two\n'],
      hunks: [{ start: 1, count: 2, oid: c }],
      commits: new Map([[c, { oid: c, subject: 'subject', author: { name: 'a', when: 0 } }]]),
      partial: true,
      approximate: false,
      versions: 3,
      renames: [],
      unfollowedRename: null,
    }
    // The run answers its abort with what it had (the real blameFile does); rejected before the
    // click, so the mock's own AbortError on the signal comes too late to count.
    await act(async () => {
      const run = calls[0]!
      run.reject(new BlameStoppedError(partial as never))
      ;(el.querySelector('[data-testid="blame-cancel"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(el.querySelector('[data-testid="blame-table"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="blame-stopped"]')?.textContent).toContain('Run again')
    expect(el.textContent).not.toContain('Stopped before')
  })
})

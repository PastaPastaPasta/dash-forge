// @vitest-environment jsdom
/**
 * The bulk bar: members select rows, confirm one batch with its cost, watch each item, and retry
 * only what failed. Outsiders get no controls.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setTargetState = vi.fn()
const setLabel = vi.fn()
let role: string | null = 'maintainer'
vi.mock('@/lib/repo', async (orig) => ({ ...(await orig<typeof import('@/lib/repo')>()), setTargetState: (...a: unknown[]) => setTargetState(...a), setLabel: (...a: unknown[]) => setLabel(...a) }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'sakura' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'me', signer: {} }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/hooks/use-repo-chrome', () => ({ useViewerRole: () => ({ role, known: true, failed: false, retry: () => undefined }) }))

import { BulkBar, BulkRowCheckbox, useBulkAllowed, useBulkSelection } from './bulk-actions'
import type { BulkRow } from '@/lib/view/bulk'
import type { RepoHome } from '@/lib/view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  setTargetState.mockReset()
  setLabel.mockReset()
  role = 'maintainer'
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const home = { repo: { repoId: 'r', visibility: 'public', forge: {} }, config: null } as unknown as RepoHome
const ROWS: BulkRow[] = [1, 2, 3].map((n) => ({ id: `id${n}`, number: n, title: `Issue ${n}`, author: 'a', open: true, merged: false, labels: [] }))

function List({ onWritten = () => undefined }: { onWritten?: () => void }): JSX.Element {
  const allowed = useBulkAllowed(home)
  const sel = useBulkSelection(ROWS)
  return (
    <div>
      {allowed ? <BulkBar kind="issue" home={home} rows={ROWS} selection={sel} labels={[]} onWritten={onWritten} /> : null}
      <ul>
        {ROWS.map((r) => (
          <li key={r.id}>{allowed ? <BulkRowCheckbox kind="issue" number={r.number} checked={sel.selected.has(r.id)} onChange={(on) => sel.toggle(r.id, on)} /> : null}</li>
        ))}
      </ul>
    </div>
  )
}

const q = (sel: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(sel)
  if (!el) throw new Error(`no ${sel}`)
  return el
}
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => el.click())
}
const button = (text: string): HTMLElement => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === text)
  if (!b) throw new Error(`no button ${text}`)
  return b
}

describe('bulk actions', () => {
  it('shows no checkboxes to a reader or an outsider', async () => {
    role = 'reader'
    await act(async () => root.render(<List />))
    expect(host.querySelector('[data-testid="bulk-select-row"]')).toBeNull()
    expect(host.querySelector('[data-testid="bulk-bar"]')).toBeNull()
    role = null
    await act(async () => root.render(<List />))
    expect(host.querySelector('[data-testid="bulk-select-row"]')).toBeNull()
  })

  it('closes the selected issues in one batch, reports a failure, and retries only it', async () => {
    const onWritten = vi.fn()
    await act(async () => root.render(<List onWritten={onWritten} />))
    const boxes = host.querySelectorAll<HTMLInputElement>('[data-testid="bulk-select-row"]')
    expect(boxes[0]?.getAttribute('aria-label')).toBe('Select issue #1')
    await click(q('[data-testid="bulk-select-all"]'))
    expect(host.textContent).toContain('3 selected')

    await click(q('[data-testid="bulk-close"]'))
    await click(button('Close as not planned'))
    expect(document.body.textContent).toContain('Close 3 issues as not planned')

    let calls = 0
    setTargetState.mockImplementation(async (_s: unknown, _a: unknown, _r: unknown, input: { target: { number: number }; intent: string }) => {
      calls += 1
      if (input.target.number === 2 && calls === 2) throw new Error('Platform refused it')
      return { documentId: 'd' }
    })
    await click(q('[data-testid="bulk-confirm"]'))
    expect(q('[data-testid="bulk-summary"]').textContent).toBe("2 of 3 done. 1 didn't go through.")
    expect(document.body.textContent).toContain('Platform refused it')
    expect(setTargetState.mock.calls[0]?.[3]).toMatchObject({ action: 'close', closed: { reason: 'not_planned', duplicateOf: null } })

    await click(q('[data-testid="bulk-retry"]'))
    expect(setTargetState).toHaveBeenCalledTimes(4)
    // The retry signs the same item under the same intent: an attempt that landed is not repeated.
    expect(setTargetState.mock.calls[3]?.[3].intent).toBe(setTargetState.mock.calls[1]?.[3].intent)
    expect(q('[data-testid="bulk-summary"]').textContent).toBe('Closed: 3 issues.')
    await click(q('[data-testid="bulk-done"]'))
    expect(onWritten).toHaveBeenCalledTimes(1)
  })
})

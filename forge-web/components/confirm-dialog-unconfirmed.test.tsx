// @vitest-environment jsdom
/**
 * A write sent but not yet seen (`UnconfirmedWriteError`): a calm note, not an error; the
 * button reads "Check again" and reruns the same action (same intent), and the dialog checks
 * again by itself. The title the action was confirmed with stays while it runs.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: null, balance: '0', keyLimits: null }) }))
vi.mock('@/hooks/use-ui-store', () => ({ useUiStore: (pick: (s: { openTopUp: () => void }) => unknown) => pick({ openTopUp: () => undefined }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => (e as Error).message, disabledReason: null }) }))
vi.mock('@/components/ui/cost-preview', () => ({ CostPreview: () => <span data-testid="cost-preview" /> }))

import { UnconfirmedWriteError } from '@/lib/sdk'
import { ConfirmDialog, RECHECK_MS } from './confirm-dialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const button = (label: string): HTMLButtonElement | undefined => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

describe('an unconfirmed write', () => {
  it('says it was sent, offers Check again with the same intent, and checks again by itself', async () => {
    const intents: string[] = []
    let landed = false
    const onConfirm = vi.fn(async (intent: string) => {
      intents.push(intent)
      if (!landed) throw new UnconfirmedWriteError('DOC')
    })
    act(() => root.render(<ConfirmDialog open onClose={() => undefined} title="Close issue #1" cost={null} confirmLabel="Close issue" onConfirm={onConfirm} />))
    act(() => button('Close issue')!.click())
    await flush()

    expect(document.querySelector('[data-testid="write-unconfirmed"]')?.textContent).toMatch(/Sent, not yet visible/)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(button('Check again')).toBeDefined()
    expect(button('Close')).toBeDefined()

    act(() => button('Check again')!.click())
    await flush()
    expect(onConfirm).toHaveBeenCalledTimes(2)

    landed = true
    await act(async () => {
      vi.advanceTimersByTime(RECHECK_MS)
    })
    await flush()
    expect(onConfirm).toHaveBeenCalledTimes(3)
    expect(new Set(intents).size).toBe(1)
    expect(document.querySelector('[data-testid="write-unconfirmed"]')).toBeNull()
    expect(button('Done')).toBeDefined()
  })

  it('keeps the confirmed title while the write runs, whatever the page renders meanwhile', async () => {
    let finish: () => void = () => undefined
    const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const render = (title: string, label: string): void =>
      act(() => root.render(<ConfirmDialog open onClose={() => undefined} title={title} cost={null} confirmLabel={label} onConfirm={onConfirm} />))
    render('Close issue #1', 'Close issue')
    act(() => button('Close issue')!.click())
    await flush()
    expect(document.querySelector('[data-testid="write-progress"]')).not.toBeNull()
    render('Reopen issue #1', 'Reopen issue')
    expect(document.body.textContent).toContain('Close issue #1')
    expect(document.body.textContent).not.toContain('Reopen issue #1')
    finish()
    await flush()
    expect(document.body.textContent).toContain('Close issue #1')
  })

  it('rechecks the action it was confirmed with, even after the page flipped under it', async () => {
    const asked: string[] = []
    const make = (what: string) => vi.fn(async () => {
      asked.push(what)
      throw new UnconfirmedWriteError('DOC')
    })
    const render = (title: string, label: string, onConfirm: (i: string) => Promise<void>): void =>
      act(() => root.render(<ConfirmDialog open onClose={() => undefined} title={title} cost={null} confirmLabel={label} onConfirm={onConfirm} />))
    render('Close issue #1', 'Close issue', make('close'))
    act(() => button('Close issue')!.click())
    await flush()
    render('Reopen issue #1', 'Reopen issue', make('reopen'))
    act(() => button('Check again')!.click())
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(RECHECK_MS)
    })
    await flush()
    expect(asked).toEqual(['close', 'close', 'close'])
    expect(document.body.textContent).toContain('Close issue #1')
  })

  it('stops checking by itself after a few tries, and never while the write is blocked', async () => {
    const onConfirm = vi.fn(async () => {
      throw new UnconfirmedWriteError('DOC')
    })
    const render = (blocked?: string): void =>
      act(() => root.render(<ConfirmDialog open onClose={() => undefined} title="Save" cost={null} confirmLabel="Save" onConfirm={onConfirm} blocked={blocked} />))
    render()
    act(() => button('Save')!.click())
    await flush()
    render('Unlock this tab first')
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(RECHECK_MS)
      })
      await flush()
    }
    expect(onConfirm).toHaveBeenCalledTimes(1)
    render()
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        vi.advanceTimersByTime(RECHECK_MS)
      })
      await flush()
    }
    expect(onConfirm).toHaveBeenCalledTimes(4)
    expect(document.body.textContent).toContain('Still not visible.')
  })

  it('after an ordinary error, a retry runs what the dialog shows now (an edited field)', async () => {
    const asked: string[] = []
    const make = (name: string) => vi.fn(async () => {
      asked.push(name)
      if (name === 'Roadmap') throw new Error('refused')
    })
    const render = (name: string): void =>
      act(() => root.render(<ConfirmDialog open onClose={() => undefined} title={`New board ${name}`} cost={null} confirmLabel="Create" onConfirm={make(name)} />))
    render('Roadmap')
    act(() => button('Create')!.click())
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('refused')
    render('Roadmap 2')
    expect(document.body.textContent).toContain('New board Roadmap 2')
    act(() => button('Create')!.click())
    await flush()
    expect(asked).toEqual(['Roadmap', 'Roadmap 2'])
  })

  it('disables its fields while a write is sent but not yet seen', async () => {
    const onConfirm = vi.fn(async () => {
      throw new UnconfirmedWriteError('DOC')
    })
    act(() => root.render(
      <ConfirmDialog open onClose={() => undefined} title="New board" cost={null} confirmLabel="Create" onConfirm={onConfirm}>
        <input aria-label="Name" />
      </ConfirmDialog>,
    ))
    const field = (): HTMLInputElement => document.querySelector('input[aria-label="Name"]')!
    expect(field().matches(':disabled')).toBe(false)
    act(() => button('Create')!.click())
    await flush()
    expect(field().matches(':disabled')).toBe(true)
  })

  it('an empty fieldset (no fields, or fields that render nothing) leaves no gap above what follows', () => {
    const Nothing = (): null => null
    act(() => root.render(
      <ConfirmDialog open onClose={() => undefined} title="Remove" cost={null} confirmLabel="Remove" onConfirm={async () => undefined}>
        {[null, <Nothing key="n" />]}
      </ConfirmDialog>,
    ))
    const fieldset = document.querySelector('fieldset')!
    expect(fieldset.childNodes.length).toBe(0)
    expect(fieldset.matches(':empty')).toBe(true)
    expect(fieldset.className).toContain('empty:hidden')
    expect(document.querySelector('[role="status"]')!.className).toContain('empty:absolute')
  })
})

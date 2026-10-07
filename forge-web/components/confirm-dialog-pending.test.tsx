// @vitest-environment jsdom
/**
 * A confirm whose cost is not known yet (`cost="pending"`, the Turn on sheet while it reads the
 * members): no cost and no "This action is free" line, and Confirm waits.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'alice', balance: '0', keyLimits: null }) }))
vi.mock('@/hooks/use-ui-store', () => ({ useUiStore: (pick: (s: { openTopUp: () => void }) => unknown) => pick({ openTopUp: () => undefined }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
vi.mock('@/components/ui/cost-preview', () => ({ CostPreview: () => <span data-testid="cost-preview" /> }))

import { ConfirmDialog } from './confirm-dialog'

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

describe('a confirm with its cost still pending', () => {
  it('shows no cost, never says it is free, and keeps Confirm disabled', () => {
    const onConfirm = vi.fn(async () => undefined)
    act(() => root.render(<ConfirmDialog open onClose={() => undefined} title="Turn on members-only content?" cost="pending" confirmLabel="Turn on" onConfirm={onConfirm} />))
    expect(document.body.textContent).not.toContain('This action is free')
    expect(document.querySelector('[data-testid="cost-preview"]')).toBeNull()
    const turnOn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Turn on')!
    expect(turnOn.disabled).toBe(true)
    act(() => turnOn.click())
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

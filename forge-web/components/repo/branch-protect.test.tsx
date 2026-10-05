// @vitest-environment jsdom
/**
 * QW-072: after a successful Protect, the pattern left the field; it stayed there under a red
 * "main is already protected" (the list now holds it, so the field re-read as a duplicate).
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoHome } from '@/lib/view'

const { update } = vi.hoisted(() => ({ update: vi.fn() }))
vi.mock('@/lib/repo', async (orig) => ({
  ...(await orig<typeof import('@/lib/repo')>()),
  updateConfig: update,
  readConfig: async () => ({ protectedPatterns: ['refs/heads/main'] }),
  changeHolds: () => true,
}))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'devnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ signer: { identityId: 'M' }, identity: 'M' }) }))
vi.mock('@/hooks/use-write-guard', () => ({ useWriteGuard: () => ({ check: () => true, failed: (e: unknown) => String(e), disabledReason: null }) }))
// The confirm signs at once: what matters is what the section does once the write holds.
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({ open, onConfirm, confirmLabel }: { open: boolean; onConfirm: (i: string) => Promise<void>; confirmLabel: string }) =>
    open ? (
      <button type="button" data-testid="confirm" onClick={() => void onConfirm('intent')}>
        {confirmLabel}
      </button>
    ) : null,
}))

import { BranchSettings } from './repo-settings-sections'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const home = {
  repo: { repoId: 'R', name: 'r', ownerId: 'O', visibility: 'public', forge: { core: 'C', collab: 'L', community: 'M' } },
  branches: [{ refName: 'refs/heads/main', state: { state: 'resolved', oid: 'a'.repeat(40), createdAt: 1 } }],
  tags: [],
  config: null,
  // Created just now: its missing config is still on its way, so no protection suggestion.
  v2: { createdAt: Date.now(), forkOf: null },
} as unknown as RepoHome

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  update.mockReset()
  update.mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Protect a branch', () => {
  it('clears the field once the pattern is protected', async () => {
    act(() => root.render(<BranchSettings home={home} maintainer onSaved={() => undefined} />))
    const input = host.querySelector<HTMLInputElement>('#protect-pattern')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'main')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const protect = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Protect')!
    act(() => protect.click())
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="confirm"]')!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(update).toHaveBeenCalledOnce()
    expect(host.querySelector<HTMLInputElement>('#protect-pattern')!.value).toBe('')
    expect(host.textContent).not.toMatch(/already protected/)
  })
})

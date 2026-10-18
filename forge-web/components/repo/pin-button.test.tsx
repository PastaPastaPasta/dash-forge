// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRef } from '@/lib/repo/contract'

const state = vi.hoisted(() => ({ identity: 'me' as string | null, start: vi.fn(), cancel: vi.fn(), requiresConsent: false, profile: true }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: state.identity }) }))
vi.mock('@/hooks/use-repo-pin', () => ({ useRepoPin: () => ({
  storage: { needsUnlock: false, loading: false, error: null },
  plan: { data: { targets: [{}], sizeBytes: 1048576, requiresConsent: state.requiresConsent, notOnIpfs: 0, membersOnlySkipped: 0 }, error: null },
  profiles: state.profile ? [{ name: 'kubo' }] : [], profile: state.profile ? { name: 'kubo' } : null, rows: [], summary: null, error: null, running: false,
  start: state.start, cancel: state.cancel, setChosen: vi.fn(),
}) }))
import { PinButton } from './pin-button'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const repo = { repoId: 'r', ownerId: 'owner', name: 'repo', visibility: 'public' } as RepoRef
let host: HTMLDivElement; let root: Root
beforeEach(() => { state.identity = 'me'; state.requiresConsent = false; state.profile = true; state.start.mockReset(); state.cancel.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const render = async (r = repo, member = false) => { await act(async () => root.render(<PinButton repo={r} member={member} />)) }
const buttons = (text: string) => [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)
const open = async () => { await act(async () => buttons('Pin')[0]!.click()) }

describe('repo Pin dialog', () => {
  it('is visible only to signed-in public readers or private members', async () => {
    state.identity = null; await render(); expect(buttons('Pin')).toHaveLength(0)
    state.identity = 'me'; await render({ ...repo, visibility: 'private' }); expect(buttons('Pin')).toHaveLength(0)
    await render({ ...repo, visibility: 'private' }, true); expect(buttons('Pin')).toHaveLength(1)
  })
  it('explains DHT disclosure and waits for a click', async () => {
    await render(); await open()
    expect(host.textContent).toContain('1 file · 1.0 MiB · cost 0 DASH (uses your disk)')
    expect(host.textContent).toContain('Your node will tell the IPFS network')
    expect(state.start).not.toHaveBeenCalled()
    await act(async () => buttons('Pin')[1]!.click())
    expect(state.start).toHaveBeenCalledWith(false)
    expect(host.textContent).toContain('dg ipfs pin owner/repo --follow')
  })
  it('requires explicit consent for private and members-only content', async () => {
    state.requiresConsent = true; await render(); await open()
    expect(buttons('Pin')[1]!.disabled).toBe(true)
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(buttons('Pin')[1]!.disabled).toBe(false)
    await act(async () => buttons('Pin')[1]!.click())
    expect(state.start).toHaveBeenCalledWith(true)
  })
  it('offers setup when no node is configured and cancels on close', async () => {
    state.profile = false; await render(); await open()
    expect(host.textContent).toContain('dg ipfs up'); expect(buttons('Pin')[1]!.disabled).toBe(true)
    await act(async () => buttons('Close')[0]!.click()); expect(state.cancel).toHaveBeenCalledOnce()
  })
})

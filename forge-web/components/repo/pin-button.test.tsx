// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoRef } from '@/lib/repo/contract'

const pack = (n: number, size = 1048576) => ({ packHash: String(n).repeat(64).slice(0, 64), sizeBytes: size, source: {} })
const state = vi.hoisted(() => ({
  identity: 'me' as string | null, start: vi.fn(), cancel: vi.fn(), requiresConsent: false, profile: true, unavailable: 0, invalid: 0,
  pub: {} as Record<string, unknown>,
}))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: state.identity }) }))
vi.mock('@/hooks/use-repo-pin', () => ({ useRepoPin: () => ({
  storage: { needsUnlock: false, loading: false, error: null },
  plan: { data: { targets: [{ size: 1048576 }], needsConsent: state.requiresConsent, notOnIpfs: 0, membersOnlySkipped: 0, unreadableSkipped: state.unavailable, invalidCidsSkipped: state.invalid }, error: null },
  profiles: state.profile ? [{ name: 'kubo' }] : [], profile: state.profile ? { name: 'kubo' } : null, rows: [], summary: null, error: null, running: false,
  start: state.start, cancel: state.cancel, setChosen: vi.fn(),
}) }))
vi.mock('@/hooks/use-public-pin', () => ({ usePublicPin: () => state.pub }))
vi.mock('next/link', () => ({ default: (props: React.ComponentProps<'a'>) => <a {...props} /> }))
vi.mock('@/components/ui/cost-preview', () => ({ CostPreview: ({ cost }: { cost: { credits: number } }) => <span data-testid="cost">{cost.credits}</span> }))
import { PinButton } from './pin-button'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const repo = { forge: { core: 'core' }, repoId: 'r', ownerId: 'owner', name: 'repo', visibility: 'public' } as RepoRef
const R2 = { name: 'r2', settings: { kind: 's3', publicUrl: 'https://cdn.example', prefix: '' } }
const KUBO = { name: 'node', settings: { kind: 'ipfs-kubo', publicGateway: '' } }
const mine = (n: number) => ({ id: `m${n}`, repoId: 'r', packHash: pack(n).packHash, kind: 1, uris: ['https://cdn.example/x'] })
function publicPin(over: Record<string, unknown> = {}, status: unknown = { packs: [pack(1), pack(2)], mine: [], missing: [pack(1), pack(2)], tooLarge: [] }) {
  state.pub = {
    storage: { needsUnlock: false, loading: false, error: null }, status: { data: status, error: null },
    profiles: [R2], profile: R2, setChosen: vi.fn(), running: null, error: null, summary: null, rows: [],
    start: vi.fn(), unpin: vi.fn(), cancel: vi.fn(), ...over,
  }
}
let host: HTMLDivElement; let root: Root
beforeEach(() => {
  state.identity = 'me'; state.requiresConsent = false; state.profile = true; state.unavailable = 0; state.invalid = 0; state.start.mockReset(); state.cancel.mockReset()
  publicPin()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const render = async (r = repo, member = false) => { await act(async () => root.render(<PinButton repo={r} member={member} />)) }
const buttons = (text: string) => [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)
const header = () => host.querySelector<HTMLButtonElement>('[data-testid="pin-button"]')!
const open = async () => { await act(async () => header().click()) }

describe('Pin on a public repo', () => {
  it('is shown only to signed-in readers', async () => {
    state.identity = null; await render(); expect(host.querySelector('button')).toBeNull()
  })

  it('labels the header button from your records', async () => {
    await render(); expect(header().textContent?.trim()).toBe('Pin')
    publicPin({}, { packs: [pack(1), pack(2)], mine: [mine(1)], missing: [pack(2)], tooLarge: [] }); await render()
    expect(header().textContent?.trim()).toBe('Update pin (1 new)')
    publicPin({}, { packs: [pack(1)], mine: [mine(1)], missing: [], tooLarge: [] }); await render()
    expect(header().textContent?.trim()).toBe('Pinned')
  })

  it('shows the plan and price, then pins on one click', async () => {
    await render(); await open()
    expect(host.querySelector('[data-testid="pin-plan"]')?.textContent).toBe('2 files · 2.0 MiB → r2')
    expect(Number(host.querySelector('[data-testid="cost"]')?.textContent)).toBeGreaterThan(0)
    expect(host.querySelector('select')).toBeNull()
    await act(async () => buttons('Pin')[1]!.click())
    expect(state.pub['start']).toHaveBeenCalledWith(expect.objectContaining({ credits: expect.any(Number) }))
  })

  it('offers a storage picker only with more than one profile', async () => {
    publicPin({ profiles: [R2, KUBO] }); await render(); await open()
    expect([...host.querySelectorAll('option')].map((o) => o.value)).toEqual(['r2', 'node'])
  })

  it('updates only the new files, and offers Unpin', async () => {
    publicPin({}, { packs: [pack(1), pack(2)], mine: [mine(1)], missing: [pack(2)], tooLarge: [] })
    await render(); await open()
    expect(host.querySelector('[data-testid="pin-plan"]')?.textContent).toBe('1 file · 1.0 MiB → r2')
    await act(async () => buttons('Update pin (1 new)')[1]!.click())
    expect(state.pub['start']).toHaveBeenCalledOnce()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="pin-unpin"]')!.click())
    expect(state.pub['unpin']).toHaveBeenCalledOnce()
  })

  it('says Pinned with Done as the one closing action', async () => {
    publicPin({}, { packs: [pack(1)], mine: [mine(1)], missing: [], tooLarge: [] })
    await render(); await open()
    expect(host.querySelector('[data-testid="pin-state"]')?.textContent).toBe('Pinned: every file has a copy on your storage.')
    expect(buttons('Done')).toHaveLength(1)
    expect(buttons('Close')).toHaveLength(0)
    expect(host.querySelector('[data-testid="cost"]')).toBeNull()
  })

  it('names the command in the main text when every file left is too large for the browser', async () => {
    publicPin({}, { packs: [pack(1), pack(2, 600 * 1048576)], mine: [mine(1)], missing: [], tooLarge: [pack(2, 600 * 1048576)] })
    await render(); await open()
    expect(host.querySelector('[data-testid="pin-state"]')?.textContent).toBe('Pinned: 1 file has a copy on your storage. 1 file over 512 MiB is too large for the browser; pin it with:')
    expect(host.querySelector('[role="dialog"]')?.querySelector(':scope details')?.contains(host.querySelector('[data-testid="pin-state"]'))).toBeFalsy()
    expect(host.textContent).toContain('dg repo pin owner/repo --follow')
  })

  it('leads to storage setup and the self-host guide when there is no usable storage', async () => {
    publicPin({ profiles: [], profile: null }); await render(); await open()
    const setup = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Set up storage')
    expect(setup?.getAttribute('href')).toBe('/settings/storage/')
    expect([...host.querySelectorAll('a')].find((a) => a.textContent === 'Self-host guide')?.getAttribute('href')).toMatch(/\/blob\/master\/docs\/self-host\.md$/)
    expect([...host.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent?.trim())).not.toContain('Pin')
  })

  it('keeps detail, large-file counts and the follow command collapsed', async () => {
    publicPin({}, { packs: [pack(1), pack(2, 600 * 1048576)], mine: [], missing: [pack(1)], tooLarge: [pack(2, 600 * 1048576)] })
    await render(); await open()
    const details = host.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('1 file over 512 MiB needs the command below.')
    expect(details.textContent).toContain('dg repo pin owner/repo --follow')
  })

  it('shows where a run is, and cancels it', async () => {
    publicPin({ running: 'pin', rows: [{ index: 2, total: 3, packHash: pack(1).packHash, sizeBytes: 1, state: 'copying' }] })
    await render(); await open()
    expect(host.textContent).toContain('Copying 2 of 3…')
    await act(async () => buttons('Cancel')[0]!.click())
    expect(state.pub['cancel']).toHaveBeenCalled()
  })
})

describe('Pin on a private repo (IPFS only, members)', () => {
  const priv = { ...repo, visibility: 'private' } as RepoRef
  const openPrivate = async () => { await act(async () => buttons('Pin')[0]!.click()) }

  it('is shown only to members', async () => {
    await render(priv); expect(buttons('Pin')).toHaveLength(0)
    await render(priv, true); expect(buttons('Pin')).toHaveLength(1)
  })

  it('requires explicit consent before pinning', async () => {
    await render(priv, true); await openPrivate()
    expect(host.textContent).toContain('1 file · 1.0 MiB · cost 0 DASH (uses your disk)')
    expect(host.textContent).toContain("My IP address will be listed on IPFS as holding this private repo's encrypted files.")
    expect(buttons('Pin')[1]!.disabled).toBe(true)
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () => buttons('Pin')[1]!.click())
    expect(state.start).toHaveBeenCalledWith(true)
    expect(host.textContent).toContain('dg ipfs pin owner/repo --follow')
  })

  it('offers node setup when none is configured and cancels on close', async () => {
    state.profile = false; await render(priv, true); await openPrivate()
    expect(host.textContent).toContain('dg ipfs up'); expect(buttons('Pin')[1]!.disabled).toBe(true)
    await act(async () => buttons('Close')[0]!.click()); expect(state.cancel).toHaveBeenCalledOnce()
  })

  it.each([
    ['https://custom.example', '/repo/', "dg ipfs up --origin 'https://custom.example'"],
    ['https://ipfs.io', '/ipfs/bafy/repo/', 'Open Forge from its own address'],
    ['https://example.ipns.dweb.link', '/repo/', 'Open Forge from its own address'],
  ])('uses origin-aware setup on %s%s', async (origin, pathname, expected) => {
    state.profile = false; vi.stubGlobal('location', { origin, pathname })
    await render(priv, true); await openPrivate()
    expect(host.textContent).toContain(expected)
  })

  it('shows unreachable-pack and invalid-CID skip counts', async () => {
    state.unavailable = 2; state.invalid = 3
    await render(priv, true); await openPrivate()
    expect(host.textContent).toContain('2 files skipped: no reachable copy to check.')
    expect(host.textContent).toContain('3 IPFS addresses skipped: invalid CID.')
  })
})

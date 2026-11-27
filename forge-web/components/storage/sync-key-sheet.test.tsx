// @vitest-environment jsdom
/**
 * The sync line's key states (#751): moved (one action, "Add the new key"), a browser without the
 * identity's sync key (the same action), synced ("Move sync to a new key", one sheet: why, the
 * phrase, one button, then what to do next), and no key actions anywhere else.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UserSyncStatus } from '@/lib/user-sync/session'

const state = vi.hoisted(() => ({ status: { kind: 'off' } as UserSyncStatus }))
const calls = vi.hoisted(() => ({ move: vi.fn(), add: vi.fn(), charged: vi.fn() }))
vi.mock('@/hooks/use-user-sync', () => ({ useUserSyncStatus: () => state.status }))
vi.mock('@/hooks/use-sdk', () => ({ useSdk: () => ({ sdk: {}, ready: true, network: 'testnet' }) }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ identity: 'Owner11111111111111111111111111111111111111', signer: {}, controller: { chargedUpdate: calls.charged } }) }))
vi.mock('@/lib/auth/sync-key-move', () => ({ moveSyncKeyWithPhrase: calls.move, addSyncKeyWithPhrase: calls.add }))
vi.mock('@/lib/spend-toast', () => ({ namedAction: (t: string) => ({ title: t, done: t }), spendAction: (_l: unknown, run: (tag: <A>(a: A) => A) => Promise<unknown>) => run((a) => a) }))
vi.mock('@/lib/constants', async (orig) => {
  const real = await orig<typeof import('@/lib/constants')>()
  return { ...real, ACTIVE_NETWORK: { ...real.ACTIVE_NETWORK, key: 'testnet', v2: { ...real.ACTIVE_NETWORK.v2, user: 'User111111111111111111111111111111111111111' } } }
})

import { ADD_ACTION, ADD_WHY, ADDED, MOVE_ACTION, MOVE_WHY, MOVED_DONE, MOVED_LINE, OTHER_DEVICES, ROTATE_NOW, WALLET_NOTE } from './sync-key-sheet'
import { ADD_KEY_LINE, SyncNote } from './sync-note'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  calls.move.mockReset().mockResolvedValue({ keyId: 6, created: true, slots: 2, shares: 0 })
  calls.add.mockReset().mockResolvedValue(6)
  calls.charged.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function show(status: UserSyncStatus): void {
  state.status = status
  act(() => root.render(<SyncNote />))
}

const byTestId = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)
const buttons = (): string[] => [...document.querySelectorAll('button')].map((b) => b.textContent ?? '')

function click(el: HTMLElement | null): void {
  if (el === null) throw new Error('no such element')
  act(() => el.click())
}

async function submit(phrase: string): Promise<void> {
  const field = document.getElementById('sync-key-phrase') as HTMLTextAreaElement
  field.value = phrase
  await act(async () => {
    byTestId('sync-key-submit')!.click()
  })
}

describe('the sync line', () => {
  it('moved: the one line and one action, no error styling', () => {
    show({ kind: 'moved', syncedAt: 1 })
    expect(byTestId('sync-note')?.textContent).toBe(`${MOVED_LINE} ${ADD_ACTION}`)
    expect(MOVED_LINE).toBe('Your synced settings moved to a new key.')
    expect(ADD_ACTION).toBe('Add the new key')
    expect(buttons()).toEqual([ADD_ACTION])
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(byTestId('sync-note')?.className).not.toMatch(/danger|caution/)
  })

  it('a browser without the identity’s sync key offers the same action; one without the offer shows none', () => {
    show({ kind: 'local', syncedAt: null, addKey: true })
    expect(byTestId('sync-note')?.textContent).toContain('On this device only')
    expect(byTestId('sync-note')?.textContent).toContain(ADD_KEY_LINE)
    expect(buttons()).toEqual([ADD_ACTION])
    show({ kind: 'local', syncedAt: null })
    expect(buttons()).toEqual([])
    expect(byTestId('sync-note')?.textContent).not.toContain(ADD_KEY_LINE)
  })

  it('offers "Move sync to a new key" only when synced', () => {
    show({ kind: 'synced', syncedAt: 1 })
    expect(buttons()).toEqual([MOVE_ACTION])
    for (const s of [{ kind: 'syncing', syncedAt: 1 }, { kind: 'error', syncedAt: 1, message: 'x' }, { kind: 'local', syncedAt: null }] as const) {
      show(s)
      expect(buttons()).not.toContain(MOVE_ACTION)
    }
  })

  it('nothing where sync is off', () => {
    show({ kind: 'off' })
    expect(byTestId('sync-note')).toBeNull()
  })
})

describe('the sheet', () => {
  it('add: why, the phrase warning, the phrase, one button; then done', async () => {
    show({ kind: 'moved', syncedAt: 1 })
    click(byTestId('sync-add-key'))
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(ADD_WHY)
    expect(byTestId('phrase-warning')).not.toBeNull()
    expect([...dialog.querySelectorAll('button')].map((b) => b.textContent).filter((t) => t !== '')).toEqual(['Add the key'])
    await submit('  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about ')
    expect(calls.add).toHaveBeenCalledTimes(1)
    expect(calls.add.mock.calls[0]![0]).toMatchObject({ identityId: 'Owner11111111111111111111111111111111111111', contractId: 'User111111111111111111111111111111111111111', mnemonic: '  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about ' })
    expect(calls.move).not.toHaveBeenCalled()
    expect(byTestId('sync-key-done')?.textContent).toBe(ADDED)
  })

  it('move: one line of why, then the four lines of what follows, the phrase field cleared', async () => {
    show({ kind: 'synced', syncedAt: 1 })
    click(byTestId('sync-move-key'))
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(MOVE_WHY)
    await submit('words')
    expect(calls.move).toHaveBeenCalledTimes(1)
    expect(calls.move.mock.calls[0]![0]).toMatchObject({ mnemonic: 'words', networkKey: 'testnet' })
    const done = byTestId('sync-key-done')!
    for (const line of [MOVED_DONE, ROTATE_NOW, OTHER_DEVICES, WALLET_NOTE]) expect(done.textContent).toContain(line)
    expect(done.querySelector('a')?.getAttribute('href')).toContain('rotate-storage-credentials')
    expect(document.getElementById('sync-key-phrase')).toBeNull()
    expect(WALLET_NOTE).toBe('Wallet sign-ins no longer carry the sync key.')
  })

  it('move: the identity update runs through the spend ledger', async () => {
    calls.move.mockImplementation(async (p: { charged: (u: () => Promise<void>) => Promise<void> }) => {
      const update = vi.fn(async () => {})
      await p.charged(update)
      return { keyId: 6, created: true, slots: 0, shares: 0 }
    })
    calls.charged.mockImplementation(async (_id: string, kind: string, run: () => Promise<boolean>) => run().then(() => kind === 'key:encryption'))
    show({ kind: 'synced', syncedAt: 1 })
    click(byTestId('sync-move-key'))
    await submit('words')
    expect(calls.charged).toHaveBeenCalledWith('Owner11111111111111111111111111111111111111', 'key:encryption', expect.any(Function))
  })

  it('a refusal is said in its words and nothing is done', async () => {
    calls.move.mockRejectedValue(new Error("This recovery phrase doesn't make this identity's sync key."))
    show({ kind: 'synced', syncedAt: 1 })
    click(byTestId('sync-move-key'))
    await submit('wrong words')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("This recovery phrase doesn't make this identity's sync key.")
    expect(byTestId('sync-key-done')).toBeNull()
    expect((document.getElementById('sync-key-phrase') as HTMLTextAreaElement).value).toBe('')
  })
})

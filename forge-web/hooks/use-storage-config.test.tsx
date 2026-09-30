// @vitest-environment jsdom
/**
 * useStorageConfig after a reload: a signing-only tab can neither open nor save storage
 * settings, so it asks for the unlock whether any settings are stored yet or not. A first setup
 * after a reload used to show an empty page whose Save failed with "unlock this tab to save
 * storage settings" and nothing on the page to unlock with.
 *
 * A write that only uses the settings (a pack upload) is another matter: with none stored in
 * this browser there is nothing to open, so it goes on with the empty settings (QW-007: batch
 * suggestions failed after every reload with "your storage settings are not unlocked yet").
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useStorageConfig, type StorageConfigState } from './use-storage-config'

let scope: 'signing' | 'full' = 'signing'
let stored = false
const loadStorageConfig = vi.fn(async () => ({ profiles: [], policies: [] }))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ identity: 'me', storage: 'vault', unlockScope: scope, controller: { unlockScope: () => scope } }),
}))
vi.mock('@/lib/auth/vault', () => ({ hasStorageBlob: async () => stored }))
vi.mock('@/lib/storage', () => ({
  EMPTY_STORAGE_CONFIG: { profiles: [], policies: [] },
  loadStorageConfig: () => loadStorageConfig(),
  saveStorageConfig: vi.fn(),
  discardStorageConfig: vi.fn(),
}))

let seen: StorageConfigState | null = null
function Probe(): null {
  seen = useStorageConfig()
  return null
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  loadStorageConfig.mockClear()
  stored = false
  seen = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Render the hook and let its read settle. */
async function settle(): Promise<StorageConfigState> {
  await act(async () => root.render(<Probe />))
  await act(async () => new Promise((r) => setTimeout(r, 0)))
  return seen as unknown as StorageConfigState
}

describe('useStorageConfig', () => {
  it('asks for the unlock in a signing-only tab, with no settings stored yet', async () => {
    scope = 'signing'
    const s = await settle()
    expect(s.needsUnlock).toBe(true)
    expect(s.config).toBeNull()
    expect(loadStorageConfig).not.toHaveBeenCalled()
  })

  it('lets an upload use the empty settings in a signing-only tab with none stored', async () => {
    scope = 'signing'
    const s = await settle()
    expect(s.sealed).toBe(false)
    expect(s.usable).toEqual({ profiles: [], policies: [] })
  })

  it('keeps stored settings sealed for an upload until the unlock', async () => {
    scope = 'signing'
    stored = true
    const s = await settle()
    expect(s.needsUnlock).toBe(true)
    expect(s.sealed).toBe(true)
    expect(s.usable).toBeNull()
    expect(loadStorageConfig).not.toHaveBeenCalled()
  })

  it('opens the settings once the tab is unlocked', async () => {
    scope = 'full'
    const s = await settle()
    expect(s.needsUnlock).toBe(false)
    expect(s.sealed).toBe(false)
    expect(s.config).not.toBeNull()
    expect(s.usable).toBe(s.config)
    expect(loadStorageConfig).toHaveBeenCalledOnce()
  })
})

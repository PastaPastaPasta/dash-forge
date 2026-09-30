// @vitest-environment jsdom
/**
 * useStorageConfig after a reload: a signing-only tab can neither open nor save storage
 * settings, so it asks for the unlock whether any settings are stored yet or not. A first setup
 * after a reload used to show an empty page whose Save failed with "unlock this tab to save
 * storage settings" and nothing on the page to unlock with.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useStorageConfig, type StorageConfigState } from './use-storage-config'

let scope: 'signing' | 'full' = 'signing'
const loadStorageConfig = vi.fn(async () => ({ profiles: [], policies: [] }))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ identity: 'me', storage: 'vault', unlockScope: scope, controller: { unlockScope: () => scope } }),
}))
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

  it('opens the settings once the tab is unlocked', async () => {
    scope = 'full'
    const s = await settle()
    expect(s.needsUnlock).toBe(false)
    expect(s.config).not.toBeNull()
    expect(loadStorageConfig).toHaveBeenCalledOnce()
  })
})

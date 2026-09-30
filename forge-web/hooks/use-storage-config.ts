'use client'

/**
 * useStorageConfig — the signed-in identity's storage configuration, read from and written to
 * the vault. Null while signed out or locked (the settings are sealed with the key; there is
 * nothing to show without it). A tab-only pasted key has no vault record, so it cannot store
 * settings; `storable` says so. After a reload picked up a signing-only session, settings can
 * be neither opened nor saved until an interactive unlock in this tab, whether any are stored
 * or not: `needsUnlock` says so (and writes that need them fall back to asking, never to "no
 * storage set up").
 */

import { useCallback } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { DEFAULT_NETWORK } from '@/lib/constants'
import { EMPTY_STORAGE_CONFIG, discardStorageConfig, loadStorageConfig, saveStorageConfig, type StorageConfig } from '@/lib/storage'

export interface StorageConfigState {
  readonly config: StorageConfig | null
  readonly loading: boolean
  readonly error: string | null
  /** Whether this session can store settings (a vault-stored key). */
  readonly storable: boolean
  /** This tab resumed a signing-only session: unlock to open, set up or save settings. */
  readonly needsUnlock: boolean
  save: (next: StorageConfig) => Promise<void>
  reload: () => void
  /** Delete stored settings this key cannot open, then reload (empty). */
  discard: () => Promise<void>
}

const NEEDS_UNLOCK = Symbol('needs-unlock')

export function useStorageConfig(): StorageConfigState {
  const { identity, storage, controller, unlockScope } = useAuth()
  const storable = identity !== null && storage === 'vault'
  const state = useAsync<StorageConfig | typeof NEEDS_UNLOCK>(
    async () => {
      if (!storable) return EMPTY_STORAGE_CONFIG
      // A signing-only tab can neither open stored settings nor seal new ones (the vault key
      // opens only on an interactive unlock): a first setup after a reload asks too, rather
      // than letting Save fail with nothing on the page to unlock.
      if (controller.unlockScope() === 'signing') return NEEDS_UNLOCK
      return loadStorageConfig(DEFAULT_NETWORK, identity)
    },
    [identity ?? '', storage ?? '', unlockScope ?? ''],
    { enabled: identity !== null },
  )
  const { reload } = state
  const save = useCallback(
    async (next: StorageConfig): Promise<void> => {
      if (!storable || identity === null) throw new Error('Storage settings are kept in the vault: sign in with a stored key (not a pasted one).')
      await saveStorageConfig(DEFAULT_NETWORK, identity, next)
      reload()
    },
    [identity, reload, storable],
  )
  const discard = useCallback(async (): Promise<void> => {
    if (identity === null) return
    await discardStorageConfig(DEFAULT_NETWORK, identity)
    reload()
  }, [identity, reload])
  const needsUnlock = state.data === NEEDS_UNLOCK
  const config = identity === null || state.data === NEEDS_UNLOCK ? null : state.data
  return { config, loading: state.loading, error: state.error, storable, needsUnlock, save, reload, discard }
}

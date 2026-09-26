'use client'

/**
 * useStorageConfig — the signed-in identity's storage configuration, read from and written to
 * the vault. Null while signed out or locked (the settings are sealed with the key; there is
 * nothing to show without it). A tab-only pasted key has no vault record, so it cannot store
 * settings; `storable` says so.
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
  save: (next: StorageConfig) => Promise<void>
  reload: () => void
  /** Delete stored settings this key cannot open, then reload (empty). */
  discard: () => Promise<void>
}

export function useStorageConfig(): StorageConfigState {
  const { identity, storage } = useAuth()
  const storable = identity !== null && storage === 'vault'
  const state = useAsync<StorageConfig>(
    () => (storable ? loadStorageConfig(DEFAULT_NETWORK, identity) : Promise.resolve(EMPTY_STORAGE_CONFIG)),
    [identity ?? '', storage ?? ''],
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
  return { config: identity === null ? null : state.data, loading: state.loading, error: state.error, storable, save, reload, discard }
}

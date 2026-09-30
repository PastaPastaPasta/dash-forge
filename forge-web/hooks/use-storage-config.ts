'use client'

/**
 * useStorageConfig — the signed-in identity's storage configuration, read from and written to
 * the vault. Null while signed out or locked (the settings are sealed with the key; there is
 * nothing to show without it). A tab-only pasted key has no vault record, so it cannot store
 * settings; `storable` says so. After a reload picked up a signing-only session, settings can
 * be neither opened nor saved until an interactive unlock in this tab, whether any are stored
 * or not: `needsUnlock` says so (and writes that need them fall back to asking, never to "no
 * storage set up"). A write that only USES the settings (a merge's or a suggestion's pack upload)
 * needs no unlock when none are stored in this browser: there is nothing sealed to open, and the
 * settings it would use are the empty ones. `usable` is what such a write may use now; `sealed`
 * says stored settings are waiting for the unlock.
 */

import { useCallback } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useAsync } from '@/hooks/use-async'
import { DEFAULT_NETWORK } from '@/lib/constants'
import { hasStorageBlob } from '@/lib/auth/vault'
import { EMPTY_STORAGE_CONFIG, discardStorageConfig, loadStorageConfig, saveStorageConfig, type StorageConfig } from '@/lib/storage'

export interface StorageConfigState {
  readonly config: StorageConfig | null
  readonly loading: boolean
  readonly error: string | null
  /** Whether this session can store settings (a vault-stored key). */
  readonly storable: boolean
  /** This tab resumed a signing-only session: unlock to open, set up or save settings. */
  readonly needsUnlock: boolean
  /**
   * The settings a write may use now (an upload, not a save): `config`, or in a signing-only tab
   * with none stored in this browser the empty settings; null while stored ones stay sealed.
   */
  readonly usable: StorageConfig | null
  /** Settings are stored in this browser, and this tab must unlock to use them. */
  readonly sealed: boolean
  save: (next: StorageConfig) => Promise<void>
  reload: () => void
  /** Delete stored settings this key cannot open, then reload (empty). */
  discard: () => Promise<void>
}

/** A signing-only tab: settings are stored, sealed until the unlock. */
const SEALED = Symbol('sealed')
/** A signing-only tab with no settings stored: nothing to open, but a save still needs the unlock. */
const NONE_STORED = Symbol('none-stored')

export function useStorageConfig(): StorageConfigState {
  const { identity, storage, controller, unlockScope } = useAuth()
  const storable = identity !== null && storage === 'vault'
  const state = useAsync<StorageConfig | typeof SEALED | typeof NONE_STORED>(
    async () => {
      if (!storable) return EMPTY_STORAGE_CONFIG
      // A signing-only tab can neither open stored settings nor seal new ones (the vault key
      // opens only on an interactive unlock): a first setup after a reload asks too, rather
      // than letting Save fail with nothing on the page to unlock.
      if (controller.unlockScope() === 'signing') return (await hasStorageBlob(DEFAULT_NETWORK, identity)) ? SEALED : NONE_STORED
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
  const sealed = state.data === SEALED
  const needsUnlock = sealed || state.data === NONE_STORED
  const config = identity === null || needsUnlock ? null : (state.data as StorageConfig | null)
  const usable = config ?? (identity !== null && state.data === NONE_STORED ? EMPTY_STORAGE_CONFIG : null)
  return { config, loading: state.loading, error: state.error, storable, needsUnlock, usable, sealed, save, reload, discard }
}

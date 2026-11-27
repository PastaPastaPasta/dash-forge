'use client'

/**
 * Settings that follow the identity (docs/design/identity-synced-state.md §5): {@link UserSyncDriver}
 * runs once, app-wide, and syncs whenever the session holds the forge-user key: after an unlock or
 * a wallet sign-in, after a Settings save, and when the tab is shown or hidden again (at most once
 * a minute). {@link useUserSyncStatus} is the one line Settings → Storage shows.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import type { AuthController } from '@/lib/auth/controller'
import type { WriteAuth } from '@/lib/sdk/write'
import { heldSyncKeyId, onSyncKeyChange, onVaultLock, storageSyncId, withSyncKey } from '@/lib/auth/vault'
import { deviceShortId } from '@/lib/user-sync/device'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { namedAction, spendAction } from '@/lib/spend-toast'
import { loadStorageConfig, updateStorageConfig, type StorageConfig } from '@/lib/storage'
import { setActive } from '@/lib/user-sync/overlay'
import { forgeUserPort } from '@/lib/user-sync/platform'
import { syncedAt, syncUserSettings } from '@/lib/user-sync/service'
import { dropSyncedStorage, onLocalSettingsChange, requestUserSync, syncSubject, setSyncSubject, subscribeUserSync, userSyncStatus, type UserSyncStatus } from '@/lib/user-sync/session'

/** The least time between two syncs a tab switch starts. */
const VISIBILITY_SYNC_MS = 60_000

export function UserSyncDriver(): null {
  const { identity, storage, unlockScope, signer, controller } = useAuth()
  const { sdk } = useSdk()
  const user = ACTIVE_NETWORK.v2?.user
  const [changes, setChanges] = useState(0)

  useEffect(() => {
    setActive(ACTIVE_NETWORK.key, user !== undefined ? identity : null)
  }, [identity, user])

  useEffect(() => {
    const bump = (): void => setChanges((c) => c + 1)
    const offKey = onSyncKeyChange(bump)
    // A lock ends this tab's access to the synced settings: the decrypted config goes with it.
    const offLock = onVaultLock(dropSyncedStorage)
    const offLocal = onLocalSettingsChange(bump)
    let last = 0
    const onVisibility = (): void => {
      if (Date.now() - last < VISIBILITY_SYNC_MS) return
      last = Date.now()
      bump()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      offKey()
      offLock()
      offLocal()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  useEffect(() => {
    if (user === undefined || identity === null) {
      setSyncSubject(identity, { kind: 'off' })
      return
    }
    let stale = false
    void (async () => {
      const keyId = await heldSyncKeyId(DEFAULT_NETWORK, identity)
      if (stale) return
      const at = syncedAt(ACTIVE_NETWORK.key, identity)
      if (keyId === null || sdk === null || signer === null) {
        setSyncSubject(identity, { kind: 'local', syncedAt: at })
        // The identity syncs with a key this browser lacks (a wallet that no longer sends it, after a move): the phrase adds it.
        if (keyId === null && sdk !== null && unlockScope === 'full') {
          const current = await forgeUserPort(sdk, user, null).syncKey(identity).catch(() => null)
          if (!stale && current !== null) setSyncSubject(identity, { kind: 'local', syncedAt: at, addKey: true })
        }
        return
      }
      setSyncSubject(identity, { kind: 'syncing', syncedAt: at })
      // The storage settings sync only where this tab can open them (a vault key, fully unlocked).
      const local =
        storage === 'vault' && unlockScope === 'full'
          ? {
              load: () => loadStorageConfig(DEFAULT_NETWORK, identity),
              update: (change: (c: StorageConfig) => StorageConfig | null) => updateStorageConfig(DEFAULT_NETWORK, identity, change),
              syncId: async () => (await storageSyncId(DEFAULT_NETWORK, identity, true))!,
            }
          : null
      const deviceId = deviceShortId()
      void requestUserSync(identity, () =>
        withSyncKey(DEFAULT_NETWORK, identity, (kid, E) =>
          spendAction(namedAction('Settings synced'), (tag) =>
            syncUserSettings({ port: forgeUserPort(sdk, user, tag(quietSigner(controller, signer))), networkKey: ACTIVE_NETWORK.key, network: DEFAULT_NETWORK, identityId: identity, keyId: kid, E, deviceId, storage: local, stillActive: () => syncSubject() === identity }),
          ),
        ),
      )
    })()
    return () => {
      stale = true
    }
  }, [identity, user, sdk, signer, controller, storage, unlockScope, changes])

  return null
}

/**
 * The session's signer for background writes: its charges reach the ledger and toast like any
 * write's, but a key that does not cover a contract fails the write instead of opening sign-in.
 */
export function quietSigner(controller: AuthController, signer: WriteAuth): WriteAuth {
  return { ...(controller.writeAuth ?? signer), onSpend: signer.onSpend }
}

export function useUserSyncStatus(): UserSyncStatus {
  return useSyncExternalStore(subscribeUserSync, userSyncStatus, userSyncStatus)
}

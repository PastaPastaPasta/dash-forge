'use client'

/**
 * Settings that follow the identity (docs/design/identity-synced-state.md §5): {@link UserSyncDriver}
 * runs once, app-wide, and syncs whenever the session holds the forge-user key: after an unlock or
 * a wallet sign-in, after a Settings save, and when the tab is shown or hidden again (at most once
 * a minute). {@link useUserSyncStatus} is the one line Settings → Storage shows.
 */

import { bytesToHex } from '@noble/hashes/utils.js'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { connectionId } from '@/lib/auth/connection-id'
import { heldSyncKeyId, onSyncKeyChange, withSyncKey } from '@/lib/auth/vault'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import { namedAction, spendAction } from '@/lib/spend-toast'
import { loadStorageConfig, saveStorageConfig, type StorageConfig } from '@/lib/storage'
import { setActive } from '@/lib/user-sync/overlay'
import { forgeUserPort } from '@/lib/user-sync/platform'
import { syncedAt, syncUserSettings } from '@/lib/user-sync/service'
import { onLocalSettingsChange, requestUserSync, setSyncSubject, subscribeUserSync, userSyncStatus, type UserSyncStatus } from '@/lib/user-sync/session'

/** The least time between two syncs a tab switch starts. */
const VISIBILITY_SYNC_MS = 60_000

export function UserSyncDriver(): null {
  const { identity, storage, unlockScope, signer } = useAuth()
  const { sdk } = useSdk()
  const user = ACTIVE_NETWORK.v2?.user
  const [changes, setChanges] = useState(0)

  useEffect(() => {
    setActive(ACTIVE_NETWORK.key, user !== undefined ? identity : null)
  }, [identity, user])

  useEffect(() => {
    const bump = (): void => setChanges((c) => c + 1)
    const offKey = onSyncKeyChange(bump)
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
      if (keyId === null || sdk === null || signer === null) {
        setSyncSubject(identity, { kind: 'local', syncedAt: syncedAt(ACTIVE_NETWORK.key, identity) })
        return
      }
      setSyncSubject(identity, { kind: 'syncing', syncedAt: syncedAt(ACTIVE_NETWORK.key, identity) })
      // The storage settings sync only where this tab can open them (a vault key, fully unlocked).
      const local =
        storage === 'vault' && unlockScope === 'full'
          ? { load: () => loadStorageConfig(DEFAULT_NETWORK, identity), save: (c: StorageConfig) => saveStorageConfig(DEFAULT_NETWORK, identity, c) }
          : null
      const deviceId = bytesToHex(connectionId(ACTIVE_NETWORK.key)).slice(0, 4)
      void requestUserSync(identity, () =>
        withSyncKey(DEFAULT_NETWORK, identity, (kid, E) =>
          spendAction(namedAction('Settings synced'), (tag) =>
            syncUserSettings({ port: forgeUserPort(sdk, user, tag(signer)), networkKey: ACTIVE_NETWORK.key, network: DEFAULT_NETWORK, identityId: identity, keyId: kid, E, deviceId, storage: local }),
          ),
        ),
      )
    })()
    return () => {
      stale = true
    }
  }, [identity, user, sdk, signer, storage, unlockScope, changes])

  return null
}

export function useUserSyncStatus(): UserSyncStatus {
  return useSyncExternalStore(subscribeUserSync, userSyncStatus, userSyncStatus)
}

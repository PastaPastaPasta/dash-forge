'use client'

/**
 * Maintainers use the owner's storage (docs/design/identity-synced-state.md §5), in the web app:
 * {@link useRepoStorageShare} reconciles the share and grants when the owner opens the repo's
 * Settings → Storage (and on a removal), and says which maintainers wait for a wallet sign-in;
 * {@link useGrantedStorage} gives a maintainer's pushes to one repo the owner's storage for it.
 */

import { useCallback, useEffect, useState } from 'react'

import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/hooks/use-sdk'
import { heldSyncKeyId, onSyncKeyChange, onVaultLock, withSyncKey } from '@/lib/auth/vault'
import { ACTIVE_NETWORK, DEFAULT_NETWORK } from '@/lib/constants'
import type { RepoRef } from '@/lib/repo'
import { readMaintainers } from '@/lib/repo/members'
import { namedAction, spendAction } from '@/lib/spend-toast'
import type { StorageConfig } from '@/lib/storage'
import { readGrantedStorage, reconcileRepoShare, withGrantedStorage, type GrantedStorage, type Reconciled } from '@/lib/user-sync/maintainers'
import { forgeUserPort } from '@/lib/user-sync/platform'
import { syncedShareView } from '@/lib/user-sync/session'
import { quietSigner, useUserSyncStatus } from '@/hooks/use-user-sync'

export interface RepoShareState {
  /** Owner: maintainers with no forge-user key yet. */
  readonly waiting: readonly string[]
  /** Maintainer: this browser holds no forge-user key, so the owner's storage cannot reach it yet. */
  readonly memberNeedsKey: boolean
  /**
   * Owner: after removing `member` as maintainer, move the share to a new epoch without them.
   * Resolves whether a share existed (so they may have seen its credentials).
   */
  readonly afterRemoval: (member: string) => Promise<boolean>
}

/** Members removed in this tab, per repo: never granted again from a node read that still lists them. */
const removedHere = new Map<string, Set<string>>()
/** One reconcile per repo at a time; the next waits for the last. */
const reconciling = new Map<string, Promise<unknown>>()

function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (reconciling.get(key) ?? Promise.resolve()).catch(() => undefined).then(run)
  reconciling.set(key, next)
  void next.finally(() => {
    if (reconciling.get(key) === next) reconciling.delete(key)
  }).catch(() => undefined)
  return next
}

export function useRepoStorageShare(repo: RepoRef): RepoShareState {
  const { identity, signer, controller } = useAuth()
  const { sdk } = useSdk()
  const user = ACTIVE_NETWORK.v2?.user
  // What the share holds comes from the owner's synced storage slot, once this tab's sync finished: never the
  // device-local one, nor what a tab has before its first sync ('off' is also the state before the
  // driver ran).
  const syncKind = useUserSyncStatus().kind
  const config = identity !== null && syncKind === 'synced' ? syncedShareView(identity) : null
  const [waiting, setWaiting] = useState<readonly string[]>([])
  const [memberNeedsKey, setMemberNeedsKey] = useState(false)
  const isOwner = identity !== null && identity === repo.ownerId

  const repoKey = `${ACTIVE_NETWORK.key}:${repo.repoId}`
  const reconcile = useCallback(
    (view: Readonly<Record<string, unknown>>): Promise<Reconciled | null> =>
      oneAtATime(repoKey, async () => {
        if (user === undefined || identity === null || sdk === null || signer === null || !isOwner) return null
        const maintainers = await readMaintainers(sdk, repo)
        const removed = [...(removedHere.get(repoKey) ?? [])]
        return withSyncKey(DEFAULT_NETWORK, identity, (keyId, E) =>
          spendAction(namedAction('Storage shared with maintainers'), (tag) =>
            reconcileRepoShare({ port: forgeUserPort(sdk, user, tag(quietSigner(controller, signer))), networkKey: ACTIVE_NETWORK.key, ownerId: identity, keyId, E }, { repoId: repo.repoId, view, maintainers, removed }),
          ),
        )
      }),
    [user, identity, sdk, signer, controller, isOwner, repo, repoKey],
  )

  useEffect(() => {
    if (user === undefined || identity === null || sdk === null) return
    let stale = false
    void (async () => {
      if (isOwner) {
        if (config === null) return
        const done = await reconcile(config).catch(() => null)
        if (!stale && done !== null) setWaiting(done.waiting)
        return
      }
      const maintainers = await readMaintainers(sdk, repo).catch(() => [] as string[])
      if (stale || !maintainers.includes(identity)) return
      setMemberNeedsKey((await heldSyncKeyId(DEFAULT_NETWORK, identity)) === null)
    })()
    return () => {
      stale = true
    }
  }, [user, identity, sdk, isOwner, config, reconcile, repo])

  const afterRemoval = useCallback(
    async (member: string): Promise<boolean> => {
      removedHere.set(repoKey, new Set([...(removedHere.get(repoKey) ?? []), member]))
      const done = config === null ? null : await reconcile(config).catch(() => null)
      if (done !== null) {
        setWaiting(done.waiting)
        return done.shared
      }
      // Not reconciled here (no sync key in this tab): the next visit with one moves the epoch.
      if (user === undefined || sdk === null) return false
      return (await forgeUserPort(sdk, user, null).readShare(repo.ownerId, repo.repoId).catch(() => null)) !== null
    },
    [config, reconcile, user, sdk, repo, repoKey],
  )

  return { waiting, memberNeedsKey, afterRemoval }
}

const granted = new Map<string, Promise<GrantedStorage | null>>()
// The owner's credentials go with the unlock that opened them, and with the key.
if (typeof window !== 'undefined') {
  onVaultLock(() => granted.clear())
  onSyncKeyChange(() => granted.clear())
}

/**
 * `config` as pushes to `repo` use it: with the storage the repo's owner shared with this
 * maintainer (when this browser holds a grant to it), for this repo only.
 */
export function useGrantedStorage(repo: RepoRef | null, config: StorageConfig | null): StorageConfig | null {
  const { identity } = useAuth()
  const { sdk } = useSdk()
  const user = ACTIVE_NETWORK.v2?.user
  const [grant, setGrant] = useState<GrantedStorage | null>(null)

  useEffect(() => {
    setGrant(null)
    if (user === undefined || repo === null || identity === null || sdk === null || identity === repo.ownerId) return
    let stale = false
    const key = `${ACTIVE_NETWORK.key}:${identity}:${repo.repoId}`
    let read = granted.get(key)
    if (read === undefined) {
      read = (async () => {
        if (!(await readMaintainers(sdk, repo)).includes(identity)) return null
        return withSyncKey(DEFAULT_NETWORK, identity, (keyId, E) =>
          readGrantedStorage({ port: forgeUserPort(sdk, user, null), networkKey: ACTIVE_NETWORK.key, memberId: identity, keyId, E }, { repoId: repo.repoId, repoOwnerId: repo.ownerId }),
        )
      })().catch(() => null)
      granted.set(key, read)
      // A failed or empty read is tried again next time this repo is opened.
      void read.then((g) => {
        if (g === null) granted.delete(key)
      })
    }
    void read.then((g) => {
      if (!stale) setGrant(g)
    })
    return () => {
      stale = true
    }
  }, [user, repo, identity, sdk])

  return config === null || repo === null ? config : withGrantedStorage(config, repo.repoId, grant)
}

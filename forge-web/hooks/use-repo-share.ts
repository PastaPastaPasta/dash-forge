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
  /** Owner: `member` is a maintainer again (the add read back): this tab grants them again. */
  readonly afterAdd: (member: string) => void
  /** Owner: the repo's maintainers (null until read). */
  readonly maintainers: readonly string[] | null
  /** Owner: maintainers holding a grant to the repo's storage. */
  readonly granted: readonly string[]
  /** Owner: this visit stopped a share of the default storage; said once per repo. */
  readonly stoppedDefault: boolean
}

/** Where the one-time "stopped sharing your default storage" line was shown, per repo (additive). */
export function stoppedDefaultKey(networkKey: string, repoId: string): string {
  return `forge:user-sync:stopped-default:${networkKey}:${repoId}`
}

/** Repos (network:repo) whose default-storage share a reconcile here stopped, waiting to be said. */
const stopsToSay = new Set<string>()
const stopListeners = new Set<() => void>()

/** A reconcile stopped `repoKey`'s default-storage share: say it, whatever became of the visit that ran it. */
export function noteStoppedDefault(repoKey: string): void {
  stopsToSay.add(repoKey)
  for (const l of stopListeners) l()
}

/** Whether to say it now for (network, repo): once per repo, recorded as said when it is. */
export function takeStoppedNotice(networkKey: string, repoId: string): boolean {
  const key = `${networkKey}:${repoId}`
  if (!stopsToSay.has(key)) return false
  stopsToSay.delete(key)
  return firstStoppedNotice(networkKey, repoId)
}

/** Whether the line was shown before; records it as shown when not. */
export function firstStoppedNotice(networkKey: string, repoId: string): boolean {
  try {
    const store = typeof localStorage === 'undefined' ? null : localStorage
    if (store === null || store.getItem(stoppedDefaultKey(networkKey, repoId)) !== null) return false
    store.setItem(stoppedDefaultKey(networkKey, repoId), String(Date.now()))
    return true
  } catch {
    return false
  }
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
  const [granted, setGranted] = useState<readonly string[]>([])
  const [maintainers, setMaintainers] = useState<readonly string[] | null>(null)
  const [stoppedDefault, setStoppedDefault] = useState(false)
  const [memberNeedsKey, setMemberNeedsKey] = useState(false)
  const isOwner = identity !== null && identity === repo.ownerId

  const repoKey = `${ACTIVE_NETWORK.key}:${repo.repoId}`
  const reconcile = useCallback(
    (view: Readonly<Record<string, unknown>> | null): Promise<Reconciled | null> =>
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
        const listed = await readMaintainers(sdk, repo).catch(() => null)
        if (!stale && listed !== null) setMaintainers(listed.filter((m) => m !== identity))
        if (config === null || stale) return
        const done = await reconcile(config).catch(() => null)
        // A share of the default storage (from before only repo storage was shared) just stopped:
        // said even if this visit moved on meanwhile (a later pass finds nothing left to stop).
        if (done?.stopped === 'default') noteStoppedDefault(repoKey)
        if (stale || done === null) return
        setWaiting(done.waiting)
        setGranted(done.granted)
        return
      }
      const maintainers = await readMaintainers(sdk, repo).catch(() => [] as string[])
      if (stale || !maintainers.includes(identity)) return
      setMemberNeedsKey((await heldSyncKeyId(DEFAULT_NETWORK, identity)) === null)
    })()
    return () => {
      stale = true
    }
  }, [user, identity, sdk, isOwner, config, reconcile, repo, repoKey])

  const [stopTick, setStopTick] = useState(0)
  useEffect(() => {
    const bump = (): void => setStopTick((t) => t + 1)
    stopListeners.add(bump)
    return () => {
      stopListeners.delete(bump)
    }
  }, [])
  useEffect(() => {
    if (isOwner && takeStoppedNotice(ACTIVE_NETWORK.key, repo.repoId)) setStoppedDefault(true)
  }, [isOwner, repo.repoId, stopTick])

  const afterRemoval = useCallback(
    async (member: string): Promise<boolean> => {
      removedHere.set(repoKey, new Set([...(removedHere.get(repoKey) ?? []), member]))
      // Before this tab's sync settled too: with no synced view the share keeps what it holds,
      // and the removed member's grant still goes, at the next epoch.
      const done = await reconcile(config).catch(() => null)
      if (done !== null) {
        setWaiting(done.waiting)
        setGranted(done.granted)
        return done.shared
      }
      // Not reconciled here (no sync key in this tab): the next visit with one moves the epoch.
      if (user === undefined || sdk === null) return false
      return (await forgeUserPort(sdk, user, null).readShare(repo.ownerId, repo.repoId).catch(() => null)) !== null
    },
    [config, reconcile, user, sdk, repo, repoKey],
  )

  const afterAdd = useCallback(
    (member: string): void => {
      removedHere.get(repoKey)?.delete(member)
    },
    [repoKey],
  )

  return { waiting, memberNeedsKey, afterRemoval, afterAdd, maintainers, granted, stoppedDefault }
}

/**
 * A maintainer's grant to a repo's storage: `granted`, `none` (the owner shares nothing with this
 * key), `no-key` (this browser holds no forge-user key), `not-maintainer`, or `off` (no sync on
 * this network, or not read: the owner, signed out).
 */
export type RepoGrantStatus = 'off' | 'pending' | 'granted' | 'none' | 'unusable' | 'no-key' | 'not-maintainer'

interface GrantRead {
  readonly status: Exclude<RepoGrantStatus, 'off' | 'pending'>
  readonly grant: GrantedStorage | null
}

// One object per status without a grant: a repeated read settles on the same value (no re-render).
const NOT_MAINTAINER: GrantRead = { status: 'not-maintainer', grant: null }
const NO_KEY: GrantRead = { status: 'no-key', grant: null }
const NONE: GrantRead = { status: 'none', grant: null }
const UNUSABLE: GrantRead = { status: 'unusable', grant: null }

/** Grant reads in flight (one per repo and identity); a settled one is read again on the next visit. */
const grantReads = new Map<string, Promise<GrantRead | null>>()
/** Bumped on a lock or a key change: a grant opened before it is dropped, and a read begun before it ignored. */
let grantGeneration = 0
const generationListeners = new Set<() => void>()
if (typeof window !== 'undefined') {
  const invalidate = (): void => {
    grantGeneration++
    grantReads.clear()
    for (const l of generationListeners) l()
  }
  onVaultLock(invalidate)
  onSyncKeyChange(invalidate)
}

function onGrantInvalidated(listener: () => void): () => void {
  generationListeners.add(listener)
  return () => {
    generationListeners.delete(listener)
  }
}

/** This maintainer's grant to `repo`'s storage, read once per visit (dropped on a lock or a key change). */
export function useRepoGrant(repo: RepoRef | null): { readonly status: RepoGrantStatus; readonly grant: GrantedStorage | null } {
  const { identity } = useAuth()
  const { sdk } = useSdk()
  const user = ACTIVE_NETWORK.v2?.user
  // The read with the scope (network, identity, repo) and generation it was made for: used only for those.
  const [read, setRead] = useState<{ readonly scope: string; readonly generation: number; readonly value: GrantRead | null } | null>(null)
  const [generation, setGeneration] = useState(grantGeneration)
  useEffect(() => onGrantInvalidated(() => setGeneration(grantGeneration)), [])
  const scope = repo === null || identity === null ? null : `${ACTIVE_NETWORK.key}:${identity}:${repo.repoId}`
  const applies = user !== undefined && repo !== null && identity !== null && identity !== repo.ownerId

  useEffect(() => {
    if (!applies || user === undefined || repo === null || identity === null || sdk === null || scope === null) return
    let stale = false
    const startedAt = grantGeneration
    let pending = grantReads.get(scope)
    if (pending === undefined) {
      pending = (async (): Promise<GrantRead> => {
        if (!(await readMaintainers(sdk, repo)).includes(identity)) return NOT_MAINTAINER
        const port = forgeUserPort(sdk, user, null)
        const got = await withSyncKey(DEFAULT_NETWORK, identity, async (keyId, E) => ({
          grant: await readGrantedStorage({ port, networkKey: ACTIVE_NETWORK.key, memberId: identity, keyId, E }, { repoId: repo.repoId, repoOwnerId: repo.ownerId }),
        }))
        if (got === null) return NO_KEY
        if (got.grant !== null) return { status: 'granted', grant: got.grant }
        // A grant there that does not open here (an older key, an epoch moving): not "nothing set".
        return (await port.grantFor(repo.ownerId, repo.repoId, identity)) === null ? NONE : UNUSABLE
      })().catch(() => null)
      const mine = pending
      grantReads.set(scope, mine)
      void mine.finally(() => {
        if (grantReads.get(scope) === mine) grantReads.delete(scope)
      })
    }
    void pending.then((value) => {
      if (!stale && grantGeneration === startedAt) setRead((prev) => (prev !== null && prev.scope === scope && prev.generation === startedAt && prev.value === value ? prev : { scope, generation: startedAt, value }))
    })
    return () => {
      stale = true
    }
  }, [applies, user, repo, identity, sdk, scope, generation])

  if (!applies) return { status: 'off', grant: null }
  const current = read !== null && read.scope === scope && read.generation === generation ? read.value : undefined
  if (current === undefined) return { status: 'pending', grant: null }
  if (current === null) return { status: 'off', grant: null }
  return current
}

/**
 * `config` as pushes to `repo` use it: with the storage the repo's owner shared with this
 * maintainer (when this browser holds a grant to it), for this repo only.
 */
export function useGrantedStorage(repo: RepoRef | null, config: StorageConfig | null): StorageConfig | null {
  const { grant } = useRepoGrant(repo)
  return config === null || repo === null ? config : withGrantedStorage(config, repo.repoId, grant)
}

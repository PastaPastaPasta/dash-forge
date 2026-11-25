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
import { readGrantedStorage, reconcileRepoShare, withGrantedStorage, type GrantedStorage, type Reconciled, type StopLine } from '@/lib/user-sync/maintainers'
import { forgeUserPort } from '@/lib/user-sync/platform'
import { syncedRemovedKeys, syncedShareView } from '@/lib/user-sync/session'
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
  /** Owner: whether the share lends storage as it stands after this tab's last reconcile (null: not yet). */
  readonly lends: boolean | null
}

/** Where the one-time "stopped sharing your default storage" line was shown, per repo (additive). */
export function stoppedDefaultKey(networkKey: string, repoId: string): string {
  return `forge:user-sync:stopped-default:${networkKey}:${repoId}`
}

/** The key's value from a stop until the line is shown (then the time it was). */
const STOP_PENDING = 'pending'

/** Stops a reconcile in this tab made, per network:repo, waiting to be said. */
const stopsToSay = new Map<string, StopLine>()
const stopListeners = new Set<() => void>()

function stopStore(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * A reconcile stopped sharing (networkKey, repoId): to be said whatever became of the visit that ran
 * it. The default-storage line also waits in its key, so a reload before it shows keeps it.
 */
export function noteStopped(networkKey: string, repoId: string, line: StopLine): void {
  try {
    const store = stopStore()
    const stored = store?.getItem(stoppedDefaultKey(networkKey, repoId)) ?? null
    // The default line waits in its key; an explicit stop after it makes it moot.
    if (line === 'default' && stored === null) store?.setItem(stoppedDefaultKey(networkKey, repoId), STOP_PENDING)
    if (line === 'removed' && stored === STOP_PENDING) store?.setItem(stoppedDefaultKey(networkKey, repoId), String(Date.now()))
  } catch {
    // Said in this tab only.
  }
  stopsToSay.set(`${networkKey}:${repoId}`, line)
  for (const l of stopListeners) l()
}

/**
 * The line to say now for (network, repo), if any: the default-storage one once per repo, recorded as
 * said, and not at all once the repo has storage of its own (`repoStorageSet`: set since, elsewhere).
 */
export function takeStoppedNotice(networkKey: string, repoId: string, repoStorageSet = false): StopLine | null {
  const noted = stopsToSay.get(`${networkKey}:${repoId}`)
  stopsToSay.delete(`${networkKey}:${repoId}`)
  if (noted === 'removed') return 'removed'
  const key = stoppedDefaultKey(networkKey, repoId)
  try {
    const store = stopStore()
    const stored = store?.getItem(key) ?? null
    if (stored === STOP_PENDING) {
      store?.setItem(key, String(Date.now()))
      return repoStorageSet ? null : 'default'
    }
    if (repoStorageSet) return null
    // Noted here but not recordable (storage blocked): said in this tab.
    return noted === 'default' && stored === null ? 'default' : null
  } catch {
    return noted === 'default' && !repoStorageSet ? 'default' : null
  }
}

/**
 * The owner's line for a share a reconcile stopped (see `StopLine`), to the owner only, taken only
 * while `visible` (the Storage section shows): a stop made on another section is said there, not lost.
 */
export function useStoppedShareNotice(repo: RepoRef, visible: boolean): StopLine | null {
  const { identity } = useAuth()
  const [said, setSaid] = useState<{ readonly owner: string; readonly repoId: string; readonly line: StopLine } | null>(null)
  const [tick, setTick] = useState(0)
  const on = ACTIVE_NETWORK.v2?.user !== undefined
  const owner = identity !== null && identity === repo.ownerId ? identity : null
  useEffect(() => {
    if (!on) return
    const bump = (): void => setTick((t) => t + 1)
    stopListeners.add(bump)
    return () => {
      stopListeners.delete(bump)
    }
  }, [on])
  useEffect(() => {
    if (!on || !visible || owner === null) return
    const taken = takeStoppedNotice(ACTIVE_NETWORK.key, repo.repoId, Object.hasOwn(syncedShareView(owner) ?? {}, `repo:${repo.repoId}`))
    if (taken !== null) setSaid({ owner, repoId: repo.repoId, line: taken })
  }, [on, visible, owner, repo.repoId, tick])
  return said !== null && said.owner === owner && said.repoId === repo.repoId ? said.line : null
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
  const removedKeys = identity !== null && syncKind === 'synced' ? syncedRemovedKeys(identity) : null
  const [waiting, setWaiting] = useState<readonly string[]>([])
  const [granted, setGranted] = useState<readonly string[]>([])
  const [lends, setLends] = useState<boolean | null>(null)
  const [maintainers, setMaintainers] = useState<readonly string[] | null>(null)
  const [memberNeedsKey, setMemberNeedsKey] = useState(false)
  const isOwner = identity !== null && identity === repo.ownerId

  const repoKey = `${ACTIVE_NETWORK.key}:${repo.repoId}`
  const reconcile = useCallback(
    (view: Readonly<Record<string, unknown>> | null, removedKeys: readonly string[] | null): Promise<Reconciled | null> =>
      oneAtATime(repoKey, async () => {
        if (user === undefined || identity === null || sdk === null || signer === null || !isOwner) return null
        const maintainers = await readMaintainers(sdk, repo)
        const removed = [...(removedHere.get(repoKey) ?? [])]
        const repoPolicyRemoved = view !== null && (removedKeys ?? []).includes(`repo:${repo.repoId}`)
        return withSyncKey(DEFAULT_NETWORK, identity, (keyId, E) =>
          spendAction(namedAction('Storage shared with maintainers'), (tag) =>
            reconcileRepoShare({ port: forgeUserPort(sdk, user, tag(quietSigner(controller, signer))), networkKey: ACTIVE_NETWORK.key, ownerId: identity, keyId, E }, { repoId: repo.repoId, view, maintainers, removed, repoPolicyRemoved }),
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
        const done = await reconcile(config, removedKeys).catch(() => null)
        // Sharing just stopped: said even if this visit moved on meanwhile (a later pass finds nothing left to stop).
        if (done?.stopped !== undefined) noteStopped(ACTIVE_NETWORK.key, repo.repoId, done.stopped)
        if (stale || done === null) return
        setWaiting(done.waiting)
        setGranted(done.granted)
        setLends(done.lends)
        return
      }
      const maintainers = await readMaintainers(sdk, repo).catch(() => [] as string[])
      if (stale || !maintainers.includes(identity)) return
      setMemberNeedsKey((await heldSyncKeyId(DEFAULT_NETWORK, identity)) === null)
    })()
    return () => {
      stale = true
    }
  }, [user, identity, sdk, isOwner, config, removedKeys, reconcile, repo])

  // The owner's maintainers again, after this tab added or removed one (the card counts them).
  const refreshMaintainers = useCallback(async (): Promise<void> => {
    if (user === undefined || identity === null || sdk === null || !isOwner) return
    const listed = await readMaintainers(sdk, repo).catch(() => null)
    if (listed !== null) setMaintainers(listed.filter((m) => m !== identity))
  }, [user, identity, sdk, isOwner, repo])

  const afterRemoval = useCallback(
    async (member: string): Promise<boolean> => {
      removedHere.set(repoKey, new Set([...(removedHere.get(repoKey) ?? []), member]))
      // Before this tab's sync settled too: with no synced view the share keeps what it holds,
      // and the removed member's grant still goes, at the next epoch.
      const done = await reconcile(config, removedKeys).catch(() => null)
      if (done?.stopped !== undefined) noteStopped(ACTIVE_NETWORK.key, repo.repoId, done.stopped)
      void refreshMaintainers()
      if (done !== null) {
        setWaiting(done.waiting)
        setGranted(done.granted)
        setLends(done.lends)
        return done.shared
      }
      // Not reconciled here (no sync key in this tab): the next visit with one moves the epoch.
      if (user === undefined || sdk === null) return false
      return (await forgeUserPort(sdk, user, null).readShare(repo.ownerId, repo.repoId).catch(() => null)) !== null
    },
    [config, removedKeys, reconcile, user, sdk, repo, repoKey, refreshMaintainers],
  )

  const afterAdd = useCallback(
    (member: string): void => {
      removedHere.get(repoKey)?.delete(member)
      void (async () => {
        await refreshMaintainers()
        // The new maintainer gets the repo's storage now (as `dg collab add` does), not on the next visit.
        if (config === null) return
        const done = await reconcile(config, removedKeys).catch(() => null)
        if (done?.stopped !== undefined) noteStopped(ACTIVE_NETWORK.key, repo.repoId, done.stopped)
        if (done === null) return
        setWaiting(done.waiting)
        setGranted(done.granted)
        setLends(done.lends)
      })()
    },
    [repoKey, refreshMaintainers, config, removedKeys, reconcile, repo],
  )

  return { waiting, memberNeedsKey, afterRemoval, afterAdd, maintainers, granted, lends }
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

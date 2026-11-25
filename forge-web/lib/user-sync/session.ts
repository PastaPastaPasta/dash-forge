/**
 * This tab's settings sync: whether it runs for the signed-in identity, its last outcome, and the
 * effective storage config it produced (memory only: it holds credentials). One run at a time; a
 * request while one runs makes one more run after it.
 */

import type { StorageConfig } from '../storage/store'
import { vaultLockGeneration } from '../auth/vault'
import type { SyncOutcome } from './service'

export type UserSyncStatus =
  /** No forge-user on this network, or nobody signed in. */
  | { readonly kind: 'off' }
  /** Signed in without the sync key (not a wallet sign-in, or the wallet did not send it, or locked). */
  | { readonly kind: 'local'; readonly syncedAt: number | null }
  | { readonly kind: 'syncing'; readonly syncedAt: number | null }
  | { readonly kind: 'synced'; readonly syncedAt: number }
  | { readonly kind: 'error'; readonly syncedAt: number | null; readonly message: string }

interface State {
  readonly identityId: string | null
  readonly status: UserSyncStatus
  readonly storage: StorageConfig | null
  /** The synced storage slot's live entries (what a repo's share is taken from), from the last sync. */
  readonly synced?: Readonly<Record<string, unknown>> | null
  /** That slot's tombstoned keys, read only with `synced`. */
  readonly syncedRemoved?: readonly string[] | null
}

let state: State = { identityId: null, status: { kind: 'off' }, storage: null }
const listeners = new Set<() => void>()
const storageListeners = new Set<() => void>()

function set(next: State): void {
  const storageChanged = next.storage !== state.storage
  state = next
  for (const l of listeners) l()
  if (storageChanged) for (const l of storageListeners) l()
}

export function subscribeUserSync(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Be told when the effective storage config changes (a sync finished, or ended). */
export function onSyncedStorage(listener: () => void): () => void {
  storageListeners.add(listener)
  return () => {
    storageListeners.delete(listener)
  }
}

export function userSyncStatus(): UserSyncStatus {
  return state.status
}

/** The effective storage config the last sync produced for `identityId`, or null (use the local one). */
export function syncedStorage(identityId: string): StorageConfig | null {
  return state.identityId === identityId ? state.storage : null
}

/** The synced storage slot's live entries for `identityId` from this tab's last sync, or null (none yet). */
export function syncedShareView(identityId: string): Readonly<Record<string, unknown>> | null {
  return state.identityId === identityId ? (state.synced ?? null) : null
}

/** The synced storage slot's tombstoned keys for `identityId` (with `syncedShareView`), or null. */
export function syncedRemovedKeys(identityId: string): readonly string[] | null {
  return state.identityId === identityId && state.synced ? (state.syncedRemoved ?? []) : null
}

/** Who sync is for now, and whether it can run (it holds the key); drops the last outcome on a change. */
export function setSyncSubject(identityId: string | null, status: UserSyncStatus): void {
  if (identityId !== state.identityId) set({ identityId, status, storage: null, synced: null })
  else if (state.status.kind !== 'syncing' && (status.kind !== state.status.kind || status.kind === 'off')) set({ ...state, status, ...(status.kind === 'off' || status.kind === 'local' ? { storage: null, synced: null } : {}) })
}

let running: Promise<void> | null = null
interface Request {
  readonly identityId: string
  readonly exec: () => Promise<SyncOutcome | null>
}
let again: Request | null = null

/**
 * Run `exec` (one sync; null: it could not run, the key is gone). Single-flight: a request while
 * one runs is kept, and the latest one runs once the current one ends.
 */
export function requestUserSync(identityId: string, exec: () => Promise<SyncOutcome | null>): Promise<void> {
  if (running) {
    again = { identityId, exec }
    return running
  }
  const run = async (): Promise<void> => {
    let next: Request | null = { identityId, exec }
    try {
      while (next) {
        const { identityId, exec: current } = next
        again = null
        const syncedAt = 'syncedAt' in state.status ? state.status.syncedAt : null
        const generation = vaultLockGeneration()
        try {
          if (state.identityId === identityId) set({ ...state, status: { kind: 'syncing', syncedAt } })
          const saves = localSaves
          const outcome = await current()
          // Locked meanwhile: what the run decrypted is not kept.
          if (vaultLockGeneration() !== generation) {
            if (state.identityId === identityId) set({ ...state, status: { kind: 'local', syncedAt }, storage: null, synced: null })
          } else if (state.identityId === identityId) {
            if (outcome === null) set({ ...state, status: { kind: 'local', syncedAt } })
            // A Settings save during the run shows what it saved: the run's view predates it (the next run follows).
            else set({ identityId, status: { kind: 'synced', syncedAt: outcome.syncedAt }, storage: localSaves !== saves ? state.storage : (outcome.storage ?? state.storage), synced: outcome.synced ?? state.synced ?? null, syncedRemoved: outcome.synced ? (outcome.syncedRemoved ?? []) : (state.syncedRemoved ?? null) })
          }
        } catch (e) {
          if (state.identityId === identityId) set({ ...state, status: { kind: 'error', syncedAt, message: e instanceof Error ? e.message : String(e) } })
        }
        next = again
      }
    } finally {
      // No await between the last check of `again` and this: a request made later starts a new run.
      running = null
    }
  }
  running = run()
  return running
}

/** Forget the decrypted effective config (a lock). */
export function dropSyncedStorage(): void {
  if (state.storage !== null || state.synced) set({ ...state, storage: null, synced: null })
}

const changeListeners = new Set<() => void>()

/** Local settings changed here (a Settings save): sync again. */
export function noteLocalSettingsChange(): void {
  for (const l of changeListeners) l()
}

export function onLocalSettingsChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

let localSaves = 0

/** Who sync is for in this tab now (the signed-in identity), or null. */
export function syncSubject(): string | null {
  return state.identityId
}

/** Show `config` as the effective one until the sync it starts finishes (a Settings save). */
export function setSyncedStorage(identityId: string, config: StorageConfig): void {
  localSaves++
  if (state.identityId === identityId && state.storage !== null) set({ ...state, storage: config })
}

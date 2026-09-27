/**
 * A minimal IndexedDB key-value layer: one database, a few object stores, promise-shaped.
 *
 * Holds the browser's local state that must survive a reload but never leaves the device:
 * the spend ledger, write journals (a repo creation interrupted half-way), the key vault, and
 * the local notifications inbox (items, per-feed cursors, subscriptions).
 * Every call is browser-only; outside a browser (SSR, vitest) the stores are in-memory maps,
 * so the modules built on this stay testable without a fake IndexedDB.
 */

export type StoreName = 'spend' | 'journal' | 'vault' | 'inbox'

const DB_NAME = 'dash-forge'
// Bump on every new store; the upgrade only ever adds stores (STORES stays additive).
const DB_VERSION = 2
const STORES: readonly StoreName[] = ['spend', 'journal', 'vault', 'inbox']

/** How long a caller waits for the database to open before it gets an error. */
export const IDB_OPEN_TIMEOUT_MS = 10_000

/** Another tab holds an older version of the database open, so this one cannot upgrade it. */
export class IdbBlockedError extends Error {
  constructor() {
    super('Dash Forge is open in another tab running an older version, which holds this browser’s storage. Close or reload the other Dash Forge tabs, then try again.')
    this.name = 'IdbBlockedError'
  }
}

/**
 * The one open request, kept until it settles. It is never abandoned while blocked: a second
 * `indexedDB.open` queues behind a blocked upgrade and then fires no event at all, which left
 * every later read waiting forever. The blocked request itself completes once the other tab
 * closes or reloads, so a retry after that succeeds.
 */
let opening: Promise<IDBDatabase> | null = null
let blocked = false
const blockedWaiters = new Set<() => void>()
const memory = new Map<StoreName, Map<string, unknown>>()

/**
 * A newer Dash Forge (another tab) upgraded this browser's storage: this tab let go of it and
 * runs an older build, so it should reload. The app shell shows a banner.
 */
let superseded = false
const supersededListeners = new Set<() => void>()

function markSuperseded(): void {
  if (superseded) return
  superseded = true
  for (const l of supersededListeners) l()
}

export function storageSuperseded(): boolean {
  return superseded
}

export function onStorageSuperseded(listener: () => void): () => void {
  supersededListeners.add(listener)
  return () => {
    supersededListeners.delete(listener)
  }
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function startOpen(): Promise<IDBDatabase> {
  blocked = false
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name)
      }
    }
    // Another tab still holds the old version open: the upgrade waits until it lets go.
    req.onblocked = () => {
      blocked = true
      for (const w of blockedWaiters) w()
    }
    req.onsuccess = () => {
      blocked = false
      const db = req.result
      // A newer tab wants to upgrade: let go so it is not blocked, and say this tab is behind.
      db.onversionchange = () => {
        db.close()
        if (opening === p) opening = null
        markSuperseded()
      }
      resolve(db)
    }
    req.onerror = () => {
      blocked = false
      if (opening === p) opening = null
      reject(req.error ?? new Error('IndexedDB open failed'))
    }
  })
  // Settles with no caller waiting when every caller already gave up (blocked or timed out).
  p.catch(() => undefined)
  return p
}

/** The database, or an error within {@link IDB_OPEN_TIMEOUT_MS}: blocked, failed or stuck. */
function open(): Promise<IDBDatabase> {
  if (!opening) opening = startOpen()
  if (blocked) return Promise.reject(new IdbBlockedError())
  const request = opening
  return new Promise<IDBDatabase>((resolve, reject) => {
    const onBlocked = (): void => settle(() => reject(new IdbBlockedError()))
    const timer = setTimeout(
      () => settle(() => reject(new Error(`This browser’s storage (IndexedDB) did not open within ${IDB_OPEN_TIMEOUT_MS / 1000} s. Reload the page and try again.`))),
      IDB_OPEN_TIMEOUT_MS,
    )
    const settle = (fn: () => void): void => {
      clearTimeout(timer)
      blockedWaiters.delete(onBlocked)
      fn()
    }
    blockedWaiters.add(onBlocked)
    request.then(
      (db) => settle(() => resolve(db)),
      (e: unknown) => settle(() => reject(e)),
    )
  })
}

function mem(store: StoreName): Map<string, unknown> {
  let m = memory.get(store)
  if (!m) {
    m = new Map()
    memory.set(store, m)
  }
  return m
}

async function run<T>(store: StoreName, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = op(tx.objectStore(store))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

/** Read one value, or undefined. */
export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  if (!hasIndexedDb()) return structuredClone(mem(store).get(key)) as T | undefined
  return (await run(store, 'readonly', (s) => s.get(key))) as T | undefined
}

/** Write one value (structured-cloned; Uint8Arrays stay binary). */
export async function idbPut<T>(store: StoreName, key: string, value: T): Promise<void> {
  if (!hasIndexedDb()) {
    mem(store).set(key, structuredClone(value))
    return
  }
  await run(store, 'readwrite', (s) => s.put(value, key))
}

/**
 * Several puts and deletes in ONE store, atomically: one transaction, so a crash or a failed
 * write leaves either all of them or none (`value: undefined` deletes the key).
 */
export async function idbBatch(store: StoreName, ops: readonly (readonly [string, unknown])[]): Promise<void> {
  if (!hasIndexedDb()) {
    const m = mem(store)
    for (const [k, v] of ops) {
      if (v === undefined) m.delete(k)
      else m.set(k, structuredClone(v))
    }
    return
  }
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    const s = tx.objectStore(store)
    for (const [k, v] of ops) {
      if (v === undefined) s.delete(k)
      else s.put(v, k)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

/** Delete one value (no-op when absent). */
export async function idbDelete(store: StoreName, key: string): Promise<void> {
  if (!hasIndexedDb()) {
    mem(store).delete(key)
    return
  }
  await run(store, 'readwrite', (s) => s.delete(key))
}

/** Every `[key, value]` in a store whose key starts with `prefix`. */
export async function idbEntries<T>(store: StoreName, prefix = ''): Promise<[string, T][]> {
  if (!hasIndexedDb()) {
    return [...mem(store).entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => [k, structuredClone(v) as T])
  }
  const range = prefix === '' ? undefined : IDBKeyRange.bound(prefix, `${prefix}￿`)
  const db = await open()
  return new Promise((resolve, reject) => {
    const out: [string, T][] = []
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).openCursor(range)
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      out.push([String(cursor.key), cursor.value as T])
      cursor.continue()
    }
    tx.oncomplete = () => resolve(out)
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB cursor failed'))
  })
}

/** Test hook: forget the in-memory fallback stores. */
export function resetMemoryStores(): void {
  memory.clear()
}

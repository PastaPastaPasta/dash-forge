/**
 * A minimal IndexedDB key-value layer: one database, a few object stores, promise-shaped.
 *
 * Holds the browser's local state that must survive a reload but never leaves the device:
 * the spend ledger, write journals (a repo creation interrupted half-way), and the key vault.
 * Every call is browser-only; outside a browser (SSR, vitest) the stores are in-memory maps,
 * so the modules built on this stay testable without a fake IndexedDB.
 */

export type StoreName = 'spend' | 'journal' | 'vault'

const DB_NAME = 'dash-forge'
const DB_VERSION = 1
const STORES: readonly StoreName[] = ['spend', 'journal', 'vault']

let dbPromise: Promise<IDBDatabase> | null = null
const memory = new Map<StoreName, Map<string, unknown>>()

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
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

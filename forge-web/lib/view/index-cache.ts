/**
 * Persistent cache for a repo's browse-index artifacts (objectLocator fragments), keyed by
 * their manifest's `packHash` (D-023).
 *
 * Without it every page load of an S3- or IPFS-stored repo downloads the whole index again:
 * 14.4 MB on a 408k-object repo, cold and warm. The artifacts are content-addressed (the
 * manifest's `packHash` is the sha256 of the bytes), so a stored copy is valid for as long as
 * any manifest names it, and it is checked against that hash on every read as well as before it
 * is stored: a corrupt or tampered IndexedDB entry is a miss, never a wrong index.
 *
 * Self-contained on purpose. The P-2 delta-cache work will cover the other browse caches and
 * can fold this store into its own; nothing else depends on its layout.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** Where verified artifacts are kept. Tests pass an in-memory one. */
export interface ArtifactStore {
  get(key: string): Promise<Uint8Array | undefined>
  put(key: string, bytes: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
}

const DB_NAME = 'dash-forge-index'
const DB_VERSION = 1
const STORE = 'artifacts'
/** Stored artifacts beyond this total are evicted, least recently stored first. */
export const INDEX_CACHE_BUDGET_BYTES = 256 * 1024 * 1024

interface Record_ {
  readonly key: string
  readonly bytes: ArrayBuffer
  readonly size: number
  readonly at: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('could not open the index cache'))
    req.onblocked = () => reject(new Error('index cache upgrade blocked'))
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('index cache transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('index cache transaction aborted'))
  })
}

/** The browser's IndexedDB-backed store, or null outside a browser. */
function idbStore(): ArtifactStore | null {
  if (typeof indexedDB === 'undefined') return null
  const withDb = async <T>(op: (db: IDBDatabase) => Promise<T>): Promise<T | undefined> => {
    let db: IDBDatabase | null = null
    try {
      db = await openDb()
      return await op(db)
    } catch {
      return undefined // storage unavailable or full: the cache is best-effort
    } finally {
      db?.close()
    }
  }
  return {
    get: (key) =>
      withDb(async (db) => {
        const tx = db.transaction(STORE, 'readonly')
        const req = tx.objectStore(STORE).get(key)
        await done(tx)
        const rec = req.result as Record_ | undefined
        return rec?.bytes instanceof ArrayBuffer ? new Uint8Array(rec.bytes) : undefined
      }),
    put: async (key, bytes) => {
      await withDb(async (db) => {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        store.put({ key, bytes: bytes.slice().buffer, size: bytes.length, at: Date.now() } satisfies Record_)
        // Evict the oldest entries past the budget (a handful of rows; sizes are stored).
        const all = store.getAll()
        all.onsuccess = () => {
          const rows = (all.result as Record_[]).sort((a, b) => b.at - a.at)
          let total = 0
          for (const r of rows) {
            total += r.size
            if (total > INDEX_CACHE_BUDGET_BYTES && r.key !== key) store.delete(r.key)
          }
        }
        await done(tx)
      })
    },
    delete: async (key) => {
      await withDb(async (db) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(key)
        await done(tx)
      })
    },
  }
}

let defaultStore: ArtifactStore | null | undefined

/** Test hook: use `store` (null: no cache) instead of IndexedDB. */
export function setIndexArtifactStore(store: ArtifactStore | null): void {
  defaultStore = store
}

/** An in-memory {@link ArtifactStore} (tests). */
export function memoryArtifactStore(): ArtifactStore & { readonly entries: Map<string, Uint8Array> } {
  const entries = new Map<string, Uint8Array>()
  return {
    entries,
    get: async (key) => entries.get(key),
    put: async (key, bytes) => void entries.set(key, bytes),
    delete: async (key) => void entries.delete(key),
  }
}

/** The artifact store for this page (IndexedDB in a browser; none elsewhere). */
export function indexArtifactStore(): ArtifactStore | null {
  if (defaultStore === undefined) defaultStore = idbStore()
  return defaultStore
}

/**
 * The bytes of the artifact whose sha256 is `packHash`: from the store when it holds a copy
 * that still hashes to it, else from `load` — stored afterwards only if the loaded bytes hash
 * to `packHash` too. `scope` separates networks (the same bytes on testnet and a devnet are
 * still the same bytes, but a cache shared across them would be surprising to reason about).
 */
export async function loadIndexArtifact(
  scope: string,
  packHash: string,
  load: () => Promise<Uint8Array>,
  store: ArtifactStore | null = indexArtifactStore(),
): Promise<Uint8Array> {
  const want = packHash.toLowerCase()
  if (store === null) return load()
  const key = `${scope}:${want}`
  const hit = await store.get(key).catch(() => undefined)
  if (hit !== undefined) {
    if (bytesToHex(sha256(hit)) === want) return hit
    await store.delete(key).catch(() => undefined)
  }
  const bytes = await load()
  if (bytesToHex(sha256(bytes)) === want) void store.put(key, bytes).catch(() => undefined)
  return bytes
}

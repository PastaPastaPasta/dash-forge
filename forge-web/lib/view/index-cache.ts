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
  /** Several entries in one read (one IndexedDB transaction). */
  getMany?(keys: readonly string[]): Promise<(Uint8Array | undefined)[]>
  put(key: string, bytes: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
}

const DB_NAME = 'dash-forge-index'
const DB_VERSION = 1
/** Artifact bytes, keyed by `scope:packHash`. */
const BYTES = 'artifacts'
/** `{ key, size, at }` per artifact: what eviction reads, so it never loads the bytes. */
const META = 'meta'
/** Stored artifacts beyond this total are evicted, least recently used first. */
export const INDEX_CACHE_BUDGET_BYTES = 256 * 1024 * 1024

interface Meta {
  readonly key: string
  readonly size: number
  /** Last stored or read (ms). */
  readonly at: number
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const req = indexedDB.open(name, DB_VERSION)
    req.onupgradeneeded = () => {
      for (const name of [BYTES, META]) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => {
      // Opened after the caller gave up on a blocked upgrade: nobody will close it otherwise.
      if (settled) req.result.close()
      else resolve(req.result)
      settled = true
    }
    req.onerror = () => {
      settled = true
      reject(req.error ?? new Error('could not open the index cache'))
    }
    req.onblocked = () => {
      settled = true
      reject(new Error('index cache upgrade blocked'))
    }
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('index cache transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('index cache transaction aborted'))
  })
}

/** The IndexedDB-backed store, or null where there is no IndexedDB. */
export function idbArtifactStore(budget = INDEX_CACHE_BUDGET_BYTES, name = DB_NAME): ArtifactStore | null {
  if (typeof indexedDB === 'undefined') return null
  const withDb = async <T>(op: (db: IDBDatabase) => Promise<T>): Promise<T | undefined> => {
    let db: IDBDatabase | null = null
    try {
      db = await openDb(name)
      return await op(db)
    } catch {
      return undefined // storage unavailable or full: the cache is best-effort
    } finally {
      db?.close()
    }
  }
  const getMany = async (keys: readonly string[]): Promise<(Uint8Array | undefined)[]> =>
    (await withDb(async (db) => {
      const tx = db.transaction([BYTES, META], 'readwrite')
      const reqs = keys.map((key) => {
        const req = tx.objectStore(BYTES).get(key)
        req.onsuccess = () => {
          const rec = req.result as { bytes?: unknown } | undefined
          // Touch: eviction is least recently USED, so a repo visited daily stays.
          if (rec?.bytes instanceof ArrayBuffer) tx.objectStore(META).put({ key, size: rec.bytes.byteLength, at: Date.now() } satisfies Meta)
        }
        return req
      })
      await done(tx)
      return reqs.map((req) => {
        const rec = req.result as { bytes?: unknown } | undefined
        return rec?.bytes instanceof ArrayBuffer ? new Uint8Array(rec.bytes) : undefined
      })
    })) ?? keys.map(() => undefined)
  return {
    get: async (key) => (await getMany([key]))[0],
    getMany,
    put: async (key, bytes) => {
      await withDb(async (db) => {
        const tx = db.transaction([BYTES, META], 'readwrite')
        const store = tx.objectStore(BYTES)
        const meta = tx.objectStore(META)
        store.put({ key, bytes: bytes.slice().buffer })
        meta.put({ key, size: bytes.length, at: Date.now() } satisfies Meta)
        // Evict the least recently used past the budget, reading only the small meta rows.
        const all = meta.getAll()
        all.onsuccess = () => {
          const rows = (all.result as Meta[]).sort((a, b) => b.at - a.at)
          let total = 0
          for (const r of rows) {
            total += r.size
            if (total > budget && r.key !== key) {
              store.delete(r.key)
              meta.delete(r.key)
            }
          }
        }
        await done(tx)
      })
    },
    delete: async (key) => {
      await withDb(async (db) => {
        const tx = db.transaction([BYTES, META], 'readwrite')
        tx.objectStore(BYTES).delete(key)
        tx.objectStore(META).delete(key)
        await done(tx)
      })
    },
  }
}

/** SHA-256 hex: WebCrypto where the page has it (several times faster on a 14 MB index). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle !== undefined) {
    try {
      return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource)))
    } catch {
      /* fall through to the JS implementation */
    }
  }
  return bytesToHex(sha256(bytes))
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
  if (defaultStore === undefined) defaultStore = idbArtifactStore()
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
  const hit = await storedIndexArtifact(scope, want, store)
  if (hit !== undefined) return hit
  const bytes = await load()
  if ((await sha256Hex(bytes)) === want) void store.put(`${scope}:${want}`, bytes).catch(() => undefined)
  return bytes
}

/**
 * The stored copy of the artifact whose sha256 is `packHash`, if the store holds one that still
 * hashes to it ({@link loadIndexArtifact}'s hit, without loading anything on a miss).
 */
export async function storedIndexArtifact(
  scope: string,
  packHash: string,
  store: ArtifactStore | null = indexArtifactStore(),
): Promise<Uint8Array | undefined> {
  if (store === null) return undefined
  const want = packHash.toLowerCase()
  const key = `${scope}:${want}`
  const hit = await store.get(key).catch(() => undefined)
  if (hit === undefined) return undefined
  if ((await sha256Hex(hit)) === want) return hit
  await store.delete(key).catch(() => undefined)
  return undefined
}

/**
 * Where an index range is kept: unlike a whole artifact (checked against its sha256 before it is
 * kept or served), a range is unchecked, so it is keyed by the copy it was read from, `copy` (the
 * network's repo and uploader, whose Platform chunks only that uploader can write), never by the
 * pack hash alone: another repo's manifest naming the same hash must not supply its rows.
 */
const rangeKey = (copy: string, packHash: string, start: number, end: number): string => `${copy}:${packHash.toLowerCase()}@${start}-${end}`

/**
 * The kept copies of byte ranges `[start, end)` of the artifact whose sha256 is `packHash`
 * (QW3-001: a large index's fanout and the slices pages looked objects up in), in one store read;
 * undefined for each one not kept. A range cannot be hashed on its own, so the caller checks what
 * it gets: an index slice's shape, then every object read through it against its oid.
 */
export async function storedIndexRanges(
  copy: string,
  packHash: string,
  ranges: readonly (readonly [number, number])[],
  store: ArtifactStore | null = indexArtifactStore(),
): Promise<(Uint8Array | undefined)[]> {
  if (store === null || ranges.length === 0) return ranges.map(() => undefined)
  const keys = ranges.map(([start, end]) => rangeKey(copy, packHash, start, end))
  const got = await (store.getMany !== undefined ? store.getMany(keys) : Promise.all(keys.map((k) => store.get(k)))).catch(() => keys.map(() => undefined))
  return got.map((bytes, i) => {
    const [start, end] = ranges[i] as readonly [number, number]
    return bytes !== undefined && bytes.length === end - start ? bytes : undefined
  })
}

/** Keep range `[start, end)` of copy `copy` of artifact `packHash` for the next visit ({@link storedIndexRanges}). */
export function keepIndexRange(copy: string, packHash: string, start: number, end: number, bytes: Uint8Array, store: ArtifactStore | null = indexArtifactStore()): void {
  if (store !== null && bytes.length === end - start) void store.put(rangeKey(copy, packHash, start, end), bytes).catch(() => undefined)
}

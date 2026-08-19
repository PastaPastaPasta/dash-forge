/**
 * Persistent storage for fallback-cloned repositories.
 *
 * A fallback clone is content-addressed by its ordered live-pack manifest. Keeping the
 * verified packs and synthesized locator in IndexedDB lets a hard reload reconstruct the
 * ordinary BrowseReader without downloading or indexing the repository again. The cache is
 * best-effort: unavailable, full, or corrupt browser storage degrades to the normal download.
 */

import type { PackManifest } from '../repo'

const DB_NAME = 'dash-forge-browse'
const DB_VERSION = 1
const STORE_NAME = 'fallback-clones'
const RECORD_VERSION = 1

interface FallbackRecord {
  readonly contractId: string
  readonly version: number
  readonly manifestKey: string
  readonly locator: ArrayBuffer
  readonly packs: readonly ArrayBuffer[]
}

export interface StoredFallback {
  readonly locator: Uint8Array
  readonly packs: readonly Uint8Array[]
}

/** Exact content-and-order identity for the packRef space represented by a fallback clone. */
export function fallbackManifestKey(livePacks: readonly PackManifest[]): string {
  return livePacks
    .map((pack) => `${pack.packHash.toLowerCase()}:${pack.sizeBytes}:${pack.objectCount}`)
    .join('|')
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'contractId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('could not open fallback cache'))
    request.onblocked = () => {
      request.onsuccess = () => request.result.close()
      reject(new Error('fallback cache upgrade blocked'))
    }
  })
}

async function withDatabase<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T | null> {
  let database: IDBDatabase | null = null
  try {
    database = await openDatabase()
    return database === null ? null : await operation(database)
  } catch {
    return null
  } finally {
    database?.close()
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('fallback cache request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('fallback cache transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('fallback cache transaction aborted'))
  })
}

function isFallbackRecord(value: unknown): value is FallbackRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<FallbackRecord>
  return (
    typeof record.contractId === 'string' &&
    record.version === RECORD_VERSION &&
    typeof record.manifestKey === 'string' &&
    record.locator instanceof ArrayBuffer &&
    Array.isArray(record.packs) &&
    record.packs.every((pack) => pack instanceof ArrayBuffer)
  )
}

/** Read an exact-manifest fallback clone. Storage failures and stale records are cache misses. */
export async function loadStoredFallback(
  contractId: string,
  livePacks: readonly PackManifest[],
): Promise<StoredFallback | null> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const value: unknown = await requestResult(transaction.objectStore(STORE_NAME).get(contractId))
    if (!isFallbackRecord(value) || value.manifestKey !== fallbackManifestKey(livePacks)) return null
    if (value.packs.length !== livePacks.length) return null
    return {
      locator: new Uint8Array(value.locator),
      packs: value.packs.map((pack) => new Uint8Array(pack)),
    }
  })
}

/** Persist a completed clone. Callers do not fail merely because browser storage is unavailable. */
export async function storeFallback(
  contractId: string,
  livePacks: readonly PackManifest[],
  fallback: StoredFallback,
): Promise<void> {
  await withDatabase(async (database) => {
    const record: FallbackRecord = {
      contractId,
      version: RECORD_VERSION,
      manifestKey: fallbackManifestKey(livePacks),
      locator: fallback.locator.slice().buffer,
      packs: fallback.packs.map((pack) => pack.slice().buffer),
    }
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(record)
    await transactionDone(transaction)
  })
}

/** Remove an unusable persisted clone so the next successful download can replace it. */
export async function deleteStoredFallback(contractId: string): Promise<void> {
  await withDatabase(async (database) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(contractId)
    await transactionDone(transaction)
  })
}

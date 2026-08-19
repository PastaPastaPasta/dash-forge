/**
 * Fallback clone orchestrator — in-browser browsing for repos with no published
 * objectLocator.
 *
 * Downloads the repo's live kind-0 packs whole (each sha256-verified against its
 * consensus-proven `packManifest.packHash`, mirroring `git-remote-dash::fetch`), indexes
 * them client-side (`lib/browse/indexer` — dynamically imported so pako stays out of the
 * main bundles), and assembles the same {@link BrowseContext} the locator path produces,
 * so every downstream view works unchanged.
 *
 * One in-flight/completed context is cached per contract for the session, while completed
 * clones are persisted in IndexedDB — navigation and hard reloads neither re-download nor
 * re-index an unchanged pack set. Failed runs are evicted so a retry starts clean. When
 * flatIndex-backed features (filename search / full listing) gain UI consumers, this context
 * can synthesize a listing by walking trees through the in-memory reader.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { BrowseReader, ObjectLocator } from '../browse'
import type { PackManifest, RepoRef } from '../repo'
import { loadArtifactBytesProgress, type BrowseContext } from './browse-source'
import {
  deleteStoredFallback,
  fallbackManifestKey,
  loadStoredFallback,
  storeFallback,
  type StoredFallback,
} from './fallback-cache'

/** Progress of a fallback run: whole-pack download, then client-side indexing. */
export interface FallbackProgress {
  readonly phase: 'download' | 'index'
  readonly bytesFetched: number
  readonly bytesTotal: number
  readonly objectsIndexed: number
  readonly objectsTotal: number
}

interface CacheEntry {
  readonly manifestKey: string
  readonly promise: Promise<BrowseContext>
}

const cache = new Map<string, CacheEntry>()
const restores = new Map<string, Promise<BrowseContext | null>>()

function remember(contractId: string, manifestKey: string, promise: Promise<BrowseContext>): Promise<BrowseContext> {
  const entry: CacheEntry = { manifestKey, promise }
  cache.set(contractId, entry)
  promise.catch(() => {
    if (cache.get(contractId) === entry) cache.delete(contractId)
  })
  return promise
}

/** The session's in-flight or completed fallback context for a contract, if any. */
export function cachedFallback(
  contractId: string,
  livePacks?: readonly PackManifest[],
): Promise<BrowseContext> | null {
  const entry = cache.get(contractId)
  if (entry === undefined) return null
  if (livePacks !== undefined && entry.manifestKey !== fallbackManifestKey(livePacks)) return null
  return entry.promise
}

/**
 * Restore a completed fallback clone from browser storage. A missing, stale, or corrupt record
 * is a cache miss, not an error; the caller can then offer the ordinary download action.
 */
export function restoreFallback(
  repo: RepoRef,
  livePacks: readonly PackManifest[],
): Promise<BrowseContext | null> {
  const manifestKey = fallbackManifestKey(livePacks)
  const existing = cachedFallback(repo.contractId, livePacks)
  if (existing !== null) return existing

  const restoreKey = `${repo.contractId}\0${manifestKey}`
  const restoring = restores.get(restoreKey)
  if (restoring !== undefined) return restoring

  const restore = (async (): Promise<BrowseContext | null> => {
    const stored = await loadStoredFallback(repo.contractId, livePacks)
    if (stored === null) return null

    // A download may have started while IndexedDB was being read; prefer that shared run.
    const active = cachedFallback(repo.contractId, livePacks)
    if (active !== null) return active

    try {
      validatePacks(stored.packs, livePacks)
      return await remember(repo.contractId, manifestKey, contextFromStored(stored))
    } catch {
      await deleteStoredFallback(repo.contractId)
      return null
    }
  })()
  restores.set(restoreKey, restore)
  restore.finally(() => {
    if (restores.get(restoreKey) === restore) restores.delete(restoreKey)
  })
  return restore
}

/**
 * Run (or join) the fallback clone for a repo. `livePacks` must already be in canonical
 * packRef order (oldest-first `($createdAt, $id)` — `loadBrowseContext` returns them so);
 * the synthesized locator's packRef space is defined by exactly this list.
 */
export function startFallback(
  sdk: EvoSDK,
  repo: RepoRef,
  livePacks: readonly PackManifest[],
  onProgress?: (p: FallbackProgress) => void,
): Promise<BrowseContext> {
  const manifestKey = fallbackManifestKey(livePacks)
  const existing = cachedFallback(repo.contractId, livePacks)
  if (existing !== null) return existing

  const run = runFallback(sdk, repo, livePacks, onProgress)
  return remember(repo.contractId, manifestKey, run)
}

function validatePacks(packs: readonly Uint8Array[], livePacks: readonly PackManifest[]): void {
  if (packs.length !== livePacks.length) throw new Error('cached pack count mismatch')
  for (let i = 0; i < livePacks.length; i++) {
    const manifest = livePacks[i] as PackManifest
    const bytes = packs[i] as Uint8Array
    if (bytes.length !== manifest.sizeBytes) {
      throw new Error(`pack size mismatch for ${manifest.packHash.slice(0, 12)}…`)
    }
    const gotHash = bytesToHex(sha256(bytes))
    if (gotHash !== manifest.packHash.toLowerCase()) {
      throw new Error(`pack hash mismatch for ${manifest.packHash.slice(0, 12)}…`)
    }
    // The frame's object count is consensus-committed via the manifest — a mismatch means
    // an inconsistent publisher, not corruption (the sha256 above already rules that out).
    if (bytes.length >= 12 && manifest.objectCount > 0) {
      const headerCount = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, false)
      if (headerCount !== manifest.objectCount) {
        throw new Error(
          `pack ${manifest.packHash.slice(0, 12)}… header claims ${headerCount} objects, manifest says ${manifest.objectCount}`,
        )
      }
    }
  }
}

function contextFromStored(stored: StoredFallback): Promise<BrowseContext> {
  const locator = ObjectLocator.parse(stored.locator)
  return import('../browse/indexer').then(({ memoryPackSource }) => {
    const packs = memoryPackSource(stored.packs)
    return { locator, packs, reader: new BrowseReader(locator, packs) }
  })
}

async function runFallback(
  sdk: EvoSDK,
  repo: RepoRef,
  livePacks: readonly PackManifest[],
  onProgress?: (p: FallbackProgress) => void,
): Promise<BrowseContext> {
  if (livePacks.length === 0) throw new Error('no live packs to index')
  const bytesTotal = livePacks.reduce((s, m) => s + m.sizeBytes, 0)
  const report = (p: Partial<FallbackProgress> & { phase: FallbackProgress['phase'] }): void =>
    onProgress?.({
      bytesFetched: 0,
      bytesTotal,
      objectsIndexed: 0,
      objectsTotal: 0,
      ...p,
    })

  const packs: Uint8Array[] = []
  let fetchedBefore = 0
  for (const manifest of livePacks) {
    const bytes = await loadArtifactBytesProgress(sdk, repo, manifest, (done) =>
      report({ phase: 'download', bytesFetched: fetchedBefore + done }),
    )
    fetchedBefore += manifest.sizeBytes
    packs.push(bytes)
  }
  validatePacks(packs, livePacks)

  const { indexPacks, serializeLocator, memoryPackSource } = await import('../browse/indexer')
  const objects = await indexPacks(packs, (objectsIndexed, objectsTotal) =>
    report({ phase: 'index', bytesFetched: bytesTotal, objectsIndexed, objectsTotal }),
  )
  const locatorBytes = serializeLocator(objects)
  const locator = ObjectLocator.parse(locatorBytes)
  const packSource = memoryPackSource(packs)
  const reader = new BrowseReader(locator, packSource)
  await storeFallback(repo.contractId, livePacks, { locator: locatorBytes, packs })
  return { locator, packs: packSource, reader }
}

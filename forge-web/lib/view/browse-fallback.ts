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
 * One in-flight/completed context is cached per contract for the session, keyed by
 * contract id — navigating between a repo's pages neither re-downloads nor re-indexes.
 * Failed runs are evicted so a retry starts clean. When flatIndex-backed features
 * (filename search / full listing) gain UI consumers, this context can synthesize a
 * listing by walking trees through the in-memory reader.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { BrowseReader, ObjectLocator } from '../browse'
import type { PackManifest, RepoRef } from '../repo'
import { loadArtifactBytesProgress, type BrowseContext } from './browse-source'

/** Progress of a fallback run: whole-pack download, then client-side indexing. */
export interface FallbackProgress {
  readonly phase: 'download' | 'index'
  readonly bytesFetched: number
  readonly bytesTotal: number
  readonly objectsIndexed: number
  readonly objectsTotal: number
}

const cache = new Map<string, Promise<BrowseContext>>()

/** The session's in-flight or completed fallback context for a contract, if any. */
export function cachedFallback(contractId: string): Promise<BrowseContext> | null {
  return cache.get(contractId) ?? null
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
  const existing = cache.get(repo.contractId)
  if (existing !== undefined) return existing

  const run = runFallback(sdk, repo, livePacks, onProgress)
  cache.set(repo.contractId, run)
  run.catch(() => cache.delete(repo.contractId))
  return run
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
    fetchedBefore += manifest.sizeBytes
    packs.push(bytes)
  }

  const { indexPacks, serializeLocator, memoryPackSource } = await import('../browse/indexer')
  const objects = await indexPacks(packs, (objectsIndexed, objectsTotal) =>
    report({ phase: 'index', bytesFetched: bytesTotal, objectsIndexed, objectsTotal }),
  )
  const locator = ObjectLocator.parse(serializeLocator(objects))
  const packSource = memoryPackSource(packs)
  const reader = new BrowseReader(locator, packSource)
  return { locator, packs: packSource, reader }
}

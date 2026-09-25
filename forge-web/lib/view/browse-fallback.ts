/**
 * Fallback clone orchestrator — in-browser browsing for repos with no published
 * objectLocator.
 *
 * Downloads the repo's live kind-0 packs whole (each sha256-verified against its
 * consensus-proven `packManifest.packHash`, mirroring `git-remote-dash::fetch`: platform
 * packs from `chunk` documents, external packs from any of their mirrors or IPFS gateways —
 * an external pack none serves is skipped and reported, never silently), indexes
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
import {
  loadArtifactBytesProgress,
  PackUnavailableError,
  type BrowseContext,
  type UnavailablePack,
} from './browse-source'
import { noteContentCheck, objectObserver } from './content-checks'
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
      // The stored copy passed the same sha256 check a fresh download does.
      noteContentCheck(repo.contractId, { packsVerified: livePacks.length, source: 'browser cache' })
      return await remember(repo.contractId, manifestKey, contextFromStored(repo, stored))
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

function contextFromStored(repo: RepoRef, stored: StoredFallback): Promise<BrowseContext> {
  const locator = ObjectLocator.parse(stored.locator)
  return import('../browse/indexer').then(({ memoryPackSource }) => {
    const packs = memoryPackSource(stored.packs)
    const onObject = objectObserver(repo.contractId)
    return { locator, packs, reader: new BrowseReader(locator, packs, { onObject }) }
  })
}

/**
 * The error a view gets for an object this clone does not hold, when some packs were
 * skipped: it names them and where they were looked for, instead of a bare "not in locator".
 */
export function missingObjectError(
  oidHex: string,
  unavailable: readonly UnavailablePack[],
): Error {
  const where = unavailable
    .map((p) => `${p.packHash.slice(0, 12)}… (${p.hosts.length > 0 ? p.hosts.join(', ') : 'no fetchable mirror'})`)
    .join('; ')
  return new Error(
    `object ${oidHex.slice(0, 12)}… is not in any pack this browser could load. ` +
      `${unavailable.length === 1 ? 'One pack' : `${unavailable.length} packs`} could not be fetched from ` +
      `${unavailable.length === 1 ? 'its' : 'their'} external storage and may hold it: ${where}. ` +
      'Cloning with dash:// reads the same packs; if their mirrors are down it will fail the same way.',
  )
}

/** A downloaded live pack, or the record of why it could not be. */
type PackOutcome =
  | { readonly manifest: PackManifest; readonly bytes: Uint8Array }
  | { readonly manifest: PackManifest; readonly unavailable: UnavailablePack }

/**
 * Download every live pack. Platform packs (storage 0) are the repo's own chain data: they
 * download one after another and any failure fails the clone. External packs race their
 * mirrors concurrently from the start, so dead mirrors cost one timeout in total, not one per
 * pack; one no mirror serves authentically is skipped and reported, mirroring the dash://
 * helper (a clone is not held hostage by one dead mirror, and git's connectivity check —
 * here, the reader's missing-object error — still fails anything that truly needed it).
 */
async function downloadPacks(
  sdk: EvoSDK,
  repo: RepoRef,
  livePacks: readonly PackManifest[],
  report: (bytesFetched: number) => void,
): Promise<PackOutcome[]> {
  let fetched = 0
  const external = new Map(
    livePacks
      .filter((m) => m.storage !== 0)
      .map((m) => [
        m,
        loadArtifactBytesProgress(sdk, repo, m).then(
          (bytes): PackOutcome => {
            fetched += m.sizeBytes
            report(fetched)
            return { manifest: m, bytes }
          },
          (e: unknown): PackOutcome => {
            if (!(e instanceof PackUnavailableError)) throw e
            return {
              manifest: m,
              unavailable: { packHash: m.packHash, hosts: e.hosts, reason: e.message },
            }
          },
        ),
      ]),
  )
  const outcomes: PackOutcome[] = []
  for (const manifest of livePacks) {
    const ext = external.get(manifest)
    if (ext !== undefined) {
      outcomes.push(await ext)
      continue
    }
    const base = fetched
    const bytes = await loadArtifactBytesProgress(sdk, repo, manifest, (done) => report(base + done))
    fetched += manifest.sizeBytes
    outcomes.push({ manifest, bytes })
  }
  return outcomes
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

  const outcomes = await downloadPacks(sdk, repo, livePacks, (bytesFetched) =>
    report({ phase: 'download', bytesFetched }),
  )
  const got = outcomes.filter((o): o is Extract<PackOutcome, { bytes: Uint8Array }> => 'bytes' in o)
  // Keyed by packHash: a repo can carry several manifests for one pack (a re-push, a
  // re-announced mirror), and a pack is missing once however many documents name it.
  const unavailable = [
    ...new Map(
      outcomes.flatMap((o) =>
        'unavailable' in o ? [[o.unavailable.packHash.toLowerCase(), o.unavailable] as const] : [],
      ),
    ).values(),
  ]
  for (const u of unavailable) noteContentCheck(repo.contractId, { unavailablePack: u.packHash })
  if (got.length === 0) {
    throw new Error(
      `none of this repo's ${livePacks.length} live packs could be fetched from their storage: ` +
        unavailable.map((u) => u.reason).join('; '),
    )
  }

  const packs = got.map((o) => o.bytes)
  const manifests = got.map((o) => o.manifest)
  try {
    validatePacks(packs, manifests)
  } catch (e) {
    // A downloaded pack that does not match its proof-read manifest is a content-check
    // failure the trust panel must report, not only an error on this page.
    noteContentCheck(repo.contractId, { packsFailed: 1 })
    throw e
  }
  noteContentCheck(repo.contractId, { packsVerified: packs.length })

  const { indexPacks, serializeLocator, memoryPackSource } = await import('../browse/indexer')
  const objects = await indexPacks(packs, (objectsIndexed, objectsTotal) =>
    report({ phase: 'index', bytesFetched: bytesTotal, objectsIndexed, objectsTotal }),
  )
  const locatorBytes = serializeLocator(objects)
  const locator = ObjectLocator.parse(locatorBytes)
  // The synthesized locator's packRef space is exactly the packs that downloaded.
  const packSource = memoryPackSource(packs)
  const reader = new BrowseReader(locator, packSource, {
    onObject: objectObserver(repo.contractId),
    missingObject:
      unavailable.length > 0 ? (oid) => missingObjectError(oid, unavailable) : undefined,
  })
  // Only a complete clone is persisted. A skipped pack's mirror may come back, and a reload
  // is the natural moment to try it again; a persisted partial clone would never retry.
  if (unavailable.length === 0) {
    await storeFallback(repo.contractId, livePacks, { locator: locatorBytes, packs })
  }
  return { locator, packs: packSource, reader, unavailable }
}

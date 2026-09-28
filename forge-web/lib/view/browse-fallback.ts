/**
 * Fallback clone orchestrator — in-browser browsing for repos with no published
 * objectLocator.
 *
 * Downloads the repo's live kind-0 packs whole (each sha256-verified against its
 * consensus-proven `packManifest.packHash`, mirroring `git-remote-dash::fetch`: platform
 * packs from `chunk` documents, external packs from any of their mirrors or IPFS gateways —
 * an external pack none serves is skipped and reported, never silently), indexes
 * them client-side (`lib/browse/indexer`, dynamically imported: only a repo without a locator
 * needs it), and assembles the same {@link BrowseContext} the locator path produces,
 * so every downstream view works unchanged.
 *
 * One in-flight/completed context is cached per repo (`repoKey`) for the session, while completed
 * clones are persisted in IndexedDB — navigation and hard reloads neither re-download nor
 * re-index an unchanged pack set. A PRIVATE repo's clone is decrypted segment by segment
 * (`private-packs.ts`, after the sealed bytes matched `packHash`) and lives in memory only:
 * nothing decrypted is ever written to IndexedDB, and the clone is keyed by the reader's
 * session, so it ends with it. Failed runs are evicted so a retry starts clean. When
 * flatIndex-backed features (filename search / full listing) gain UI consumers, this context
 * can synthesize a listing by walking trees through the in-memory reader.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { ObjectLocator } from '../browse'
import { repoKey, type PackManifest, type RepoRef } from '../repo'
import { onPrivateSessionEnded } from '../repo/private-session'
import {
  loadArtifactBytesProgress,
  missingObjectError,
  PackUnavailableError,
  repoReader,
  StorageUnreachableError,
  unavailableOf,
  type BrowseContext,
  type UnavailablePack,
} from './browse-source'
import { describePack, readGatewaysFor } from './storage-status'
import { noteContentCheck } from './content-checks'
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

// A private repo's entries are keyed `repoId#sessionId` and hold decrypted state: they go with
// the session, however it ends (lock, key change, retirement).
onPrivateSessionEnded((id) => {
  for (const m of [cache, restores]) for (const k of [...m.keys()]) if (k.endsWith(`#${id}`) || k.includes(`#${id}\0`)) m.delete(k)
})

/**
 * How long a PARTIAL clone (some external packs skipped) is reused before the next view
 * tries the mirrors again. A mirror that was down or slow a minute ago may be back; holding
 * the partial context for the whole session would keep hiding its objects. A complete clone
 * is kept for the session (and persisted), as before.
 */
export const PARTIAL_FALLBACK_TTL_MS = 60_000

function remember(key: string, manifestKey: string, promise: Promise<BrowseContext>): Promise<BrowseContext> {
  const entry: CacheEntry = { manifestKey, promise }
  cache.set(key, entry)
  promise.then(
    (ctx) => {
      if ((ctx.unavailable?.length ?? 0) === 0) return
      setTimeout(() => {
        if (cache.get(key) === entry) cache.delete(key)
      }, PARTIAL_FALLBACK_TTL_MS)
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key)
    },
  )
  return promise
}

/** The session's in-flight or completed fallback context for a repo (`repoKey`), if any. */
export function cachedFallback(
  key: string,
  livePacks?: readonly PackManifest[],
): Promise<BrowseContext> | null {
  const entry = cache.get(key)
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
  /** Lets the restored reader re-resolve the repo on a miss; null: it cannot. */
  sdk: EvoSDK | null = null,
): Promise<BrowseContext | null> {
  const manifestKey = fallbackManifestKey(livePacks)
  const existing = cachedFallback(repoKey(repo), livePacks)
  if (existing !== null) return existing

  // A private repo's decrypted clone is never persisted, so there is nothing to restore.
  if (repo.visibility === 'private') return Promise.resolve(null)
  const restoreKey = `${repoKey(repo)}\0${manifestKey}`
  const restoring = restores.get(restoreKey)
  if (restoring !== undefined) return restoring

  const restore = (async (): Promise<BrowseContext | null> => {
    const stored = await loadStoredFallback(repoKey(repo), livePacks)
    if (stored === null) return null

    // A download may have started while IndexedDB was being read; prefer that shared run.
    const active = cachedFallback(repoKey(repo), livePacks)
    if (active !== null) return active

    try {
      validatePacks(stored.packs, livePacks)
      // The stored copy passed the same sha256 check a fresh download does.
      noteContentCheck(repoKey(repo), { packsVerified: livePacks.length, source: 'browser cache' })
      return await remember(repoKey(repo), manifestKey, contextFromStored(sdk, repo, stored))
    } catch {
      await deleteStoredFallback(repoKey(repo))
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
  const existing = cachedFallback(repoKey(repo), livePacks)
  if (existing !== null) return existing

  const run = runFallback(sdk, repo, livePacks, onProgress)
  return remember(repoKey(repo), manifestKey, run)
}

/**
 * Check each pack against its manifest. `sealed` false: `packs` are a private repo's
 * decrypted plaintext, whose sealed bytes were already checked against `packHash` and `sizeBytes`
 * before decryption; only the object count is left to check.
 */
function validatePacks(packs: readonly Uint8Array[], livePacks: readonly PackManifest[], sealed = true): void {
  if (packs.length !== livePacks.length) throw new Error('cached pack count mismatch')
  for (let i = 0; i < livePacks.length; i++) {
    const manifest = livePacks[i] as PackManifest
    const bytes = packs[i] as Uint8Array
    if (sealed && bytes.length !== manifest.sizeBytes) {
      throw new Error(`pack size mismatch for ${manifest.packHash.slice(0, 12)}…`)
    }
    if (sealed && bytesToHex(sha256(bytes)) !== manifest.packHash.toLowerCase()) {
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

/**
 * A clone's reader ({@link repoReader}): a read of an object it does not hold re-resolves the repo
 * once, since a push since the clone was built may hold it. The published index, when that push
 * brought one, answers the read; a new pack list otherwise has the views build a new clone.
 */
function contextFromStored(sdk: EvoSDK | null, repo: RepoRef, stored: StoredFallback): Promise<BrowseContext> {
  const locator = ObjectLocator.parse(stored.locator)
  return import('../browse/indexer').then(({ memoryPackSource }) => {
    const packs = memoryPackSource(stored.packs)
    return { locator, packs, reader: repoReader(sdk, repo, locator, packs) }
  })
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
  // Cancels every external download when the clone fails on a Platform pack: nothing will
  // use those bytes, and a large pack would otherwise keep downloading in the background.
  const abandon = new AbortController()
  const external = new Map(
    livePacks
      .filter((m) => m.storage !== 0)
      .map((m) => {
        const outcome = loadArtifactBytesProgress(sdk, repo, m, undefined, abandon.signal).then(
          (bytes): PackOutcome => {
            fetched += m.sizeBytes
            report(fetched)
            return { manifest: m, bytes }
          },
          (e: unknown): PackOutcome => {
            if (!(e instanceof PackUnavailableError)) throw e
            return { manifest: m, unavailable: { ...unavailableOf(e), packHash: m.packHash } }
          },
        )
        // Observed here so an outcome no one awaits (the clone failed first) is never an
        // unhandled rejection.
        outcome.catch(() => undefined)
        return [m, outcome] as const
      }),
  )
  try {
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
  } catch (e) {
    abandon.abort()
    throw e
  }
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
  for (const u of unavailable) {
    noteContentCheck(repoKey(repo), {
      unavailablePack: u.packHash,
      corruptMirror: u.corrupt,
      unreachable: describePack(u, readGatewaysFor(repoKey(repo))),
    })
  }
  if (got.length === 0) throw new StorageUnreachableError(unavailable)

  const packs = got.map((o) => o.bytes)
  const manifests = got.map((o) => o.manifest)
  const isPrivate = repo.visibility === 'private'
  try {
    validatePacks(packs, manifests, !isPrivate)
  } catch (e) {
    // A downloaded pack that does not match its proof-read manifest is a content-check
    // failure the trust panel must report, not only an error on this page.
    noteContentCheck(repoKey(repo), { packsFailed: 1 })
    throw e
  }
  noteContentCheck(repoKey(repo), { packsVerified: packs.length })

  const { indexPacks, serializeLocator, memoryPackSource } = await import('../browse/indexer')
  let objects: Awaited<ReturnType<typeof indexPacks>>
  try {
    objects = await indexPacks(packs, (objectsIndexed, objectsTotal) =>
      report({ phase: 'index', bytesFetched: bytesTotal, objectsIndexed, objectsTotal }),
    )
  } catch (e) {
    // A thin pack (imported or third-party) can REF_DELTA a base that only a skipped pack
    // holds. Say so, naming the skipped packs, instead of a bare indexer error.
    const base = /REF_DELTA base not found in live packs: ([0-9a-f]+)/.exec(
      e instanceof Error ? e.message : '',
    )?.[1]
    if (base !== undefined && unavailable.length > 0) throw missingObjectError(base, unavailable)
    throw e
  }
  const locatorBytes = serializeLocator(objects)
  const locator = ObjectLocator.parse(locatorBytes)
  // The synthesized locator's packRef space is exactly the packs that downloaded.
  const packSource = memoryPackSource(packs)
  const reader = repoReader(sdk, repo, locator, packSource, unavailable)
  // Only a complete clone is persisted. A skipped pack's mirror may come back, and a reload
  // is the natural moment to try it again; a persisted partial clone would never retry.
  // A private repo's clone is decrypted: it is never written to browser storage.
  if (unavailable.length === 0 && !isPrivate) {
    await storeFallback(repoKey(repo), livePacks, { locator: locatorBytes, packs })
  }
  return { locator, packs: packSource, reader, unavailable }
}

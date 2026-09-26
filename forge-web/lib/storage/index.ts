/**
 * Bring-your-own storage in the browser (`ux-dx-spec.md` §3.1): profiles sealed in the vault,
 * the live bucket test, and the upload path browser writes that push packs (merge, fork
 * follow-ups, release assets) go through.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { WriteAuth, WriteResult } from '../sdk'
import type { V2RepoRef } from '../repo/contract'
import { writePackManifest } from '../repo/push'
import { storeArtifact, type PlatformQuestion, type StoredArtifact, type UploadEvent } from './upload'
import type { StoragePolicy, StorageProfile } from './profiles'

export * from './profiles'
export * from './store'
export { corsFix, kuboCorsLines, type CorsFix } from './cors'
export { probeProfile, IPFS_ROWS, S3_ROWS, type ProbeRow, type RowId, type RowState } from './probe'
export {
  PlatformDeclinedError,
  ReplicationError,
  fitManifestUris,
  orderUris,
  storeArtifact,
  type PlatformQuestion,
  type StoredArtifact,
  type TargetFailure,
  type UploadEvent,
} from './upload'

/** What {@link storeAndRecordPack} did: where the bytes went and the manifest that records them. */
export interface RecordedPack {
  readonly stored: StoredArtifact
  readonly manifest: WriteResult
}

/**
 * Upload an artifact under `policy`, then write its `packManifest` — the two steps every
 * browser push does per artifact, in that order (the manifest only after the bytes are stored
 * and verified). A failure after the upload leaves the bytes stored; a retry re-verifies them
 * (content-addressed keys, CIDs, the signer's own chunks) and writes only the manifest.
 */
export async function storeAndRecordPack(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: V2RepoRef,
  bytes: Uint8Array,
  meta: { readonly kind: number; readonly objectCount: number; readonly tips?: readonly string[]; readonly supersedes?: readonly string[] },
  opts: {
    readonly policy: StoragePolicy | null
    readonly profiles: readonly StorageProfile[]
    readonly confirmPlatform: (q: PlatformQuestion) => Promise<boolean>
    readonly onStep?: (e: UploadEvent) => void
    readonly intent?: string
  },
): Promise<RecordedPack> {
  const stored = await storeArtifact(sdk, auth, repo, bytes, opts)
  const manifest = await writePackManifest(
    sdk,
    auth,
    repo,
    {
      packHash: stored.packHash,
      kind: meta.kind,
      sizeBytes: stored.sizeBytes,
      objectCount: meta.objectCount,
      chunkCount: stored.chunkCount,
      storage: stored.storage,
      uris: stored.uris,
      ...(meta.tips ? { tips: meta.tips } : {}),
      ...(meta.supersedes ? { supersedes: meta.supersedes } : {}),
    },
    opts.intent,
  )
  return { stored, manifest }
}

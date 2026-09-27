/**
 * Bring-your-own storage in the browser (`ux-dx-spec.md` §3.1): profiles sealed in the vault,
 * the live bucket test, and the upload path browser writes that push packs (merge, fork
 * follow-ups, release assets) go through.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { WriteAuth, WriteResult } from '../sdk'
import type { RepoRef } from '../repo/contract'
import { forgetSealedArtifact, sealArtifact } from '../repo/private-writes'
import { writePackManifest, type PackManifestInput } from '../repo/push'
import { storeArtifact, type StoreOptions, type StoredArtifact } from './upload'

export * from './profiles'
export * from './store'
export { corsFix, type CorsFix } from './cors'
export { probeProfile, IPFS_ROWS, S3_ROWS, type ProbeRow, type RowId, type RowState } from './probe'
export {
  PlatformDeclinedError,
  ReplicationError,
  fitManifestUris,
  orderUris,
  storeArtifact,
  storeFile,
  externalTargets,
  NO_EXTERNAL_STORAGE,
  type StoredFile,
  type PlatformQuestion,
  type StoreOptions,
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
  repo: RepoRef,
  bytes: Uint8Array,
  meta: Pick<PackManifestInput, 'kind' | 'objectCount' | 'tips' | 'supersedes'>,
  opts: StoreOptions & { readonly intent?: string },
): Promise<RecordedPack> {
  // A private repo stores the artifact sealed (`private-repos.md` §3); `packHash` and
  // `sizeBytes` are then the sealed bytes', as every reader checks them.
  const stored = await storeArtifact(sdk, auth, repo, await sealArtifact(sdk, auth, repo, bytes), opts)
  const { packHash, sizeBytes, chunkCount, storage, uris } = stored
  const manifest = await writePackManifest(sdk, auth, repo, { ...meta, packHash, sizeBytes, chunkCount, storage, uris }, opts.intent)
  // Recorded: the kept sealed bytes of a private upload are no longer needed for a resume.
  await forgetSealedArtifact(auth, repo, bytes)
  return { stored, manifest }
}

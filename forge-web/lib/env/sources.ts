/**
 * The loader's reads ({@link EnvSources}) over the SDK: the kind-8 manifests by the `(kind,
 * $createdAt)` index, the maintainers read fresh (D24 counts only a current maintainer, so no
 * cached list decides it), each artifact from Platform chunks or its recorded copies (the stored
 * bytes, never opened as a pack: the env codec checks and opens them), and owners' identity keys.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { PACK_KIND } from '../constants'
import { fetchIdentityKeys, ownerKeysOf } from '../auth/encryption-key'
import type { RepoRef } from '../repo/contract'
import { readMaintainers } from '../repo/members'
import { readManifestsOfKind, type PackManifest } from '../repo/packs'
import { loadStoredArtifactBytes } from '../view/browse-source'
import type { EnvManifest, EnvSources } from './loader'

/** An identity's keys as the letter reader rule takes them (forge-core `env::codec::owner_keys`). */
export { ownerKeysOf } from '../auth/encryption-key'

export function envManifestOf(m: PackManifest): EnvManifest {
  return {
    id: m.documentId,
    ownerId: m.uploader,
    packHash: m.packHash.toLowerCase(),
    supersedes: m.supersedes.map((h) => h.toLowerCase()),
    height: m.createdAtBlockHeight ?? 0,
    createdAt: m.createdAt,
    sizeBytes: m.sizeBytes,
  }
}

/** {@link EnvSources} for `repo`. */
export function sdkEnvSources(sdk: EvoSDK, repo: RepoRef): EnvSources {
  const raw = new Map<string, PackManifest>()
  return {
    manifests: async () => {
      const all = await readManifestsOfKind(sdk, repo, PACK_KIND.ENV_SNAPSHOT)
      for (const m of all) raw.set(m.documentId, m)
      return all.map(envManifestOf)
    },
    maintainers: () => readMaintainers(sdk, repo),
    fetch: async (m) => {
      const manifest = raw.get(m.id)
      if (manifest === undefined) throw new Error('no such manifest')
      return loadStoredArtifactBytes(sdk, repo, manifest)
    },
    ownerKeys: async (id) => ownerKeysOf((await fetchIdentityKeys(sdk, id)) ?? []),
  }
}

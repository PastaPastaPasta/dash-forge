/**
 * The loader's reads ({@link EnvSources}) over the SDK: the kind-8 manifests by the `(kind,
 * $createdAt)` index, the maintainers read fresh (D24 counts only a current maintainer, so no
 * cached list decides it), each artifact from Platform chunks or its recorded copies (the stored
 * bytes, never opened as a pack: the env codec checks and opens them), and owners' identity keys.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { PACK_KIND } from '../constants'
import { fetchIdentityKeys, type EncKeyLike } from '../auth/encryption-key'
import { KEY_TYPE_ECDSA_SECP256K1, PURPOSE_ENCRYPTION, hexToBytes, type OwnerKey } from '../private'
import type { RepoRef } from '../repo/contract'
import { readMemberships } from '../repo/members'
import { readManifestsOfKind, type PackManifest } from '../repo/packs'
import { loadStoredArtifactBytes } from '../view/browse-source'
import type { EnvManifest, EnvSources } from './loader'

/** An identity's keys as the letter reader rule takes them (forge-core `env::codec::owner_keys`). */
export function ownerKeysOf(keys: readonly EncKeyLike[]): OwnerKey[] {
  return keys.map((k) => ({
    id: k.keyId,
    purpose: k.purposeNumber === PURPOSE_ENCRYPTION ? PURPOSE_ENCRYPTION : 0xff,
    keyType: k.keyTypeNumber === KEY_TYPE_ECDSA_SECP256K1 ? KEY_TYPE_ECDSA_SECP256K1 : 0xff,
    data: hexToBytes(k.data),
  }))
}

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
    maintainers: async () => (await readMemberships(sdk, repo)).filter((m) => m.role === 'maintainer').map((m) => m.identity),
    fetch: async (m) => {
      const manifest = raw.get(m.id)
      if (manifest === undefined) throw new Error('no such manifest')
      return loadStoredArtifactBytes(sdk, repo, manifest)
    },
    ownerKeys: async (id) => ownerKeysOf((await fetchIdentityKeys(sdk, id)) ?? []),
  }
}

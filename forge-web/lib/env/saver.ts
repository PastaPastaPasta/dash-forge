/**
 * {@link EnvSaver} over the SDK and this browser's vault: the maintainer check, the signer's
 * newest usable encryption key held here, each person's usable key (forge-core
 * `recipient_key`), the seal (the key opened from the vault for the call and wiped after), and
 * the store as `dg` does it: one Platform chunk, then the kind-8 `packManifest` naming what it
 * supersedes (forge-core `RepoService::store_env_snapshot`).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { PACK_KIND, type Network } from '../constants'
import { fetchIdentityKeys, isUsableEncryptionKey, usableEncryptionKey } from '../auth/encryption-key'
import { VaultLockedError, storedEncryptionKeyIds, withEncryptionKeys } from '../auth/vault'
import { bytesToHex, hexToBytes, privateId } from '../private'
import type { WriteAuth } from '../sdk'
import type { RepoRef } from '../repo/contract'
import { readMaintainers } from '../repo/members'
import { putPlatformChunks, writePackManifest } from '../repo/push'
import { mapPooled } from '../view/pool'
import * as secp from '@noble/secp256k1'
import { sealLetterSnapshot } from './codec'
import { EnvSaveError, type EnvSaver, type PersonKey, type Sender } from './write'

/** Identities fetched at once for their keys. */
const KEY_WINDOW = 8

async function sha256Hex(b: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b))))
}

export function sdkEnvSaver(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, network: Network): EnvSaver {
  const me = auth.identityId
  const core = repo.forge.core
  return {
    me,
    requireMaintainer: async () => {
      if (!(await readMaintainers(sdk, repo)).includes(me)) {
        throw new EnvSaveError('Only maintainers can change environments. Ask a maintainer to make the change; nothing was saved.')
      }
    },
    sender: async (): Promise<Sender> => {
      const held = await storedEncryptionKeyIds(network, me)
      const keys = (await fetchIdentityKeys(sdk, me)) ?? []
      // the newest held key that is still a usable encryption key of the identity
      const usable = keys.filter((k) => held.includes(k.keyId) && isUsableEncryptionKey(k, core)).sort((a, b) => b.keyId - a.keyId)[0]
      if (usable === undefined) {
        throw new EnvSaveError("This browser doesn't hold a usable encryption key of yours, so it can't save an environment. Add it under Settings → Members-only and private content.")
      }
      return { identity: me, keyId: usable.keyId, publicKey: hexToBytes(usable.data) }
    },
    keysOf: async (ids) => {
      const got = await mapPooled([...ids], KEY_WINDOW, async (id): Promise<readonly [string, PersonKey | null]> => {
        const k = usableEncryptionKey((await fetchIdentityKeys(sdk, id)) ?? [], core)
        return [id, k === null ? null : { keyId: k.keyId, publicKey: hexToBytes(k.data) }]
      })
      return new Map(got)
    },
    seal: (slots, snapshot) =>
      withEncryptionKeys(network, me, async (keys) => {
        const want = slots[0] === undefined ? '' : bytesToHex(slots[0].publicKey)
        const sender = keys.find((k) => bytesToHex(secp.getPublicKey(k.secret, true)) === want)
        if (sender === undefined) throw new VaultLockedError("this browser does not hold the encryption key the writer's slot names")
        return sealLetterSnapshot(privateId(repo.repoId), sender.secret, sender.keyId, privateId(me), slots, snapshot)
      }),
    store: async (sealed, supersedes) => {
      const packHash = await sha256Hex(sealed)
      const { locator, chunkCount } = await putPlatformChunks(sdk, auth, repo, sealed, packHash)
      const written = await writePackManifest(
        sdk,
        auth,
        repo,
        { packHash, kind: PACK_KIND.ENV_SNAPSHOT, sizeBytes: sealed.length, objectCount: 0, chunkCount, storage: 0, uris: [locator], supersedes: [...supersedes] },
        `env:${repo.repoId}:${packHash}`,
      )
      return { id: written.documentId, packHash }
    },
  }
}

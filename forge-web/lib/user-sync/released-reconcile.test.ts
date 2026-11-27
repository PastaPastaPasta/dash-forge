/**
 * What the RELEASED web app (`maintainers-released.fixture.ts`, a copy of origin/master 6e3e1a45's
 * `lib/user-sync/maintainers.ts`, which has no key guard) does to a repo's share after a move, from
 * a tab still holding the old key. Its storage slot no longer opens (`SyncKeyChangedError`), so its
 * status is an error and `use-repo-share.ts:179` hands the reconcile a null view: it never writes
 * profile content under the old key; at most the empty share, when it revokes a grant. The last case
 * records the one way it does write content: a tab whose last sync, from before the move, still
 * reads as synced.
 */

import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { decodeIdentifier } from '../auth/base58'
import type { StorageConfig } from '../storage/store'
import { openShare, repoStorageKey } from './crypto'
import { fakePlatform, fakeReplaceKey, memoryStorage, type FakePlatform } from './fake-port'
import { reconcileRepoShare } from './maintainers'
import { reconcileRepoShare as releasedReconcile } from './maintainers-released.fixture'
import { moveSyncKey, type DeriveSyncKey } from './move-key'
import { SyncKeyChangedError, syncUserSettings } from './service'
import { storageEntries } from './storage-slot'

const OWNER = '9oaYDFZ9n1zsuzMRdGLyUatghRj1zhTGJNi7uNQZzDjX'
const ALICE = 'HeHGBRkJ9zWrJ6RNRx5vtSWEDizrY6eGbYMuBqK8GfRw'
const BOB = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const CAROL = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const REPO = 'sv4PJfH7SV4dSEJ7kFXYGk5iPzaviTT2TdXndfN7PHJ'
const NET = 'testnet'
const OLD_ID = 5

const R2 = { name: 'r2-main', settings: { kind: 's3', provider: 'r2', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://packs.example.org', prefix: '' }, secrets: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret-not-real' } } as StorageConfig['profiles'][number]
const CONFIG: StorageConfig = { version: 1, profiles: [R2], defaultPolicy: { targets: ['r2-main'], replicas: 1, platformFallback: false }, repoPolicies: { [REPO]: { targets: ['r2-main'], replicas: 1, platformFallback: true } }, lastTests: {} }
const VIEW = storageEntries(CONFIG)

const phrase: DeriveSyncKey = async (r) => {
  const secret = sha256(new TextEncoder().encode(`owner/${r}`))
  return { secret, pub: secp.getPublicKey(secret, true) }
}

/** Shared with Alice and Bob under rotation 0 (key 5), then moved to rotation 1 (key 6). */
async function moved(): Promise<{ platform: FakePlatform; e0: Uint8Array }> {
  const platform = fakePlatform()
  const e0 = (await phrase(0)).secret
  platform.keys.set(OWNER, { keyId: OLD_ID, pub: secp.getPublicKey(e0, true) })
  platform.maxKeyIds.set(OWNER, OLD_ID)
  for (const [id, keyId] of [[ALICE, 9], [BOB, 4], [CAROL, 3]] as const) platform.keys.set(id, { keyId, pub: secp.getPublicKey(secp.utils.randomSecretKey(), true) })
  const owner = { port: platform.port(OWNER), networkKey: NET, ownerId: OWNER, keyId: OLD_ID, E: e0 }
  await syncUserSettings({ port: platform.port(OWNER), networkKey: NET, network: NET, identityId: OWNER, keyId: OLD_ID, E: e0, deviceId: 'aaaa', storage: null, localStore: memoryStorage() })
  await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
  await moveSyncKey({ port: platform.port(OWNER), networkKey: NET, identityId: OWNER, derive: phrase, replace: fakeReplaceKey(platform, OWNER), store: async () => {}, sleep: async () => {}, maintainers: async () => [ALICE, BOB] })
  // The old tab's sync now fails before it decrypts anything: its status is an error, its view null.
  await expect(syncUserSettings({ port: platform.port(OWNER), networkKey: NET, network: NET, identityId: OWNER, keyId: OLD_ID, E: e0, deviceId: 'aaaa', storage: null, localStore: memoryStorage() })).rejects.toBeInstanceOf(SyncKeyChangedError)
  return { platform, e0 }
}

/** The share as the old key opens it now, or null (not sealed under the old key). */
async function underOldKey(platform: FakePlatform, e0: Uint8Array): Promise<unknown> {
  const share = platform.shares.get(`${OWNER}/${REPO}`)!
  if (share.fields.keyId !== OLD_ID) return null
  const rsk = await repoStorageKey(e0, decodeIdentifier(REPO), NET, share.fields.epoch)
  return openShare(rsk, { network: NET, repoId: decodeIdentifier(REPO) }, share.fields)
}

const old = (platform: FakePlatform, e0: Uint8Array) => ({ port: platform.port(OWNER), networkKey: NET, ownerId: OWNER, keyId: OLD_ID, E: e0 })

describe('the released reconcile, from a tab holding the old key after a move (null view)', () => {
  it('the same maintainers: writes nothing', async () => {
    const { platform, e0 } = await moved()
    const writes = platform.writes
    await releasedReconcile(old(platform, e0), { repoId: REPO, view: null, maintainers: [ALICE, BOB] })
    expect(platform.writes).toBe(writes)
    expect(await underOldKey(platform, e0)).toBeNull()
  })

  it('a maintainer added: writes nothing, grants nothing', async () => {
    const { platform, e0 } = await moved()
    const writes = platform.writes
    await releasedReconcile(old(platform, e0), { repoId: REPO, view: null, maintainers: [ALICE, BOB, CAROL] })
    expect(platform.writes).toBe(writes)
  })

  it('a maintainer removed, or a grant to a key no longer live: only the empty share, under the old key', async () => {
    for (const change of ['removed', 'dead-key'] as const) {
      const { platform, e0 } = await moved()
      if (change === 'dead-key') platform.keys.delete(BOB)
      await releasedReconcile(old(platform, e0), { repoId: REPO, view: null, maintainers: change === 'removed' ? [ALICE] : [ALICE, BOB], ...(change === 'removed' ? { removed: [BOB] } : {}) })
      const share = (await underOldKey(platform, e0)) as { profiles: Record<string, unknown>; policy: unknown }
      expect(share.profiles).toEqual({})
      expect(share.policy).toBeNull()
      // No grant is written from the old key: the empty share lends nothing.
      expect([...platform.grants.values()].every((g) => g.fields.senderKeyId !== OLD_ID)).toBe(true)
    }
  })

  it('the one way it writes content: a tab whose pre-move sync still reads as synced re-seals that view under the old key', async () => {
    const { platform, e0 } = await moved()
    await releasedReconcile(old(platform, e0), { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
    const share = (await underOldKey(platform, e0)) as { profiles: Record<string, { secrets: unknown }> }
    // The pre-move credentials (the ones the move tells the owner to rotate), sealed again under the old key,
    expect(share.profiles['r2-main']?.secrets).toEqual(R2.secrets)
    // with grants from the old, now disabled key: maintainers read nothing until a new-key reconcile.
    expect([...platform.grants.values()].map((g) => g.fields.senderKeyId)).toEqual([OLD_ID, OLD_ID])
    // The new build refuses the same call, writing nothing.
    const fresh = await moved()
    const writes = fresh.platform.writes
    await expect(reconcileRepoShare(old(fresh.platform, fresh.e0), { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })).rejects.toThrow('moved to a new key')
    expect(fresh.platform.writes).toBe(writes)
  })
})

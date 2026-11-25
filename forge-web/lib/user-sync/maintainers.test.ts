import * as secp from '@noble/secp256k1'
import { describe, expect, it } from 'vitest'

import type { StorageConfig } from '../storage/store'
import { fakePlatform } from './fake-port'
import { readGrantedStorage, reconcileRepoShare, sharePlain, withGrantedStorage } from './maintainers'

const OWNER = '9oaYDFZ9n1zsuzMRdGLyUatghRj1zhTGJNi7uNQZzDjX'
const ALICE = 'HeHGBRkJ9zWrJ6RNRx5vtSWEDizrY6eGbYMuBqK8GfRw'
const BOB = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const CAROL = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const REPO = 'sv4PJfH7SV4dSEJ7kFXYGk5iPzaviTT2TdXndfN7PHJ'
const NET = 'testnet'

const R2 = { name: 'r2-main', settings: { kind: 's3', provider: 'r2', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://packs.example.org', prefix: '' }, secrets: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret-not-real' } } as StorageConfig['profiles'][number]
const PRIVATE = { ...R2, name: 'private-bucket', settings: { ...R2.settings, bucket: 'mine' } } as StorageConfig['profiles'][number]
const CONFIG: StorageConfig = { version: 1, profiles: [PRIVATE, R2], defaultPolicy: { targets: ['private-bucket'], replicas: 1, platformFallback: false }, repoPolicies: { [REPO]: { targets: ['r2-main'], replicas: 1, platformFallback: true } }, lastTests: {} }

function identities() {
  const platform = fakePlatform()
  const keys: Record<string, { E: Uint8Array; keyId: number }> = {}
  for (const [id, keyId] of [[OWNER, 7], [ALICE, 9], [BOB, 4]] as const) {
    const E = secp.utils.randomSecretKey()
    keys[id] = { E, keyId }
    platform.keys.set(id, { keyId, pub: secp.getPublicKey(E, true) })
  }
  const owner = { port: platform.port(OWNER), networkKey: NET, ownerId: OWNER, keyId: 7, E: keys[OWNER]!.E }
  const member = (id: string) => ({ port: platform.port(id), networkKey: NET, memberId: id, keyId: keys[id]!.keyId, E: keys[id]!.E })
  return { platform, owner, member }
}

describe('maintainers use the owner’s storage', () => {
  it('shares only the profiles this repo’s policy names', () => {
    expect(Object.keys(sharePlain(CONFIG, REPO)!.profiles)).toEqual(['r2-main'])
    expect(sharePlain({ ...CONFIG, repoPolicies: {}, defaultPolicy: { targets: ['platform'], replicas: 1, platformFallback: false } }, REPO)).toBeNull()
  })

  it('grants each maintainer with a key, and lists the rest as waiting', async () => {
    const { platform, owner, member } = identities()
    const done = await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE, BOB, CAROL] })
    expect(done).toEqual({ granted: [ALICE, BOB], waiting: [CAROL], shared: true, epoch: 0 })
    const got = await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER })
    expect(got?.profiles.map((p) => p.name)).toEqual(['r2-main'])
    expect(got?.profiles[0]?.secrets).toEqual(R2.secrets)
    // A second visit with nothing changed writes nothing.
    const writes = platform.writes
    await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE, BOB, CAROL] })
    expect(platform.writes).toBe(writes)
  })

  it('a removal moves to the next epoch: the removed member reads nothing, the others still do', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE, BOB] })
    const done = await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE], removed: [BOB] })
    expect(done.epoch).toBe(1)
    expect([...platform.grants.values()].map((g) => g.fields.memberId)).toEqual([ALICE])
    expect(await readGrantedStorage(member(BOB), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
    expect((await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER }))?.epoch).toBe(1)
  })

  it('finds a grant to someone no longer a maintainer and moves the epoch', async () => {
    const { owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE, BOB] })
    expect((await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE] })).epoch).toBe(1)
  })

  it('accepts a grant only from the repo’s owner', async () => {
    const { owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE] })
    expect(await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: BOB })).toBeNull()
  })

  it('pushes to that repo alone use the shared profiles, renamed apart, unless the maintainer chose otherwise', async () => {
    const { owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE] })
    const got = await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER })
    const own: StorageConfig = { version: 1, profiles: [{ ...R2, settings: { ...R2.settings, bucket: 'alice' } } as StorageConfig['profiles'][number]], defaultPolicy: { targets: ['r2-main'], replicas: 1, platformFallback: false }, repoPolicies: {}, lastTests: {} }
    const cfg = withGrantedStorage(own, REPO, got)
    expect(cfg.repoPolicies[REPO]?.targets).toEqual(['shared-r2-main'])
    expect(cfg.profiles.find((p) => p.name === 'r2-main')).toEqual(own.profiles[0])
    expect(cfg.defaultPolicy).toEqual(own.defaultPolicy)
    const chose = { ...own, repoPolicies: { [REPO]: own.defaultPolicy! } }
    expect(withGrantedStorage(chose, REPO, got)).toBe(chose)
  })

  it('never grants a member removed here again, even when a stale read still lists them (H2)', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE, BOB] })
    await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE, BOB], removed: [BOB] })
    // A node a block behind still lists BOB: the tab's removed list keeps them out, and nothing moves again.
    const writes = platform.writes
    const again = await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE, BOB], removed: [BOB] })
    expect(again).toEqual({ granted: [ALICE], waiting: [], shared: true, epoch: 1 })
    expect(platform.writes).toBe(writes)
    expect(await readGrantedStorage(member(BOB), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
  })

  it('a repo switched to Platform only takes back the share and every grant (M2)', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, config: CONFIG, maintainers: [ALICE] })
    const platformOnly: StorageConfig = { ...CONFIG, repoPolicies: { [REPO]: { targets: ['platform'], replicas: 1, platformFallback: false } }, profiles: [...CONFIG.profiles, { name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} } as StorageConfig['profiles'][number]] }
    const done = await reconcileRepoShare(owner, { repoId: REPO, config: platformOnly, maintainers: [ALICE] })
    expect(done.shared).toBe(true)
    expect(platform.shares.size).toBe(0)
    expect(platform.grants.size).toBe(0)
    expect(await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
  })
})

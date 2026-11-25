import * as secp from '@noble/secp256k1'
import { describe, expect, it } from 'vitest'

import type { StorageConfig } from '../storage/store'
import { fakePlatform } from './fake-port'
import { readGrantedStorage, reconcileRepoShare, shareMeaning, shareRule, withGrantedStorage, type SharePlain } from './maintainers'
import { storageEntries } from './storage-slot'
import { repoStorageKey, sealShare } from './crypto'
import { decodeIdentifier } from '../auth/base58'

const OWNER = '9oaYDFZ9n1zsuzMRdGLyUatghRj1zhTGJNi7uNQZzDjX'
const ALICE = 'HeHGBRkJ9zWrJ6RNRx5vtSWEDizrY6eGbYMuBqK8GfRw'
const BOB = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const CAROL = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const REPO = 'sv4PJfH7SV4dSEJ7kFXYGk5iPzaviTT2TdXndfN7PHJ'
const NET = 'testnet'

const R2 = { name: 'r2-main', settings: { kind: 's3', provider: 'r2', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://packs.example.org', prefix: '' }, secrets: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret-not-real' } } as StorageConfig['profiles'][number]
const PRIVATE = { ...R2, name: 'private-bucket', settings: { ...R2.settings, bucket: 'mine' } } as StorageConfig['profiles'][number]
const CONFIG: StorageConfig = { version: 1, profiles: [PRIVATE, R2], defaultPolicy: { targets: ['private-bucket'], replicas: 1, platformFallback: false }, repoPolicies: { [REPO]: { targets: ['r2-main'], replicas: 1, platformFallback: true } }, lastTests: {} }

const VIEW = storageEntries(CONFIG)
const sharePlain = (config: StorageConfig, repo: string): SharePlain => {
  const rule = shareRule(storageEntries(config), repo)
  if (rule.kind !== 'content') throw new Error(`expected a share, got ${rule.kind}`)
  return rule.plain
}
const PLATFORM_ONLY: StorageConfig = { ...CONFIG, repoPolicies: { [REPO]: { targets: ['platform'], replicas: 1, platformFallback: false } }, profiles: [...CONFIG.profiles, { name: 'platform', settings: { kind: 'platform', provider: 'platform' }, secrets: {} } as StorageConfig['profiles'][number]] }

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
    expect(Object.keys(sharePlain(CONFIG, REPO).profiles)).toEqual(['r2-main'])
    expect(shareRule(storageEntries({ ...CONFIG, repoPolicies: {}, defaultPolicy: { targets: ['platform'], replicas: 1, platformFallback: false } }), REPO).kind).toBe('nothing')
  })

  it('grants each maintainer with a key, and lists the rest as waiting', async () => {
    const { platform, owner, member } = identities()
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB, CAROL] })
    expect(done).toEqual({ granted: [ALICE, BOB], waiting: [CAROL], shared: true, epoch: 0 })
    const got = await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER })
    expect(got?.profiles.map((p) => p.name)).toEqual(['r2-main'])
    expect(got?.profiles[0]?.secrets).toEqual(R2.secrets)
    // A second visit with nothing changed writes nothing.
    const writes = platform.writes
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB, CAROL] })
    expect(platform.writes).toBe(writes)
  })

  it('a removal moves to the next epoch: the removed member reads nothing, the others still do', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE], removed: [BOB] })
    expect(done.epoch).toBe(1)
    expect([...platform.grants.values()].map((g) => g.fields.memberId)).toEqual([ALICE])
    expect(await readGrantedStorage(member(BOB), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
    expect((await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER }))?.epoch).toBe(1)
  })

  it('finds a grant to someone no longer a maintainer and moves the epoch', async () => {
    const { owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
    expect((await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })).epoch).toBe(1)
  })

  it('accepts a grant only from the repo’s owner', async () => {
    const { owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    expect(await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: BOB })).toBeNull()
  })

  it('pushes to that repo alone use the shared profiles, renamed apart, unless the maintainer chose otherwise', async () => {
    const { owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
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
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB], removed: [BOB] })
    // A node a block behind still lists BOB: the tab's removed list keeps them out, and nothing moves again.
    const writes = platform.writes
    const again = await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB], removed: [BOB] })
    expect(again).toEqual({ granted: [ALICE], waiting: [], shared: true, epoch: 1 })
    expect(platform.writes).toBe(writes)
    expect(await readGrantedStorage(member(BOB), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
  })

  it('a repo switched to Platform only shares nothing at the next epoch and revokes every grant, never deleting the share', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: storageEntries(PLATFORM_ONLY), maintainers: [ALICE] })
    expect(done.shared).toBe(true)
    expect([...platform.shares.values()].map((s) => s.fields.epoch)).toEqual([1])
    expect(platform.grants.size).toBe(0)
    // Already stopped: nothing more is written.
    const writes = platform.writes
    await reconcileRepoShare(owner, { repoId: REPO, view: storageEntries(PLATFORM_ONLY), maintainers: [ALICE] })
    expect(platform.writes).toBe(writes)
    expect(await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
  })

  it('a share’s epoch never goes back: remove, stop, share again, each above every earlier one', async () => {
    const { platform, owner, member } = identities()
    const epochs: number[] = []
    const shareEpoch = (): number => [...platform.shares.values()][0]!.fields.epoch
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
    epochs.push(shareEpoch())
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE], removed: [BOB] })
    epochs.push(shareEpoch())
    await reconcileRepoShare(owner, { repoId: REPO, view: storageEntries(PLATFORM_ONLY), maintainers: [ALICE] })
    epochs.push(shareEpoch())
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    epochs.push(shareEpoch())
    // Sharing again stays at the stop's epoch, as dg does: no grant ever went to it.
    expect(epochs).toEqual([0, 1, 2, 2])
    expect((await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER }))?.epoch).toBe(2)
    expect(await readGrantedStorage(member(BOB), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
  })

  it('with no share but grants left over, a first share starts above them', async () => {
    const { platform, owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE], removed: [BOB] })
    for (const g of platform.grants.values()) platform.grants.set(`x/${g.id}`, { ...g, fields: { ...g.fields, epoch: 7 } })
    platform.shares.clear()
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    expect(done.epoch).toBe(8)
  })

  it('a share another client wrote with the same meaning is not rewritten', async () => {
    const { platform, owner } = identities()
    const plain = sharePlain(CONFIG, REPO)
    const dgWritten = { ...plain, profiles: { 'r2-main': { dg: { note: 1 }, secrets: { ...R2.secrets, sessionToken: '' }, settings: R2.settings } } }
    expect(shareMeaning(dgWritten)).toBe(shareMeaning(plain))
    const rsk = await repoStorageKey(owner.E, decodeIdentifier(REPO), 'testnet', 0)
    await platform.port(OWNER).writeShare(REPO, await sealShare(rsk, { network: 'testnet', repoId: decodeIdentifier(REPO), epoch: 0, keyId: owner.keyId }, dgWritten), null)
    const writes = platform.writes
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [] })
    expect(platform.writes).toBe(writes)
  })

  it('accepts a share whose policy names Platform without a profile (dg writes them)', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    const rsk = await repoStorageKey(owner.E, decodeIdentifier(REPO), 'testnet', 0)
    const stored = [...platform.shares.values()][0]!
    const plain = { ...sharePlain(CONFIG, REPO), policy: { targets: ['r2-main', 'platform'], replicas: 1, platformFallback: false } }
    await platform.port(OWNER).writeShare(REPO, await sealShare(rsk, { network: 'testnet', repoId: decodeIdentifier(REPO), epoch: 0, keyId: owner.keyId }, plain), stored)
    const got = await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER })
    expect(got?.policy.targets).toEqual(['r2-main', 'platform'])
    const own: StorageConfig = { version: 1, profiles: [], defaultPolicy: null, repoPolicies: {}, lastTests: {} }
    expect(withGrantedStorage(own, REPO, got).profiles.map((p) => p.name)).toEqual(['shared-r2-main', 'platform'])
  })

  it('keep (no usable policy, or a profile it names is not synced): the share stays, refreshed only for those holding it', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    const unsynced = { ...VIEW, [`repo:${REPO}`]: { targets: ['not-synced'], replicas: 1, platformFallback: false } }
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: unsynced, maintainers: [ALICE, BOB] })
    // Kept for ALICE, who holds it; BOB is new, and a kept share is never lent anew.
    expect(done).toEqual({ granted: [ALICE], waiting: [], shared: true, epoch: 0 })
    expect((await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER }))?.profiles.map((p) => p.name)).toEqual(['r2-main'])
    expect(await readGrantedStorage(member(BOB), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
    const gone = await reconcileRepoShare(owner, { repoId: REPO, view: { [`repo:${REPO}`]: { targets: [] } }, maintainers: [], removed: [ALICE] })
    expect(gone.epoch).toBe(1)
    expect(await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
    expect(platform.shares.size).toBe(1)
  })

  it('keep with no share writes the nothing share past a leftover grant before deleting it', async () => {
    const { platform, owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    for (const [k, g] of platform.grants) platform.grants.set(k, { ...g, fields: { ...g.fields, epoch: 7 } })
    platform.shares.clear()
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: {}, maintainers: [] })
    expect(done.epoch).toBe(8)
    expect([...platform.shares.values()].map((s) => s.fields.epoch)).toEqual([8])
    expect(platform.grants.size).toBe(0)
  })

  it('stopping returns the epoch it wrote', async () => {
    const { platform, owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: storageEntries(PLATFORM_ONLY), maintainers: [ALICE] })
    expect(done.epoch).toBe([...platform.shares.values()][0]!.fields.epoch)
  })

  it('a grant another tab wrote during the pass to someone no longer a maintainer is revoked at the next epoch', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
    const bobs = [...platform.grants.values()].find((g) => g.fields.memberId === BOB)!
    platform.grants.clear()
    let reads = 0
    const port = {
      ...owner.port,
      grantsOf: async (o: string, r: string) => {
        const got = await owner.port.grantsOf(o, r)
        // Another tab, with a stale member list, grants Bob again right after this pass read the grants.
        if (reads++ === 0) platform.grants.set(`${OWNER}/${REPO}/${BOB}`, bobs)
        return got
      },
    }
    const done = await reconcileRepoShare({ ...owner, port }, { repoId: REPO, view: VIEW, maintainers: [ALICE], removed: [BOB] })
    expect(done.epoch).toBe(1)
    expect([...platform.grants.values()].map((g) => g.fields.memberId)).toEqual([ALICE])
    expect(await readGrantedStorage(member(BOB), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
  })

  it('rewrites a grant envelope of another size', async () => {
    const { platform, owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    for (const [k, g] of platform.grants) platform.grants.set(k, { ...g, fields: { ...g.fields, wrapped: new Uint8Array(61) } })
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    expect([...platform.grants.values()].map((g) => g.fields.wrapped.length)).toEqual([60])
  })

  it('a maintainer uses each shared destination once, and keeps its own profile of the shared name', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    const rsk = await repoStorageKey(owner.E, decodeIdentifier(REPO), 'testnet', 0)
    const stored = [...platform.shares.values()][0]!
    const plain = { ...sharePlain(CONFIG, REPO), policy: { targets: ['r2-main', 'platform', 'platform'], replicas: 3, platformFallback: false } }
    await platform.port(OWNER).writeShare(REPO, await sealShare(rsk, { network: 'testnet', repoId: decodeIdentifier(REPO), epoch: 0, keyId: owner.keyId }, plain), stored)
    const got = await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER })
    expect(got?.policy).toEqual({ targets: ['r2-main', 'platform'], replicas: 2, platformFallback: false })
    const mine = { ...R2, name: 'shared-r2-main', settings: { ...R2.settings, bucket: 'alice' } } as StorageConfig['profiles'][number]
    const own: StorageConfig = { version: 1, profiles: [mine], defaultPolicy: { targets: ['shared-r2-main'], replicas: 1, platformFallback: false }, repoPolicies: {}, lastTests: {} }
    const cfg = withGrantedStorage(own, REPO, got)
    expect(cfg.profiles.find((p) => p.name === 'shared-r2-main')).toEqual(mine)
    expect(cfg.repoPolicies[REPO]?.targets).toEqual(['shared-r2-main-2', 'platform'])
  })

  it('a share of the repo’s own storage the owner removed stops: nothing at the next epoch, every grant revoked, said plainly once', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
    const { [`repo:${REPO}`]: _own, ...defaultOnly } = VIEW
    expect(shareRule(defaultOnly, REPO)).toEqual({ kind: 'nothing', reason: 'no-repo-policy' })
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: defaultOnly, maintainers: [ALICE, BOB], repoPolicyRemoved: true })
    expect(done).toMatchObject({ granted: [], shared: true, epoch: 1, stopped: 'removed' })
    expect(platform.grants.size).toBe(0)
    expect(await readGrantedStorage(member(ALICE), { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
    const writes = platform.writes
    const again = await reconcileRepoShare(owner, { repoId: REPO, view: defaultOnly, maintainers: [ALICE, BOB], repoPolicyRemoved: true })
    expect(again.stopped).toBeUndefined()
    expect(platform.writes).toBe(writes)
  })

  it('a share that held the default storage (the old rule) stops and says so', async () => {
    const { platform, owner } = identities()
    const legacy = { ...VIEW, [`repo:${REPO}`]: VIEW['default'] }
    await reconcileRepoShare(owner, { repoId: REPO, view: legacy, maintainers: [ALICE] })
    const { [`repo:${REPO}`]: _own, ...defaultOnly } = VIEW
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: defaultOnly, maintainers: [ALICE] })
    expect(done).toMatchObject({ granted: [], shared: true, epoch: 1, stopped: 'default' })
    expect(platform.grants.size).toBe(0)
  })

  it('a Platform-only repo setting stops sharing without a line (the owner set it)', async () => {
    const { platform, owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: storageEntries(PLATFORM_ONLY), maintainers: [ALICE] })
    expect(done).toMatchObject({ granted: [], epoch: 1 })
    expect(done.stopped).toBeUndefined()
    expect(platform.grants.size).toBe(0)
  })

  it('grants an older build left with no share: revoked, the empty share above their epoch, the default line', async () => {
    const { platform, owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    platform.shares.clear()
    const { [`repo:${REPO}`]: _own, ...defaultOnly } = VIEW
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: defaultOnly, maintainers: [ALICE] })
    expect(done).toMatchObject({ granted: [], epoch: 1, stopped: 'default' })
    expect(platform.grants.size).toBe(0)
  })

  it('a share kept as it is is refreshed for those holding it, never lent to a new maintainer', async () => {
    const { platform, owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    const unusable = { ...VIEW, [`repo:${REPO}`]: { targets: [] } }
    expect(shareRule(unusable, REPO).kind).toBe('keep')
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: unusable, maintainers: [ALICE, BOB] })
    expect(done.granted).toEqual([ALICE])
    expect(done.waiting).toEqual([])
    expect([...platform.grants.keys()].some((k) => k.endsWith(`/${BOB}`))).toBe(false)
  })

  it('a member’s new key moves the share to the next epoch: the rotated-out key opens nothing current', async () => {
    const { platform, owner, member } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    const before = member(ALICE)
    const E = secp.utils.randomSecretKey()
    platform.keys.set(ALICE, { keyId: 12, pub: secp.getPublicKey(E, true) })
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    expect(done).toMatchObject({ granted: [ALICE], epoch: 1 })
    expect([...platform.grants.values()].map((g) => [g.fields.recipientKeyId, g.fields.epoch])).toEqual([[12, 1]])
    expect([...platform.shares.values()][0]!.fields.epoch).toBe(1)
    expect(await readGrantedStorage(before, { repoId: REPO, repoOwnerId: OWNER })).toBeNull()
    expect((await readGrantedStorage({ ...before, keyId: 12, E }, { repoId: REPO, repoOwnerId: OWNER }))?.epoch).toBe(1)
    const writes = platform.writes
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    expect(platform.writes).toBe(writes)
  })

  it('a member’s new key with the old one still live: the next epoch, the grant rewritten in place', async () => {
    const { platform, owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    const old = platform.keys.get(ALICE)!
    const id = [...platform.grants.values()][0]!.id
    platform.olderKeys.set(ALICE, [old])
    platform.keys.set(ALICE, { keyId: 12, pub: secp.getPublicKey(secp.utils.randomSecretKey(), true) })
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    expect(done.epoch).toBe(1)
    const grants = [...platform.grants.values()]
    expect(grants.map((g) => [g.id, g.fields.recipientKeyId, g.fields.epoch])).toEqual([[id, 12, 1]])
  })

  it('a grant to a key no longer live is revoked at the next epoch; the member waits for a key', async () => {
    const { platform, owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
    platform.keys.delete(ALICE)
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
    expect(done).toMatchObject({ granted: [BOB], waiting: [ALICE], epoch: 1 })
    expect([...platform.grants.values()].map((g) => g.fields.memberId)).toEqual([BOB])
  })

  it('a share kept as it is that is already empty leaves its members’ grants: no epoch, no writes', async () => {
    const { platform, owner } = identities()
    await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })
    const grant = [...platform.grants.entries()][0]!
    const { [`repo:${REPO}`]: _own, ...defaultOnly } = VIEW
    await reconcileRepoShare(owner, { repoId: REPO, view: defaultOnly, maintainers: [ALICE] })
    expect(platform.grants.size).toBe(0)
    // A grant left behind (an interrupted stop, another client): under keep, it stays.
    platform.grants.set(grant[0], grant[1])
    const writes = platform.writes
    const unusable = { ...VIEW, [`repo:${REPO}`]: { targets: [] } }
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: unusable, maintainers: [ALICE] })
    expect(done).toMatchObject({ granted: [], epoch: 1 })
    expect(platform.writes).toBe(writes)
    expect(platform.grants.size).toBe(1)
  })

  it('a repo with no storage of its own and no share writes nothing', async () => {
    const { platform, owner } = identities()
    const done = await reconcileRepoShare(owner, { repoId: REPO, view: { default: VIEW['default'], 'profile:r2-main': VIEW['profile:r2-main'] }, maintainers: [ALICE] })
    expect(done).toEqual({ granted: [], waiting: [], shared: false, epoch: null })
    expect(platform.writes).toBe(0)
  })
})

/**
 * Moving settings sync to a new key (#751) over the fake forge-user: every slot and share opens
 * under the new key with its plaintext unchanged, the old key opens nothing, an interrupted move
 * carries on from where it stopped, a wrong phrase or an identity without sync writes nothing, and
 * a session still holding the old key writes nothing either.
 */

import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeIdentifier } from '../auth/base58'
import type { StorageConfig } from '../storage/store'
import { encodePlain, inflateRaw, openShare, openStateBytes, repoStorageKey, sealStateBytes, type StateContext } from './crypto'
import { fakePlatform, fakeReplaceKey, memoryStorage, type FakePlatform } from './fake-port'
import { readGrantedStorage, reconcileRepoShare } from './maintainers'
import { SyncNotSetUpError, WrongSyncPhraseError, addSyncKey, moveSyncKey, type DeriveSyncKey, type MoveContext } from './move-key'
import type { UserSyncPort } from './platform'
import { SyncKeyChangedError, SyncKeyMovedError, syncUserSettings } from './service'
import { storageEntries } from './storage-slot'

const OWNER = '9oaYDFZ9n1zsuzMRdGLyUatghRj1zhTGJNi7uNQZzDjX'
const ALICE = 'HeHGBRkJ9zWrJ6RNRx5vtSWEDizrY6eGbYMuBqK8GfRw'
const BOB = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const REPO = 'sv4PJfH7SV4dSEJ7kFXYGk5iPzaviTT2TdXndfN7PHJ'
const NET = 'testnet'
const OLD_ID = 5

const R2 = { name: 'r2-main', settings: { kind: 's3', provider: 'r2', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://packs.example.org', prefix: '' }, secrets: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret-not-real' } } as StorageConfig['profiles'][number]
const CONFIG: StorageConfig = { version: 1, profiles: [R2], defaultPolicy: { targets: ['r2-main'], replicas: 1, platformFallback: false }, repoPolicies: { [REPO]: { targets: ['r2-main'], replicas: 1, platformFallback: true } }, lastTests: {} }
const VIEW = storageEntries(CONFIG)

/** The slots as some client wrote them: entries and a slot this build does not know, kept byte for byte. */
const SLOTS: Record<string, unknown> = {
  storage: { format: 'forge-user/storage', version: 1, entries: { 'profile:r2-main': { at: 1, v: { settings: R2.settings, secrets: R2.secrets } }, 'future:thing': { at: 2, v: { anything: [1, 'two'] } } } },
  prefs: { format: 'forge-user/prefs', version: 1, entries: { diff: { at: 3, v: 'split' }, gone: { at: 4, v: null } } },
  'later-slot': { format: 'forge-user/later-slot', version: 9, whatever: true },
}

/** A recovery phrase, as rotations: `seed` stands for the words. */
function phrase(seed: string): DeriveSyncKey {
  return async (r) => {
    const secret = sha256(new TextEncoder().encode(`${seed}/${r}`))
    return { secret, pub: secp.getPublicKey(secret, true) }
  }
}

async function E(seed: string, r: number | 'legacy'): Promise<Uint8Array> {
  return (await phrase(seed)(r)).secret
}

const ctxOf = (E: Uint8Array, keyId: number, id = OWNER): StateContext => ({ E, keyId, identityId: decodeIdentifier(id), network: NET })

interface World {
  platform: FakePlatform
  /** The compressed plaintext of each slot as first written. */
  plain: Record<string, Uint8Array>
  /** The share's plaintext at the start. */
  sharePlain: unknown
  aliceE: Uint8Array
}

async function world(): Promise<World> {
  const platform = fakePlatform()
  const e0 = await E('owner', 0)
  platform.keys.set(OWNER, { keyId: OLD_ID, pub: secp.getPublicKey(e0, true) })
  platform.maxKeyIds.set(OWNER, OLD_ID)
  const aliceE = secp.utils.randomSecretKey()
  platform.keys.set(ALICE, { keyId: 9, pub: secp.getPublicKey(aliceE, true) })
  platform.keys.set(BOB, { keyId: 4, pub: secp.getPublicKey(secp.utils.randomSecretKey(), true) })
  const port = platform.port(OWNER)
  const plain: Record<string, Uint8Array> = {}
  for (const [slot, value] of Object.entries(SLOTS)) {
    plain[slot] = encodePlain(value)
    await port.writeState(await sealStateBytes(ctxOf(e0, OLD_ID), slot, plain[slot]!), null)
  }
  const owner = { port, networkKey: NET, ownerId: OWNER, keyId: OLD_ID, E: e0 }
  await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
  // Bob removed and added again: grants have been at a later epoch than the share's first.
  await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE], removed: [BOB] })
  await reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })
  const share = platform.shares.get(`${OWNER}/${REPO}`)!
  const rsk = await repoStorageKey(e0, decodeIdentifier(REPO), NET, share.fields.epoch)
  const sharePlain = await openShare(rsk, { network: NET, repoId: decodeIdentifier(REPO) }, share.fields)
  return { platform, plain, sharePlain, aliceE }
}

function moveCtx(platform: FakePlatform, over: Partial<MoveContext> = {}): MoveContext & { stored: { keyId: number; secret: Uint8Array }[] } {
  const stored: { keyId: number; secret: Uint8Array }[] = []
  return {
    port: platform.port(OWNER),
    networkKey: NET,
    identityId: OWNER,
    derive: phrase('owner'),
    replace: fakeReplaceKey(platform, OWNER),
    store: async (keyId, secret) => void stored.push({ keyId, secret: secret.slice() }),
    sleep: async () => {},
    stored,
    ...over,
  }
}

/** A port whose `n`-th write (0-based) fails before it lands. */
function failingAt(port: UserSyncPort, n: number): UserSyncPort {
  let count = 0
  const gate = <A extends unknown[]>(f: (...a: A) => Promise<void>) => async (...a: A): Promise<void> => {
    if (count++ === n) throw new Error('the connection dropped')
    await f(...a)
  }
  return { ...port, writeState: gate(port.writeState), writeShare: gate(port.writeShare), writeGrant: gate(port.writeGrant), deleteGrant: gate(port.deleteGrant) }
}

async function expectMoved(w: World, keyId = OLD_ID + 1): Promise<void> {
  const { platform } = w
  const e1 = await E('owner', 1)
  expect(platform.keys.get(OWNER)).toEqual({ keyId, pub: secp.getPublicKey(e1, true) })
  expect(platform.disabledKeys.get(OWNER)?.map((k) => k.keyId)).toEqual([OLD_ID])
  for (const slot of Object.keys(SLOTS)) {
    const doc = platform.states.get(`${OWNER}/${slot}`)!
    expect(doc.fields.keyId).toBe(keyId)
    expect(await openStateBytes(ctxOf(e1, keyId), doc.fields)).toEqual(w.plain[slot])
  }
  const share = platform.shares.get(`${OWNER}/${REPO}`)!
  expect(share.fields.keyId).toBe(keyId)
  const grants = [...platform.grants.values()]
  expect(grants.map((g) => [g.fields.memberId, g.fields.senderKeyId, g.fields.epoch])).toEqual([[ALICE, keyId, share.fields.epoch]])
  const rsk = await repoStorageKey(e1, decodeIdentifier(REPO), NET, share.fields.epoch)
  expect(await openShare(rsk, { network: NET, repoId: decodeIdentifier(REPO) }, share.fields)).toEqual(w.sharePlain)
  const got = await readGrantedStorage({ port: platform.port(ALICE), networkKey: NET, memberId: ALICE, keyId: 9, E: w.aliceE }, { repoId: REPO, repoOwnerId: OWNER })
  expect(got?.profiles.map((p) => p.name)).toEqual(['r2-main'])
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('move sync to a new key', () => {
  it('re-seals every slot and the share under the next rotation, plaintext unchanged, grants from the new key', async () => {
    const w = await world()
    const before = Math.max(...[...w.platform.grants.values()].map((g) => g.fields.epoch), w.platform.shares.get(`${OWNER}/${REPO}`)!.fields.epoch)
    // Bob's key is gone: his grant goes, as a reconcile drops it.
    w.platform.keys.delete(BOB)
    const ctx = moveCtx(w.platform)
    const out = await moveSyncKey(ctx)
    expect(out).toMatchObject({ keyId: OLD_ID + 1, created: true, slots: 3, shares: 1, startedSlots: [] })
    expect(out.written).toBe(6)
    await expectMoved(w)
    expect(w.platform.shares.get(`${OWNER}/${REPO}`)!.fields.epoch).toBe(before + 1)
    expect(ctx.stored.map((s) => s.keyId)).toEqual([OLD_ID + 1])
    expect(ctx.stored[0]!.secret).toEqual(await E('owner', 1))
  })

  it('leaves the old key unable to open anything', async () => {
    const w = await world()
    w.platform.keys.delete(BOB)
    await moveSyncKey(moveCtx(w.platform))
    const e0 = await E('owner', 0)
    for (const slot of Object.keys(SLOTS)) {
      const doc = w.platform.states.get(`${OWNER}/${slot}`)!
      await expect(openStateBytes(ctxOf(e0, doc.fields.keyId), doc.fields)).rejects.toThrow()
      await expect(openStateBytes(ctxOf(e0, OLD_ID), doc.fields)).rejects.toThrow()
    }
    const share = w.platform.shares.get(`${OWNER}/${REPO}`)!
    const old = await repoStorageKey(e0, decodeIdentifier(REPO), NET, share.fields.epoch)
    await expect(openShare(old, { network: NET, repoId: decodeIdentifier(REPO) }, share.fields)).rejects.toThrow()
  })

  it('refuses a wrong phrase before anything is written', async () => {
    const w = await world()
    const writes = w.platform.writes
    const replace = vi.fn()
    const ctx = moveCtx(w.platform, { derive: phrase('someone else'), replace })
    await expect(moveSyncKey(ctx)).rejects.toBeInstanceOf(WrongSyncPhraseError)
    await expect(moveSyncKey(ctx)).rejects.toThrow("This recovery phrase doesn't make this identity's sync key.")
    expect(replace).not.toHaveBeenCalled()
    expect(w.platform.writes).toBe(writes)
    expect(ctx.stored).toEqual([])
  })

  it('refuses an identity with no live sync key', async () => {
    const platform = fakePlatform()
    platform.disabledKeys.set(OWNER, [{ keyId: OLD_ID, pub: secp.getPublicKey(await E('owner', 0), true) }])
    await expect(moveSyncKey(moveCtx(platform))).rejects.toBeInstanceOf(SyncNotSetUpError)
    await expect(moveSyncKey(moveCtx(fakePlatform()))).rejects.toThrow("This identity doesn't sync yet.")
    expect(platform.writes).toBe(0)
  })

  it('carries on after an interruption at every write, registering one key in all', async () => {
    const clean = await world()
    clean.platform.keys.delete(BOB)
    const start = clean.platform.writes
    await moveSyncKey(moveCtx(clean.platform))
    const total = clean.platform.writes - start
    expect(total).toBeGreaterThan(4)
    for (let n = 0; n < total; n++) {
      const w = await world()
      w.platform.keys.delete(BOB)
      await expect(moveSyncKey(moveCtx(w.platform, { port: failingAt(w.platform.port(OWNER), n) }))).rejects.toThrow('the connection dropped')
      const again = await moveSyncKey(moveCtx(w.platform))
      expect(again.created).toBe(false)
      expect(again.keyId).toBe(OLD_ID + 1)
      await expectMoved(w)
    }
  })

  it('carries on after the identity update landed but its answer was lost', async () => {
    const w = await world()
    w.platform.keys.delete(BOB)
    const lost = fakeReplaceKey(w.platform, OWNER)
    await expect(
      moveSyncKey(moveCtx(w.platform, { replace: async (add, disable) => { await lost(add, disable); throw new Error('no answer') } })),
    ).rejects.toThrow('no answer')
    expect((await moveSyncKey(moveCtx(w.platform))).created).toBe(false)
    await expectMoved(w)
  })

  it('a second move rotates again, from the moved key', async () => {
    const w = await world()
    w.platform.keys.delete(BOB)
    await moveSyncKey(moveCtx(w.platform))
    const out = await moveSyncKey(moveCtx(w.platform))
    expect(out).toMatchObject({ keyId: OLD_ID + 2, created: true, slots: 3, shares: 1, startedSlots: [] })
    const e2 = await E('owner', 2)
    expect(w.platform.keys.get(OWNER)?.pub).toEqual(secp.getPublicKey(e2, true))
    const doc = w.platform.states.get(`${OWNER}/storage`)!
    expect(await openStateBytes(ctxOf(e2, OLD_ID + 2), doc.fields)).toEqual(w.plain['storage'])
  })
})

describe('which key a move goes to', () => {
  const pubOf = async (r: number | 'legacy'): Promise<Uint8Array> => (await phrase('owner')(r)).pub

  it('a key added back under an older rotation is never resumed to: the move goes past the newest rotation', async () => {
    const w = await world()
    w.platform.keys.delete(BOB)
    await moveSyncKey(moveCtx(w.platform))
    // Rotation 0 disabled, rotation 1 live (key 6); rotation 0 registered again as key 7, now current.
    w.platform.olderKeys.set(OWNER, [w.platform.keys.get(OWNER)!])
    w.platform.keys.set(OWNER, { keyId: OLD_ID + 2, pub: await pubOf(0) })
    w.platform.maxKeyIds.set(OWNER, OLD_ID + 2)
    const port = w.platform.port(OWNER)
    const sealedWith: number[] = []
    const watched: UserSyncPort = { ...port, writeState: async (f, e) => { sealedWith.push(f.keyId); await port.writeState(f, e) }, writeShare: async (r, f, e) => { sealedWith.push(f.keyId); await port.writeShare(r, f, e) } }
    const out = await moveSyncKey(moveCtx(w.platform, { port: watched }))
    expect(out).toMatchObject({ keyId: OLD_ID + 3, created: true })
    expect(w.platform.keys.get(OWNER)).toEqual({ keyId: OLD_ID + 3, pub: await pubOf(2) })
    expect(w.platform.olderKeys.get(OWNER)).toEqual([])
    expect(w.platform.disabledKeys.get(OWNER)?.map((k) => k.keyId).sort()).toEqual([OLD_ID, OLD_ID + 1, OLD_ID + 2])
    expect(new Set(sealedWith)).toEqual(new Set([OLD_ID + 3]))
    const e2 = await E('owner', 2)
    expect(await openStateBytes(ctxOf(e2, OLD_ID + 3), w.platform.states.get(`${OWNER}/storage`)!.fields)).toEqual(w.plain['storage'])
  })

  it('a device holding an older key resumes: the update landed but nothing else did, and no second key is made', async () => {
    const platform = fakePlatform()
    platform.keys.set(OWNER, { keyId: OLD_ID, pub: await pubOf(0) })
    platform.maxKeyIds.set(OWNER, OLD_ID)
    // An identity with nothing synced yet: after the update, nothing is left under the old key.
    await expect(moveSyncKey(moveCtx(platform, { store: async () => { throw new Error('the vault refused') } }))).rejects.toThrow('the vault refused')
    expect(platform.keys.get(OWNER)?.keyId).toBe(OLD_ID + 1)
    const again = moveCtx(platform, { held: OLD_ID })
    const out = await moveSyncKey(again)
    expect(out).toMatchObject({ keyId: OLD_ID + 1, created: false, written: 0 })
    expect(again.stored.map((k) => k.keyId)).toEqual([OLD_ID + 1])
    expect(platform.disabledKeys.get(OWNER)?.map((k) => k.keyId)).toEqual([OLD_ID])
  })

  it('moves a legacy key (no rotation level) to rotation 1, and adds a legacy current key', async () => {
    const platform = fakePlatform()
    const legacy = await E('owner', 'legacy')
    platform.keys.set(OWNER, { keyId: OLD_ID, pub: await pubOf('legacy') })
    platform.maxKeyIds.set(OWNER, OLD_ID)
    const plain = encodePlain(SLOTS['storage'])
    await platform.port(OWNER).writeState(await sealStateBytes(ctxOf(legacy, OLD_ID), 'storage', plain), null)
    const stored: { keyId: number; secret: Uint8Array }[] = []
    expect(await addSyncKey({ port: platform.port(OWNER), networkKey: NET, identityId: OWNER, derive: phrase('owner'), store: async (keyId, secret) => void stored.push({ keyId, secret: secret.slice() }) })).toEqual({ keyId: OLD_ID })
    expect(stored[0]!.secret).toEqual(legacy)
    const out = await moveSyncKey(moveCtx(platform))
    expect(out).toMatchObject({ keyId: OLD_ID + 1, created: true })
    expect(platform.keys.get(OWNER)?.pub).toEqual(await pubOf(1))
    expect(await openStateBytes(ctxOf(await E('owner', 1), OLD_ID + 1), platform.states.get(`${OWNER}/storage`)!.fields)).toEqual(plain)
  })

  it('refuses when the identity already has the key a move would add', async () => {
    const platform = fakePlatform()
    platform.keys.set(OWNER, { keyId: 9, pub: await pubOf(4) })
    platform.disabledKeys.set(OWNER, [{ keyId: 10, pub: await pubOf(5) }])
    platform.maxKeyIds.set(OWNER, 10)
    const replace = vi.fn()
    await expect(moveSyncKey(moveCtx(platform, { replace }))).rejects.toThrow('already has the sync key a move would add')
    expect(replace).not.toHaveBeenCalled()
    expect(platform.writes).toBe(0)
  })
})

describe('slots the identity lacks', () => {
  const EMPTY = (slot: string): string => `{"entries":{},"format":"forge-user/${slot}","version":1}`

  /** An identity with a share and only a slot of its own: no storage or prefs yet. */
  async function bare(): Promise<FakePlatform> {
    const w = await world()
    w.platform.states.delete(`${OWNER}/storage`)
    w.platform.states.delete(`${OWNER}/prefs`)
    return w.platform
  }

  it('starts storage and prefs empty under the new key, the plaintext dg writes', async () => {
    const platform = await bare()
    const out = await moveSyncKey(moveCtx(platform))
    expect(out.startedSlots).toEqual(['storage', 'prefs'])
    const e1 = await E('owner', 1)
    for (const slot of ['storage', 'prefs']) {
      const doc = platform.states.get(`${OWNER}/${slot}`)!
      expect(doc.fields.keyId).toBe(OLD_ID + 1)
      const plain = await openStateBytes(ctxOf(e1, OLD_ID + 1), doc.fields)
      expect(new TextDecoder().decode(inflateRaw(plain))).toBe(EMPTY(slot))
    }
  })

  it('leaves a session holding the old key nothing to start under it', async () => {
    const platform = await bare()
    await moveSyncKey(moveCtx(platform))
    const writes = platform.writes
    const local = memoryStorage()
    local.setItem('forge:fiat:v1', JSON.stringify({ v: 1, enabled: true, currency: 'EUR' }))
    await expect(syncUserSettings({ port: platform.port(OWNER), networkKey: NET, network: NET, identityId: OWNER, keyId: OLD_ID, E: await E('owner', 0), deviceId: 'aaaa', storage: null, localStore: local })).rejects.toBeInstanceOf(SyncKeyChangedError)
    expect(platform.writes).toBe(writes)
  })

  it('carries on after an interruption while starting them, starting each once', async () => {
    const clean = await bare()
    const start = clean.writes
    await moveSyncKey(moveCtx(clean))
    const total = clean.writes - start
    for (let n = 0; n < total; n++) {
      const platform = await bare()
      await expect(moveSyncKey(moveCtx(platform, { port: failingAt(platform.port(OWNER), n) }))).rejects.toThrow('the connection dropped')
      const again = await moveSyncKey(moveCtx(platform))
      expect(again.created).toBe(false)
      expect([...platform.states.keys()].sort()).toEqual([`${OWNER}/later-slot`, `${OWNER}/prefs`, `${OWNER}/storage`])
      for (const doc of platform.states.values()) expect(doc.fields.keyId).toBe(OLD_ID + 1)
      expect(platform.keys.get(OWNER)?.keyId).toBe(OLD_ID + 1)
      // Done: a resume writes nothing more.
      const writes = platform.writes
      platform.keys.set(OWNER, platform.keys.get(OWNER)!)
      expect(platform.writes).toBe(writes)
    }
  })
})

describe('a session holding the old key', () => {
  it('gets SyncKeyChangedError from sync and writes nothing', async () => {
    const w = await world()
    await moveSyncKey(moveCtx(w.platform))
    const writes = w.platform.writes
    const e0 = await E('owner', 0)
    const run = syncUserSettings({ port: w.platform.port(OWNER), networkKey: NET, network: NET, identityId: OWNER, keyId: OLD_ID, E: e0, deviceId: 'aaaa', storage: null, localStore: memoryStorage() })
    await expect(run).rejects.toBeInstanceOf(SyncKeyMovedError)
    await expect(syncUserSettings({ port: w.platform.port(OWNER), networkKey: NET, network: NET, identityId: OWNER, keyId: OLD_ID, E: e0, deviceId: 'aaaa', storage: null, localStore: memoryStorage() })).rejects.toBeInstanceOf(SyncKeyChangedError)
    expect(w.platform.writes).toBe(writes)
  })

  it('writes no share or grant after a move, nor during one cut short', async () => {
    const w = await world()
    const e0 = await E('owner', 0)
    const owner = { port: w.platform.port(OWNER), networkKey: NET, ownerId: OWNER, keyId: OLD_ID, E: e0 }
    // Cut short: the new key is registered, nothing sealed under it yet.
    await expect(moveSyncKey(moveCtx(w.platform, { port: failingAt(w.platform.port(OWNER), 0) }))).rejects.toThrow()
    let writes = w.platform.writes
    await expect(reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE] })).rejects.toBeInstanceOf(SyncKeyMovedError)
    expect(w.platform.writes).toBe(writes)
    await moveSyncKey(moveCtx(w.platform))
    writes = w.platform.writes
    await expect(reconcileRepoShare(owner, { repoId: REPO, view: VIEW, maintainers: [ALICE, BOB] })).rejects.toBeInstanceOf(SyncKeyMovedError)
    expect(w.platform.writes).toBe(writes)
  })

  it('a slot that never existed is not created under the old key', async () => {
    const platform = fakePlatform()
    const e0 = await E('owner', 0)
    platform.keys.set(OWNER, { keyId: OLD_ID + 1, pub: secp.getPublicKey(await E('owner', 1), true) })
    platform.disabledKeys.set(OWNER, [{ keyId: OLD_ID, pub: secp.getPublicKey(e0, true) }])
    const local = memoryStorage()
    local.setItem('forge:fiat:v1', JSON.stringify({ v: 1, enabled: true, currency: 'EUR' }))
    await expect(syncUserSettings({ port: platform.port(OWNER), networkKey: NET, network: NET, identityId: OWNER, keyId: OLD_ID, E: e0, deviceId: 'aaaa', storage: null, localStore: local })).rejects.toBeInstanceOf(SyncKeyMovedError)
    expect(platform.writes).toBe(0)
  })
})

describe('a failed identity read', () => {
  it("can't tell, so sync and sharing go ahead as before", async () => {
    const w = await world()
    const port = w.platform.port(OWNER)
    const blind: UserSyncPort = { ...port, identitySyncKeys: async () => { throw new Error('Platform is busy') } }
    const e0 = await E('owner', 0)
    const local = memoryStorage()
    local.setItem('forge:fiat:v1', JSON.stringify({ v: 1, enabled: true, currency: 'EUR' }))
    const writes = w.platform.writes
    await syncUserSettings({ port: blind, networkKey: NET, network: NET, identityId: OWNER, keyId: OLD_ID, E: e0, deviceId: 'aaaa', storage: null, localStore: local })
    expect(w.platform.writes).toBeGreaterThan(writes)
    const before = w.platform.writes
    await reconcileRepoShare({ port: blind, networkKey: NET, ownerId: OWNER, keyId: OLD_ID, E: e0 }, { repoId: REPO, view: VIEW, maintainers: [ALICE], removed: [BOB] })
    expect(w.platform.writes).toBeGreaterThan(before)
  })

  it('a read that shows another current key refuses', async () => {
    const w = await world()
    w.platform.keys.set(OWNER, { keyId: OLD_ID + 1, pub: secp.getPublicKey(await E('owner', 1), true) })
    const writes = w.platform.writes
    await expect(reconcileRepoShare({ port: w.platform.port(OWNER), networkKey: NET, ownerId: OWNER, keyId: OLD_ID, E: await E('owner', 0) }, { repoId: REPO, view: VIEW, maintainers: [ALICE], removed: [BOB] })).rejects.toBeInstanceOf(SyncKeyMovedError)
    expect(w.platform.writes).toBe(writes)
  })
})

describe('add the new key on another device', () => {
  it('stores the current key the phrase makes, and writes nothing', async () => {
    const w = await world()
    await moveSyncKey(moveCtx(w.platform))
    const writes = w.platform.writes
    const stored: { keyId: number; secret: Uint8Array }[] = []
    const ctx = { port: w.platform.port(OWNER), networkKey: NET, identityId: OWNER, derive: phrase('owner'), store: async (keyId: number, secret: Uint8Array) => void stored.push({ keyId, secret: secret.slice() }) }
    expect(await addSyncKey(ctx)).toEqual({ keyId: OLD_ID + 1 })
    expect(stored).toEqual([{ keyId: OLD_ID + 1, secret: await E('owner', 1) }])
    expect(w.platform.writes).toBe(writes)
    await expect(addSyncKey({ ...ctx, derive: phrase('someone else') })).rejects.toBeInstanceOf(WrongSyncPhraseError)
    expect(stored).toHaveLength(1)
  })
})

describe('the sync line after a move', () => {
  it('a sync refused for a moved key reads as moved, any other failure as an error', async () => {
    const { requestUserSync, setSyncSubject, userSyncStatus } = await import('./session')
    setSyncSubject(OWNER, { kind: 'syncing', syncedAt: 1 })
    setSyncSubject(OWNER, { kind: 'local', syncedAt: 1 })
    await requestUserSync(OWNER, async () => {
      throw new SyncKeyMovedError(6, 5)
    })
    expect(userSyncStatus()).toEqual({ kind: 'moved', syncedAt: 1 })
    await requestUserSync(OWNER, async () => {
      throw new SyncKeyChangedError(4, 5)
    })
    expect(userSyncStatus().kind).toBe('error')
  })
})

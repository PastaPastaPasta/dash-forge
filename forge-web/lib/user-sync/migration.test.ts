/**
 * Migration (docs/design/identity-synced-state.md §8): a browser with master-format settings (the
 * sealed vault storage blob, written by the store's own API, and the preference keys in
 * localStorage) syncs for the first time. The merged view holds every profile, policy and
 * preference; the local stores are unchanged but for additions; a second device with nothing
 * local ends with the same effective config; and the old reader still reads the local blob.
 */

import { bytesToHex } from '@noble/hashes/utils.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { idbEntries, idbPut, resetMemoryStores } from '../idb'
import { lockVault, storeInVault, unlockWithPassphrase } from '../auth/vault'
import { encodeWif } from '../auth/wif'
import { loadStorageConfig, saveStorageConfig, type StorageConfig } from '../storage/store'
import { parsePrefs, PREFS_KEY } from '../view/prefs'
import { fakePlatform, memoryStorage } from './fake-port'
import { readPref, recordKey, setActive } from './overlay'
import { syncUserSettings, type SyncContext } from './service'
import type { FakePlatform } from './fake-port'

const NETWORK = 'testnet' as const
const ID = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const SECRET = { identityId: ID, keyId: 5, wif: encodeWif(new Uint8Array(32).fill(7), NETWORK) }
const E = new Uint8Array(32).fill(0x51)
const KEY_ID = 9

const MASTER_CONFIG: StorageConfig = {
  version: 1,
  profiles: [
    { name: 'home-kubo', settings: { kind: 'ipfs-kubo', provider: 'kubo', api: 'http://127.0.0.1:5001', gateway: 'http://127.0.0.1:8080', publicGateway: 'https://ipfs.example.org', pinningEndpoint: '' }, secrets: { apiAuth: 'Basic dGVzdDp0ZXN0' } },
    { name: 'r2-main', settings: { kind: 's3', provider: 'r2', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'forge', pathStyle: true, publicUrl: 'https://packs.example.org', prefix: '' }, secrets: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret-not-real' } },
  ],
  defaultPolicy: { targets: ['r2-main', 'home-kubo'], replicas: 1, platformFallback: false },
  repoPolicies: { '9oaYDFZ9n1zsuzMRdGLyUatghRj1zhTGJNi7uNQZzDjX': { targets: ['home-kubo'], replicas: 1, platformFallback: true } },
  lastTests: { 'r2-main': { at: 1764000000000, ok: true } },
}

const MASTER_PREFS: Record<string, string> = {
  [PREFS_KEY]: JSON.stringify({ diffLayout: 'unified', ignoreWhitespace: true, palette: 'colorblind', mergeName: 'Test User', mergeEmail: 'test@example.org' }),
  'forge:fiat:v1': JSON.stringify({ v: 1, enabled: true, currency: 'EUR' }),
  'forge.trending.v1': 'off',
  'forge.imageHosts.v1': JSON.stringify(['img.example.org']),
  'forge.ipfsGateways': JSON.stringify(['https://gw.example.org']),
  'forge.ipfsPeer': 'off',
  'forge:orgs:testnet': JSON.stringify([{ network: 'testnet', orgId: 'Org1', room: 'r', relay: 'https://relay.example.org', authPub: '02ab', label: 'Org', threshold: 2, members: [] }]),
  'forge.unrelated': 'kept',
}

/** One device: its vault and its localStorage. */
interface Device {
  vault: [string, unknown][]
  local: ReturnType<typeof memoryStorage>
  pass: string
}

function snapshotVault(entries: [string, unknown][]): string {
  return JSON.stringify(entries, (_k, v: unknown) => (v instanceof Uint8Array ? bytesToHex(v) : v))
}

async function use(device: Device): Promise<void> {
  lockVault()
  resetMemoryStores()
  for (const [k, v] of device.vault) await idbPut('vault', k, v)
  vi.stubGlobal('localStorage', device.local)
  if (device.vault.length > 0) await unlockWithPassphrase(NETWORK, ID, device.pass)
}

async function leave(device: Device): Promise<void> {
  device.vault = await idbEntries('vault')
}

function ctx(platform: FakePlatform, deviceId: string, local: Storage): SyncContext {
  return {
    port: platform.port(ID),
    networkKey: NETWORK,
    network: NETWORK,
    identityId: ID,
    keyId: KEY_ID,
    E,
    deviceId,
    storage: { load: () => loadStorageConfig(NETWORK, ID), save: (c) => saveStorageConfig(NETWORK, ID, c) },
    localStore: local,
    now: () => 1764100000000,
  }
}

describe('first sync from master-format state', () => {
  let platform: FakePlatform
  let a: Device
  let b: Device

  beforeEach(async () => {
    platform = fakePlatform()
    a = { vault: [], local: memoryStorage(), pass: 'correct horse battery' }
    b = { vault: [], local: memoryStorage(), pass: 'another passphrase!' }
    // Device A, as master left it: the vault, its sealed storage blob, and the preference keys.
    await use(a)
    await storeInVault(NETWORK, SECRET, { passphrase: 'correct horse battery' })
    await saveStorageConfig(NETWORK, ID, MASTER_CONFIG)
    for (const [k, v] of Object.entries(MASTER_PREFS)) a.local.setItem(k, v)
  }, 60_000)

  afterEach(() => {
    setActive(NETWORK, null)
    vi.unstubAllGlobals()
    lockVault()
  })

  it('merges every profile, policy and preference, and changes nothing local but additions', async () => {
    const vaultBefore = snapshotVault(await idbEntries('vault'))
    const localBefore = new Map(a.local.map)

    const out = await syncUserSettings(ctx(platform, 'aaaa', a.local))

    expect(out.storage).toEqual(MASTER_CONFIG)
    // The vault is byte-identical: nothing was added (the synced copy held nothing it lacked).
    expect(snapshotVault(await idbEntries('vault'))).toBe(vaultBefore)
    // localStorage: every key as it was; the only new key is sync's own record.
    for (const [k, v] of localBefore) expect(a.local.getItem(k)).toBe(v)
    expect([...a.local.map.keys()].filter((k) => !localBefore.has(k))).toEqual([recordKey(NETWORK, ID)])
    // Uploaded, read back and compared before the sync was recorded.
    expect(platform.states.size).toBe(2)
    const record = JSON.parse(a.local.getItem(recordKey(NETWORK, ID))!)
    expect(record.storage.syncedAt).toBe(1764100000000)
    expect(record.prefs.syncedAt).toBe(1764100000000)
    // The old reader still reads the blob, unchanged.
    expect(await loadStorageConfig(NETWORK, ID)).toEqual(MASTER_CONFIG)
    expect(parsePrefs(a.local.getItem(PREFS_KEY))).toEqual(parsePrefs(MASTER_PREFS[PREFS_KEY]!))
  }, 60_000)

  it('a second device with nothing local ends with the same effective config, written through additively', async () => {
    const first = await syncUserSettings(ctx(platform, 'aaaa', a.local))
    await leave(a)

    await use(b)
    await storeInVault(NETWORK, SECRET, { passphrase: 'another passphrase!' })
    b.local.setItem('forge.unrelated', 'mine')
    const second = await syncUserSettings(ctx(platform, 'bbbb', b.local))

    expect(second.storage).toEqual(first.storage)
    // Write-through: the second device's own blob now holds every synced profile and policy, and an
    // older build there reads it.
    expect(await loadStorageConfig(NETWORK, ID)).toEqual(MASTER_CONFIG)
    // Preferences it never set take the synced values as its own; its other keys are untouched.
    for (const k of [PREFS_KEY, 'forge:fiat:v1', 'forge.trending.v1', 'forge.imageHosts.v1', 'forge.ipfsGateways', 'forge:orgs:testnet']) {
      expect(JSON.parse(JSON.stringify(b.local.getItem(k)))).not.toBeNull()
    }
    expect(parsePrefs(b.local.getItem(PREFS_KEY))).toEqual(parsePrefs(MASTER_PREFS[PREFS_KEY]!))
    expect(b.local.getItem('forge.unrelated')).toBe('mine')
    // ipfsPeer stays per device.
    expect(b.local.getItem('forge.ipfsPeer')).toBeNull()
  }, 120_000)

  it('a preference set on both devices: the local key is never overwritten, readers see the synced value until it changes here', async () => {
    await syncUserSettings(ctx(platform, 'aaaa', a.local))
    await leave(a)

    await use(b)
    await storeInVault(NETWORK, SECRET, { passphrase: 'another passphrase!' })
    const own = JSON.stringify({ diffLayout: 'split', ignoreWhitespace: false, palette: 'standard', mergeName: '', mergeEmail: '' })
    b.local.setItem(PREFS_KEY, own)
    await syncUserSettings(ctx(platform, 'bbbb', b.local))
    expect(b.local.getItem(PREFS_KEY)).toBe(own)
    setActive(NETWORK, ID)
    expect(parsePrefs(readPref(PREFS_KEY)).diffLayout).toBe('unified')

    // Changed here: the local value wins at once, and the next sync uploads it.
    const mine = JSON.stringify({ ...parsePrefs(readPref(PREFS_KEY)), palette: 'standard' })
    b.local.setItem(PREFS_KEY, mine)
    expect(readPref(PREFS_KEY)).toBe(mine)
    await syncUserSettings({ ...ctx(platform, 'bbbb', b.local), now: () => 1764100005000 })
    await leave(b)

    await use(a)
    await syncUserSettings({ ...ctx(platform, 'aaaa', a.local), now: () => 1764100009000 })
    setActive(NETWORK, ID)
    expect(parsePrefs(readPref(PREFS_KEY)).palette).toBe('standard')
    expect(a.local.getItem(PREFS_KEY)).toBe(MASTER_PREFS[PREFS_KEY])
  }, 120_000)

  it('a profile both devices hold with other settings: nothing is dropped', async () => {
    await syncUserSettings(ctx(platform, 'aaaa', a.local))
    await leave(a)

    await use(b)
    await storeInVault(NETWORK, SECRET, { passphrase: 'another passphrase!' })
    const theirs = { ...MASTER_CONFIG.profiles[1]!, settings: { ...MASTER_CONFIG.profiles[1]!.settings, bucket: 'other' } } as StorageConfig['profiles'][number]
    await saveStorageConfig(NETWORK, ID, { ...MASTER_CONFIG, profiles: [theirs], defaultPolicy: null, repoPolicies: {}, lastTests: {} })
    const out = await syncUserSettings(ctx(platform, 'bbbb', b.local))

    // The synced r2-main wins the name; this device's own is shown beside it, and kept locally.
    expect(out.storage!.profiles.map((p) => p.name)).toEqual(['home-kubo', 'r2-main', 'r2-main-bbbb'])
    expect(out.storage!.profiles.find((p) => p.name === 'r2-main-bbbb')).toEqual({ ...theirs, name: 'r2-main-bbbb' })
    const local = await loadStorageConfig(NETWORK, ID)
    expect(local.profiles.find((p) => p.name === 'r2-main')).toEqual(theirs)
    expect(local.profiles.map((p) => p.name)).toEqual(['home-kubo', 'r2-main'])
  }, 120_000)

  it('a profile deleted on one device is hidden on the other, never deleted there', async () => {
    await syncUserSettings(ctx(platform, 'aaaa', a.local))
    await leave(a)
    await use(b)
    await storeInVault(NETWORK, SECRET, { passphrase: 'another passphrase!' })
    await syncUserSettings(ctx(platform, 'bbbb', b.local))
    // The user deletes home-kubo on device B (Settings removes it, and its policies, from the blob).
    const local = await loadStorageConfig(NETWORK, ID)
    await saveStorageConfig(NETWORK, ID, { ...local, profiles: local.profiles.filter((p) => p.name !== 'home-kubo'), defaultPolicy: { targets: ['r2-main'], replicas: 1, platformFallback: false }, repoPolicies: {} })
    await syncUserSettings({ ...ctx(platform, 'bbbb', b.local), now: () => 1764100005000 })
    await leave(b)

    await use(a)
    const out = await syncUserSettings({ ...ctx(platform, 'aaaa', a.local), now: () => 1764100009000 })
    expect(out.storage!.profiles.map((p) => p.name)).toEqual(['r2-main'])
    expect(out.storage!.defaultPolicy).toEqual({ targets: ['r2-main'], replicas: 1, platformFallback: false })
    // Device A keeps its own copy: restorable, and an older build there still has it.
    expect(await loadStorageConfig(NETWORK, ID)).toEqual(MASTER_CONFIG)
  }, 120_000)

  it('keeps entries this build does not understand, and writes them back', async () => {
    await syncUserSettings(ctx(platform, 'aaaa', a.local))
    const { openState, sealState } = await import('./crypto')
    const { decodeIdentifier } = await import('../auth/base58')
    const sctx = { E, keyId: KEY_ID, identityId: decodeIdentifier(ID), network: NETWORK }
    const stored = platform.states.get(`${ID}/prefs`)!
    const doc = (await openState(sctx, stored.fields)) as { entries: Record<string, unknown> }
    const withFuture = { ...doc, futureField: 1, entries: { ...doc.entries, ipfsPeer: { at: 1, v: false }, future: { at: 2, v: { x: 1 } } } }
    platform.states.set(`${ID}/prefs`, { ...stored, revision: stored.revision! + 1n, fields: await sealState(sctx, 'prefs', withFuture) })
    a.local.setItem('forge.trending.v1', 'on')
    await syncUserSettings({ ...ctx(platform, 'aaaa', a.local), now: () => 1764100005000 })
    const after = (await openState(sctx, platform.states.get(`${ID}/prefs`)!.fields)) as Record<string, unknown> & { entries: Record<string, { v: unknown }> }
    expect(after['futureField']).toBe(1)
    expect(after.entries['future']!.v).toEqual({ x: 1 })
    expect(after.entries['ipfsPeer']!.v).toBe(false)
    expect(after.entries['trending']!.v).toBe(true)
    // ipfsPeer is not applied here.
    expect(a.local.getItem('forge.ipfsPeer')).toBe('off')
  }, 60_000)
})

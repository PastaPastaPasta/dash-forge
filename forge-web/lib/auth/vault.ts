/**
 * The browser vault (`ux-dx-spec.md` §2.3): this browser's limited signing key, encrypted at
 * rest, unlocked for the session.
 *
 * - What it holds: one record per (network, identity) — the identity id, the limited key's id
 *   and its private key. Never a master key: the import and create flows do not retain it past
 *   anything reaches here.
 * - At rest: IndexedDB (`vault` store), the secret sealed with AES-256-GCM under a random
 *   256-bit data key. The data key is itself wrapped (AES-GCM) by one or both of:
 *     - a passkey: WebAuthn `prf` extension output (evaluated with a random 32-byte salt stored
 *       beside it), stretched with HKDF-SHA256 to a key-wrapping key;
 *     - a passphrase: Argon2id(passphrase, 16-byte salt, m = 64 MiB, t = 3, p = 1) → 32 bytes.
 *   The AES-GCM additional data binds each ciphertext to its network, identity and slot, so a
 *   record cannot be replayed under another identity.
 * - In memory: the unlocked record lives only in this module (never React state, never
 *   localStorage), for at most {@link AUTO_LOCK_MS} (12 h) or until {@link lockVault}.
 * - Storage credentials (`ux-dx-spec.md` §3.1: bucket keys, pinning tokens) are a second
 *   AES-GCM blob beside the record (`vault-storage:<network>:<identity>`), sealed under a key
 *   HKDF-derived from the same data key. While unlocked, only that derived key is held, as a
 *   non-extractable `CryptoKey`; it is dropped with the rest on lock. A renewal that replaces
 *   the record re-seals the blob under the new data key.
 * - The identity's ENCRYPTION private key (private repos, `docs/security/private-repos.md`
 *   §5.2) is one more AES-GCM blob (`vault-enc:<network>:<identity>`) sealed under its own
 *   HKDF-derived key, so it is protected by the same passkey PRF (the default) or passphrase.
 *   It never leaves this module: `lib/auth/encryption-key.ts` gets operations only (unwrap a
 *   `repoKey`, seal a wrap), each of which opens the blob, hands the key to the SDK and wipes
 *   it. A tab-only session (the advanced raw key) holds it in memory for the session only.
 *   Blast radius: it reads every private repo the identity is a member of, and every key it
 *   has handed out as a maintainer.
 *
 * Per-origin by construction: IndexedDB and WebAuthn (`rpId` = this host) are origin-scoped.
 */

import { argon2idAsync } from '@noble/hashes/argon2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

import type { Network } from '../constants'
import { idbBatch, idbDelete, idbEntries, idbGet, idbPut } from '../idb'
import { withTimeout } from '../timeout'

/** Unlocked vaults lock themselves after this long (spec §2.3). */
export const AUTO_LOCK_MS = 12 * 60 * 60 * 1000

/** Argon2id parameters (spec §2.3: m = 64 MiB, t = 3). */
export const ARGON2_PARAMS = { m: 64 * 1024, t: 3, p: 1, dkLen: 32 } as const

/** The minimum passphrase length the vault accepts. */
export const MIN_PASSPHRASE = 10

/**
 * Hosts where many sites share one origin — a GitHub Pages project site, an IPFS path gateway.
 * Every co-hosted site could read this vault's records and ask the browser for the passkey's
 * PRF output, so the vault refuses to run there. Browsing still works.
 */
const SHARED_ORIGIN_HOSTS = [/\.github\.io$/i, /^(ipfs\.io|dweb\.link|gateway\.pinata\.cloud|cloudflare-ipfs\.com|ipfs\.[^.]+\.[^.]+)$/i]

/** Why signing in cannot happen on this origin, or null when it can. */
export function sharedOriginProblem(location: { hostname: string; pathname: string } | null = typeof window === 'undefined' ? null : window.location): string | null {
  if (location === null) return null
  const pathGateway = /^\/ip[fn]s\//.test(location.pathname)
  if (pathGateway || SHARED_ORIGIN_HOSTS.some((re) => re.test(location.hostname))) {
    return 'Signing in needs a dedicated origin; use https://forge.dashhq.org or an IPFS subdomain gateway. Browsing works here.'
  }
  return null
}

function assertDedicatedOrigin(): void {
  const problem = sharedOriginProblem()
  if (problem) throw new VaultLockedError(problem)
}

/** What the vault protects. */
export interface VaultSecret {
  readonly identityId: string
  /** The limited key's id on the identity. */
  readonly keyId: number
  /** The limited key's private key, WIF. */
  readonly wif: string
  /**
   * More keys of the same identity, each for one contract: a shipped Dash wallet grants a key
   * bound to ONE contract, so a forge-core key and a later forge-collab key are two grants.
   * Absent for a group-bound key (it covers both contracts).
   */
  readonly extra?: readonly ExtraKey[]
}

/** A wallet-granted key for one contract, held beside the main key. */
export interface ExtraKey {
  readonly contractId: string
  readonly keyId: number
  readonly wif: string
}

/** A key-wrapping slot: the data key encrypted under one unlock method. */
type Slot =
  | {
      readonly kind: 'passkey'
      readonly credentialId: Uint8Array
      readonly prfSalt: Uint8Array
      readonly iv: Uint8Array
      readonly wrapped: Uint8Array
    }
  | {
      readonly kind: 'passphrase'
      readonly salt: Uint8Array
      readonly params: typeof ARGON2_PARAMS
      readonly iv: Uint8Array
      readonly wrapped: Uint8Array
    }

/** The stored (encrypted) vault record. */
interface VaultRecord {
  readonly version: 1
  readonly network: Network
  readonly identityId: string
  readonly keyId: number
  readonly createdAt: number
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
  readonly slots: readonly Slot[]
}

/** What the UI may know about a stored vault (no secrets). */
export interface VaultInfo {
  readonly identityId: string
  readonly keyId: number
  readonly createdAt: number
  readonly methods: readonly ('passkey' | 'passphrase')[]
}

const enc = new TextEncoder()

function key(network: Network, identityId: string): string {
  return `vault:${network}:${identityId}`
}

function aad(network: Network, identityId: string, slot: string): Uint8Array {
  return enc.encode(`dash-forge vault v1|${network}|${identityId}|${slot}`)
}

function storageBlobKey(network: Network, identityId: string): string {
  return `vault-storage:${network}:${identityId}`
}

function encryptionBlobKey(network: Network, identityId: string): string {
  return `vault-enc:${network}:${identityId}`
}

/** The extra wallet grants ({@link ExtraKey}), sealed like the storage settings. */
function extraBlobKey(network: Network, identityId: string): string {
  return `vault-extra:${network}:${identityId}`
}

/** The sealed storage-credentials blob. */
interface StorageBlob {
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
}

/** The storage-blob key: HKDF(data key) → a non-extractable AES-GCM key. */
async function deriveStorageKey(dataKey: Uint8Array, network: Network, identityId: string): Promise<CryptoKey> {
  const raw = hkdf(sha256, dataKey, enc.encode('dash-forge vault storage v1'), enc.encode(`${network}|${identityId}`), 32)
  try {
    return await aesKey(raw, ['encrypt', 'decrypt'])
  } finally {
    raw.fill(0)
  }
}

/** The encryption blob's key: HKDF(data key) under its own label → a non-extractable AES-GCM key. */
async function deriveEncryptionKey(dataKey: Uint8Array, network: Network, identityId: string): Promise<CryptoKey> {
  const raw = hkdf(sha256, dataKey, enc.encode('dash-forge vault encryption v1'), enc.encode(`${network}|${identityId}`), 32)
  try {
    return await aesKey(raw, ['encrypt', 'decrypt'])
  } finally {
    raw.fill(0)
  }
}

async function sealBlob(key: CryptoKey, network: Network, identityId: string, value: unknown, slot = 'storage'): Promise<StorageBlob> {
  const iv = random(12)
  const plain = enc.encode(JSON.stringify(value))
  try {
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad(network, identityId, slot)) }, key, buf(plain))
    return { iv, ciphertext: new Uint8Array(ct) }
  } finally {
    plain.fill(0)
  }
}

async function openBlob(key: CryptoKey, network: Network, identityId: string, blob: StorageBlob, slot = 'storage'): Promise<unknown> {
  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(blob.iv), additionalData: buf(aad(network, identityId, slot)) }, key, buf(blob.ciphertext)),
    )
  } catch {
    throw new VaultLockedError(slot === 'extra' ? 'the stored wallet grants do not open with this key' : 'the stored storage settings do not open with this key')
  }
  try {
    return JSON.parse(new TextDecoder().decode(plain)) as unknown
  } finally {
    plain.fill(0)
  }
}

function random(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** A copy backed by its own ArrayBuffer (what WebCrypto's BufferSource wants). */
function buf(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b)
}

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, usage)
}

async function seal(keyBytes: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const iv = random(12)
  const k = await aesKey(keyBytes, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(ad) }, k, buf(plaintext)))
  return { iv, ct }
}

async function open(keyBytes: Uint8Array, iv: Uint8Array, ct: Uint8Array, ad: Uint8Array): Promise<Uint8Array> {
  const k = await aesKey(keyBytes, ['decrypt'])
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(ad) }, k, buf(ct)))
  } catch {
    throw new VaultLockedError('wrong passphrase or passkey')
  }
}

/** The vault could not be opened (wrong secret, no record, or locked). */
export class VaultLockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultLockedError'
  }
}

// ---------------------------------------------------------------------------
// Unlock methods → key-wrapping key
// ---------------------------------------------------------------------------

/** Argon2id(passphrase) → 32-byte wrapping key. ~1.5 s in a browser at 64 MiB. */
export async function passphraseKey(passphrase: string, salt: Uint8Array, params = ARGON2_PARAMS): Promise<Uint8Array> {
  return argon2idAsync(enc.encode(passphrase.normalize('NFKC')), salt, params)
}

/** A PRF output (32 bytes) → wrapping key. HKDF so the raw PRF output is never used as a key. */
export function prfKey(prfOutput: Uint8Array, network: Network, identityId: string): Uint8Array {
  return hkdf(sha256, prfOutput, enc.encode('dash-forge vault prf v1'), enc.encode(`${network}|${identityId}`), 32)
}

interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
}

function rpId(): string {
  return window.location.hostname
}

/**
 * How long a passkey ceremony may take (WebAuthn `timeout`, and a backstop for browsers that
 * ignore it): the user needs time for Touch ID or a security key, but not forever.
 */
export const PASSKEY_TIMEOUT_MS = 120_000

/**
 * Run a WebAuthn ceremony with the backstop: past it the ceremony is aborted (its signal), so
 * the prompt closes and the next attempt is not refused as "a request is already pending".
 */
function passkeyCeremony<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ceremony = new AbortController()
  return withTimeout(start(ceremony.signal), PASSKEY_TIMEOUT_MS + 5_000, 'The passkey prompt').catch((e: unknown) => {
    ceremony.abort()
    throw e
  })
}

/** Whether this browser can do WebAuthn at all (PRF support is only known after a ceremony). */
export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && window.isSecureContext
}

/**
 * Create a passkey for the vault and evaluate its PRF. Returns null when the authenticator
 * does not support `prf` (the caller falls back to a passphrase). Some authenticators only
 * report `prf.enabled` at creation and need a get() to produce output; both are handled.
 *
 * Every passkey gets a random WebAuthn `user.id`: platform authenticators replace a
 * discoverable credential with the same (rpId, user.id), so a shared id would let a second
 * identity's enrolment silently destroy the first identity's only unlock method.
 */
export async function enrollPasskey(label: string): Promise<{ credentialId: Uint8Array; prfSalt: Uint8Array; output: Uint8Array } | null> {
  const prfSalt = random(32)
  const cred = (await passkeyCeremony((signal) => navigator.credentials.create({
    signal,
    publicKey: {
      timeout: PASSKEY_TIMEOUT_MS,
      rp: { id: rpId(), name: 'Dash Forge' },
      user: { id: buf(random(32)), name: label, displayName: label },
      challenge: buf(random(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      extensions: { prf: { eval: { first: buf(prfSalt) } } } as AuthenticationExtensionsClientInputs,
    },
  }))) as PublicKeyCredential | null
  if (!cred) return null
  const ext = cred.getClientExtensionResults() as PrfExtensionResults
  const credentialId = new Uint8Array(cred.rawId)
  let first = ext.prf?.results?.first
  if (!first) {
    if (ext.prf?.enabled !== true) return null
    first = (await evaluatePasskey(credentialId, prfSalt)) ?? undefined
    if (!first) return null
  }
  return { credentialId, prfSalt, output: new Uint8Array(first) }
}

/** Evaluate the PRF of an enrolled passkey (a user-verified assertion). */
async function evaluatePasskey(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<ArrayBuffer | null> {
  const assertion = (await passkeyCeremony((signal) => navigator.credentials.get({
    signal,
    publicKey: {
      timeout: PASSKEY_TIMEOUT_MS,
      rpId: rpId(),
      challenge: buf(random(32)),
      allowCredentials: [{ type: 'public-key', id: buf(credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: buf(prfSalt) } } } as AuthenticationExtensionsClientInputs,
    },
  }))) as PublicKeyCredential | null
  const ext = assertion?.getClientExtensionResults() as PrfExtensionResults | undefined
  return ext?.prf?.results?.first ?? null
}

// ---------------------------------------------------------------------------
// Store / unlock / lock
// ---------------------------------------------------------------------------

/** How to protect a new vault: a passphrase, a passkey PRF output, or both. */
export interface Protection {
  readonly passphrase?: string
  readonly passkey?: { credentialId: Uint8Array; prfSalt: Uint8Array; output: Uint8Array }
}

/** What {@link storeInVault} did with storage settings sealed under the record it replaced. */
export interface StoreOutcome {
  /**
   * Storage settings existed but could not be carried across (the vault was locked when the
   * key was renewed, so they could not be opened). They are deleted; the user must add them
   * again, and the UI says so.
   */
  readonly storageSettingsDropped: boolean
  /**
   * An encryption key was stored but could not be carried across (the vault was locked when the
   * key was renewed). It is deleted; the user imports it again in Settings → Keys.
   */
  readonly encryptionKeyDropped: boolean
}

/**
 * Seal `secret` into the vault for `network`, replacing any earlier record for its identity,
 * and keep it unlocked for this session. At least one protection is required. The record and
 * the (re-sealed or deleted) storage settings are written in one transaction.
 */
export async function storeInVault(network: Network, secret: VaultSecret, protection: Protection): Promise<StoreOutcome> {
  assertDedicatedOrigin()
  if (!protection.passphrase && !protection.passkey) throw new Error('the vault needs a passphrase or a passkey')
  if (protection.passphrase !== undefined && protection.passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`use a passphrase of at least ${MIN_PASSPHRASE} characters`)
  }
  const { identityId } = secret
  // A renewal replaces the record (and its data key): carry the storage settings across when
  // this session can open them; otherwise they cannot be opened any more and are dropped.
  const hadBlob = (await idbGet<StorageBlob>('vault', storageBlobKey(network, identityId))) !== undefined
  const carried = hadBlob ? await readStorageBlob(network, identityId).catch(() => null) : null
  // The encryption key is carried the same way, but only from the stored vault blob: a tab-only
  // session's key stays in that session. One that cannot be opened is dropped, and reported.
  const hadEnc = (await idbGet<EncryptionBlob>('vault', encryptionBlobKey(network, identityId))) !== undefined
  const carriedEnc = hadEnc && unlocked?.sessionEnc === undefined ? await readEncryptionBlob(network, identityId).catch(() => null) : null
  const dataKey = random(32)
  let storageKey: CryptoKey
  let encryptionKey: CryptoKey
  // The extra grants live in their own blob, so a later grant can be added without the data key.
  const { extra, ...main } = secret
  try {
    const body = await seal(dataKey, enc.encode(JSON.stringify(main)), aad(network, identityId, 'body'))
    const slots: Slot[] = []
    if (protection.passkey) {
      const kek = prfKey(protection.passkey.output, network, identityId)
      const w = await seal(kek, dataKey, aad(network, identityId, 'passkey'))
      kek.fill(0)
      slots.push({ kind: 'passkey', credentialId: protection.passkey.credentialId, prfSalt: protection.passkey.prfSalt, iv: w.iv, wrapped: w.ct })
    }
    if (protection.passphrase) {
      const salt = random(16)
      const kek = await passphraseKey(protection.passphrase, salt)
      const w = await seal(kek, dataKey, aad(network, identityId, 'passphrase'))
      kek.fill(0)
      slots.push({ kind: 'passphrase', salt, params: ARGON2_PARAMS, iv: w.iv, wrapped: w.ct })
    }
    const record: VaultRecord = {
      version: 1,
      network,
      identityId,
      keyId: secret.keyId,
      createdAt: Date.now(),
      iv: body.iv,
      ciphertext: body.ct,
      slots,
    }
    storageKey = await deriveStorageKey(dataKey, network, identityId)
    const blob = carried !== null ? await sealBlob(storageKey, network, identityId, carried) : undefined
    const extraBlob = extra?.length ? await sealBlob(storageKey, network, identityId, extra, 'extra') : undefined
    encryptionKey = await deriveEncryptionKey(dataKey, network, identityId)
    let encBlob: EncryptionBlob | undefined
    if (carriedEnc !== null) {
      try {
        encBlob = await sealEncryptionBlob(encryptionKey, network, identityId, carriedEnc.keyId, carriedEnc.secret)
      } finally {
        carriedEnc.secret.fill(0)
      }
    }
    // One transaction: a crash between the writes must not leave settings sealed under a
    // data key no record holds any more.
    await idbBatch('vault', [
      [key(network, identityId), record],
      [storageBlobKey(network, identityId), blob],
      [extraBlobKey(network, identityId), extraBlob],
      [encryptionBlobKey(network, identityId), encBlob],
    ])
  } finally {
    dataKey.fill(0)
  }
  setUnlocked(network, secret, { storage: storageKey, encryption: encryptionKey })
  return { storageSettingsDropped: hadBlob && carried === null, encryptionKeyDropped: hadEnc && carriedEnc === null }
}

/**
 * Delete storage settings that cannot be opened (sealed under an earlier key, or unreadable),
 * so the user can start over instead of being stuck on an error.
 */
export async function discardStorageBlob(network: Network, identityId: string): Promise<void> {
  await idbDelete('vault', storageBlobKey(network, identityId))
}

/**
 * The storage settings sealed for (network, identity), or null when none are stored. Needs the
 * vault unlocked for that identity ({@link VaultLockedError} otherwise). The caller parses the
 * value (it is the caller's schema).
 */
export async function readStorageBlob(network: Network, identityId: string): Promise<unknown> {
  const k = unlockedStorageKey(network, identityId)
  const blob = await idbGet<StorageBlob>('vault', storageBlobKey(network, identityId))
  if (blob === undefined) return null
  if (k === null) throw new VaultLockedError('unlock to read your storage settings')
  return openBlob(k, network, identityId, blob)
}

/** Seal `value` as the storage settings of (network, identity). Needs the vault unlocked. */
export async function writeStorageBlob(network: Network, identityId: string, value: unknown): Promise<void> {
  assertDedicatedOrigin()
  const k = unlockedStorageKey(network, identityId)
  if (k === null) throw new VaultLockedError('unlock with a stored key to save storage settings')
  await idbPut('vault', storageBlobKey(network, identityId), await sealBlob(k, network, identityId, value))
}

/** Whether wallet grants are sealed beside the record of (network, identity) (no secrets read). */
export async function hasExtraKeys(network: Network, identityId: string): Promise<boolean> {
  return (await idbGet<StorageBlob>('vault', extraBlobKey(network, identityId))) !== undefined
}

/**
 * Add a wallet grant beside the unlocked key of (network, identity), sealed at rest and live
 * for this session. Needs the vault unlocked for that identity.
 */
export async function addExtraKey(network: Network, identityId: string, extra: ExtraKey): Promise<void> {
  assertDedicatedOrigin()
  const k = unlockedStorageKey(network, identityId)
  const current = unlocked
  if (k === null || current === null) throw new VaultLockedError('unlock this browser\'s key first')
  // Newest first, deduped by key id. An older grant for the same contract is kept, not dropped:
  // a revoke must still be able to disable it (a disabled one falls out at the next unlock).
  const next = [extra, ...(current.secret.extra ?? []).filter((e) => e.keyId !== extra.keyId)]
  await idbPut('vault', extraBlobKey(network, identityId), await sealBlob(k, network, identityId, next, 'extra'))
  unlocked = { ...current, secret: { ...current.secret, extra: next } }
}

/** The extra grants sealed for a record, or none when absent or unreadable. */
async function readExtraKeys(network: Network, identityId: string, storageKey: CryptoKey): Promise<ExtraKey[]> {
  const blob = await idbGet<StorageBlob>('vault', extraBlobKey(network, identityId))
  if (blob === undefined) return []
  const value = await openBlob(storageKey, network, identityId, blob, 'extra').catch(() => null)
  if (!Array.isArray(value)) return []
  return value.filter(
    (e): e is ExtraKey => typeof e === 'object' && e !== null && typeof e.contractId === 'string' && typeof e.keyId === 'number' && typeof e.wif === 'string',
  )
}

function unlockedStorageKey(network: Network, identityId: string): CryptoKey | null {
  if (unlockedSecret(network, identityId) === null) return null
  return unlocked?.blobKeys?.storage ?? null
}

/** The vaults stored for `network` (no secrets). */
export async function listVaults(network: Network): Promise<VaultInfo[]> {
  const rows = await idbEntries<VaultRecord>('vault', `vault:${network}:`)
  return rows.map(([, r]) => ({
    identityId: r.identityId,
    keyId: r.keyId,
    createdAt: r.createdAt,
    methods: r.slots.map((s) => s.kind),
  }))
}

async function unwrapWith(network: Network, record: VaultRecord, kek: Uint8Array, slot: Slot): Promise<{ secret: VaultSecret; blobKeys: BlobKeys }> {
  const dataKey = await open(kek, slot.iv, slot.wrapped, aad(network, record.identityId, slot.kind))
  try {
    const body = await open(dataKey, record.iv, record.ciphertext, aad(network, record.identityId, 'body'))
    const parsed = JSON.parse(new TextDecoder().decode(body)) as VaultSecret
    body.fill(0)
    if (parsed.identityId !== record.identityId) throw new VaultLockedError('vault record does not match its identity')
    const storageKey = await deriveStorageKey(dataKey, network, record.identityId)
    const extra = await readExtraKeys(network, record.identityId, storageKey)
    const secret: VaultSecret = { identityId: parsed.identityId, keyId: parsed.keyId, wif: parsed.wif, ...(extra.length ? { extra } : {}) }
    return { secret, blobKeys: { storage: storageKey, encryption: await deriveEncryptionKey(dataKey, network, record.identityId) } }
  } finally {
    dataKey.fill(0)
    kek.fill(0)
  }
}

/** Unlock with a passphrase. Throws {@link VaultLockedError} on a wrong one. */
export async function unlockWithPassphrase(network: Network, identityId: string, passphrase: string): Promise<VaultSecret> {
  assertDedicatedOrigin()
  const record = await idbGet<VaultRecord>('vault', key(network, identityId))
  const slot = record?.slots.find((s) => s.kind === 'passphrase')
  if (!record || !slot || slot.kind !== 'passphrase') throw new VaultLockedError('no passphrase-protected key for this identity here')
  // The parameters are pinned, never read from the (unauthenticated) record: a tampered
  // record cannot make unlock allocate gigabytes.
  if (JSON.stringify(slot.params) !== JSON.stringify(ARGON2_PARAMS)) throw new VaultLockedError('this key was stored with unsupported settings')
  const { secret, blobKeys } = await unwrapWith(network, record, await passphraseKey(passphrase, slot.salt), slot)
  setUnlocked(network, secret, blobKeys)
  return secret
}

/** Unlock with the enrolled passkey (a WebAuthn assertion with the PRF extension). */
export async function unlockWithPasskey(network: Network, identityId: string): Promise<VaultSecret> {
  assertDedicatedOrigin()
  const record = await idbGet<VaultRecord>('vault', key(network, identityId))
  const slot = record?.slots.find((s) => s.kind === 'passkey')
  if (!record || !slot || slot.kind !== 'passkey') throw new VaultLockedError('no passkey-protected key for this identity here')
  const output = await evaluatePasskey(slot.credentialId, slot.prfSalt)
  if (!output) throw new VaultLockedError('the passkey did not return its PRF output')
  const raw = new Uint8Array(output)
  const kek = prfKey(raw, network, identityId)
  raw.fill(0)
  const { secret, blobKeys } = await unwrapWith(network, record, kek, slot)
  setUnlocked(network, secret, blobKeys)
  return secret
}

/** Delete the stored vault for an identity (sign out and forget this browser). */
export async function forgetVault(network: Network, identityId: string): Promise<void> {
  lockVault()
  await idbDelete('vault', key(network, identityId))
  await idbDelete('vault', storageBlobKey(network, identityId))
  await idbDelete('vault', extraBlobKey(network, identityId))
  await idbDelete('vault', encryptionBlobKey(network, identityId))
  clearSignedWrites()
  notifyEncryptionKeyChange()
}

/** Drop signed-but-unconfirmed writes this browser kept for retry (no keys; still, tidy up). */
export function clearSignedWrites(): void {
  if (typeof window === 'undefined') return
  try {
    const doomed: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k?.startsWith('forge:pending-st:')) doomed.push(k)
    }
    for (const k of doomed) window.localStorage.removeItem(k)
  } catch {
    /* storage disabled */
  }
}

// The unlocked secret (and the storage-blob key, for a vault-stored key): module memory only.
/** The blob keys of a vault-stored key (non-extractable), held while unlocked. */
interface BlobKeys {
  readonly storage: CryptoKey
  readonly encryption: CryptoKey
}

/**
 * The unlocked secret and, for a vault-stored key, its blob keys; for a tab-only session, the
 * encryption key sealed under a random per-session key. Module memory only.
 */
let unlocked: {
  network: Network
  secret: VaultSecret
  at: number
  blobKeys: BlobKeys | null
  /** Tab-only sessions: the encryption key, sealed under a random per-session key. */
  sessionEnc?: { key: CryptoKey; blob: EncryptionBlob | null }
} | null = null
let lockTimer: ReturnType<typeof setTimeout> | null = null
const lockListeners = new Set<() => void>()

/** Be told when the vault locks (auto-lock, sign-out). Returns an unsubscribe function. */
export function onVaultLock(listener: () => void): () => void {
  lockListeners.add(listener)
  return () => {
    lockListeners.delete(listener)
  }
}

function setUnlocked(network: Network, secret: VaultSecret, blobKeys: BlobKeys | null = null): void {
  // Another identity (or network) takes over: the previous one's private-repo sessions end.
  const switched = unlocked !== null && (unlocked.network !== network || unlocked.secret.identityId !== secret.identityId)
  unlocked = { network, secret, at: Date.now(), blobKeys }
  if (switched) notifyEncryptionKeyChange()
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = setTimeout(lockVault, AUTO_LOCK_MS)
}

/**
 * Hold a secret for this session without storing it (the "Advanced: raw key" path: tab-scoped
 * unless the user opts into the vault).
 */
export function holdForSession(network: Network, secret: VaultSecret): void {
  setUnlocked(network, secret)
}

/** The unlocked secret for (network, identity), or null when locked or expired. */
export function unlockedSecret(network: Network, identityId: string): VaultSecret | null {
  if (!unlocked || unlocked.network !== network || unlocked.secret.identityId !== identityId) return null
  if (Date.now() - unlocked.at > AUTO_LOCK_MS) {
    lockVault()
    return null
  }
  return unlocked.secret
}

// ---------------------------------------------------------------------------
// The identity's ENCRYPTION key (private repos, `docs/security/private-repos.md` §5.2)
// ---------------------------------------------------------------------------

/** The sealed encryption key: its key id on the identity (public) and the sealed private key. */
interface EncryptionBlob {
  readonly keyId: number
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
}

function encryptionAad(network: Network, identityId: string, keyId: number): Uint8Array {
  return aad(network, identityId, `encryption|${keyId}`)
}

async function sealEncryptionBlob(key: CryptoKey, network: Network, identityId: string, keyId: number, secret: Uint8Array): Promise<EncryptionBlob> {
  if (secret.length !== 32 || !Number.isSafeInteger(keyId) || keyId < 0) throw new Error('not an encryption private key')
  const iv = random(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(encryptionAad(network, identityId, keyId)) }, key, buf(secret))
  return { keyId, iv, ciphertext: new Uint8Array(ct) }
}

async function openEncryptionBlob(key: CryptoKey, network: Network, identityId: string, blob: EncryptionBlob): Promise<Uint8Array> {
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(blob.iv), additionalData: buf(encryptionAad(network, identityId, blob.keyId)) }, key, buf(blob.ciphertext)),
    )
    if (plain.length !== 32) {
      plain.fill(0)
      throw new Error('bad length')
    }
    return plain
  } catch {
    throw new VaultLockedError('the stored encryption key does not open with this key')
  }
}

/** The unlocked session's encryption blob and the key it is sealed under, or null. */
async function encryptionSource(network: Network, identityId: string): Promise<{ key: CryptoKey; blob: EncryptionBlob } | null> {
  if (unlockedSecret(network, identityId) === null || unlocked === null) return null
  if (unlocked.sessionEnc !== undefined) return unlocked.sessionEnc.blob === null ? null : { key: unlocked.sessionEnc.key, blob: unlocked.sessionEnc.blob }
  const k = unlocked.blobKeys?.encryption
  if (k === undefined) return null
  const blob = await idbGet<EncryptionBlob>('vault', encryptionBlobKey(network, identityId))
  return blob === undefined ? null : { key: k, blob }
}

/** The stored encryption key's plaintext, for re-sealing on renewal. Needs the vault unlocked. */
async function readEncryptionBlob(network: Network, identityId: string): Promise<{ keyId: number; secret: Uint8Array } | null> {
  const src = await encryptionSource(network, identityId)
  if (src === null) return null
  return { keyId: src.blob.keyId, secret: await openEncryptionBlob(src.key, network, identityId, src.blob) }
}

const encListeners = new Set<() => void>()

/** Be told when the encryption key is added, removed, or becomes unusable (lock). */
export function onEncryptionKeyChange(listener: () => void): () => void {
  encListeners.add(listener)
  return () => {
    encListeners.delete(listener)
  }
}

function notifyEncryptionKeyChange(): void {
  for (const l of encListeners) l()
}

/** The tab-only session's encryption slot for (network, identity), or undefined. */
function sessionEncFor(network: Network, identityId: string): { key: CryptoKey; blob: EncryptionBlob | null } | undefined {
  // Not `unlockedSecret()`: that one auto-locks an expired session, which a read must not do.
  return unlocked?.network === network && unlocked.secret.identityId === identityId ? unlocked.sessionEnc : undefined
}

/**
 * Whether an encryption key is stored for (network, identity), and its key id (public: it is
 * on the identity). Readable while locked; using it needs the vault unlocked.
 */
export async function storedEncryptionKeyId(network: Network, identityId: string): Promise<number | null> {
  const session = sessionEncFor(network, identityId)
  if (session !== undefined) return session.blob?.keyId ?? null
  // Unlocked for this identity by a tab-only key: a vault blob it cannot open does not count.
  if (unlocked?.network === network && unlocked.secret.identityId === identityId && unlocked.blobKeys === null) return null
  const blob = await idbGet<EncryptionBlob>('vault', encryptionBlobKey(network, identityId))
  return blob?.keyId ?? null
}

/**
 * Seal the identity's encryption private key (32 bytes, key `keyId` on the identity) beside the
 * unlocked vault record, replacing any earlier one. A tab-only session holds it for the session
 * only. The caller has verified it against the identity and wipes `secret` afterwards.
 */
export async function storeEncryptionKey(network: Network, identityId: string, keyId: number, secret: Uint8Array): Promise<void> {
  assertDedicatedOrigin()
  if (unlockedSecret(network, identityId) === null || unlocked === null) throw new VaultLockedError('unlock this browser first')
  if (unlocked.blobKeys === null) {
    // A tab-only session: sealed under a random key that lives as long as the session.
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    unlocked.sessionEnc = { key, blob: await sealEncryptionBlob(key, network, identityId, keyId, secret) }
  } else {
    await idbPut('vault', encryptionBlobKey(network, identityId), await sealEncryptionBlob(unlocked.blobKeys.encryption, network, identityId, keyId, secret))
  }
  notifyEncryptionKeyChange()
}

/** Delete the stored encryption key (it can be imported again from the identity file). */
export async function removeEncryptionKey(network: Network, identityId: string): Promise<void> {
  const session = sessionEncFor(network, identityId)
  if (session !== undefined && unlocked !== null) unlocked.sessionEnc = { key: session.key, blob: null }
  await idbDelete('vault', encryptionBlobKey(network, identityId))
  notifyEncryptionKeyChange()
}

/**
 * Run `use` with the unlocked encryption private key (a fresh copy, wiped afterwards). Module
 * internal: callers get the {@link EncryptionOps} of `lib/auth/encryption-key.ts`, which pass the
 * key only to the SDK. Throws {@link VaultLockedError} when locked or when no key is stored.
 */
export async function withEncryptionKey<T>(network: Network, identityId: string, use: (keyId: number, secret: Uint8Array) => Promise<T>): Promise<T> {
  const src = await encryptionSource(network, identityId)
  if (src === null) {
    throw new VaultLockedError(unlockedSecret(network, identityId) === null ? 'unlock this browser to read private repos' : 'no encryption key is stored in this browser')
  }
  const secret = await openEncryptionBlob(src.key, network, identityId, src.blob)
  try {
    return await use(src.blob.keyId, secret)
  } finally {
    secret.fill(0)
  }
}

/** Forget the unlocked secret (sign-out, auto-lock). The stored record stays. */
export function lockVault(): void {
  const wasUnlocked = unlocked !== null
  unlocked = null
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = null
  if (wasUnlocked) for (const l of lockListeners) l()
  // Every private-repo session ends with the vault (its keys were opened with this unlock).
  if (wasUnlocked) notifyEncryptionKeyChange()
}

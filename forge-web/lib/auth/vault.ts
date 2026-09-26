/**
 * The browser vault (`ux-dx-spec.md` §2.3): this browser's limited signing key, encrypted at
 * rest, unlocked for the session.
 *
 * - What it holds: one record per (network, identity) — the identity id, the limited key's id
 *   and its private key. Never a master key: the import and create flows discard it before
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
 *
 * Per-origin by construction: IndexedDB and WebAuthn (`rpId` = this host) are origin-scoped.
 */

import { argon2idAsync } from '@noble/hashes/argon2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

import type { Network } from '../constants'
import { idbDelete, idbEntries, idbGet, idbPut } from '../idb'

/** Unlocked vaults lock themselves after this long (spec §2.3). */
export const AUTO_LOCK_MS = 12 * 60 * 60 * 1000

/** Argon2id parameters (spec §2.3: m = 64 MiB, t = 3). */
export const ARGON2_PARAMS = { m: 64 * 1024, t: 3, p: 1, dkLen: 32 } as const

/** The minimum passphrase length the vault accepts. */
export const MIN_PASSPHRASE = 10

/** What the vault protects. */
export interface VaultSecret {
  readonly identityId: string
  /** The limited key's id on the identity. */
  readonly keyId: number
  /** The limited key's private key, WIF. */
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

/** Whether this browser can do WebAuthn at all (PRF support is only known after a ceremony). */
export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && window.isSecureContext
}

/**
 * Create a passkey for the vault and evaluate its PRF. Returns null when the authenticator
 * does not support `prf` (the caller falls back to a passphrase). Some authenticators only
 * report `prf.enabled` at creation and need a get() to produce output; both are handled.
 */
export async function enrollPasskey(identityId: string, label: string): Promise<{ credentialId: Uint8Array; prfSalt: Uint8Array; output: Uint8Array } | null> {
  const prfSalt = random(32)
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId(), name: 'Dash Forge' },
      user: { id: buf(sha256(enc.encode(identityId))), name: label, displayName: label },
      challenge: buf(random(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      extensions: { prf: { eval: { first: buf(prfSalt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
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
  const assertion = (await navigator.credentials.get({
    publicKey: {
      rpId: rpId(),
      challenge: buf(random(32)),
      allowCredentials: [{ type: 'public-key', id: buf(credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: buf(prfSalt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
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

/**
 * Seal `secret` into the vault for `network`, replacing any earlier record for its identity,
 * and keep it unlocked for this session. At least one protection is required.
 */
export async function storeInVault(network: Network, secret: VaultSecret, protection: Protection): Promise<void> {
  if (!protection.passphrase && !protection.passkey) throw new Error('the vault needs a passphrase or a passkey')
  if (protection.passphrase !== undefined && protection.passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`use a passphrase of at least ${MIN_PASSPHRASE} characters`)
  }
  const { identityId } = secret
  const dataKey = random(32)
  try {
    const body = await seal(dataKey, enc.encode(JSON.stringify(secret)), aad(network, identityId, 'body'))
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
    await idbPut('vault', key(network, identityId), record)
  } finally {
    dataKey.fill(0)
  }
  setUnlocked(network, secret)
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

async function unwrapWith(network: Network, record: VaultRecord, kek: Uint8Array, slot: Slot): Promise<VaultSecret> {
  const dataKey = await open(kek, slot.iv, slot.wrapped, aad(network, record.identityId, slot.kind))
  try {
    const body = await open(dataKey, record.iv, record.ciphertext, aad(network, record.identityId, 'body'))
    const secret = JSON.parse(new TextDecoder().decode(body)) as VaultSecret
    body.fill(0)
    if (secret.identityId !== record.identityId) throw new VaultLockedError('vault record does not match its identity')
    return secret
  } finally {
    dataKey.fill(0)
    kek.fill(0)
  }
}

/** Unlock with a passphrase. Throws {@link VaultLockedError} on a wrong one. */
export async function unlockWithPassphrase(network: Network, identityId: string, passphrase: string): Promise<VaultSecret> {
  const record = await idbGet<VaultRecord>('vault', key(network, identityId))
  const slot = record?.slots.find((s) => s.kind === 'passphrase')
  if (!record || !slot || slot.kind !== 'passphrase') throw new VaultLockedError('no passphrase-protected key for this identity here')
  const secret = await unwrapWith(network, record, await passphraseKey(passphrase, slot.salt, slot.params), slot)
  setUnlocked(network, secret)
  return secret
}

/** Unlock with the enrolled passkey (a WebAuthn assertion with the PRF extension). */
export async function unlockWithPasskey(network: Network, identityId: string): Promise<VaultSecret> {
  const record = await idbGet<VaultRecord>('vault', key(network, identityId))
  const slot = record?.slots.find((s) => s.kind === 'passkey')
  if (!record || !slot || slot.kind !== 'passkey') throw new VaultLockedError('no passkey-protected key for this identity here')
  const output = await evaluatePasskey(slot.credentialId, slot.prfSalt)
  if (!output) throw new VaultLockedError('the passkey did not return its PRF output')
  const raw = new Uint8Array(output)
  const kek = prfKey(raw, network, identityId)
  raw.fill(0)
  const secret = await unwrapWith(network, record, kek, slot)
  setUnlocked(network, secret)
  return secret
}

/** Delete the stored vault for an identity (sign out and forget this browser). */
export async function forgetVault(network: Network, identityId: string): Promise<void> {
  lockVault()
  await idbDelete('vault', key(network, identityId))
}

// The unlocked secret: module memory only.
let unlocked: { network: Network; secret: VaultSecret; at: number } | null = null
let lockTimer: ReturnType<typeof setTimeout> | null = null

function setUnlocked(network: Network, secret: VaultSecret): void {
  unlocked = { network, secret, at: Date.now() }
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

/** Forget the unlocked secret (sign-out, auto-lock). The stored record stays. */
export function lockVault(): void {
  unlocked = null
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = null
}

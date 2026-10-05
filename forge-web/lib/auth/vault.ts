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
 * - Across reloads and tabs (`./session-resume.ts`): ONLY the limited signing key is kept (it is
 *   capped by its on-chain budget and expiry), until 12 h after the unlock or 4 h without use. A
 *   resumed tab signs public-repo writes at once; the encryption key, the storage credentials
 *   and wallet grants stay sealed until an interactive unlock in that tab ({@link resumeVault}).
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
import { idbDelete, idbEntries, idbGet, idbPut, idbUpdate } from '../idb'
import { withTimeout } from '../timeout'
import {
  KEPT_TTL_MS,
  LOCKED_AT_KEY,
  SAVED_AT_KEY,
  askToUnlockEveryVisit,
  framed,
  keptExpired,
  loadResume,
  lockMarker,
  markLocked,
  openResume,
  saveResume,
  touchResume,
  wipeResume,
} from './session-resume'

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
  /**
   * Held only so the next renewal or revoke disables it, never used to sign: the key of an
   * unfinished renewal the user gave up for a wallet sign-in (D-016). A registered key nobody
   * holds would stay live, unseen.
   */
  readonly holdOnly?: true
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
  /**
   * A staged record (D-016): the key id of the main record it is meant to replace, or null
   * when there was none (a first import). Finishing it replaces only that record.
   */
  readonly replaces?: number | null
}

/** What the UI may know about a stored vault (no secrets). */
export interface VaultInfo {
  readonly identityId: string
  readonly keyId: number
  readonly createdAt: number
  readonly methods: readonly ('passkey' | 'passphrase')[]
  /** Only a key whose registration was not finished is stored (unlocking finishes it). */
  readonly staged?: true
  /**
   * An encryption key for private repos is sealed beside it. Replacing the key without unlocking
   * it first drops that blob (it cannot be opened), so the import form says so beforehand.
   */
  readonly encryptionKey?: true
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

/**
 * A key registered by a renewal or import that is still in flight (D-016): stored here, and
 * read back, BEFORE the identity update is signed, and moved over the main record once the
 * update has landed. If the tab dies in between, the next unlock finds it here.
 */
function stagedKey(network: Network, identityId: string): string {
  return `vault-staged:${network}:${identityId}`
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
    throw new VaultLockedError('Wrong passphrase or passkey.')
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
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer; second?: ArrayBuffer } }
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
function passkeyCeremony<T>(start: (signal: AbortSignal) => Promise<T>, kind: 'create' | 'get' = 'get'): Promise<T> {
  const ceremony = new AbortController()
  return withTimeout(start(ceremony.signal), PASSKEY_TIMEOUT_MS + 5_000, 'The passkey prompt').catch((e: unknown) => {
    ceremony.abort()
    throw passkeyFailure(e, kind)
  })
}

/**
 * A WebAuthn failure in words a user can act on. Browsers reject with a `DOMException` whose
 * message is written for developers (Chrome's NotAllowedError quotes a w3.org URL, D-111); the
 * name says what happened. An abort (the flow was cancelled) and anything else pass through.
 */
export function passkeyFailure(e: unknown, kind: 'create' | 'get'): unknown {
  const name = e instanceof Error || e instanceof DOMException ? e.name : ''
  // Enrolment's caller adds "use a passphrase instead"; an unlock says where else to go.
  const words: Record<string, string> = {
    // Cancelled, timed out, or (for `get`) no passkey for this key on this device: the browser
    // deliberately does not say which (privacy).
    NotAllowedError:
      kind === 'get'
        ? "The passkey didn't open. The prompt was closed or timed out, or this device has no passkey for this key. Passkeys stay on the device or password manager that made them. Try again, or use another way in below."
        : 'No passkey was made: the prompt was closed or timed out',
    InvalidStateError: 'This security key or device already holds a passkey for this key',
    SecurityError: "Passkeys aren't available on this page: it has to be opened over https on the site's own address",
    NotSupportedError: "This browser or security key can't make the kind of passkey Forge needs",
    UnknownError: kind === 'get' ? 'The passkey prompt failed on this device. Try again, or use another way in below.' : 'The passkey prompt failed on this device',
  }
  const text = words[name]
  if (text === undefined) return e
  const out = new Error(kind === 'get' && !text.endsWith('.') ? `${text}.` : text)
  out.name = `Passkey${name}`
  return out
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
  }), 'create')) as PublicKeyCredential | null
  if (!cred) return null
  const ext = cred.getClientExtensionResults() as PrfExtensionResults
  const credentialId = new Uint8Array(cred.rawId)
  let first = ext.prf?.results?.first
  if (!first) {
    if (ext.prf?.enabled !== true) return null
    // Part of making the passkey: a failure reads as enrolment's, not an unlock's.
    first = (await evaluatePasskey(credentialId, prfSalt, 'create')) ?? undefined
    if (!first) return null
  }
  return { credentialId, prfSalt, output: new Uint8Array(first) }
}

/**
 * The PRF output of the last passkey assertion, briefly: finishing a staged renewal right after
 * a passkey unlock opens a record sealed with the same credential and salt, and must not prompt
 * a second time. Kept for {@link PRF_REUSE_MS}, then wiped; never stored.
 */
let recentPrf: { credentialId: string; prfSalt: string; output: Uint8Array; at: number }[] = []
const PRF_REUSE_MS = 60_000
/** At most this many outputs are kept (one prompt evaluates at most two). */
const PRF_CACHE_MAX = 2

function prfCacheKey(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** The fresh cached PRF output of (credential, salt), or null. */
function cachedPrf(credentialId: Uint8Array, prfSalt: Uint8Array): ArrayBuffer | null {
  const c = prfCacheKey(credentialId)
  const s = prfCacheKey(prfSalt)
  const hit = recentPrf.find((p) => p.credentialId === c && p.prfSalt === s && Date.now() - p.at < PRF_REUSE_MS)
  return hit === undefined ? null : hit.output.slice().buffer
}

function cachePrf(credentialId: Uint8Array, prfSalt: Uint8Array, out: ArrayBuffer): void {
  const c = prfCacheKey(credentialId)
  const s = prfCacheKey(prfSalt)
  const keep = recentPrf.filter((p) => !(p.credentialId === c && p.prfSalt === s))
  const next = [{ credentialId: c, prfSalt: s, output: new Uint8Array(out.slice(0)), at: Date.now() }, ...keep]
  for (const dropped of next.slice(PRF_CACHE_MAX)) dropped.output.fill(0)
  recentPrf = next.slice(0, PRF_CACHE_MAX)
}

/** Wipe every cached PRF output (on lock). */
function wipePrfCache(): void {
  for (const p of recentPrf) p.output.fill(0)
  recentPrf = []
}

/**
 * Evaluate the PRF of an enrolled passkey (a user-verified assertion), reusing a fresh one.
 * `cachedOnly`: never prompt; null unless this passkey was just used.
 */
async function evaluatePasskeyOnce(credentialId: Uint8Array, prfSalt: Uint8Array, cachedOnly = false): Promise<ArrayBuffer | null> {
  const cached = cachedPrf(credentialId, prfSalt)
  if (cached !== null || cachedOnly) return cached
  const out = await evaluatePasskey(credentialId, prfSalt)
  if (out !== null) cachePrf(credentialId, prfSalt, out)
  return out
}

function base64url(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Said before a passkey prompt that follows another one (see {@link evaluateAnyPasskey}). */
export type PasskeyPromptNote = (why: string) => void

/**
 * One passkey prompt for several enrolled passkeys (an unfinished renewal's and the current
 * key's, D-016): the browser offers whichever of them it holds, and the PRF of the one the user
 * picks is evaluated (`evalByCredential`), cached for the record it opens. Resolves with the
 * index in `options` of the passkey picked; null when the prompt returned none. Options that
 * share a credential are asked with the first one's salt. A browser that returns no PRF for
 * `evalByCredential` gets one more prompt for the picked passkey alone, announced by `note`.
 */
async function evaluateAnyPasskey(
  options: readonly { credentialId: Uint8Array; prfSalt: Uint8Array }[],
  note?: PasskeyPromptNote,
): Promise<number | null> {
  const cachedAt = options.findIndex((o) => cachedPrf(o.credentialId, o.prfSalt) !== null)
  if (cachedAt >= 0) return cachedAt
  // Per credential, the options it can open (two records may share one passkey, each sealed
  // with its own salt: PRF evaluates both salts in the same assertion, `first` and `second`).
  const byCredential = new Map<string, number[]>()
  options.forEach((o, i) => byCredential.set(base64url(o.credentialId), [...(byCredential.get(base64url(o.credentialId)) ?? []), i]))
  const inputs = (at: readonly number[]): { first: Uint8Array<ArrayBuffer>; second?: Uint8Array<ArrayBuffer> } => ({
    first: buf(options[at[0]!]!.prfSalt),
    ...(at[1] !== undefined ? { second: buf(options[at[1]]!.prfSalt) } : {}),
  })
  const only = byCredential.size === 1 ? [...byCredential.values()][0]! : null
  const assertion = (await passkeyCeremony((signal) => navigator.credentials.get({
    signal,
    publicKey: {
      timeout: PASSKEY_TIMEOUT_MS,
      rpId: rpId(),
      challenge: buf(random(32)),
      allowCredentials: [...byCredential.values()].map((at) => ({ type: 'public-key' as const, id: buf(options[at[0]!]!.credentialId) })),
      userVerification: 'required',
      extensions: {
        prf: only !== null ? { eval: inputs(only) } : { evalByCredential: Object.fromEntries([...byCredential].map(([id, at]) => [id, inputs(at)])) },
      } as AuthenticationExtensionsClientInputs,
    },
  }))) as PublicKeyCredential | null
  if (!assertion) return null
  const at = byCredential.get(base64url(new Uint8Array(assertion.rawId)))
  if (at === undefined) return null
  const results = (assertion.getClientExtensionResults() as PrfExtensionResults).prf?.results
  const outs = [results?.first, results?.second]
  at.forEach((i, n) => {
    const out = outs[n]
    if (out !== undefined) cachePrf(options[i]!.credentialId, options[i]!.prfSalt, out)
  })
  if (outs[0] !== undefined) return at[0]!
  // The browser returned the passkey but no PRF for it (some do not support evalByCredential).
  note?.('This browser needs one more passkey confirmation to open the key it just identified.')
  const pick = options[at[0]!]!
  return (await evaluatePasskeyOnce(pick.credentialId, pick.prfSalt)) === null ? null : at[0]!
}

async function evaluatePasskey(credentialId: Uint8Array, prfSalt: Uint8Array, kind: 'create' | 'get' = 'get'): Promise<ArrayBuffer | null> {
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
  }), kind)) as PublicKeyCredential | null
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
   * key was renewed, or this tab holds a tab-only key that cannot open the stored ones). It is
   * deleted; the user imports it again in Settings → Private repos.
   */
  readonly encryptionKeyDropped: boolean
  /** The key ids of the dropped encryption keys (the ones that did carry across are kept). */
  readonly encryptionKeysDropped?: readonly number[]
  /**
   * The record was written but did not read back: this browser's storage may not keep it. The
   * session works; the UI warns to keep the identity file handy.
   */
  readonly readBackFailed?: true
}

/** Refuse a protection the vault cannot seal with (before any work is done). */
function assertProtection(protection: Protection): void {
  if (!protection.passphrase && !protection.passkey) throw new Error('the vault needs a passphrase or a passkey')
  if (protection.passphrase !== undefined && protection.passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`use a passphrase of at least ${MIN_PASSPHRASE} characters`)
  }
}

/** The encrypted record of `main` under a fresh data key, wrapped by each protection. */
async function sealRecord(network: Network, main: Omit<VaultSecret, 'extra'>, protection: Protection, dataKey: Uint8Array): Promise<VaultRecord> {
  const { identityId } = main
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
  return { version: 1, network, identityId, keyId: main.keyId, createdAt: Date.now(), iv: body.iv, ciphertext: body.ct, slots }
}

/**
 * Whether the record at `at` reads back from storage and opens with `dataKey` to exactly
 * `main` (D-016): false when the browser did not keep what was written (storage blocked, full,
 * or lost). A failed read of storage itself rejects.
 */
async function readsBack(network: Network, at: string, main: Omit<VaultSecret, 'extra'>, dataKey: Uint8Array): Promise<boolean> {
  const stored = await idbGet<VaultRecord>('vault', at)
  if (stored === undefined) return false
  try {
    const body = await open(dataKey, stored.iv, stored.ciphertext, aad(network, main.identityId, 'body'))
    const parsed = JSON.parse(new TextDecoder().decode(body)) as VaultSecret
    body.fill(0)
    return parsed.identityId === main.identityId && parsed.keyId === main.keyId && parsed.wif === main.wif
  } catch {
    return false
  }
}

/**
 * Store a key that is about to be registered (D-016): sealed like the vault record, under its
 * own slot, so the current key stays usable if the registration never happens, then read
 * back. Call before signing the identity update; {@link storeInVault} of the same key id
 * replaces the main record with it once the update has landed.
 *
 * A stage for another key id already here is a registration that may have landed and not been
 * finished: it is never overwritten ({@link PendingRenewalError}); unlocking finishes it first.
 */
export async function stageInVault(network: Network, secret: VaultSecret, protection: Protection): Promise<void> {
  assertDedicatedOrigin()
  assertProtection(protection)
  const { extra: _extra, ...main } = secret
  const at = stagedKey(network, secret.identityId)
  // Fails fast, before the slow sealing; checked again inside the write below.
  const existing = await idbGet<VaultRecord>('vault', at)
  if (existing !== undefined && existing.keyId !== secret.keyId) throw new PendingRenewalError()
  const replaces = (await idbGet<VaultRecord>('vault', key(network, secret.identityId)))?.keyId ?? null
  const dataKey = random(32)
  try {
    const record: VaultRecord = { ...(await sealRecord(network, main, protection, dataKey)), replaces }
    await idbUpdate<VaultRecord>('vault', at, (current) => {
      if (current !== undefined && current.keyId !== secret.keyId) throw new PendingRenewalError()
      return [[at, record]]
    })
    // Not kept: nothing has changed on chain yet, so the renewal stops here.
    if (!(await readsBack(network, at, main, dataKey))) {
      throw new VaultLockedError(
        "This browser could not keep the new key (its storage is blocked, full or cleared), so nothing was changed on Platform and your current key still works. Allow site storage, or use another browser, and try again.",
      )
    }
  } finally {
    dataKey.fill(0)
  }
}

/** A key renewal on this device may have landed and is not finished: unlock to finish it first. */
export class PendingRenewalError extends VaultLockedError {
  constructor() {
    super('A key renewal on this device is not finished yet (it may already be on Platform). Unlock with the passphrase or passkey you chose for that renewal to finish it, then try again.')
    this.name = 'PendingRenewalError'
  }
}

/** Whether a registration was left in flight for (network, identity). */
export async function hasStaged(network: Network, identityId: string): Promise<boolean> {
  return (await idbGet<VaultRecord>('vault', stagedKey(network, identityId))) !== undefined
}

/** What Platform says about a staged key (see {@link recoverStaged}). */
export type StagedKeyState =
  /**
   * On the identity under its key id: the renewal landed (and replaced the old key). Live,
   * or since expired or disabled: registered either way.
   */
  | 'registered'
  /** Provably never registered: its key id holds another key. */
  | 'never'
  /** Not visible yet, or not provable either way (a node behind, an update in flight). */
  | 'unknown'

/**
 * Open a record with one unlock method, trying only that record's own slots. `cachedOnly`: a
 * passkey opens it only when it was just used (no new prompt).
 */
async function openRecord(
  network: Network,
  record: VaultRecord,
  method: { passphrase: string } | 'passkey',
  withExtra: boolean,
  cachedOnly = false,
): Promise<{ secret: VaultSecret; blobKeys: BlobKeys } | null> {
  if (method === 'passkey') {
    const slot = passkeySlot(record)
    if (!slot) return null
    const output = await evaluatePasskeyOnce(slot.credentialId, slot.prfSalt, cachedOnly)
    if (!output) return null
    const raw = new Uint8Array(output)
    const kek = prfKey(raw, network, record.identityId)
    raw.fill(0)
    return unwrapWith(network, record, kek, slot, withExtra).catch(() => null)
  }
  // The Argon2 parameters are pinned, never read from the (unauthenticated) record: a tampered
  // record cannot make unlock allocate gigabytes.
  const slot = record.slots.find((s) => s.kind === 'passphrase')
  if (!slot || slot.kind !== 'passphrase' || JSON.stringify(slot.params) !== JSON.stringify(ARGON2_PARAMS)) return null
  return unwrapWith(network, record, await passphraseKey(method.passphrase, slot.salt), slot, withExtra).catch(() => null)
}

function passkeyCached(record: VaultRecord): boolean {
  const slot = passkeySlot(record)
  return slot !== null && cachedPrf(slot.credentialId, slot.prfSalt) !== null
}

function passkeySlot(record: VaultRecord): Extract<Slot, { kind: 'passkey' }> | null {
  const slot = record.slots.find((s) => s.kind === 'passkey')
  return slot?.kind === 'passkey' ? slot : null
}

/** How finishing a staged key went ({@link recoverStaged}). */
export type RecoverResult =
  /** Adopted as the main record (now unlocked). */
  | { readonly status: 'adopted'; readonly secret: VaultSecret; readonly outcome: StoreOutcome }
  /** Provably never registered: the staged record was deleted. */
  | { readonly status: 'discarded' }
  /** Not provable yet (not visible, or a node behind): kept for a later unlock. */
  | { readonly status: 'pending' }
  /** This unlock method does not open it (it was protected differently): kept. */
  | { readonly status: 'locked' }
  /**
   * Registered, but the main record changed since it was staged (another sign-in, e.g. a
   * wallet, replaced it): kept, the main record untouched; the user decides.
   */
  | { readonly status: 'conflict' }

/**
 * Finish a registration this device did not live to finish (D-016). The staged record is
 * opened with its OWN slots (it was sealed with the protection chosen for the renewal, which
 * may differ from the main record's), with `method`:
 *
 * - Platform shows the key registered (live, or since expired or disabled: it was registered
 *   and replaced the old key either way): it becomes the main record, but only over the record
 *   it was staged to replace (`replaces`), or when there is none. The old record's storage
 *   settings and encryption key are carried over when this session holds them open, else
 *   dropped and reported, like any renewal made while locked.
 * - Provably never registered: the staged record is deleted.
 * - Not known yet: nothing changes; the next unlock asks again. A key is never deleted on a
 *   read that could be a node behind.
 */
export async function recoverStaged(
  network: Network,
  identityId: string,
  method: { passphrase: string } | 'passkey',
  state: (secret: VaultSecret) => Promise<StagedKeyState>,
): Promise<RecoverResult> {
  assertDedicatedOrigin()
  const lockMarkerAt = lockMarker()
  const at = stagedKey(network, identityId)
  const record = await idbGet<VaultRecord>('vault', at)
  // Gone since the caller checked: another tab finished or discarded it. Not proof it never
  // landed; unlocking again opens whatever that tab left.
  if (record === undefined) return { status: 'pending' }
  // A passkey unlock already prompted once, for whichever passkey the user picked: the staged
  // record opens only if that was its passkey (never a second prompt).
  const opened = await openRecord(network, record, method, false, true)
  if (opened === null) return { status: 'locked' }
  const s = await state(opened.secret)
  if (s === 'never') {
    await idbUpdate<VaultRecord>('vault', at, (current) => (current?.keyId === record.keyId ? [[at, undefined]] : []))
    return { status: 'discarded' }
  }
  if (s !== 'registered') return { status: 'pending' }
  // Adopt only over the record it was staged to replace (or none, or itself): a newer sign-in
  // stored since is never overwritten. Checked again inside the write's transaction.
  const replaceable = (main: VaultRecord | undefined): boolean =>
    main === undefined || main.keyId === (record.replaces ?? null) || main.keyId === record.keyId
  if (!replaceable(await idbGet<VaultRecord>('vault', key(network, identityId)))) return { status: 'conflict' }
  // Carry the old record's blobs across when this session has them open (the old key was
  // unlocked just before), sealed under the staged record's blob keys.
  const carried = await readStorageBlob(network, identityId).catch(() => null)
  const carriedEnc = unlocked?.sessionEnc === undefined ? await readEncryptionBlobs(network, identityId).catch(() => []) : []
  const hadBlob = (await idbGet('vault', storageBlobKey(network, identityId))) !== undefined
  const droppedEnc = await droppedEncryptionIds(network, identityId, carriedEnc)
  const encBlob = await sealEncryptionBlobs(opened.blobKeys.encryption, network, identityId, carriedEnc)
  const blob = carried !== null ? await sealBlob(opened.blobKeys.storage, network, identityId, carried) : undefined
  const { replaces: _replaces, ...promoted } = record
  let raced = false
  await idbUpdate<VaultRecord>(
    'vault',
    at,
    (current, [main]) => {
      if (current?.keyId !== record.keyId) throw new VaultLockedError('the pending key renewal changed while it was being finished; unlock again')
      if (!replaceable(main as VaultRecord | undefined)) {
        raced = true
        return []
      }
      return [
        [key(network, identityId), promoted],
        [at, undefined],
        [storageBlobKey(network, identityId), blob],
        // Wallet grants were disabled by the renewal's update; none survives it.
        [extraBlobKey(network, identityId), undefined],
        [encryptionBlobKey(network, identityId), encBlob],
      ]
    },
    [key(network, identityId)],
  )
  if (raced) return { status: 'conflict' }
  // Adopted over an interactive unlock of this tab: its 12-hour lock carries over.
  const unlockedAt = unlockedFor(network, identityId)?.at
  setUnlocked(network, opened.secret, opened.blobKeys, { lockMarkerAt, ...(unlockedAt !== undefined ? { at: unlockedAt } : {}) })
  return {
    status: 'adopted',
    secret: opened.secret,
    outcome: { storageSettingsDropped: hadBlob && carried === null, encryptionKeyDropped: droppedEnc.length > 0, encryptionKeysDropped: droppedEnc },
  }
}

/**
 * Give up a pending renewal (the user chose another sign-in instead): its staged record is
 * deleted. Open it first ({@link openStaged}) to keep its key beside the new one, so the next
 * renewal or revoke disables it.
 */
export async function abandonStaged(network: Network, identityId: string, keyId?: number): Promise<void> {
  const at = stagedKey(network, identityId)
  // Only the stage that was given up: another tab may have staged another key since.
  await idbUpdate<VaultRecord>('vault', at, (current) => (current !== undefined && (keyId === undefined || current.keyId === keyId) ? [[at, undefined]] : []))
}

/**
 * Open a record with a {@link Protection} (a passphrase, or a passkey chosen just now: no
 * second prompt when the record was sealed with that same one; another one prompts once, for
 * the record's own), or `'passkey'` (a prompt for the record's passkey).
 */
async function openWith(
  network: Network,
  record: VaultRecord,
  using: Protection | 'passkey',
  withExtra: boolean,
  noPrompt = false,
): Promise<{ secret: VaultSecret; blobKeys: BlobKeys } | null> {
  if (using === 'passkey') return openRecord(network, record, 'passkey', withExtra)
  if (using.passphrase !== undefined) {
    const opened = await openRecord(network, record, { passphrase: using.passphrase }, withExtra)
    if (opened !== null) return opened
  }
  const chosen = using.passkey
  const slot = passkeySlot(record)
  if (chosen === undefined || slot === null) return null
  if (prfCacheKey(slot.credentialId) === prfCacheKey(chosen.credentialId) && prfCacheKey(slot.prfSalt) === prfCacheKey(chosen.prfSalt)) {
    cachePrf(slot.credentialId, slot.prfSalt, chosen.output.slice().buffer)
  }
  return openRecord(network, record, 'passkey', withExtra, noPrompt)
}

/**
 * The staged key of (network, identity), without making it this session's key; null when none
 * is staged or it does not open. With a {@link Protection} (the one just chosen for a sign-in)
 * nothing prompts: a passphrase is tried, and a passkey opens it only when it is the one the
 * renewal was sealed with. `'passkey'` or `{ passphrase }` is the renewal's own method, asked
 * for explicitly (a passkey prompt).
 */
export async function openStaged(
  network: Network,
  identityId: string,
  using: Protection | 'passkey',
  explicit = using === 'passkey',
): Promise<VaultSecret | null> {
  assertDedicatedOrigin()
  const record = await idbGet<VaultRecord>('vault', stagedKey(network, identityId))
  if (record === undefined) return null
  return (await openWith(network, record, using, false, !explicit))?.secret ?? null
}

/** Forget cached passkey outputs now (a sign-in that opened other records has finished). */
export function forgetPasskeyOutputs(): void {
  wipePrfCache()
}

/**
 * Unlock the stored key of (network, identity) with a {@link Protection} just chosen for it
 * (identity creation, reopened: the key an earlier run stored). Null when no key is stored or
 * the protection does not open it.
 */
export async function unlockWithProtection(network: Network, identityId: string, protection: Protection): Promise<VaultSecret | null> {
  assertDedicatedOrigin()
  const lockMarkerAt = lockMarker()
  const record = await idbGet<VaultRecord>('vault', key(network, identityId))
  if (record === undefined) return null
  const opened = await openWith(network, record, protection, true)
  if (opened === null) return null
  const at = unlockedFor(network, identityId)?.at
  setUnlocked(network, opened.secret, opened.blobKeys, { lockMarkerAt, ...(at !== undefined ? { at } : {}) })
  return opened.secret
}

/** The pending (staged) key of (network, identity), without secrets, or null. */
export async function stagedInfo(network: Network, identityId: string): Promise<Pick<VaultInfo, 'keyId' | 'createdAt' | 'methods'> | null> {
  const r = await idbGet<VaultRecord>('vault', stagedKey(network, identityId))
  return r === undefined ? null : { keyId: r.keyId, createdAt: r.createdAt, methods: r.slots.map((x) => x.kind) }
}

/**
 * Seal `secret` into the vault for `network`, replacing any earlier record for its identity,
 * and keep it unlocked for this session. At least one protection is required. The record and
 * the (re-sealed or deleted) storage settings are written in one transaction, then the record
 * is read back (D-016); a staged copy of the same key is dropped.
 */
export async function storeInVault(
  network: Network,
  secret: VaultSecret,
  protection: Protection,
  options: {
    /**
     * Also drop the staged record of this key id, in the same transaction (a renewal the user
     * gave up, its key carried in `secret.extra`): it is never gone before its key is stored.
     */
    readonly dropStagedKeyId?: number
  } = {},
): Promise<StoreOutcome> {
  const lockMarkerAt = lockMarker()
  assertDedicatedOrigin()
  assertProtection(protection)
  const { identityId } = secret
  // A renewal replaces the record (and its data key): carry the storage settings across when
  // this session can open them; otherwise they cannot be opened any more and are dropped.
  const hadBlob = (await idbGet<StorageBlob>('vault', storageBlobKey(network, identityId))) !== undefined
  const carried = hadBlob ? await readStorageBlob(network, identityId).catch(() => null) : null
  // The encryption key is carried the same way, but only from the stored vault blob: a tab-only
  // session's key stays in that session. One that cannot be opened is dropped, and reported.
  // Each key that opens is carried; any other is dropped, and reported by id.
  const carriedEnc = unlocked?.sessionEnc === undefined ? await readEncryptionBlobs(network, identityId).catch(() => []) : []
  const droppedEnc = await droppedEncryptionIds(network, identityId, carriedEnc)
  const dataKey = random(32)
  let storageKey: CryptoKey
  let encryptionKey: CryptoKey
  let readBackOk = true
  // The extra grants live in their own blob, so a later grant can be added without the data key.
  const { extra, ...main } = secret
  try {
    const record = await sealRecord(network, main, protection, dataKey)
    storageKey = await deriveStorageKey(dataKey, network, identityId)
    const blob = carried !== null ? await sealBlob(storageKey, network, identityId, carried) : undefined
    const extraBlob = extra?.length ? await sealBlob(storageKey, network, identityId, extra, 'extra') : undefined
    encryptionKey = await deriveEncryptionKey(dataKey, network, identityId)
    const encBlob = await sealEncryptionBlobs(encryptionKey, network, identityId, carriedEnc)
    // One transaction: a crash between the writes must not leave settings sealed under a
    // data key no record holds any more. The key is now the main record, so a staged copy of
    // THIS key (the renewal that registered it) is done; a stage of another key (a renewal
    // from another tab, not finished) stays, for its unlock to finish.
    const at = stagedKey(network, identityId)
    await idbUpdate<VaultRecord>('vault', at, (staged) => [
      [key(network, identityId), record],
      [storageBlobKey(network, identityId), blob],
      [extraBlobKey(network, identityId), extraBlob],
      [encryptionBlobKey(network, identityId), encBlob],
      ...(staged !== undefined && (staged.keyId === secret.keyId || staged.keyId === options.dropStagedKeyId) ? ([[at, undefined]] as const) : []),
    ])
    // The key is on chain and was staged and read back first: a failed read-back here is not a
    // reason to fail the sign-in (the staged copy, when there was one, is still the safe copy).
    readBackOk = await readsBack(network, key(network, identityId), main, dataKey).catch(() => false)
  } finally {
    dataKey.fill(0)
  }
  setUnlocked(network, secret, { storage: storageKey, encryption: encryptionKey }, { lockMarkerAt })
  return {
    storageSettingsDropped: hadBlob && carried === null,
    encryptionKeyDropped: droppedEnc.length > 0,
    encryptionKeysDropped: droppedEnc,
    ...(readBackOk ? {} : { readBackFailed: true }),
  }
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
  if (k === null) throw new VaultLockedError(unlockScope(network, identityId) === 'signing' ? 'unlock this tab to save storage settings' : 'unlock with a stored key to save storage settings')
  await idbPut('vault', storageBlobKey(network, identityId), await sealBlob(k, network, identityId, value))
}

/** Whether storage settings are sealed beside the record of (network, identity) (no secrets read). */
export async function hasStorageBlob(network: Network, identityId: string): Promise<boolean> {
  return (await idbGet<StorageBlob>('vault', storageBlobKey(network, identityId))) !== undefined
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
  if (k === null || current === null) {
    throw new VaultLockedError(unlockScope(network, identityId) === 'signing' ? 'unlock this tab first (Sign in → Unlock): wallet grants are not kept across reloads' : 'unlock this browser\'s key first')
  }
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
  return value
    .filter((e): e is ExtraKey => typeof e === 'object' && e !== null && typeof e.contractId === 'string' && typeof e.keyId === 'number' && typeof e.wif === 'string')
    .map((e) => ({ contractId: e.contractId, keyId: e.keyId, wif: e.wif, ...(e.holdOnly === true ? { holdOnly: true as const } : {}) }))
}

function unlockedStorageKey(network: Network, identityId: string): CryptoKey | null {
  if (unlockedSecret(network, identityId) === null) return null
  // A resumed session holds the signing key only: storage settings need an interactive unlock.
  return unlocked?.blobKeys?.storage ?? null
}

/** The vaults stored for `network` (no secrets). */
export async function listVaults(network: Network): Promise<VaultInfo[]> {
  const rows = await idbEntries<VaultRecord>('vault', `vault:${network}:`)
  const withEnc = new Set((await idbEntries<StoredEncryption>('vault', `vault-enc:${network}:`)).filter(([, v]) => encryptionEntries(v).length > 0).map(([k]) => k))
  const out: VaultInfo[] = rows.map(([, r]) => ({
    identityId: r.identityId,
    keyId: r.keyId,
    createdAt: r.createdAt,
    methods: r.slots.map((s) => s.kind),
    ...(withEnc.has(encryptionBlobKey(network, r.identityId)) ? { encryptionKey: true as const } : {}),
  }))
  // An identity with only a staged key (a first import whose tab closed after registering,
  // D-016) must still be offered for unlock, or the key it paid for is unreachable.
  const known = new Set(out.map((v) => v.identityId))
  for (const [, r] of await idbEntries<VaultRecord>('vault', `vault-staged:${network}:`)) {
    if (!known.has(r.identityId)) {
      out.push({ identityId: r.identityId, keyId: r.keyId, createdAt: r.createdAt, methods: r.slots.map((s) => s.kind), staged: true })
    }
  }
  return out
}

async function unwrapWith(network: Network, record: VaultRecord, kek: Uint8Array, slot: Slot, withExtra = true): Promise<{ secret: VaultSecret; blobKeys: BlobKeys }> {
  const dataKey = await open(kek, slot.iv, slot.wrapped, aad(network, record.identityId, slot.kind))
  try {
    const body = await open(dataKey, record.iv, record.ciphertext, aad(network, record.identityId, 'body'))
    const parsed = JSON.parse(new TextDecoder().decode(body)) as VaultSecret
    body.fill(0)
    if (parsed.identityId !== record.identityId) throw new VaultLockedError('vault record does not match its identity')
    const storageKey = await deriveStorageKey(dataKey, network, record.identityId)
    const extra = withExtra ? await readExtraKeys(network, record.identityId, storageKey) : []
    const secret: VaultSecret = { identityId: parsed.identityId, keyId: parsed.keyId, wif: parsed.wif, ...(extra.length ? { extra } : {}) }
    return { secret, blobKeys: { storage: storageKey, encryption: await deriveEncryptionKey(dataKey, network, record.identityId) } }
  } finally {
    dataKey.fill(0)
    kek.fill(0)
  }
}

/** Unlock with a passphrase. Throws {@link VaultLockedError} on a wrong one. */
export async function unlockWithPassphrase(network: Network, identityId: string, passphrase: string): Promise<VaultSecret> {
  return unlockWith(network, identityId, { passphrase })
}

/**
 * Unlock with the enrolled passkey (a WebAuthn assertion with the PRF extension). One prompt,
 * also when an unfinished renewal is protected with another passkey; `note` is told why when
 * a second prompt follows.
 */
export async function unlockWithPasskey(network: Network, identityId: string, note?: PasskeyPromptNote): Promise<VaultSecret> {
  return unlockWith(network, identityId, 'passkey', note)
}

/**
 * Open the main record with `method`; when that fails (or there is none) and a key whose
 * registration was not finished is staged here (D-016), try the staged record's own slots:
 * a renewal may have been protected with another passphrase or passkey than the key it
 * replaces. The controller then asks Platform and finishes or keeps the staged key. Each
 * record is only ever opened with its own slots; neither stands in for the other.
 */
async function unlockWith(network: Network, identityId: string, method: { passphrase: string } | 'passkey', note?: PasskeyPromptNote): Promise<VaultSecret> {
  assertDedicatedOrigin()
  const lockMarkerAt = lockMarker()
  const main = await idbGet<VaultRecord>('vault', key(network, identityId))
  const staged = await idbGet<VaultRecord>('vault', stagedKey(network, identityId))
  const kind = method === 'passkey' ? 'passkey' : 'passphrase'
  if (!main?.slots.some((s) => s.kind === kind) && !staged?.slots.some((s) => s.kind === kind)) {
    throw new VaultLockedError(`no ${kind}-protected key for this identity here`)
  }
  // Passkeys: one prompt offering both records' passkeys; the record of the passkey the user
  // picks is opened first, the other only if that one does not open (never expected).
  const candidates = method === 'passkey' ? await passkeyOrder(main, staged, note) : [main, staged]
  for (const record of candidates) {
    if (record === undefined) continue
    if (method === 'passkey' && record !== candidates[0] && !passkeyCached(record)) {
      note?.("That passkey did not open this device's key; confirm the other passkey saved for it.")
    }
    const opened = await openRecord(network, record, method, record === main)
    if (opened !== null) {
      // An interactive unlock over a resumed session keeps its first unlock's 12-hour lock.
      const at = unlockedFor(network, identityId)?.at
      setUnlocked(network, opened.secret, opened.blobKeys, { lockMarkerAt, ...(at !== undefined ? { at } : {}) })
      return opened.secret
    }
  }
  throw new VaultLockedError(method === 'passkey' ? 'That passkey did not open the key stored here.' : 'Wrong passphrase.')
}

/**
 * The records with a passkey, the one whose passkey the user picks in one prompt first (see
 * {@link evaluateAnyPasskey}); none when the prompt returned nothing.
 */
async function passkeyOrder(main: VaultRecord | undefined, staged: VaultRecord | undefined, note?: PasskeyPromptNote): Promise<VaultRecord[]> {
  const withPasskey = [main, staged].filter((r): r is VaultRecord => r !== undefined && passkeySlot(r) !== null)
  const at = await evaluateAnyPasskey(withPasskey.map((r) => passkeySlot(r)!), note)
  if (at === null) return []
  const picked = withPasskey[at]!
  return [picked, ...withPasskey.filter((r) => r !== picked)]
}

/** Whether the only key here for (network, identity) is a staged one (no main record). */
export async function onlyStaged(network: Network, identityId: string): Promise<boolean> {
  return (await idbGet('vault', key(network, identityId))) === undefined && (await hasStaged(network, identityId))
}

/** Delete the stored vault for an identity (sign out and forget this browser). */
export async function forgetVault(network: Network, identityId: string): Promise<void> {
  lockVault()
  await idbDelete('vault', key(network, identityId))
  await idbDelete('vault', storageBlobKey(network, identityId))
  await idbDelete('vault', extraBlobKey(network, identityId))
  await idbDelete('vault', encryptionBlobKey(network, identityId))
  await idbDelete('vault', stagedKey(network, identityId))
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
interface Unlocked {
  network: Network
  secret: VaultSecret
  at: number
  blobKeys: BlobKeys | null
  /** Tab-only sessions: the encryption key, sealed under a random per-session key. */
  sessionEnc?: { key: CryptoKey; blobs: readonly EncryptionBlob[] }
  /**
   * `signing`: picked up from a kept session. Only the limited signing key is here; the
   * encryption key, storage settings and wallet grants need an interactive unlock
   * ({@link unlockScope}). `full`: an interactive unlock (or a pasted key).
   */
  scope: 'full' | 'signing'
  /** The lock marker when this unlock began: a lock anywhere since refuses to keep it. */
  lockMarkerAt: number
}
let unlocked: Unlocked | null = null

/** This tab's unlock when it is for (network, identity), else null (no expiry check). */
function unlockedFor(network: Network, identityId: string): Unlocked | null {
  return unlocked?.network === network && unlocked.secret.identityId === identityId ? unlocked : null
}
let lockTimer: ReturnType<typeof setTimeout> | null = null
/** Bumped on every lock: work that started before one must not open a session after it. */
let lockGeneration = 0
const lockListeners = new Set<() => void>()
const keptListeners = new Set<() => void>()

/** Be told when the vault locks (auto-lock, sign-out). Returns an unsubscribe function. */
export function onVaultLock(listener: () => void): () => void {
  lockListeners.add(listener)
  return () => {
    lockListeners.delete(listener)
  }
}

/** Be told when another tab kept an unlocked session (a locked tab can pick it up). */
export function onSessionKept(listener: () => void): () => void {
  keptListeners.add(listener)
  return () => {
    keptListeners.delete(listener)
  }
}

/** The current lock generation: compare before and after async work to spot a lock in between. */
export function vaultLockGeneration(): number {
  return lockGeneration
}

/**
 * `at`: when the unlock happened (a resumed session keeps its first unlock's: one 12-hour lock).
 * `lockMarkerAt`: the lock marker read when the unlock began (a lock since refuses the keep).
 */
function setUnlocked(
  network: Network,
  secret: VaultSecret,
  blobKeys: BlobKeys | null = null,
  opts: { scope?: 'full' | 'signing'; at?: number; lockMarkerAt?: number } = {},
): void {
  // Another identity (or network) takes over: the previous one's private-repo sessions end.
  const switched = unlocked !== null && (unlocked.network !== network || unlocked.secret.identityId !== secret.identityId)
  const at = opts.at ?? Date.now()
  unlocked = { network, secret, at, blobKeys, scope: opts.scope ?? 'full', lockMarkerAt: opts.lockMarkerAt ?? lockMarker() }
  if (switched) notifyEncryptionKeyChange()
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = setTimeout(() => expire(network), Math.max(0, at + AUTO_LOCK_MS - Date.now()))
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
  const u = unlockedFor(network, identityId)
  if (u === null) return null
  if (Date.now() - u.at >= AUTO_LOCK_MS) {
    expire(network)
    return null
  }
  return u.secret
}

/**
 * How much of the vault this tab holds open for (network, identity): `full` after an
 * interactive unlock, `signing` for a session picked up from a kept one (the limited key only),
 * null when locked.
 */
export function unlockScope(network: Network, identityId: string): 'full' | 'signing' | null {
  return unlockedSecret(network, identityId) === null ? null : unlocked!.scope
}

// ---------------------------------------------------------------------------
// Keeping the signing key across reloads and tabs (`./session-resume.ts`)
// ---------------------------------------------------------------------------

/**
 * Keep this tab's limited signing key of (network, identity) for later page loads and other
 * tabs, with the public session facts `hint`. Only the main limited key is kept, and only when it
 * has a budget and an expiry on chain (`limited`): never a wallet's unlimited key, the encryption
 * key, the storage settings or wallet grants. Nothing is kept for a pasted key, when "Stay signed
 * in for public repos" is off, in a framed page, on a shared origin, or when a lock happened
 * anywhere since this unlock began. The absolute expiry stays the one of the first unlock.
 */
export async function keepUnlocked(network: Network, identityId: string, limited: boolean, hint: unknown): Promise<void> {
  const u = unlockedFor(network, identityId)
  if (u === null || u.secret.keyId < 0) return
  if (!limited || askToUnlockEveryVisit() || framed() || sharedOriginProblem() !== null) return
  // A pasted key has no vault record; only a key this vault stores is kept.
  if ((await storedKeyId(network, identityId)) !== u.secret.keyId) return
  const generation = lockGeneration
  const ok = await saveResume(network, { identityId, keyId: u.secret.keyId, wif: u.secret.wif }, u.at + KEPT_TTL_MS, hint, u.lockMarkerAt)
  // A lock landed while it was written: it must not survive (the lock's own wipe may have run first).
  if (ok && generation !== lockGeneration) await wipeResume()
}

/**
 * Pick up the signing key an earlier page load kept (a reload, a new tab), unlocked until the
 * ORIGINAL 12-hour lock with scope `signing`. Null (and nothing kept any more) when there is
 * nothing to pick up: nothing kept, expired (absolute, or 4 h idle), locked since, "Stay signed in"
 * off, a record replaced since (renewed, forgotten), a copy that does not open, or a staged key
 * renewal waiting for recovery (D-016: only an interactive unlock can adopt it). The expiry is
 * checked before anything is unwrapped.
 */
export async function resumeVault(network: Network): Promise<{ secret: VaultSecret; hint: unknown } | null> {
  if (sharedOriginProblem() !== null || framed()) return null
  if (askToUnlockEveryVisit()) {
    await wipeResume()
    return null
  }
  const generation = lockGeneration
  const markerAtStart = lockMarker()
  const kept = await loadResume(network)
  if (kept === null) return null
  const current = (await storedKeyId(network, kept.identityId)) === kept.keyId && !(await hasStaged(network, kept.identityId))
  const opened = current ? await openResume(kept) : null
  if (opened === null) {
    await wipeResume()
    return null
  }
  // Locked (here or in another tab), or unlocked some other way, while this ran: that wins.
  if (generation !== lockGeneration || lockMarker() !== markerAtStart || unlocked !== null || keptExpired(kept)) return null
  const secret: VaultSecret = opened
  setUnlocked(network, secret, null, { scope: 'signing', at: kept.expiresAt - KEPT_TTL_MS, lockMarkerAt: markerAtStart })
  noteSessionUse(network)
  return { secret, hint: kept.hint }
}

/** The key id a kept session holds for `network`, or null (none, or not usable any more). */
export async function keptKeyId(network: Network): Promise<{ identityId: string; keyId: number } | null> {
  const kept = await loadResume(network)
  return kept === null ? null : { identityId: kept.identityId, keyId: kept.keyId }
}

/** The key id of the stored (main) record of (network, identity), or null when none. */
export async function storedKeyId(network: Network, identityId: string): Promise<number | null> {
  return (await idbGet<VaultRecord>('vault', key(network, identityId)))?.keyId ?? null
}

/** The kept session was used (a signature, the user active): its idle limit counts from now. */
export function noteSessionUse(network: Network): void {
  if (unlocked !== null) void touchResume(network).catch(() => undefined)
}

export { askToUnlockEveryVisit, setAskToUnlockEveryVisit } from './session-resume'

let watching = false

/**
 * Follow the other tabs of this origin (once per page): a lock in any of them locks this one; a
 * session kept in another one is announced to {@link onSessionKept}.
 */
export function watchOtherTabs(network: Network): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('storage', (e) => applyOtherTabEvent(e.key))
  // The user coming back to a tab is use: the kept session's idle limit counts from then.
  let lastTouch = 0
  window.addEventListener('focus', () => {
    if (Date.now() - lastTouch < 5 * 60_000) return
    lastTouch = Date.now()
    noteSessionUse(network)
  })
}

/** React to another tab's localStorage change (`changed`: its key; null when storage was cleared). */
export function applyOtherTabEvent(changed: string | null): void {
  if (changed === LOCKED_AT_KEY || changed === null) {
    releaseUnlocked()
    // A copy this tab was writing as the lock landed must go too (the locking tab's wipe may
    // have run before it).
    void wipeResume().catch(() => undefined)
  } else if (changed === SAVED_AT_KEY) {
    for (const l of keptListeners) l()
  }
}

/**
 * The 12 hours are up: this tab locks, and the kept copy goes when it has expired too. When
 * another tab unlocked since (a newer copy, not expired), the listeners pick that one up.
 */
function expire(network: Network): void {
  releaseUnlocked()
  void loadResume(network)
    .then((kept) => {
      if (kept !== null) for (const l of keptListeners) l()
    })
    .catch(() => undefined)
}

/**
 * Forget the unlocked secret in THIS tab only: the kept session and the other tabs stay. Used
 * after a sign-in step that did not finish (a failed read, an abandoned identity creation), for
 * a key superseded by another tab's renewal, and by every lock ({@link lockVault}, another tab's
 * lock, expiry).
 */
export function releaseUnlocked(): void {
  // A recent passkey PRF output reopens the whole vault with no gesture: it goes with the unlock.
  wipePrfCache()
  const wasUnlocked = unlocked !== null
  unlocked = null
  lockGeneration++
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = null
  if (wasUnlocked) for (const l of lockListeners) l()
  // Every private-repo session ends with the vault (its keys were opened with this unlock).
  if (wasUnlocked) notifyEncryptionKeyChange()
}

// ---------------------------------------------------------------------------
// The identity's ENCRYPTION key (private repos, `docs/security/private-repos.md` §5.2)
// ---------------------------------------------------------------------------

/** One sealed encryption key: its key id on the identity (public) and the sealed private key. */
interface EncryptionBlob {
  readonly keyId: number
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
}

/**
 * What the vault keeps for an identity's encryption keys: every key this browser has held for it,
 * one sealed entry per on-chain key id (DESIGN D27: a wallet registers a new one with each first
 * approval for another contract, and wraps made to an older key must still open). A vault written
 * before that holds a single entry, read as a set of one.
 */
type StoredEncryption = EncryptionBlob | readonly EncryptionBlob[]

/** The entries of a stored value, highest key id first (a legacy single entry: a set of one). */
function encryptionEntries(v: StoredEncryption | undefined | null): EncryptionBlob[] {
  if (v === undefined || v === null) return []
  return (Array.isArray(v) ? [...(v as readonly EncryptionBlob[])] : [v as EncryptionBlob]).sort((a, b) => b.keyId - a.keyId)
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

/** Seal every carried key under `key` (each secret is wiped); undefined when there is none. */
async function sealEncryptionBlobs(
  key: CryptoKey,
  network: Network,
  identityId: string,
  carried: readonly { readonly keyId: number; readonly secret: Uint8Array }[],
): Promise<EncryptionBlob[] | undefined> {
  try {
    const sealed: EncryptionBlob[] = []
    for (const c of carried) sealed.push(await sealEncryptionBlob(key, network, identityId, c.keyId, c.secret))
    return sealed.length > 0 ? sealed : undefined
  } finally {
    for (const c of carried) c.secret.fill(0)
  }
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

/** The unlocked session's encryption entries and the key they are sealed under, or null (none). */
async function encryptionSource(network: Network, identityId: string): Promise<{ key: CryptoKey; blobs: EncryptionBlob[] } | null> {
  if (unlockedSecret(network, identityId) === null || unlocked === null) return null
  if (unlocked.sessionEnc !== undefined) {
    const blobs = encryptionEntries(unlocked.sessionEnc.blobs)
    return blobs.length === 0 ? null : { key: unlocked.sessionEnc.key, blobs }
  }
  const k = unlocked.blobKeys?.encryption
  if (k === undefined) return null
  const blobs = encryptionEntries(await idbGet<StoredEncryption>('vault', encryptionBlobKey(network, identityId)))
  return blobs.length === 0 ? null : { key: k, blobs }
}

/**
 * The plaintext of every stored encryption key this unlocked session can open, for re-sealing on
 * renewal: an entry that does not open is left out (and reported dropped), never the whole set.
 */
async function readEncryptionBlobs(network: Network, identityId: string): Promise<{ keyId: number; secret: Uint8Array }[]> {
  const src = await encryptionSource(network, identityId)
  if (src === null) return []
  const out: { keyId: number; secret: Uint8Array }[] = []
  for (const b of src.blobs) {
    try {
      out.push({ keyId: b.keyId, secret: await openEncryptionBlob(src.key, network, identityId, b) })
    } catch {
      /* not carried: reported by droppedEncryptionIds */
    }
  }
  return out
}

/**
 * The key ids stored in the vault for the identity (its raw entries, whatever this tab can open)
 * that `carried` does not include: what a re-key is about to delete.
 */
async function droppedEncryptionIds(network: Network, identityId: string, carried: readonly { readonly keyId: number }[]): Promise<number[]> {
  const stored = encryptionEntries(await idbGet<StoredEncryption>('vault', encryptionBlobKey(network, identityId))).map((b) => b.keyId)
  return stored.filter((id) => !carried.some((c) => c.keyId === id))
}

const encListeners = new Set<() => void>()

/** Be told when an encryption key is added, removed, or becomes unusable (lock). */
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
function sessionEncFor(network: Network, identityId: string): { key: CryptoKey; blobs: readonly EncryptionBlob[] } | undefined {
  // Not `unlockedSecret()`: that one auto-locks an expired session, which a read must not do.
  return unlockedFor(network, identityId)?.sessionEnc
}

/**
 * The key ids (public: they are on the identity) of every encryption key stored for (network,
 * identity), highest first; empty when none. Readable while locked; using one needs the vault
 * unlocked.
 */
export async function storedEncryptionKeyIds(network: Network, identityId: string): Promise<number[]> {
  const session = sessionEncFor(network, identityId)
  if (session !== undefined) return encryptionEntries(session.blobs).map((b) => b.keyId)
  // Unlocked for this identity by a tab-only key: a vault blob it cannot open does not count.
  // (A resumed signing-only session has no blob keys either, but the blob is its own: it counts,
  // and using it asks for an interactive unlock.)
  const u = unlockedFor(network, identityId)
  if (u !== null && u.blobKeys === null && u.scope === 'full') return []
  return encryptionEntries(await idbGet<StoredEncryption>('vault', encryptionBlobKey(network, identityId))).map((b) => b.keyId)
}

/** The highest key id among {@link storedEncryptionKeyIds}, or null when none is stored. */
export async function storedEncryptionKeyId(network: Network, identityId: string): Promise<number | null> {
  return (await storedEncryptionKeyIds(network, identityId))[0] ?? null
}

/**
 * Seal the identity's encryption private key (32 bytes, key `keyId` on the identity) beside the
 * unlocked vault record, ADDED to the keys already there (a key of the same id is resealed; no
 * other is ever replaced). A tab-only session holds it for the session only. The caller has
 * verified it against the identity and wipes `secret` afterwards.
 */
export async function storeEncryptionKey(network: Network, identityId: string, keyId: number, secret: Uint8Array): Promise<void> {
  assertDedicatedOrigin()
  if (unlockedSecret(network, identityId) === null || unlocked === null) throw new VaultLockedError('unlock this browser first')
  // A resumed signing-only tab has no blob keys either, but its vault does: seal there after an
  // interactive unlock, never into this tab's memory (it would be lost on reload).
  if (unlocked.scope === 'signing') throw new VaultLockedError('unlock this tab first: your encryption key is stored with the rest of the vault')
  const add = (current: StoredEncryption | undefined, sealed: EncryptionBlob): EncryptionBlob[] => [...encryptionEntries(current).filter((b) => b.keyId !== keyId), sealed]
  if (unlocked.blobKeys === null) {
    // A tab-only session: sealed under a random key that lives as long as the session.
    const held = unlocked.sessionEnc
    const key = held?.key ?? (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
    const sealed = await sealEncryptionBlob(key, network, identityId, keyId, secret)
    unlocked.sessionEnc = { key, blobs: add(held?.blobs, sealed) }
  } else {
    const sealed = await sealEncryptionBlob(unlocked.blobKeys.encryption, network, identityId, keyId, secret)
    const at = encryptionBlobKey(network, identityId)
    // Read and written in one transaction: a key another tab adds meanwhile is kept.
    await idbUpdate<StoredEncryption>('vault', at, (current) => [[at, add(current, sealed)]])
  }
  notifyEncryptionKeyChange()
}

/** Delete every stored encryption key (each can be imported again from the identity file). */
export async function removeEncryptionKey(network: Network, identityId: string): Promise<void> {
  const session = sessionEncFor(network, identityId)
  if (session !== undefined && unlocked !== null) unlocked.sessionEnc = { key: session.key, blobs: [] }
  await idbDelete('vault', encryptionBlobKey(network, identityId))
  notifyEncryptionKeyChange()
}

/** This browser does not hold encryption key `keyId` of the identity. */
export class EncryptionKeyNotHeldError extends Error {
  constructor(readonly keyId: number) {
    super(`this browser does not hold encryption key ${keyId}`)
    this.name = 'EncryptionKeyNotHeldError'
  }
}

/**
 * Run `use` with an unlocked encryption private key (a fresh copy, wiped afterwards): key `keyId`
 * ({@link EncryptionKeyNotHeldError} when this browser does not hold it), else the highest held.
 * Module internal: callers get the {@link EncryptionOps} of `lib/auth/encryption-key.ts`, which
 * pass the key only to the SDK. Throws {@link VaultLockedError} when locked or when none is stored.
 */
export async function withEncryptionKey<T>(network: Network, identityId: string, use: (keyId: number, secret: Uint8Array) => Promise<T>, keyId?: number): Promise<T> {
  const src = await encryptionSource(network, identityId)
  if (src === null) {
    const scope = unlockScope(network, identityId)
    throw new VaultLockedError(
      scope === null ? 'unlock this browser to read private repos' : scope === 'signing' ? 'unlock to use your encryption key in this tab' : 'no encryption key is stored in this browser',
    )
  }
  const blob = keyId === undefined ? src.blobs[0] : src.blobs.find((b) => b.keyId === keyId)
  if (blob === undefined) throw new EncryptionKeyNotHeldError(keyId ?? -1)
  const secret = await openEncryptionBlob(src.key, network, identityId, blob)
  try {
    return await use(blob.keyId, secret)
  } finally {
    secret.fill(0)
  }
}

/**
 * Lock (sign-out, Lock, forget, revoke, a key found disabled on chain): forget the unlocked
 * secret here, delete the kept session, and lock every other tab. The stored record stays.
 */
export function lockVault(): void {
  // First and synchronous: a reload racing the wipe below still refuses the kept session, and
  // the storage event reaches the other tabs.
  markLocked()
  wipePrfCache()
  releaseUnlocked()
  void wipeResume().catch(() => undefined)
}

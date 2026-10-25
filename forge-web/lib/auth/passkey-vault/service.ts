/**
 * Forge's passkey vault (PLAN-passkey-vault.md §3): the vendored core's {@link PasskeyVault} with
 * Forge's rules for what a passkey may hold and what an opened one may give a sign-in.
 *
 * What goes in a bundle, slot by slot:
 * - slot 0, the session's main key: AUTHENTICATION / HIGH, bound to the dash-forge contract group,
 *   with a budget and an expiry (a Forge limited key, or an App Connect v2 wallet key). A key with
 *   no bounds, no budget or no expiry, or bound to one contract (a shipped wallet's) is never
 *   sealed: a passkey moves a capped session to another device, nothing more;
 * - then the live per-contract wallet grants this browser holds (never one held only to be
 *   disabled later);
 * - then, only when the user chose it, the identity's usable encryption key. It cannot be taken
 *   back from an entry already written: removing the passkey does not lock its holder out.
 * Never MASTER, CRITICAL or TRANSFER keys, and never a pasted tab-only key.
 *
 * Opening checks every slot against the identity read fresh with proofs (`checkSlots`): HPKE
 * authenticates nobody, and any live key of the owner can write an entry. A slot 0 that fails
 * refuses the sign-in; a grant or encryption key that fails is dropped.
 */

import { decodeIdentifier, base58Encode } from '../base58'
import type { Network } from '../../constants'
import { forgeContractIds, type ForgeIds } from '../../deployments'
import { APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS } from '../../vendor/platform-auth/app-connect'
import {
  bytesEqual,
  checkSlots,
  KeyPurpose,
  KeyType,
  matchKey,
  PasskeyError,
  PasskeyVault,
  SecurityLevel,
  VaultCryptoError,
  VaultError,
  wipe,
  type DropReason,
  type OnChainKey,
  type PasskeyAdapter,
  type SlotBundle,
  type SlotKey,
  type VaultEntryRecord,
  type VaultPort,
} from '../../vendor/platform-auth/passkey-vault'
import type { ExtraKey, VaultSecret } from '../vault'
import { decodeWif, encodeWif } from '../wif'
import type { PasskeyMarker } from './markers'
import { FORGE_BUNDLE_CODEC, FORGE_BUNDLE_FORMAT, FORGE_BUNDLE_MAX_KEYS, FORGE_VAULT_PROFILE, PASSKEY_VAULT_RP_NAME } from './profile'
import { credentialName } from './port'

/**
 * A key that expires within this margin is not sealed and does not sign in: a session opened on
 * it could not sign anything (App Connect's last-minutes rule, `controller.ts` `writeAuth`).
 */
export const PASSKEY_EXPIRY_MARGIN_MS = APP_CONNECT_SIGNING_EXPIRY_MARGIN_MS

/** A Forge network with forge-meta, where `vaultEntry` lives. */
export type VaultForgeIds = ForgeIds & { readonly meta: string }

/** What the vault seals for a session: the owner and copies of its keys in slot order. */
export interface SealableSession {
  readonly ownerId: Uint8Array
  readonly keys: readonly SlotKey[]
}

/** Overwrite every private key a {@link SealableSession} holds. */
export function wipeSession(s: SealableSession): void {
  for (const k of s.keys) wipe(k.privateKey)
}

/** What an opened passkey gives a sign-in, after the chain check: copies the caller owns. */
export interface OpenedKeys {
  /** Slot 0: the main key. */
  readonly keyId: number
  readonly wif: string
  /** The wallet grants that passed, each under the Forge contract it covers. */
  readonly extra: readonly ExtraKey[]
  /** The encryption key, when it was sealed and passed. The caller wipes `secret`. */
  readonly encryption: { readonly keyId: number; readonly secret: Uint8Array } | null
  /** Every key id that passed, in slot order (what this device's marker records). */
  readonly keyIds: readonly number[]
  /** How many slots the chain check dropped (a grant since disabled, say). */
  readonly dropped: number
}

/** Overwrite the encryption key an {@link OpenedKeys} holds (the WIFs are strings and cannot be). */
export function wipeOpened(o: OpenedKeys | null | undefined): void {
  if (o?.encryption) wipe(o.encryption.secret)
}

/** Why a passkey flow stopped, with a stable code for the UI and copy a user can act on. */
export type PlatformPasskeyErrorCode =
  /** Not offered here (`./policy`), or the network has no forge-meta. */
  | 'unavailable'
  /** This session's key may not be sealed (no budget, not group-bound, a pasted key). */
  | 'ineligible'
  /** A browser-only passkey (its handle is not a vault's): unlock with it in the browser that made it. */
  | 'not-vault'
  | 'other-vault'
  | 'no-prf'
  | 'cancelled'
  | 'exists'
  | 'too-many'
  | 'no-entry'
  /** The entry or its keys failed the checks: sign in another way. */
  | 'refused'
  /** This browser already keeps a key for the identity: unlock it instead. */
  | 'held'
  /** Written (or maybe written) but not visible yet: check again. */
  | 'pending'
  | 'failed'

export class PlatformPasskeyError extends Error {
  constructor(
    message: string,
    readonly code: PlatformPasskeyErrorCode,
  ) {
    super(message)
    this.name = 'PlatformPasskeyError'
  }
}

const SIGN_IN_ANOTHER_WAY = 'Sign in another way (your identity file, recovery phrase or wallet), then add the passkey again.'

/** Copy for a slot 0 that failed, by why. */
function slotZeroMessage(reason: DropReason | KeyProblem): string {
  switch (reason) {
    case 'missing':
      return "Platform doesn't show the key this passkey holds on its identity. Try again in a minute, or sign in another way."
    case 'disabled':
      return `The key this passkey holds was disabled. ${SIGN_IN_ANOTHER_WAY}`
    case 'expired':
      return `The key this passkey holds has expired: passkeys move a session to another device, they don't recover an account. ${SIGN_IN_ANOTHER_WAY}`
    case 'spent':
      return `The key this passkey holds has no budget left. ${SIGN_IN_ANOTHER_WAY}`
    default:
      return `This passkey holds a key Dash Forge doesn't sign in with. ${SIGN_IN_ANOTHER_WAY}`
  }
}

/** The core's errors in Forge's words. Anything else passes through (a failed read stays one). */
export function platformPasskeyError(e: unknown): unknown {
  if (e instanceof PlatformPasskeyError) return e
  if (e instanceof PasskeyError) {
    switch (e.code) {
      case 'not-vault':
        return new PlatformPasskeyError('This passkey only unlocks the browser that made it. Use it there, or sign in another way.', 'not-vault')
      case 'other-vault':
        return new PlatformPasskeyError('This passkey is for Dash Forge on another network.', 'other-vault')
      case 'no-prf':
        return new PlatformPasskeyError("This passkey's provider can't keep a key with it (it has no PRF support). Use another passkey provider, or sign in another way.", 'no-prf')
      case 'exists':
        return new PlatformPasskeyError('This device already holds a passkey for this identity.', 'exists')
      case 'cancelled':
      case 'timeout':
        return new PlatformPasskeyError('The passkey prompt was closed or timed out.', 'cancelled')
      default:
        return new PlatformPasskeyError(e.message, 'failed')
    }
  }
  if (e instanceof VaultError) {
    switch (e.code) {
      case 'too-many':
        return new PlatformPasskeyError(e.message, 'too-many')
      case 'no-entry':
        return new PlatformPasskeyError(e.message, 'no-entry')
      case 'not-visible':
        return new PlatformPasskeyError("The passkey was added, but Platform doesn't show it yet. Check again in a minute.", 'pending')
      case 'unknown-identity':
        return new PlatformPasskeyError(`Platform doesn't show the identity this passkey names. ${SIGN_IN_ANOTHER_WAY}`, 'refused')
      default:
        return new PlatformPasskeyError(e.message, 'refused')
    }
  }
  if (e instanceof VaultCryptoError) {
    return new PlatformPasskeyError(`This passkey doesn't open its entry on Platform. ${SIGN_IN_ANOTHER_WAY}`, 'refused')
  }
  return e
}

// ---------------------------------------------------------------------------
// Forge's key rules
// ---------------------------------------------------------------------------

/** Why a key may not be slot 0, beyond the core's shared checks. */
export type KeyProblem = 'shape' | 'missing' | 'disabled' | 'expired' | 'spent' | 'unbound' | 'unlimited'

const isSigningType = (type: number): boolean => type === KeyType.ECDSA_SECP256K1 || type === KeyType.ECDSA_HASH160

function groupBound(k: OnChainKey, forge: ForgeIds): boolean {
  return k.contractBounds?.kind === 'contractGroup' && bytesEqual(k.contractBounds.groupId, decodeIdentifier(forge.group))
}

const expiring = (k: OnChainKey, now: number): boolean => k.expiresAt !== undefined && k.expiresAt - now <= PASSKEY_EXPIRY_MARGIN_MS

/**
 * Why `k` cannot be a passkey's main key (slot 0), or null: a live AUTHENTICATION / HIGH key bound
 * to Forge's contract group, with a budget left and an expiry still ahead.
 */
export function mainKeyProblem(k: OnChainKey | undefined, forge: ForgeIds, now: number): KeyProblem | null {
  if (k === undefined) return 'missing'
  if (k.purpose !== KeyPurpose.AUTHENTICATION || k.securityLevel !== SecurityLevel.HIGH || !isSigningType(k.type)) return 'shape'
  if (k.disabled) return 'disabled'
  if (!groupBound(k, forge)) return 'unbound'
  if (k.totalBudget === undefined || k.expiresAt === undefined) return 'unlimited'
  if (expiring(k, now)) return 'expired'
  if (k.remainingBudget !== undefined && k.remainingBudget <= 0n) return 'spent'
  return null
}

/**
 * The Forge contract (base58) a wallet grant signs for, or null when it may not be sealed: bound
 * to one Forge contract (a shipped wallet's grant) or to Forge's group. Never an unbounded key, nor
 * one bound to a document type or to another app's contract.
 */
export function grantContract(k: OnChainKey, forge: ForgeIds): string | null {
  const b = k.contractBounds
  if (b?.kind === 'contractGroup') return groupBound(k, forge) ? forge.core : null
  if (b?.kind !== 'singleContract') return null
  const id = base58Encode(b.contractId)
  return forgeContractIds(forge).includes(id) ? id : null
}

/**
 * Whether `k` is an encryption key Forge's private repos use (`../encryption-key`
 * `isUsableEncryptionKey`): ENCRYPTION / MEDIUM, secp256k1, enabled, unbound or bound to forge-core.
 */
export function usableEncryption(k: OnChainKey, forge: ForgeIds): boolean {
  if (k.purpose !== KeyPurpose.ENCRYPTION || k.securityLevel !== SecurityLevel.MEDIUM || k.type !== KeyType.ECDSA_SECP256K1 || k.disabled) return false
  const b = k.contractBounds
  return b === undefined || (b.kind !== 'contractGroup' && base58Encode(b.contractId) === forge.core)
}

/** The identity's usable encryption key (the highest id, as writers pick it), or null. */
export function usableEncryptionKeyOf(keys: readonly OnChainKey[], forge: ForgeIds): OnChainKey | null {
  return keys.filter((k) => usableEncryption(k, forge)).reduce<OnChainKey | null>((best, k) => (best === null || k.id > best.id ? k : best), null)
}

/** Forge's rule for a slot that passed the core's checks (shape, live, unexpired, budget, match). */
function acceptSlot(slot: Readonly<SlotKey>, k: OnChainKey, index: number, forge: ForgeIds, now: number): boolean {
  if (index === 0) return mainKeyProblem(k, forge, now) === null
  if (slot.purpose === KeyPurpose.AUTHENTICATION) return grantContract(k, forge) !== null
  return usableEncryption(k, forge)
}

/**
 * The chain check of an opened bundle: every slot against the owner's keys read with proofs. A
 * slot 0 that fails throws (`VaultError` 'refused', in Forge's words); anything else that fails is
 * dropped. Returns copies: the core wipes the bundle as soon as this returns.
 */
export function verifyBundle(bundle: SlotBundle, keys: readonly OnChainKey[], o: { forge: ForgeIds; network: Network; now: number }): OpenedKeys {
  const { forge, network, now } = o
  const { accepted, dropped } = checkSlots(bundle.keys, keys, { now, expiryMarginMs: PASSKEY_EXPIRY_MARGIN_MS, accept: (slot, k, index) => acceptSlot(slot, k, index, forge, now) })
  const main = accepted.find((a) => a.index === 0)
  if (main === undefined) {
    const failed = dropped.find((d) => d.index === 0)
    const onChain = keys.find((k) => k.id === bundle.keys[0]?.keyId)
    const reason = failed?.reason === 'rule' ? (mainKeyProblem(onChain, forge, now) ?? 'shape') : (failed?.reason ?? 'missing')
    throw new VaultError(slotZeroMessage(reason), 'refused')
  }
  const extra: ExtraKey[] = []
  let encryption: OpenedKeys['encryption'] = null
  for (const a of accepted) {
    if (a.index === 0) continue
    if (a.slot.purpose === KeyPurpose.ENCRYPTION) encryption = { keyId: a.slot.keyId, secret: a.slot.privateKey.slice() }
    else extra.push({ contractId: grantContract(a.key, forge)!, keyId: a.slot.keyId, wif: encodeWif(a.slot.privateKey, network) })
  }
  return {
    keyId: main.slot.keyId,
    wif: encodeWif(main.slot.privateKey, network),
    extra,
    encryption,
    keyIds: accepted.map((a) => a.slot.keyId),
    dropped: dropped.length,
  }
}

// ---------------------------------------------------------------------------
// What a session seals
// ---------------------------------------------------------------------------

/** Copy for a main key that may not be sealed, by why. */
function ineligibleMessage(problem: KeyProblem): string {
  switch (problem) {
    case 'unbound':
    case 'unlimited':
      return "This sign-in's key has no spending limit or expiry, so it can't be kept with a passkey. Renew it with your identity file or recovery phrase, or sign in with a wallet that grants a limited key, then try again."
    case 'expired':
    case 'spent':
      return "This sign-in's key has expired or has no budget left. Renew or top it up first."
    case 'missing':
      return "Platform doesn't show this sign-in's key yet. Try again in a minute."
    default:
      return "This sign-in's key can't be kept with a passkey."
  }
}

/**
 * The wallet grants one bundle holds: one per Forge contract. With slot 0 and the encryption key
 * that fills the format's six slots.
 */
export const MAX_GRANTS = FORGE_BUNDLE_MAX_KEYS - 2

/** The private key of `wif`, when it is `k`'s; null (and nothing left in memory) otherwise. */
function privateKeyOf(wif: string, k: OnChainKey): Uint8Array | null {
  let sk: Uint8Array
  try {
    sk = decodeWif(wif).privateKey
  } catch {
    return null
  }
  if (matchKey(sk, k)) return sk
  wipe(sk)
  return null
}

const slotOf = (k: OnChainKey, privateKey: Uint8Array): SlotKey => ({ purpose: k.purpose, securityLevel: k.securityLevel, keyType: k.type, keyId: k.id, privateKey })

/**
 * The keys a session seals, checked against the identity's keys read just now: slot 0 the main
 * key (throws {@link PlatformPasskeyError} 'ineligible' when it may not be), then each live wallet
 * grant this browser holds that Forge would sign with (at most {@link MAX_GRANTS}, in the vault's
 * order, newest first), then the encryption key when given (it must be the identity's usable one). The caller wipes the
 * result ({@link wipeSession}) and its own `encryption.secret`.
 */
export function sealableSession(o: {
  readonly ownerId: Uint8Array
  readonly secret: VaultSecret
  readonly keys: readonly OnChainKey[]
  readonly forge: ForgeIds
  readonly now: number
  readonly encryption?: { readonly keyId: number; readonly secret: Uint8Array } | null
}): SealableSession {
  const { secret, keys, forge, now } = o
  const byId = (id: number) => keys.find((k) => k.id === id)
  const main = byId(secret.keyId)
  const problem = secret.keyId < 0 ? 'shape' : mainKeyProblem(main, forge, now)
  if (problem !== null || main === undefined) throw new PlatformPasskeyError(ineligibleMessage(problem ?? 'missing'), 'ineligible')
  const mainSk = privateKeyOf(secret.wif, main)
  if (mainSk === null) throw new PlatformPasskeyError(ineligibleMessage('shape'), 'ineligible')
  const slots: SlotKey[] = [slotOf(main, mainSk)]
  let encryption: SlotKey | null = null
  try {
    if (o.encryption) {
      const k = byId(o.encryption.keyId)
      const usable = usableEncryptionKeyOf(keys, forge)
      const sk = o.encryption.secret.slice()
      if (k === undefined || usable?.id !== k.id || !matchKey(sk, k)) {
        wipe(sk)
        throw new PlatformPasskeyError("The encryption key this browser holds isn't your identity's current one, so it can't be added. Import the current one in Settings first.", 'ineligible')
      }
      encryption = slotOf(k, sk)
    }
    for (const e of secret.extra ?? []) {
      if (slots.length > MAX_GRANTS || e.holdOnly) continue
      const k = byId(e.keyId)
      if (k === undefined || slots.some((s) => s.keyId === k.id)) continue
      const live = k.purpose === KeyPurpose.AUTHENTICATION && k.securityLevel === SecurityLevel.HIGH && isSigningType(k.type) && !k.disabled && !expiring(k, now)
      const spent = k.remainingBudget !== undefined && k.remainingBudget <= 0n
      if (!live || spent || grantContract(k, forge) === null) continue
      const sk = privateKeyOf(e.wif, k)
      if (sk !== null) slots.push(slotOf(k, sk))
    }
  } catch (error) {
    for (const s of slots) wipe(s.privateKey)
    throw error
  }
  return { ownerId: o.ownerId.slice(), keys: encryption ? [...slots, encryption] : slots }
}

// ---------------------------------------------------------------------------
// The vault
// ---------------------------------------------------------------------------

export type ForgePasskeyVault = PasskeyVault<SealableSession, SlotBundle, OpenedKeys>

export interface ForgePasskeyVaultOptions {
  readonly port: VaultPort
  readonly adapter: PasskeyAdapter
  readonly rpId: string
  readonly forge: VaultForgeIds
  readonly network: Network
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** Forge's passkey vault: entries in forge-meta, Forge's profile, Forge's chain check. */
export function forgePasskeyVault(o: ForgePasskeyVaultOptions): ForgePasskeyVault {
  const now = o.now ?? Date.now
  return new PasskeyVault<SealableSession, SlotBundle, OpenedKeys>({
    profile: FORGE_VAULT_PROFILE,
    codec: FORGE_BUNDLE_CODEC,
    port: o.port,
    adapter: o.adapter,
    rpId: o.rpId,
    rpName: PASSKEY_VAULT_RP_NAME,
    contractId: decodeIdentifier(o.forge.meta),
    ownerOf: (s) => s.ownerId,
    bundleFor: (s) => ({ format: FORGE_BUNDLE_FORMAT, keys: s.keys.map((k) => ({ ...k, privateKey: k.privateKey.slice() })) }),
    verify: (bundle, keys, ctx) => verifyBundle(bundle, keys, { forge: o.forge, network: o.network, now: ctx.now }),
    now,
    ...(o.sleep ? { sleep: o.sleep } : {}),
  })
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** The state of the key an entry names, as the identity shows it now. */
export type PasskeyKeyState = 'live' | 'disabled' | 'expired' | 'missing'

/** One passkey of the identity, for Settings → Devices & keys. No key material. */
export interface PlatformPasskeyRow {
  /** The credential id, base64url: what remove and re-seal take. */
  readonly id: string
  /** When the entry was written (ms), when Platform says. */
  readonly addedAt: number | null
  readonly updatedAt: number | null
  /** This device made it, or signed in with it. */
  readonly thisDevice: boolean
  /** The key it holds (slot 0). */
  readonly keyId: number
  readonly keyState: PasskeyKeyState
  /** It holds this session's key. */
  readonly current: boolean
  /** It holds an older key or other keys than this session's: re-seal it ("Needs update"). */
  readonly needsUpdate: boolean
  /** It also holds the encryption key (known for this device's passkeys only). */
  readonly encryptionKey: boolean
}

function keyState(k: OnChainKey | undefined, now: number): PasskeyKeyState {
  if (k === undefined) return 'missing'
  if (k.disabled) return 'disabled'
  return k.expiresAt !== undefined && k.expiresAt <= now ? 'expired' : 'live'
}

const sameIds = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** The auth key ids a marker recorded (its encryption key left out). */
const markedAuthIds = (m: PasskeyMarker): number[] => m.keyIds.filter((id) => id !== m.encryptionKeyId)

/**
 * Whether this device's own entry should be re-sealed for the session that now holds `authIds`
 * (slot 0 first): it names another main key, holds other grants, or holds an encryption key that
 * is no longer the identity's usable one.
 */
export function needsReseal(entry: Pick<VaultEntryRecord, 'authKeyId'>, marker: PasskeyMarker | null, authIds: readonly number[], usableEncryptionId: number | null): boolean {
  if (entry.authKeyId !== authIds[0]) return true
  if (marker === null) return false
  return !sameIds(markedAuthIds(marker), authIds) || (marker.encryptionKeyId !== undefined && marker.encryptionKeyId !== usableEncryptionId)
}

/**
 * The rows for the identity's entries: `markers` say which are this device's (only when their
 * recipient key is the entry's: a replaced entry is no longer the passkey this device made), and
 * `authIds` are the key ids this session would seal (slot 0 first), or just its main key's when
 * the rest is locked.
 */
export function passkeyRows(o: {
  readonly entries: readonly VaultEntryRecord[]
  readonly markers: readonly PasskeyMarker[]
  readonly keys: readonly OnChainKey[]
  readonly authIds: readonly number[]
  readonly usableEncryptionId: number | null
  readonly now: number
}): PlatformPasskeyRow[] {
  return o.entries
    .map((e) => {
      const m = o.markers.find((x) => bytesEqual(x.credentialId, e.credentialId) && bytesEqual(x.recipientKey, e.recipientKey)) ?? null
      return {
        id: credentialName(e.credentialId),
        addedAt: e.createdAt ?? null,
        updatedAt: e.updatedAt ?? null,
        thisDevice: m !== null,
        keyId: e.authKeyId,
        keyState: keyState(
          o.keys.find((k) => k.id === e.authKeyId),
          o.now,
        ),
        current: e.authKeyId === o.authIds[0],
        needsUpdate: needsReseal(e, m, o.authIds, o.usableEncryptionId),
        encryptionKey: m?.encryptionKeyId !== undefined,
      }
    })
    .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
}

/**
 * First-login key registration (QR #2, `dash-st:`) for the shipped Dash wallets, and the rules
 * that decide which wallet-granted keys Forge will sign with.
 *
 * A legacy wallet hands Forge a login key but does not register it: the app shows the wallet an
 * unsigned IdentityUpdate that adds the two keys the login key stands for, and the wallet
 * checks it, rebuilds it from its own state and signs it with the master key. What the shipped
 * wallets check and keep (verified 2026-09-26 against their sources):
 *
 *   - both parse the transition **without** the StateTransition enum tag (yappr's framing, what
 *     `IdentityUpdateTransition.toBytes()` emits) and check it is for their identity and adds
 *     exactly their derived keys: auth = ECDSA_HASH160(hash160(authPub)) AUTHENTICATION/HIGH,
 *     enc = ECDSA_SECP256K1(encPub) ENCRYPTION/MEDIUM;
 *   - iOS requires exactly those two keys and no disables, keeps a `singleContract` bound (it
 *     uses it to find the approved app), refuses a `contractGroup` bound, and drops a budget or
 *     an expiry;
 *   - Android rebuilds both keys unbounded and without limits.
 *
 * So Forge asks for the auth key bound to the one contract the request named, and nothing else:
 * on iOS the key lands bounded to it, on Android it lands unbounded. Neither lands with a budget
 * or an expiry, which is why {@link walletKeyScope} accepts unlimited keys and the UI warns
 * (docs/design/wallet-login.md). A budget in the transition would be dropped anyway and older
 * parsers may not decode the version 1 key that carries one.
 */

import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import type { ForgeIds } from '../deployments'
import { authSdk, type WasmKey } from '../sdk/facade'
import type { KeyLimits } from '../view/funds'
import { hash160 } from './asset-lock'
import { authKeyFromLogin, encryptionKeyFromLogin, protocolUri } from './wallet-protocol'

// ---------------------------------------------------------------------------
// Which keys Forge signs with
// ---------------------------------------------------------------------------

/** What a key may sign on the dash-forge contracts. */
export interface KeyScope {
  readonly core: boolean
  readonly collab: boolean
  /** No contract bounds: consensus lets it sign on any contract (the Android wallet's keys). */
  readonly unbounded: boolean
}

/**
 * The scope of an AUTHENTICATION key over forge-core and forge-collab, or null when Forge must
 * not use it: bound to another contract or group (it is another app's key, or a key left on a
 * superseded group), or to a single document type.
 */
export function keyScope(k: Pick<WasmKey, 'contractBounds'>, forge: ForgeIds): KeyScope | null {
  const bounds = k.contractBounds?.toJSON()
  if (bounds === undefined || bounds === null) return { core: true, collab: true, unbounded: true }
  if (bounds.$type === 'contractGroup') return bounds.id === forge.group ? { core: true, collab: true, unbounded: false } : null
  if (bounds.$type === 'singleContract') {
    if (bounds.id === forge.core) return { core: true, collab: false, unbounded: false }
    if (bounds.id === forge.collab) return { core: false, collab: true, unbounded: false }
  }
  return null
}

/** Whether a scope lets the key sign on `contractId`. Contracts other than Forge's: not ours to say. */
export function scopeCovers(scope: KeyScope, forge: ForgeIds, contractId: string): boolean {
  if (contractId === forge.core) return scope.core
  if (contractId === forge.collab) return scope.collab
  return scope.unbounded
}

/** A wallet-granted key Forge verified on chain. */
export interface WalletKey {
  readonly keyId: number
  readonly wif: string
  readonly scope: KeyScope
  /** Budget and expiry; null for a key that has neither (what the shipped wallets register). */
  readonly limits: KeyLimits | null
}

/** Why a key the wallet granted is not one Forge will use. */
export class UnusableWalletKey extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnusableWalletKey'
  }
}

/**
 * Check the key `keyId` of `identityId` is one Forge may sign with: live, AUTHENTICATION/HIGH
 * (never CRITICAL or MASTER: more than Forge needs), inside Forge's contracts, not expired, with
 * budget left when it has a budget, and controlled by `wif`.
 */
export async function verifyWalletKey(sdk: EvoSDK, p: { identityId: string; keyId: number; wif: string; forge: ForgeIds; network: Network }): Promise<WalletKey> {
  const identity = await authSdk(sdk).identities.fetch(p.identityId)
  const k = identity?.publicKeys.find((x) => x.keyId === p.keyId)
  if (!k) throw new UnusableWalletKey(`key ${p.keyId} is not on identity ${p.identityId}`)
  if (k.disabledAt !== undefined) {
    throw new UnusableWalletKey(`the wallet's key for Forge (key ${p.keyId}) is disabled on chain, and the wallet derives the same key again. Sign in another way.`)
  }
  if (k.purposeNumber !== 0 || k.securityLevelNumber !== 2) throw new UnusableWalletKey(`key ${p.keyId} is not an AUTHENTICATION/HIGH key; Forge only signs with HIGH keys`)
  const scope = keyScope(k, p.forge)
  if (scope === null) throw new UnusableWalletKey(`key ${p.keyId} is bound to contracts outside Dash Forge`)
  if (k.expiresAt !== undefined && Number(k.expiresAt) <= Date.now()) throw new UnusableWalletKey(`key ${p.keyId} has expired`)
  const { PrivateKey } = await import('@dashevo/evo-sdk')
  const pk = PrivateKey.fromWIF(p.wif)
  const bytes = pk.toBytes()
  pk.free()
  let controls = false
  try {
    controls = k.validatePrivateKey(bytes, p.network)
  } catch {
    controls = false
  } finally {
    bytes.fill(0)
  }
  if (!controls) throw new UnusableWalletKey(`the granted private key does not control key ${p.keyId}`)
  let limits: KeyLimits | null = null
  if (k.totalBudget !== undefined || k.expiresAt !== undefined) {
    const remaining = k.totalBudget === undefined ? null : ((await authSdk(sdk).identities.keysRemainingBudgets(p.identityId, [p.keyId])).get(p.keyId) ?? null)
    if (remaining !== null && remaining <= 0n) throw new UnusableWalletKey(`key ${p.keyId} has no budget left`)
    limits = { remaining, total: k.totalBudget ?? null, expiresAt: k.expiresAt === undefined ? null : Number(k.expiresAt) }
  }
  return { keyId: p.keyId, wif: p.wif, scope, limits }
}

/** A key has no budget or no expiry: whoever copies it can spend until it is disabled. */
export function isUnlimited(key: Pick<WalletKey, 'limits'>): boolean {
  return key.limits === null || key.limits.total === null || key.limits.expiresAt === null
}

// ---------------------------------------------------------------------------
// dash-st: the unsigned key registration
// ---------------------------------------------------------------------------

/** The two keys a login key stands for, as the wallet derives and registers them. */
export interface LoginKeys {
  readonly authPriv: Uint8Array
  /** hash160(authPub): the ECDSA_HASH160 key data. */
  readonly authData: Uint8Array
  readonly encPriv: Uint8Array
  readonly encPub: Uint8Array
}

export function loginKeys(loginKey: Uint8Array, identityId: string): LoginKeys {
  const authPriv = authKeyFromLogin(loginKey, identityId)
  const encPriv = encryptionKeyFromLogin(loginKey, identityId)
  return { authPriv, authData: hash160(secp.getPublicKey(authPriv, true)), encPriv, encPub: secp.getPublicKey(encPriv, true) }
}

/**
 * The `dash-st:` URI a wallet scans to register a login key: an IdentityUpdate adding the auth
 * key (HASH160, AUTHENTICATION/HIGH, bound to `contractId`) and the encryption key (SECP256K1,
 * ENCRYPTION/MEDIUM, with its proof of possession), at the identity's next revision and nonce,
 * unsigned by the identity. Serialized without the StateTransition tag, as both wallets expect.
 */
export async function keyRegistrationUri(
  sdk: EvoSDK,
  p: { identityId: string; keys: LoginKeys; contractId: string; network: Network },
): Promise<{ uri: string; authKeyId: number; bytes: Uint8Array }> {
  const evo = await import('@dashevo/evo-sdk')
  const identity = await authSdk(sdk).identities.fetch(p.identityId)
  if (!identity) throw new Error(`identity ${p.identityId} not found`)
  const nonce = (await (sdk as unknown as { identities: { nonce(id: string): Promise<bigint | undefined> } }).identities.nonce(p.identityId)) ?? 0n
  const revision = (identity as unknown as { revision: bigint }).revision
  const authKeyId = Math.max(...identity.publicKeys.map((k) => k.keyId)) + 1
  const bytes = buildKeyRegistration(evo, { identityId: p.identityId, revision: revision + 1n, nonce: nonce + 1n, authKeyId, keys: p.keys, contractId: p.contractId })
  return { uri: protocolUri('dash-st', bytes, p.network), authKeyId, bytes }
}

type Evo = typeof import('@dashevo/evo-sdk')

/** The transition bytes (pure given its inputs; exported for the test vectors). */
export function buildKeyRegistration(
  evo: Evo,
  p: { identityId: string; revision: bigint; nonce: bigint; authKeyId: number; keys: LoginKeys; contractId: string },
): Uint8Array {
  const make = (encSignature: Uint8Array): InstanceType<Evo['IdentityUpdateTransition']> => {
    const auth = new evo.IdentityPublicKeyInCreation({
      keyId: p.authKeyId,
      purpose: 'authentication',
      securityLevel: 'high',
      keyType: 'ecdsa_hash160',
      data: p.keys.authData,
      contractBounds: evo.ContractBounds.SingleContract(p.contractId),
    })
    const enc = new evo.IdentityPublicKeyInCreation({
      keyId: p.authKeyId + 1,
      purpose: 'encryption',
      securityLevel: 'medium',
      keyType: 'ecdsa_secp256k1',
      data: p.keys.encPub,
      ...(encSignature.length ? { signature: encSignature } : {}),
    })
    return new evo.IdentityUpdateTransition({ identityId: p.identityId, revision: p.revision, nonce: p.nonce, addPublicKeys: [auth, enc], disablePublicKeys: [] })
  }
  // A full public key proves possession by signing the transition's signable bytes (which
  // exclude every signature). A HASH160 key carries no proof: it would reveal the public key.
  const unsigned = make(new Uint8Array(0))
  const signable = unsigned.toStateTransition().getSignableBytes()
  unsigned.free()
  const signed = make(compactSign(p.keys.encPriv, signable))
  const bytes = signed.toBytes()
  signed.free()
  return bytes
}

/** Dash's compact recoverable signature over sha256d(data): header(27 + 4 + recid) ‖ r ‖ s. */
function compactSign(priv: Uint8Array, data: Uint8Array): Uint8Array {
  const rec = secp.sign(sha256(sha256(data)), priv, { prehash: false, format: 'recovered', lowS: true })
  const out = new Uint8Array(65)
  out[0] = 27 + 4 + (rec[0] as number)
  out.set(rec.slice(1), 1)
  return out
}

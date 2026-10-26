// The chain check's building blocks. HPKE authenticates nobody, so every key from an opened bundle must be checked against the
// owner's keys read fresh with proofs before anything uses it. These helpers do the checks every app shares; the app adds its own
// (contract bounds, group, budget policy) through `accept`, and decides what a dropped slot 0 means (it should refuse the sign-in).
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesEqual } from './bytes'
import type { SlotKey } from './codecs'
import { KeyType, type OnChainKey } from './port'

/** Whether `privateKey` is the private half of `key`: its compressed point (ECDSA_SECP256K1) or that point's hash160 (ECDSA_HASH160). */
export function matchKey(privateKey: Uint8Array, key: Pick<OnChainKey, 'type' | 'data'>): boolean {
  let publicKey: Uint8Array
  try {
    publicKey = secp256k1.getPublicKey(privateKey, true)
  } catch {
    return false
  }
  if (key.type === KeyType.ECDSA_SECP256K1) return bytesEqual(publicKey, key.data)
  if (key.type === KeyType.ECDSA_HASH160) return bytesEqual(ripemd160(sha256(publicKey)), key.data)
  return false
}

export type DropReason =
  /** No key with this id on the identity (or a node behind: the app may prefer "try again" for slot 0). */
  | 'missing'
  | 'disabled'
  | 'expired'
  /** The budget is known to be spent. An unknown budget is not a spent one. */
  | 'spent'
  /** The slot's purpose, level or type is not the key's on chain. */
  | 'shape'
  /** The private key does not match the key on chain. */
  | 'mismatch'
  /** The app's `accept` refused it. */
  | 'rule'

export interface SlotRules {
  /** ms since the epoch. */
  now: number
  /** A key expiring within this margin counts as expired (default 0). */
  expiryMarginMs?: number
  /** The app's own rule for a key that passed the shared checks. */
  accept?(slot: Readonly<SlotKey>, key: OnChainKey, index: number): boolean
}

export interface AcceptedSlot {
  index: number
  /** The bundle's slot: its private key is the bundle's and is wiped with it. Copy what you keep. */
  slot: SlotKey
  key: OnChainKey
}

export interface DroppedSlot {
  index: number
  slot: SlotKey
  reason: DropReason
}

/**
 * Checks each slot against the identity's keys: same id, purpose, level and type; enabled; not expiring within the margin; budget not
 * known to be spent; the private key matches; then the app's rule. Returns the slots in bundle order, split.
 */
export function checkSlots(keys: readonly SlotKey[], onChain: readonly OnChainKey[], rules: SlotRules): { accepted: AcceptedSlot[]; dropped: DroppedSlot[] } {
  const accepted: AcceptedSlot[] = []
  const dropped: DroppedSlot[] = []
  keys.forEach((slot, index) => {
    const key = onChain.find((k) => k.id === slot.keyId)
    if (!key) {
      dropped.push({ index, slot, reason: 'missing' })
      return
    }
    const reason = dropReason(slot, key, index, rules)
    if (reason) dropped.push({ index, slot, reason })
    else accepted.push({ index, slot, key })
  })
  return { accepted, dropped }
}

/** Why `slot` may not use the on-chain `key` of its id, or null when it may. */
function dropReason(slot: SlotKey, key: OnChainKey, index: number, rules: SlotRules): DropReason | null {
  if (key.purpose !== slot.purpose || key.securityLevel !== slot.securityLevel || key.type !== slot.keyType) return 'shape'
  if (key.disabled) return 'disabled'
  if (key.expiresAt !== undefined && key.expiresAt - rules.now <= (rules.expiryMarginMs ?? 0)) return 'expired'
  if (key.remainingBudget !== undefined && key.remainingBudget <= 0n) return 'spent'
  if (!matchKey(slot.privateKey, key)) return 'mismatch'
  if (rules.accept && !rules.accept(slot, key, index)) return 'rule'
  return null
}

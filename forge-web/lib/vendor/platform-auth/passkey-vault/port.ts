// What the vault needs from Platform. The app builds the port: it binds the vault contract and the signer (the session key), reads
// with proofs, and serialises writes per identity. Ids are raw 32-byte identifiers here; the port converts to the SDK's forms.
import type { SealedVaultEntry } from './entry'

/** rs-dpp `Purpose`. */
export const KeyPurpose = { AUTHENTICATION: 0, ENCRYPTION: 1, DECRYPTION: 2, TRANSFER: 3, SYSTEM: 4, VOTING: 5, OWNER: 6 } as const
/** rs-dpp `SecurityLevel` (lower is stronger). */
export const SecurityLevel = { MASTER: 0, CRITICAL: 1, HIGH: 2, MEDIUM: 3 } as const
/** rs-dpp `KeyType`. */
export const KeyType = { ECDSA_SECP256K1: 0, BLS12_381: 1, ECDSA_HASH160: 2, BIP13_SCRIPT_HASH: 3, EDDSA_25519_HASH160: 4 } as const

export type ContractBounds =
  | { kind: 'singleContract'; contractId: Uint8Array }
  | { kind: 'singleContractDocumentType'; contractId: Uint8Array; documentType: string }
  | { kind: 'contractGroup'; groupId: Uint8Array }

/** An identity public key as read from Platform with proofs, reduced to what the vault's checks need. */
export interface OnChainKey {
  id: number
  purpose: number
  securityLevel: number
  type: number
  /** 33-byte compressed point (ECDSA_SECP256K1) or 20-byte hash160 (ECDSA_HASH160). */
  data: Uint8Array
  disabled: boolean
  contractBounds?: ContractBounds
  /** Expiry, ms since the epoch. */
  expiresAt?: number
  /** The key's total budget in credits, when it has one. */
  totalBudget?: bigint
  /** What is left of the budget in credits; undefined when unknown or the key has none. */
  remainingBudget?: bigint
}

/** A vault entry as stored: the sealed fields plus the document's owner and bookkeeping. */
export interface VaultEntryRecord extends SealedVaultEntry {
  ownerId: Uint8Array
  /** The document id (the port's own form). */
  documentId?: string
  revision?: number
  /** `$createdAt` / `$updatedAt`, ms since the epoch. */
  createdAt?: number
  updatedAt?: number
}

export interface VaultPort {
  /** Every entry of `ownerId`, read with proofs. */
  list(ownerId: Uint8Array): Promise<VaultEntryRecord[]>
  /** The entry for one credential (`byCredential [$ownerId, credentialId]`), read with proofs; null when proved absent. */
  byCredential(ownerId: Uint8Array, credentialId: Uint8Array): Promise<VaultEntryRecord | null>
  /** The identity's public keys, read with proofs; null when the identity is proved absent. */
  identityKeys(ownerId: Uint8Array): Promise<OnChainKey[] | null>
  /** Creates the entry, or replaces `existing` (same credential). Idempotent and serialised per identity. */
  put(o: { ownerId: Uint8Array; entry: SealedVaultEntry; existing: VaultEntryRecord | null }): Promise<void>
  /** Deletes the entry. Idempotent. */
  remove(o: { ownerId: Uint8Array; entry: VaultEntryRecord }): Promise<void>
}

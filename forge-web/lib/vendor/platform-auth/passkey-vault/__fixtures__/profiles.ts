// The three apps' profiles, as the test vectors pin them. Yappr's and govhub's reproduce the bytes those apps write today; Forge's is
// the new one (PLAN-passkey-vault.md §1). The `allow`/`check` rules are each app's own and do not change any bytes; the ids, lengths,
// key counts and labels do.
import { slotKeysCodec, seedCodec, votingKeysCodec, type SeedBundle, type SlotBundle, type SlotKey, type VotingKeysBundle } from '../codecs'
import { KeyPurpose, KeyType, SecurityLevel } from '../port'
import { defineProfile } from '../profile'

type KeyShape = Readonly<Omit<SlotKey, 'privateKey'>>

const signInType = (k: KeyShape) => k.keyType === KeyType.ECDSA_SECP256K1 || k.keyType === KeyType.ECDSA_HASH160
const isAuth = (k: KeyShape) => k.purpose === KeyPurpose.AUTHENTICATION

// ---- Yappr (lib/crypto/passkey-vault.ts) ----

const YAPPR_RAW = 1
const YAPPR_RING = 2

/** Yappr `keyAllowed` plus "slot 0 must be the sign-in key". */
function yapprAllow(k: KeyShape, slot: number, format: number): boolean {
  if (isAuth(k)) return (k.securityLevel === SecurityLevel.CRITICAL || k.securityLevel === SecurityLevel.HIGH) && signInType(k)
  if (slot === 0) return false
  const purposeOk = k.purpose === KeyPurpose.ENCRYPTION || (format === YAPPR_RING && k.purpose === KeyPurpose.DECRYPTION)
  return purposeOk && k.securityLevel === SecurityLevel.MEDIUM && k.keyType === KeyType.ECDSA_SECP256K1
}

export const yapprRaw = slotKeysCodec({
  id: YAPPR_RAW,
  length: 80,
  maxKeys: 2,
  allow: yapprAllow,
  check: (keys) => (keys.filter(isAuth).length === 1 ? null : 'a raw-key bundle holds one sign-in key'),
})
export const yapprRing = slotKeysCodec({ id: YAPPR_RING, length: 160, maxKeys: 4, allow: yapprAllow })

export const yapprProfile = defineProfile({
  prfLabel: 'yappr/passkey-vault/v1/prf',
  infoLabel: 'yappr/passkey-vault/v1',
  aadDocType: 'vaultEntry',
  entryVersion: 1,
  formats: [yapprRaw, yapprRing],
  strictSealedLength: false,
})

// ---- govhub (packages/auth/src/vault/bundle.ts) ----

export const govhubSeed = seedCodec({ id: 1, length: 240 })
export const govhubKey = slotKeysCodec({
  id: 2,
  length: 240,
  maxKeys: 1,
  allow: (k) => isAuth(k) && (k.securityLevel === SecurityLevel.HIGH || k.securityLevel === SecurityLevel.CRITICAL) && signInType(k),
})
export const govhubVoting = votingKeysCodec({ id: 3, length: 240, maxKeys: 7 })

export type GovhubBundle = SeedBundle | SlotBundle | VotingKeysBundle

export const govhubProfile = defineProfile<GovhubBundle>({
  prfLabel: 'govhub/vault/v1/prf',
  infoLabel: 'govhub/vault/v1',
  aadDocType: 'vault',
  entryVersion: 1,
  formats: [govhubSeed, govhubKey, govhubVoting],
  strictSealedLength: true,
})

// ---- Forge (new) ----

/**
 * Slot 0: the session's main key, AUTHENTICATION at HIGH (secp256k1 or hash160). Slots 1 and up: per-contract wallet grants (the
 * same shape) and at most one ENCRYPTION key at MEDIUM. Never MASTER, CRITICAL or TRANSFER. The chain check (bounds, budget,
 * expiry) is the service's, not the codec's.
 */
function forgeAllow(k: KeyShape, slot: number): boolean {
  if (isAuth(k)) return k.securityLevel === SecurityLevel.HIGH && signInType(k)
  return slot > 0 && k.purpose === KeyPurpose.ENCRYPTION && k.securityLevel === SecurityLevel.MEDIUM && k.keyType === KeyType.ECDSA_SECP256K1
}

export const forgeSlots = slotKeysCodec({
  id: 1,
  length: 240,
  maxKeys: 6,
  allow: forgeAllow,
  check: (keys) => (keys.filter((k) => k.purpose === KeyPurpose.ENCRYPTION).length <= 1 ? null : 'a bundle holds one encryption key at most'),
})

export const forgeProfile = defineProfile({
  prfLabel: 'dash-forge/passkey-vault/v1/prf',
  infoLabel: 'dash-forge/passkey-vault/v1',
  aadDocType: 'vaultEntry',
  entryVersion: 1,
  formats: [forgeSlots],
  strictSealedLength: true,
})

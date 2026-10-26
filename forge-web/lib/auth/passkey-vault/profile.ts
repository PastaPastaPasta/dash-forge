/**
 * Forge's passkey-vault profile (PLAN-passkey-vault.md §1): the labels and the one bundle format
 * that make a `vaultEntry` Forge's. The ids, lengths, key count and labels define the bytes every
 * entry on Platform carries, so they are pinned by `__vectors__/forge.json` (the vendored core's,
 * written by an independent generator) and must never change: a change orphans every passkey.
 *
 * One format, padded to 240 bytes (256 sealed): slot 0 is the session's main key, then the live
 * per-contract wallet grants, then at most one encryption key. Every entry has the same size
 * whatever it holds. The codec's `allow` and `check` are shape rules only; whether a key may be
 * used is the chain check's (`./service`), against the identity read with proofs.
 */

import { KeyPurpose, KeyType, SecurityLevel, defineProfile, slotKeysCodec, type SlotKey } from '../../vendor/platform-auth/passkey-vault'

type KeyShape = Readonly<Omit<SlotKey, 'privateKey'>>

/** The relying party name a vault passkey shows in the user's passkey manager. */
export const PASSKEY_VAULT_RP_NAME = 'Dash Forge'

/** The bundle format byte of Forge's one format. */
export const FORGE_BUNDLE_FORMAT = 1

/** Keys one bundle holds: 2 + 6 × 39 = 236 of its 240 bytes. */
export const FORGE_BUNDLE_MAX_KEYS = 6

/** A signing key type Forge keys use: a secp256k1 point, or its hash160. */
const signingType = (k: KeyShape): boolean => k.keyType === KeyType.ECDSA_SECP256K1 || k.keyType === KeyType.ECDSA_HASH160

/**
 * Slot 0 and the wallet grants: AUTHENTICATION at HIGH (never MASTER or CRITICAL). After them, one
 * ENCRYPTION key at MEDIUM (secp256k1). Never TRANSFER or any other purpose.
 */
function forgeAllow(k: KeyShape, slot: number): boolean {
  if (k.purpose === KeyPurpose.AUTHENTICATION) return k.securityLevel === SecurityLevel.HIGH && signingType(k)
  return slot > 0 && k.purpose === KeyPurpose.ENCRYPTION && k.securityLevel === SecurityLevel.MEDIUM && k.keyType === KeyType.ECDSA_SECP256K1
}

export const FORGE_BUNDLE_CODEC = slotKeysCodec({
  id: FORGE_BUNDLE_FORMAT,
  length: 240,
  maxKeys: FORGE_BUNDLE_MAX_KEYS,
  allow: forgeAllow,
  check: (keys) => (keys.filter((k) => k.purpose === KeyPurpose.ENCRYPTION).length <= 1 ? null : 'a bundle holds one encryption key at most'),
})

export const FORGE_VAULT_PROFILE = defineProfile({
  prfLabel: 'dash-forge/passkey-vault/v1/prf',
  infoLabel: 'dash-forge/passkey-vault/v1',
  aadDocType: 'vaultEntry',
  entryVersion: 1,
  formats: [FORGE_BUNDLE_CODEC],
  strictSealedLength: true,
})

// @pastapastapasta/platform-auth/passkey-vault: an on-chain passkey vault core (docs/passkey-vault.md). Not re-exported from the
// package root: names such as PasskeyError would collide with the root's.
export { bytesEqual, concatBytes, randomBytes, readU32be, u32be, wipe } from './bytes'
export {
  isValidPrivateKey,
  seedCodec,
  SLOT_LENGTH,
  slotKeysCodec,
  votingKeysCodec,
  type BundleCodec,
  type SeedBundle,
  type SlotBundle,
  type SlotKey,
  type SlotKeysCodecOptions,
  type VotingKeysBundle,
} from './codecs'
export {
  entryAad,
  hpkeInfo,
  MAX_CREDENTIAL_ID_LENGTH,
  MIN_CREDENTIAL_ID_LENGTH,
  openEntry,
  prfInput,
  recipientFromPrf,
  sealEntry,
  type EntryAadFields,
  type OpenedBundle,
  type OpenEntryInput,
  type SealedVaultEntry,
  type SealEntryInput,
} from './entry'
export {
  PasskeyError,
  VaultCryptoError,
  VaultError,
  type PasskeyErrorCode,
  type VaultCryptoErrorCode,
  type VaultErrorCode,
} from './errors'
export { deriveKeyPair, openBase, sealBase, type HpkeKeyPair } from './hpke'
export { KeyPurpose, KeyType, SecurityLevel, type ContractBounds, type OnChainKey, type VaultEntryRecord, type VaultPort } from './port'
export { defineProfile, sealedLengths, TAG_LENGTH, type VaultProfile } from './profile'
export { parseUserHandle, USER_HANDLE_LENGTH, userHandleFor } from './user-handle'
export { checkSlots, matchKey, type AcceptedSlot, type DropReason, type DroppedSlot, type SlotRules } from './verify'
export {
  DEFAULT_MAX_PASSKEYS,
  PasskeyVault,
  type ConfirmedPasskey,
  type ConfirmTarget,
  type OpenedVault,
  type PasskeyVaultOptions,
  type PendingEnrolment,
  type TrustedRecipient,
  type VerifyContext,
} from './vault'
export {
  browserPasskeyAdapter,
  DEFAULT_PASSKEY_TIMEOUT_MS,
  defaultPasskeyError,
  prfSupport,
  type BrowserPasskeyOptions,
  type CeremonyKind,
  type CreatedPasskey,
  type CreatePasskeyOptions,
  type GetPasskeyOptions,
  type PasskeyAdapter,
  type PasskeyAssertion,
} from './webauthn'

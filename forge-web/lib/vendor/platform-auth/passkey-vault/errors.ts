// The module's errors. Each carries a stable `code` for the app to map to its own copy; messages are for logs.

export type VaultCryptoErrorCode =
  /** A caller passed a malformed id, key, label or option. */
  | 'input'
  /** The entry's version is not the profile's. */
  | 'version'
  /** The ciphertext's length or the bundle's format byte matches no format of the profile. */
  | 'format'
  /** The passkey's derived recipient key is not the entry's: refused before decrypting. */
  | 'wrong-passkey'
  /** The AEAD tag did not verify (another owner, contract, credential, key id, or a changed byte). */
  | 'decrypt'
  /** The bundle broke a codec rule (slot rules, repeated key, padding, slot 0 not the entry's key id). */
  | 'bundle'

export class VaultCryptoError extends Error {
  constructor(
    message: string,
    readonly code: VaultCryptoErrorCode,
  ) {
    super(message)
    this.name = 'VaultCryptoError'
  }
}

export type PasskeyErrorCode =
  | 'unsupported'
  | 'no-prf'
  | 'cancelled'
  | 'timeout'
  /** The authenticator already holds one of the owner's passkeys (an `excludeCredentials` hit, `InvalidStateError`). */
  | 'exists'
  | 'failed'
  /** The user handle is not a 64-byte vault handle (null, or a local-only passkey's 32-byte random id). */
  | 'not-vault'
  /** A vault handle for another vault contract (another network or deployment). */
  | 'other-vault'

export class PasskeyError extends Error {
  constructor(
    message: string,
    readonly code: PasskeyErrorCode,
    /** The credential the failure concerns, when known (so a passkey with no PRF can be signalled unknown). */
    readonly credentialId?: Uint8Array,
  ) {
    super(message)
    this.name = 'PasskeyError'
  }
}

export type VaultErrorCode =
  /** The identity already has the profile's maximum number of passkeys. */
  | 'too-many'
  /** No entry for this passkey (removed, or never written). */
  | 'no-entry'
  /** The passkey or entry names another identity than the one expected. */
  | 'other-identity'
  /** The identity could not be found (proved absent). */
  | 'unknown-identity'
  /** A seal was asked for a recipient key this tab neither derived nor had a passkey confirm. */
  | 'untrusted-recipient'
  /** The creation-time and assertion-time PRF outputs differ, or the assertion came from another credential. */
  | 'mismatch'
  /** The written entry is not visible on Platform yet. */
  | 'not-visible'
  /** The opened bundle failed the chain check: for the app's `verify` to throw. */
  | 'refused'

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: VaultErrorCode,
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

export function need(condition: boolean, message: string, code: VaultCryptoErrorCode = 'input'): asserts condition {
  if (!condition) throw new VaultCryptoError(message, code)
}

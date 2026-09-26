/**
 * Auth — headless identity login + secure key storage for forge-web.
 *
 * Limited-key sign-in (`ux-dx-spec.md` §2): a PV14 key bound to the dash-forge contract group,
 * with a budget and an expiry, held encrypted in the vault (passkey PRF or Argon2id) and used
 * only at signing time (never in React state or logs). The {@link AuthController} yields a
 * {@link WriteAuth} the WriteEngine consumes.
 */

export {
  base58CheckDecode,
  base58CheckEncode,
  base58Decode,
  base58Encode,
  decodeIdentifier,
} from './base58'
export {
  decodeWif,
  encodeWif,
  isLikelyHex,
  isLikelyWif,
  networkOfWifPrefix,
  normalizeToWif,
  parsePrivateKey,
  validateWifNetwork,
  type DecodedWif,
  type ParsedPrivateKey,
} from './wif'
export {
  AUTO_LOCK_MS,
  ARGON2_PARAMS,
  MIN_PASSPHRASE,
  VaultLockedError,
  enrollPasskey,
  listVaults,
  passkeysAvailable,
  type Protection,
  type VaultInfo,
} from './vault'
export { BROWSER_KEY_DEFAULTS, defaultLimits, type LimitedKey, type LimitedKeyRequest } from './limited-key'
export {
  masterMaterialFromFile,
  parseIdentityFile,
  parseIdentityFileText,
  type MasterMaterial,
  type ParsedIdentityFile,
} from './identity-file'
export {
  AuthController,
  purgeLegacyKeystore,
  type AuthSession,
  type AuthState,
  type SdkProvider,
} from './controller'

/**
 * Auth — headless identity login + secure key storage for forge-web.
 *
 * M3 shape: private-key / identity-file login with the signing key held in a network-scoped
 * browser keystore and used only at signing time (never in React state or logs). The exposed
 * {@link AuthController} yields a {@link WriteAuth} the WriteEngine consumes. Password-vault /
 * passkey-PRF wrapping of the stored key is the documented follow-up.
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
  clearAllPrivateKeys,
  clearPrivateKey,
  getPrivateKey,
  hasPrivateKey,
  storePrivateKey,
  storedIdentityIds,
} from './keystore'
export {
  parseIdentityFile,
  parseIdentityFileText,
  type ParsedIdentityFile,
} from './identity-file'
export {
  AuthController,
  type AuthSession,
  type AuthState,
  type SdkProvider,
} from './controller'

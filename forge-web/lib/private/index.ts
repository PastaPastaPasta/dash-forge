/**
 * Private repositories: the client-side crypto core (`docs/security/private-repos.md`).
 *
 * WebCrypto only (AES-256-GCM, HKDF-SHA256, HMAC-SHA256, SHA-256), with every subkey
 * non-extractable; the `repoKey` wrap goes through the evo-sdk `encryptedFor` facade the
 * caller passes in. The Rust twin is `crates/forge-core/src/private.rs`; the `private_*`
 * conformance vectors in `forge-contracts/vectors/` hold the two byte-for-byte in parity
 * (`conformance.test.ts`). Deterministic seal variants for those vectors live in
 * `./testing`, which this module deliberately does not re-export (ESLint bans importing it
 * outside tests); `__unsafe*` symbols of `./doc` and `./pack` are likewise not re-exported.
 */

export { bytesToHex, concat as concatBytes, constantTimeEqual, hexToBytes, isU32, randomBytes, type Bytes } from './bytes'
export {
  IdSet,
  bytesEqual,
  compareBytes,
  encodePrivateId,
  privateId,
  type IdEncoding,
  type PrivateId,
} from './ids'
export {
  EpochKeys,
  generateEpochKey,
  importEpochKeyAndWipe,
  refNameHash,
  type EpochKeyring,
} from './keys'
export {
  MalformedError,
  parseTlv,
  type DocFields,
  type PrivateDocType,
  type TlvContext,
} from './tlv'
export {
  GRACE_BLOCKS,
  TooLargeError,
  docAd,
  isLate,
  maxPlaintext,
  openContent,
  openWithKey,
  sealDoc,
  type AnchorRef,
  type IdentitySet,
  type OpenContext,
  type OpenResult,
  type PrivateDoc,
  type SealDocOptions,
  type StoredPrivateDoc,
  type UnreadableReason,
} from './doc'
export {
  HEADER_LEN,
  PackError,
  PackHeaderCache,
  openPack,
  openPackStream,
  packHash,
  parseHeader,
  planRange,
  readPackRange,
  sealPack,
  sealedLength,
  type PackCopySource,
  type PackErrorCode,
  type PackHeader,
  type RangeFetcher,
  type RangePlan,
} from './pack'
export {
  WrapError,
  buildWrapPlaintext,
  checkWrapPlaintext,
  openWrap,
  parseWrapPlaintext,
  sealWrap,
  unwrapKey,
  unwrapKeyRaw,
  type UnwrapParams,
  type WrapErrorCode,
  type WrapFacade,
  type WrapOpenParams,
  type WrapSealParams,
} from './wrap'
export {
  contentIsLate,
  manifestStanding,
  openContextOf,
  resolveEpochs,
  selectAnchors,
  type Anchor,
  type ConfigRow,
  type EpochAlert,
  type EpochResolution,
  type ManifestStanding,
  type PrivateMembership,
  type Repair,
  type Role,
  type WrapRow,
} from './epoch'

/**
 * evo-sdk services — the browser Platform I/O layer.
 *
 * Trusted-mode connections (`testnetTrusted()` / `mainnetTrusted()` / a devnet's) + `*WithProof`
 * reads (the only WASM-viable path, S0.3), with the base64 byteArray operand encoding and the
 * complete, tie-safe paging that active-repo correctness depends on.
 */

export { ensureSdk, evoSdkService, isStaleConnectionError, isUnreachableError, type EvoSdkConfig, type SdkStatus } from './service'
export { type DownloadProgress } from './wasm-fetch'
export {
  ConsensusRefusal,
  KeyUnusableError,
  SupersededWriteError,
  contentHash,
  DUPLICATE_UNIQUE_CODE,
  GATE_REFUSED_CODE,
  KEY_LIMIT_CODES,
  UnconfirmedWriteError,
  BusyWriteError,
  isNonceUsedError,
  newIntent,
  serialized,
  SECURITY_LEVEL,
  WriteAuthError,
  asConsensusRefusal,
  createDocumentIdempotent,
  isStaleDocumentIdError,
  measureActual,
  pendingWriteKey,
  deleteDocumentIdempotent,
  replaceDocumentIdempotent,
  precheckEdit,
  type ReplaceParams,
  type ReplaceResult,
  findSigningKey,
  isAlreadyExistsError,
  readIdentityBalance,
  type DeleteResult,
  type SpendEvent,
  type WriteAuth,
  type WriteResult,
} from './write'
export {
  CREDITS_PER_DASH,
  KEY_LIMITS_UPDATE_CREDITS,
  KEY_REGISTER_CREDITS,
  KEY_RENEW_CREDITS,
  TYPICAL_WRITE_CREDITS,
  STEADY,
  type FirstWrite,
  creditsToDash,
  previewCreate,
  previewCredits,
  previewDelete,
  previewReplace,
  sumPreviews,
  type CostPreview,
} from './cost'
export {
  ascendingEquivalent,
  base64ToBytes,
  base64ToHex,
  bytesToBase64,
  countDocuments,
  hexToBase64,
  normalizeDocument,
  setPlatformVersion,
  queryAllDocuments,
  IncompleteReadError,
  queryDocuments,
  queryDocumentsWithProof,
  tieProbeAllowed,
  type DocumentQuery,
  type OrderByClause,
  type PlainDocument,
  type ProofedDocuments,
  type WhereClause,
  type WhereOperator,
} from './query'

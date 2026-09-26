/**
 * evo-sdk services — the browser Platform I/O layer.
 *
 * Trusted-mode connections (`testnetTrusted()` / `mainnetTrusted()` / a devnet's) + `*WithProof`
 * reads (the only WASM-viable path, S0.3), with the base64 byteArray operand encoding and the
 * complete, tie-safe paging that active-repo correctness depends on.
 */

export { ensureSdk, evoSdkService, type EvoSdkConfig } from './service'
export {
  ConsensusRefusal,
  DUPLICATE_UNIQUE_CODE,
  GATE_REFUSED_CODE,
  KEY_LIMIT_CODES,
  UnconfirmedWriteError,
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
  creditsToDash,
  previewCreate,
  previewCredits,
  previewDelete,
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

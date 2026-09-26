/**
 * evo-sdk services — the browser Platform I/O layer.
 *
 * `EvoSDK.testnetTrusted()` + `*WithProof` reads (the only WASM-viable path, S0.3), with
 * the base64 byteArray operand encoding, skip-scan ref enumeration, and the in-batch
 * completeness fallback (S0.8) that active-repo correctness depends on.
 */

export { evoSdkService, type EvoSdkConfig } from './service'
export {
  ConsensusRefusal,
  DUPLICATE_UNIQUE_CODE,
  KEY_LIMIT_CODES,
  REPO_CREATE_GATES,
  SECURITY_LEVEL,
  WriteAuthError,
  asConsensusRefusal,
  createDocumentIdempotent,
  isStaleDocumentIdError,
  measureActual,
  pendingWriteKey,
  createGateFor,
  deleteDocumentIdempotent,
  findSigningKey,
  isAlreadyExistsError,
  previewDocumentCreate,
  readIdentityBalance,
  type DeleteResult,
  type SpendEvent,
  type TokenGate,
  type WriteAuth,
  type WriteResult,
} from './write'
export {
  BASE_CREDITS,
  CREDITS_PER_DASH,
  CREDITS_PER_TEXT_BYTE,
  DELETE_CREDITS,
  TOKEN_ADMIN_CREDITS,
  creditsToDash,
  estimateCreateCredits,
  previewCreate,
  previewCredits,
  previewDelete,
  sumPreviews,
  textBytes,
  type CostPreview,
} from './cost'
export {
  GRANT_AMOUNT,
  ROLE_POSITION,
  grantRole,
  revokeRole,
  suspendRole,
  type Role,
} from './token-admin'
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
  skipScanDistinct,
  tieProbeAllowed,
  type DocumentQuery,
  type OrderByClause,
  type PlainDocument,
  type ProofedDocuments,
  type WhereClause,
  type WhereOperator,
} from './query'

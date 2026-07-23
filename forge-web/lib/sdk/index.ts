/**
 * evo-sdk services — the browser Platform I/O layer.
 *
 * `EvoSDK.testnetTrusted()` + `*WithProof` reads (the only WASM-viable path, S0.3), with
 * the base64 byteArray operand encoding, skip-scan ref enumeration, and the in-batch
 * completeness fallback (S0.8) that active-repo correctness depends on.
 */

export { evoSdkService, type EvoSdkConfig } from './service'
export {
  COST_ESTIMATE_CREDITS,
  CREDITS_PER_DASH,
  REPO_CREATE_GATES,
  SECURITY_LEVEL,
  WriteAuthError,
  createDocumentIdempotent,
  createGateFor,
  creditsToDash,
  deleteDocumentIdempotent,
  findSigningKey,
  isAlreadyExistsError,
  previewCredits,
  previewDocumentCreate,
  readIdentityBalance,
  type CostPreview,
  type TokenGate,
  type WriteAuth,
  type WriteResult,
} from './write'
export {
  GRANT_AMOUNT,
  ROLE_POSITION,
  grantRole,
  revokeRole,
  suspendRole,
  type Role,
} from './token-admin'
export {
  applySoloOwnerTokenRules,
  buildRepoV1Contract,
  createRepoContract,
  normalizeDocumentPositions,
  type CreateRepoContractResult,
  type JsonValue,
} from './contract-create'
export {
  base64ToBytes,
  base64ToHex,
  bytesToBase64,
  countDocuments,
  hexToBase64,
  inBatchAllPerKey,
  inBatchNewestPerKey,
  normalizeDocument,
  setPlatformVersion,
  queryDocuments,
  queryDocumentsWithProof,
  skipScanDistinct,
  type DocumentQuery,
  type OrderByClause,
  type PlainDocument,
  type ProofedDocuments,
  type WhereClause,
  type WhereOperator,
} from './query'

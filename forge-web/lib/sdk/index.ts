/**
 * evo-sdk services — the browser Platform I/O layer.
 *
 * `EvoSDK.testnetTrusted()` + `*WithProof` reads (the only WASM-viable path, S0.3), with
 * the base64 byteArray operand encoding, skip-scan ref enumeration, and the in-batch
 * completeness fallback (S0.8) that active-repo correctness depends on.
 */

export { evoSdkService, type EvoSdkConfig } from './service'
export {
  base64ToBytes,
  base64ToHex,
  bytesToBase64,
  countDocuments,
  hexToBase64,
  inBatchAllPerKey,
  inBatchNewestPerKey,
  normalizeDocument,
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

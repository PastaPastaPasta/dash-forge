/**
 * Write cost estimates — calibrated against measured forge-v2 costs on devnet moutai.
 *
 * evo-sdk 4.2 has no fee estimator for a document transition, so the preview is a model:
 * a per-type base (what the document costs with no text) plus the storage price of its text,
 * 27,500 credits per UTF-8 byte (the 27,000 credits/byte storage rate plus the processing that
 * grows with it). Both were fitted to balance deltas measured on moutai (protocol 14,
 * 2026-09-25): an issue with a 10-byte title cost 57.7M credits, with a 1,000-byte body 85.2M,
 * with 4,000 bytes 167.7M; comments 47.6M / 74.3M / 157.2M for 10 / 1,000 / 4,000 bytes.
 * The post-write actual (the balance change) is recorded next to each estimate in the spend
 * ledger, so drift shows up there (`ux-dx-spec.md` §4 rule 2).
 */

/** 1 DASH = 1e11 credits (parity with forge-core `credits_to_dash`). */
export const CREDITS_PER_DASH = 100_000_000_000

/** Measured marginal cost of one byte of document text (storage + the processing it adds). */
export const CREDITS_PER_TEXT_BYTE = 27_500

/**
 * What a document of each type costs with no text, in credits (moutai balance deltas, text
 * contribution subtracted). Types never measured fall back to {@link DEFAULT_BASE_CREDITS}.
 */
export const BASE_CREDITS: Readonly<Record<string, number>> = {
  // forge-core
  repo: 55_000_000,
  maintainer: 39_300_000,
  writer: 38_800_000,
  config: 34_000_000,
  release: 57_600_000,
  label: 45_000_000,
  refUpdate: 45_000_000,
  protectedRefUpdate: 45_000_000,
  // Not yet measured from the browser: forge-core's per-byte model (fixed shape plus the
  // storage of its byte fields, which `textBytes` does not count — see `estimateBytesCredits`).
  packManifest: 60_000_000,
  chunk: 20_000_000,
  // forge-collab
  issue: 57_400_000,
  patch: 112_000_000,
  comment: 47_300_000,
  event: 50_000_000,
  authorEvent: 56_600_000,
  review: 34_900_000,
  star: 27_800_000,
  follow: 38_400_000,
}

const DEFAULT_BASE_CREDITS = 50_000_000
/** A delete of a type never measured: a conservative refund estimate. */
const DEFAULT_DELETE_CREDITS = -20_000_000

/**
 * What deleting a document gives back, in credits (negative = a refund). Measured on moutai:
 * unstar +23.3M, unfollow +34.1M, revoking a writer +20.8M.
 */
export const DELETE_CREDITS: Readonly<Record<string, number>> = {
  star: -23_300_000,
  follow: -34_100_000,
  maintainer: -20_800_000,
  writer: -20_800_000,
  release: -30_000_000,
  label: -25_000_000,
  comment: -25_000_000,
  review: -20_000_000,
}

/**
 * An `IdentityKeyLimitsUpdate` (top up a key's budget / expiry), signed by the master key and
 * paid from the identity balance. Measured on moutai (2026-09-26): 2,267,600 credits.
 */
export const KEY_LIMITS_UPDATE_CREDITS = 2_300_000

/** A pre-sign cost preview for the confirm UI. */
export interface CostPreview {
  /** Estimated credits; negative when the action refunds storage. */
  readonly credits: number
  readonly dash: number
}

/** Credit → DASH (display). */
export function creditsToDash(credits: number): number {
  return credits / CREDITS_PER_DASH
}

/** A preview for a plain credit amount. */
export function previewCredits(credits: number): CostPreview {
  return { credits, dash: creditsToDash(credits) }
}

/** UTF-8 bytes of every string in `data` (the text a document stores beyond its fixed shape). */
export function textBytes(data: Readonly<Record<string, unknown>>): number {
  const encoder = new TextEncoder()
  let total = 0
  const walk = (v: unknown): void => {
    if (typeof v === 'string') total += encoder.encode(v).length
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) Object.values(v).forEach(walk)
  }
  walk(data)
  return total
}

/** Estimated credits to create one `documentType` document holding `data`. */
export function estimateCreateCredits(documentType: string, data: Readonly<Record<string, unknown>> = {}): number {
  return (BASE_CREDITS[documentType] ?? DEFAULT_BASE_CREDITS) + CREDITS_PER_TEXT_BYTE * textBytes(data)
}

/** Preview for creating one document. */
export function previewCreate(documentType: string, data: Readonly<Record<string, unknown>> = {}): CostPreview {
  return previewCredits(estimateCreateCredits(documentType, data))
}

/** Estimated credits for a document that also stores `byteLen` bytes of byte-array fields. */
export function estimateBytesCredits(documentType: string, byteLen: number, data: Readonly<Record<string, unknown>> = {}): number {
  return estimateCreateCredits(documentType, data) + CREDITS_PER_TEXT_BYTE * byteLen
}

/**
 * Estimated credits to store `bytes` as Platform `chunk` documents (three 4,900-byte fields
 * each, forge-core `pack::split`): every chunk's fixed cost plus the storage of its bytes.
 * Roughly 0.28 DASH per MiB — Platform storage is permanent.
 */
export function estimateChunkCredits(bytes: number): number {
  const chunks = Math.max(1, Math.ceil(bytes / (4900 * 3)))
  return chunks * (BASE_CREDITS['chunk'] ?? DEFAULT_BASE_CREDITS) + CREDITS_PER_TEXT_BYTE * bytes
}

/** Preview for deleting one document of `documentType` (usually a refund: negative credits). */
export function previewDelete(documentType: string): CostPreview {
  return previewCredits(DELETE_CREDITS[documentType] ?? DEFAULT_DELETE_CREDITS)
}

/** The sum of several previews (a repo creation is three documents). */
export function sumPreviews(parts: readonly CostPreview[]): CostPreview {
  return previewCredits(parts.reduce((s, p) => s + p.credits, 0))
}

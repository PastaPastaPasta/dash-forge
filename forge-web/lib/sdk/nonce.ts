const SEQUENCE_MASK = (1n << 40n) - 1n
const MAX_MISSING_REVISIONS = 24n

/** The sequence part of an identity-contract nonce Platform holds (the low 40 bits). */
export function nonceTip(current: bigint): bigint {
  return current & SEQUENCE_MASK
}

/**
 * Whether `nonce` can no longer be used, given the identity-contract nonce Platform holds
 * (`current`, raw: the low 40 bits are the sequence, the high 24 a bitmap of skipped ones).
 * Mirrors Drive's `validate_identity_nonce_update`: the tip itself, anything more than 24
 * behind it, and a skipped one that was since filled are spent.
 */
export function isNonceSpent(current: bigint, nonce: bigint): boolean {
  const tip = nonceTip(current)
  if (nonce > tip) return false
  if (nonce === tip) return true
  const behind = tip - nonce
  if (behind > MAX_MISSING_REVISIONS) return true
  // Bit 40 + (behind - 1) marks a skipped nonce that is still free.
  return (current & (1n << (behind + 39n))) === 0n
}

/** Whether `nonce` is further ahead of the tip than Drive accepts (more than 24). */
export function isNonceTooFar(current: bigint, nonce: bigint): boolean {
  return nonce > nonceTip(current) + MAX_MISSING_REVISIONS
}

/**
 * FORGE_RULES — the cross-client-parity heart of Dash Forge (TypeScript port).
 *
 * Dash Platform enforces the forge-v2 writer gates, schema, and uniqueness at consensus, but it has no
 * CAS, cannot read glob patterns, and cannot fold an append-only event log into "is this
 * issue open". Those decisions are made client-side, and every conforming client must
 * make them IDENTICALLY. This module is the TypeScript half of that shared logic; the
 * Rust half is `crates/forge-core/src/rules.rs`.
 *
 * Parity is held by the shared JSON conformance vectors in `forge-contracts/vectors/`.
 * `conformance.test.ts` runs all of them against this port; the Rust test at the bottom
 * of `rules.rs` runs them against the reference. Both must produce the same `expected`.
 *
 * Everything here is PURE: no SDK, no network, no funds, no clock. Callers fetch the
 * documents and hand them in as plain objects; the only clock is the consensus
 * `createdAt` carried on every document.
 */

export * from './types'
export { compareKey, compareStrings, isCheckRefFormat, isLegalRefName, isNullOid, isOidHex, isPlainBranchRef } from './oid'
export { matchesProtected, neutralizeWildmatch, wildmatch } from './matchesProtected'
export { displayRefName, mergeBaseTips, resolveRef } from './resolveRef'
export { overlayTree } from './overlay'
// FORGE_RULES_V2: the forge-v2 membership, event-fold, pack and numbering rules
export * as v2 from './v2'
export { FORGE_RULES_V2 } from './v2'

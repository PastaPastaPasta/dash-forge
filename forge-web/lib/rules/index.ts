/**
 * FORGE_RULES_V1 — the cross-client-parity heart of Dash Forge (TypeScript port).
 *
 * Dash Platform enforces token spend, schema, and uniqueness at consensus, but it has no
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

/** The versioned rules identifier shared with forge-core and the conformance vectors. */
export const FORGE_RULES_V1 = 'FORGE_RULES_V1' as const

export * from './types'
export { isLegalRefName, isNullOid } from './oid'
export { matchesProtected, neutralizeWildmatch, wildmatch } from './matchesProtected'
export { AuthzResolver, holdingsAny, holdingsAsOf } from './holdings'
export { resolveRef } from './resolveRef'
export { foldIssueState, foldPrState } from './fold'
export { overlayTree } from './overlay'

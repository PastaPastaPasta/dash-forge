/**
 * Token-history authorization (as-of-time).
 *
 * Ports `holdings_as_of` / `token_spendable_as_of` / `AuthzResolver` from
 * `crates/forge-core/src/rules.rs`. Reconstructs an identity's *spendable* WRITE/MAINTAIN
 * holdings at a point in time by replaying mint/freeze/unfreeze/destroy records with
 * `createdAt <= at`, tie-broken by `id`.
 */

import { compareKey } from './oid'
import type { Holdings, TokenKind, TokenRecord } from './types'

/** Whether the identity holds an unfrozen balance for either token (the "holder" gate). */
export function holdingsAny(h: Holdings): boolean {
  return h.write || h.maintain
}

/** Reconstruct an identity's spendable WRITE/MAINTAIN holdings as-of time `at`. */
export function holdingsAsOf(
  records: readonly TokenRecord[],
  identity: string,
  at: number,
): Holdings {
  return {
    write: tokenSpendableAsOf(records, identity, 'write', at),
    maintain: tokenSpendableAsOf(records, identity, 'maintain', at),
  }
}

function tokenSpendableAsOf(
  records: readonly TokenRecord[],
  identity: string,
  token: TokenKind,
  at: number,
): boolean {
  const relevant = records
    .filter((r) => r.identity === identity && r.token === token && r.createdAt <= at)
    .sort(compareKey)

  let held = false
  let frozen = false
  for (const r of relevant) {
    switch (r.op) {
      case 'mint':
        held = true
        frozen = false
        break
      case 'freeze':
        frozen = true
        break
      case 'unfreeze':
        frozen = false
        break
      case 'destroy':
        held = false
        frozen = false
        break
    }
  }
  return held && !frozen
}

/**
 * A token-history-backed authorization resolver. Thin wrapper over {@link holdingsAsOf}
 * so callers can thread one object through the fold instead of the record slice.
 */
export class AuthzResolver {
  constructor(private readonly records: readonly TokenRecord[]) {}

  holdingsAsOf(identity: string, at: number): Holdings {
    return holdingsAsOf(this.records, identity, at)
  }
}

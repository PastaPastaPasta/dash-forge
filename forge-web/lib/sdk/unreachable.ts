/**
 * Whether a failed read means Platform or storage could not be reached (a transport error, a
 * timeout, a node that is down or rate-limited, a stale connection), as opposed to an answer:
 * a proof or decode failure, or a contract the network does not have. Dependency-free, so UI
 * states can classify an error without loading the SDK service.
 */

import { isContractMissingError } from './contract-missing'
import { errorMessage } from '../utils'

const STALE = /quorum not found|no available addresses/i
/**
 * A proof signed by a quorum whose key the connection does not have: "Quorum not found in cache"
 * (the keys prefetched at connect), or "Quorum not found for type …" (a refetch that missed too).
 * Right after a rotation that is the network's quorum service lagging it (#212).
 */
const QUORUM_MISS = /quorum not found/i
const UNREACHABLE =
  /failed to fetch|fetch failed|networkerror|network error|load failed|timed out|timeout|deadline exceeded|\bunavailable\b|resourceexhausted|resource exhausted|transport error|connection (?:refused|reset)|HTTP 5\d\d|could not reach platform|can't reach platform|internet disconnected/i

/**
 * The connect could not fetch the quorum public keys: wasm-sdk's trusted context reports
 * "Failed to prefetch quorums: HTTP request error: error sending request" when
 * `quorums.<net>.networks.dash.org` (or the deployment's quorum URL) does not answer. The
 * connect never reached DAPI, so the failure is the key service's, not Platform's (QW-056).
 */
const QUORUM_SERVICE = /failed to prefetch quorums|fetching (?:current|previous) quorums/i
/**
 * An answer that failed its proof check: a proof whose GroveDB hashes do not chain up to the
 * signed root ("grovedb: invalid proof: V1 mismatch in lower layer hash, expected …, got …"),
 * or one the verifier rejected outright. The node answered; the data was wrong (QW-057).
 * "Invalid proof verification parameters" is this app asking wrongly, not a bad answer.
 */
const PROOF_FAILED = /\binvalid proof\b|\bgrovedb\b|proof verification (?:error|failed)|proof did not verify/i
const PROOF_MISUSE = /invalid proof verification parameters/i

/** The connect failed because the quorum key service did not answer (see {@link QUORUM_SERVICE}). */
export function isQuorumServiceError(e: unknown): boolean {
  return QUORUM_SERVICE.test(errorMessage(e, ''))
}

/** A read's answer failed its proof check (see {@link PROOF_FAILED}). */
export function isProofFailure(e: unknown): boolean {
  const message = errorMessage(e, '')
  return PROOF_FAILED.test(message) && !PROOF_MISUSE.test(message)
}

/** A read failed because its connection went stale, not because of what it asked. */
export function isStaleConnectionError(e: unknown): boolean {
  return STALE.test(errorMessage(e, ''))
}

/** A read failed on a proof signed by a quorum the connection has no key for (see {@link QUORUM_MISS}). */
export function isQuorumMiss(e: unknown): boolean {
  return QUORUM_MISS.test(errorMessage(e, ''))
}

/** A read failed because Platform (or the storage it named) could not be reached. */
export function isUnreachableError(e: unknown): boolean {
  if (isStaleConnectionError(e)) return true
  // Drive's "contract not found" arrives as a gRPC transport error, but it is an answer.
  if (isContractMissingError(e)) return false
  return UNREACHABLE.test(errorMessage(e, ''))
}

/**
 * Whether a failed read means Platform or storage could not be reached (a transport error, a
 * timeout, a node that is down or rate-limited, a stale connection), as opposed to an answer:
 * a proof or decode failure, or a contract the network does not have. Dependency-free, so UI
 * states can classify an error without loading the SDK service.
 */

import { isContractMissingError } from './contract-missing'
import { errorMessage } from '../utils'

const STALE = /quorum not found in cache|no available addresses/i
const UNREACHABLE =
  /failed to fetch|fetch failed|networkerror|network error|load failed|timed out|timeout|deadline exceeded|\bunavailable\b|resourceexhausted|resource exhausted|transport error|connection (?:refused|reset)|HTTP 5\d\d|could not reach platform|can't reach platform|internet disconnected/i

/** A read failed because its connection went stale, not because of what it asked. */
export function isStaleConnectionError(e: unknown): boolean {
  return STALE.test(errorMessage(e, ''))
}

/** A read failed because Platform (or the storage it named) could not be reached. */
export function isUnreachableError(e: unknown): boolean {
  if (isStaleConnectionError(e)) return true
  // Drive's "contract not found" arrives as a gRPC transport error, but it is an answer.
  if (isContractMissingError(e)) return false
  return UNREACHABLE.test(errorMessage(e, ''))
}

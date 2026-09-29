/**
 * "The contracts this build reads are not on the network": a devnet was reset, or a build names
 * contracts its network never had. Platform answers a read that names a missing contract with
 * an error, not an empty result, and a retry can never succeed.
 *
 * wasm-sdk 4.2.0-beta.6 gives this no code of its own. Drive's refusal reaches JS as a
 * `WasmSdkError` of kind `DapiClientError` with `code` -1, and its gRPC status
 * (InvalidArgument) is only in the message text. So the message is matched, in two forms:
 *   - Drive's `QuerySyntaxError::DataContractNotFound` ("contract not found error: contract not
 *     found when querying from value with contract info", or "… for a document query" from
 *     document query v1). A query built from a contract the SDK already holds (a bundled
 *     snapshot) gets this one;
 *   - wasm-sdk's own "Data contract not found" (kind `NotFound`), when the SDK fetched the
 *     contract first and the network proved it absent.
 */

import { errorMessage } from '../utils'

const CONTRACT_MISSING = /contract not found (?:error|when querying|for a document query)|\bdata contract not found\b/i

/** Whether `e` says the contract a read named does not exist on the network. */
export function isContractMissingError(e: unknown): boolean {
  return CONTRACT_MISSING.test(errorMessage(e, ''))
}

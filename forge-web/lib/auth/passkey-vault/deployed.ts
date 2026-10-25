/**
 * Whether the forge-meta Platform serves has the passkey vault's `vaultEntry` type. The type is an
 * additive update of forge-meta (`deploy-v2.mjs --update meta`): until it lands, a network has the
 * contract but no vault, and every passkey control stays hidden rather than fail on a read.
 *
 * The answer comes from a proved contract fetch, which bypasses the bundled snapshots (the
 * snapshot of a network moves with the update, but a stale build must not offer what Platform
 * does not have). A missing contract (`./sdk/contract-missing`) is "not deployed"; a failed read
 * is neither answer and throws.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { authSdk } from '../../sdk/facade'
import { isContractMissingError } from '../../sdk/contract-missing'

/** The document type the vault's entries are. */
export const VAULT_ENTRY_TYPE = 'vaultEntry'

/** The document types a fetched contract declares (the wasm contract's `schemas`, else its JSON). */
function documentTypesOf(contract: unknown): readonly string[] {
  const c = contract as { schemas?: unknown; toJSON?: () => { documentSchemas?: unknown } }
  const schemas = c.schemas ?? c.toJSON?.().documentSchemas
  return typeof schemas === 'object' && schemas !== null ? Object.keys(schemas) : []
}

/** Whether forge-meta (`metaId`, base58) declares `vaultEntry`. Throws when Platform cannot be read. */
export async function vaultEntryDeployed(sdk: EvoSDK, metaId: string): Promise<boolean> {
  let contract: unknown
  try {
    contract = await authSdk(sdk).contracts.fetch(metaId)
  } catch (e) {
    if (isContractMissingError(e)) return false
    throw e
  }
  return contract !== undefined && documentTypesOf(contract).includes(VAULT_ENTRY_TYPE)
}

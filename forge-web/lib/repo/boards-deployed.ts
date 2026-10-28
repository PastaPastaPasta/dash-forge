/**
 * Whether the forge-meta Platform serves has the board types (`docs/design/boards.md` §3:
 * `board` and `card`, UPDATE-3). They are an additive update of forge-meta (`deploy-v2.mjs
 * --update meta`): until it lands a network has the contract but no boards, and every board
 * control stays hidden (the Boards tab, the issue sidebar's section) rather than fail on a read.
 *
 * The answer costs no request on a repo page when the build's bundled snapshot of forge-meta
 * (`lib/sdk/contract-seed.ts`, what the SDK is seeded with) already declares both types: a
 * snapshot is a version Platform served, and an update can never remove a document type
 * (rs-dpp `data_contract/methods/validate_update/v0`: "document type can't be removed"), so the
 * live contract declares them too. (`contracts.fetch` is a `getDataContract` request, never the
 * cache: asking it on every cold repo page cost pb-1 a request.) Otherwise, as the passkey
 * vault's check (`lib/auth/passkey-vault/deployed.ts`), the answer is the contract the SDK
 * fetches (proved), so a build never offers what Platform does not have. A missing contract is
 * "not deployed"; a failed read is neither answer and throws (asked again next time).
 *
 * Answers are kept per forge-meta id for the session ({@link knownBoardsDeployed}), and pages
 * that must not wait for the SDK (the repo's shell header) follow them ({@link subscribeBoardsDeployed}).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { documentTypesOf } from '../auth/passkey-vault/deployed'
import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { loadContractSnapshots } from '../sdk/contract-seed'
import { authSdk } from '../sdk/facade'
import { isContractMissingError } from '../sdk/contract-missing'

/** The document types boards need. */
export const BOARD_TYPES: readonly string[] = ['board', 'card']

const known = new Map<string, boolean>()
const reading = new Map<string, Promise<boolean>>()
const listeners = new Set<() => void>()

/** The answer already read for forge-meta `metaId` this session, or undefined. */
export function knownBoardsDeployed(metaId: string | undefined): boolean | undefined {
  return metaId === undefined ? false : known.get(metaId)
}

/** Be told when an answer is read; returns the unsubscribe. */
export function subscribeBoardsDeployed(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether a fetched contract declares every board type. */
export function declaresBoards(contract: unknown): boolean {
  const types = documentTypesOf(contract)
  return BOARD_TYPES.every((t) => types.includes(t))
}

/**
 * The document types the build's bundled snapshot of contract `id` declares (none without one,
 * or when it cannot be decoded): the network's own snapshot file, as the SDK is seeded.
 */
export async function bundledContractTypes(id: string): Promise<readonly string[]> {
  try {
    const snapshot = (await loadContractSnapshots(NETWORKS[DEFAULT_NETWORK].key))[id]
    if (snapshot === undefined) return []
    const evo = await import('@dashevo/evo-sdk')
    // Loaded already once the SDK is connected (as the seed it decodes alike, `lib/sdk/service.ts`).
    await evo.ensureInitialized()
    return documentTypesOf(evo.DataContract.fromBase64(snapshot.bytes, false, snapshot.platformVersion))
  } catch {
    return []
  }
}

/**
 * Whether forge-meta (`metaId`, base58; undefined on a three-contract set) declares `board` and
 * `card`: the bundled snapshot's answer when it says yes, else the fetched contract's. Throws
 * when Platform cannot be read. `bundled` is the snapshot reader (tests replace it).
 */
export function boardsDeployed(sdk: EvoSDK, metaId: string | undefined, bundled: (id: string) => Promise<readonly string[]> = bundledContractTypes): Promise<boolean> {
  if (metaId === undefined) return Promise.resolve(false)
  const held = known.get(metaId)
  if (held !== undefined) return Promise.resolve(held)
  let p = reading.get(metaId)
  if (p === undefined) {
    p = (async () => {
      const types = await bundled(metaId)
      let yes = BOARD_TYPES.every((t) => types.includes(t))
      if (!yes) {
        let contract: unknown
        try {
          contract = await authSdk(sdk).contracts.fetch(metaId)
        } catch (e) {
          if (!isContractMissingError(e)) throw e
          contract = undefined
        }
        yes = contract !== undefined && declaresBoards(contract)
      }
      known.set(metaId, yes)
      for (const l of listeners) l()
      return yes
    })().finally(() => reading.delete(metaId))
    reading.set(metaId, p)
  }
  return p
}

/** Forget every answer (tests). */
export function resetBoardsDeployed(): void {
  known.clear()
  reading.clear()
}

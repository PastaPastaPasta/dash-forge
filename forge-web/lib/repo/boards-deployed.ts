/**
 * Whether the forge-meta Platform serves has the board types (`docs/design/boards.md` §3:
 * `board` and `card`, UPDATE-3). They are an additive update of forge-meta (`deploy-v2.mjs
 * --update meta`): until it lands a network has the contract but no boards, and every board
 * control stays hidden (the Boards tab, the issue sidebar's section) rather than fail on a read.
 *
 * As the passkey vault's check (`lib/auth/passkey-vault/deployed.ts`), the answer is the
 * contract the SDK fetches (proved), so a build never offers what Platform does not have. The
 * SDK serves forge-meta from its contract cache (the bundled snapshot or the connect's preload),
 * so the check costs no request on a repo page; a snapshot older than the update answers "not
 * deployed" until the SDK drops it for a newer contract version. A missing contract is "not
 * deployed"; a failed read is neither answer and throws (asked again next time).
 *
 * Answers are kept per forge-meta id for the session ({@link knownBoardsDeployed}), and pages
 * that must not wait for the SDK (the repo's shell header) follow them ({@link subscribeBoardsDeployed}).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { documentTypesOf } from '../auth/passkey-vault/deployed'
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

/** Whether forge-meta (`metaId`, base58; undefined on a three-contract set) declares `board` and `card`. Throws when Platform cannot be read. */
export function boardsDeployed(sdk: EvoSDK, metaId: string | undefined): Promise<boolean> {
  if (metaId === undefined) return Promise.resolve(false)
  const held = known.get(metaId)
  if (held !== undefined) return Promise.resolve(held)
  let p = reading.get(metaId)
  if (p === undefined) {
    p = (async () => {
      let contract: unknown
      try {
        contract = await authSdk(sdk).contracts.fetch(metaId)
      } catch (e) {
        if (!isContractMissingError(e)) throw e
        contract = undefined
      }
      const yes = contract !== undefined && declaresBoards(contract)
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

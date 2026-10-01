/**
 * Which star shape the deployment's forge-community has (RC2 C1, decided at registration by a
 * fee probe, so a client handles both until then):
 *
 * - `'beat'` (RC1): a `star` keeps no `$createdAt`; Trending ranks a separate, optional
 *   `starBeat` (public repos of others only, one per identity and repo, ever);
 * - `'fused'` (C1): the `star` itself requires `$createdAt` and carries Trending's weekly window
 *   index (`byWeek`, `outlivesDelete`, Platform v5), and there is no `starBeat`. Every star then
 *   counts toward Trending; there is no opt-out, and an unstar leaves its window entry.
 *
 * Read from the contract itself (seeded or fetched once), not from a build flag, so a build
 * reads whichever contract the deployment registered.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ForgeIds } from '../deployments'
import { DOC } from './contract'

export type StarShape = 'beat' | 'fused'

const shapes = new Map<string, Promise<StarShape>>()

/** The star shape of `forge.community`, read once per contract id (a failed read is retried next call). */
export function starShape(sdk: EvoSDK, forge: ForgeIds): Promise<StarShape> {
  const cached = shapes.get(forge.community)
  if (cached) return cached
  const read = (async (): Promise<StarShape> => {
    const contract = await sdk.contracts.fetch(forge.community)
    if (!contract) throw new Error(`forge-community ${forge.community} was not found`)
    return DOC.starBeat in contract.schemas ? 'beat' : 'fused'
  })()
  shapes.set(forge.community, read)
  read.catch(() => shapes.delete(forge.community))
  return read
}

/** Forget every cached shape (tests). */
export function resetStarShapes(): void {
  shapes.clear()
}

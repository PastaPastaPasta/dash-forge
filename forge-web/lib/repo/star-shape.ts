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
 *
 * What a fused star gives up (the owner's C1 trade-off, PLAN.md §2): the Trending opt-out, and
 * RC1's beat rules (O-08: one per identity and repo, ever; public repos of others only) as
 * consensus rules. Readers apply the second instead (`fusedTrending` in `trending.ts`). Its
 * window entry outlives an unstar, so an unstarred repo keeps the star's count in the windows
 * it was in until they pass; a star again inside one of them writes over that entry and counts
 * once (v5 `book/src/contract-keywords/index-only.md:197-218`,
 * `book/src/drive/index-only-document-types.md:336-342`). An unstar carries no `$createdAt`
 * (rs-dpp `document_index_only_delete_transition/v0/from_document.rs:33-51`).
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
    // Fused when the star itself carries a time-window index (C1's `byWeek`), whether or not a
    // `starBeat` type is still declared.
    const star = contract.schemas[DOC.star] as { indices?: ReadonlyArray<{ timeRange?: unknown }> } | undefined
    return star?.indices?.some((index) => index.timeRange !== undefined) ? 'fused' : 'beat'
  })()
  shapes.set(forge.community, read)
  read.catch(() => shapes.delete(forge.community))
  return read
}

/** How a star click is priced and labelled. */
export interface StarTerms {
  /** The click also writes a Trending beat (a beat-shaped contract, with Trending on). */
  readonly beats: boolean
  /** The price includes a beat: written, or the upper bound of a shape not yet known. */
  readonly priceBeat: boolean
  /** Appended to the button's price ('' when nothing is promised). */
  readonly trendingNote: string
}

/**
 * The star's terms for `shape` (null while it is read, or when the read failed), the viewer's
 * Trending preference, and whether a beat is allowed on this repo for this viewer. An unknown
 * shape is priced as the larger one and promises nothing about Trending, so a signed-out
 * viewer is never told to turn off something the network has no switch for.
 */
export function starTerms(shape: StarShape | null, trending: boolean, beatAllowedHere: boolean): StarTerms {
  const beats = shape === 'beat' && trending && beatAllowedHere
  const trendingNote = shape === 'fused' ? ' · counts toward Trending' : beats ? ' · counts toward Trending (turn off in Settings)' : ''
  return { beats, priceBeat: beats || shape !== 'beat', trendingNote }
}

/** Forget every cached shape (tests). */
export function resetStarShapes(): void {
  shapes.clear()
}

/**
 * The `identicon` avatar (`profile.avatarConfig`, `lib/rules/profile.ts`): a 5×5 pattern,
 * mirrored left to right, drawn here from SHA-256 of its seed. Nothing is fetched: the same
 * seed draws the same pattern in every browser.
 *
 * The colour is {@link avatarFill} of a hue from the hash, so the cells keep the AA contrast
 * the initial avatars have against a light tile.
 */

import { sha256 } from '@noble/hashes/sha2.js'

import { avatarFill } from './avatar'

/** Cells per side. */
export const IDENTICON_SIZE = 5

/** The pattern `seed` draws: rows of cells, `true` filled. Never all empty. */
export function identiconCells(seed: string): boolean[][] {
  const h = sha256(new TextEncoder().encode(seed))
  const bit = (i: number): boolean => (((h[2 + (i >> 3)] as number) >> (i & 7)) & 1) === 1
  const half = Math.ceil(IDENTICON_SIZE / 2)
  const rows: boolean[][] = []
  for (let r = 0; r < IDENTICON_SIZE; r++) {
    const left = Array.from({ length: half }, (_, c) => bit(r * half + c))
    rows.push([...left, ...left.slice(0, IDENTICON_SIZE - half).reverse()])
  }
  if (!rows.some((row) => row.some(Boolean))) for (const row of rows) row[half - 1] = true
  return rows
}

/** The pattern's colour: a hue from the hash, at the initial avatars' AA lightness. */
export function identiconFill(seed: string): string {
  const h = sha256(new TextEncoder().encode(seed))
  return avatarFill((((h[0] as number) << 8) | (h[1] as number)) % 360)
}

/**
 * The members-only object locator (`packManifest.kind == 65`, mixed-visibility DESIGN §4.3
 * "Packs (D22)", `docs/security/private-repos.md` §19.5): the browse index of ONE members-only
 * git pack (kind 64), so a member's browser range-reads that pack's objects instead of fetching
 * and indexing it whole. Port of forge-core `pack::members_index`.
 *
 * A sealed kind carries no `tips`, and one members-only branch's pack is never another's, so the
 * artifact names the pack it indexes inside its sealed plaintext:
 *
 * ```text
 * plaintext = "DFML" ‖ version 0x01 ‖ packHash(32, the kind-64 pack's) ‖ objectLocator
 * ```
 *
 * The `objectLocator` is the kind-1 layout (`./locator`) with every row at `packRef` 0, the pack
 * named in the header. Who may be trusted for it (the pack's own uploader, every object of the
 * pack) is the reader's rule (`lib/view/members-browse.ts`).
 */

import { bytesToHex } from '@noble/hashes/utils.js'

import { FANOUT_LEN, ObjectLocator, fanoutCount, wellFormedSlice } from './locator'

/** `"DFML"`. */
export const MEMBERS_INDEX_MAGIC = new Uint8Array([0x44, 0x46, 0x4d, 0x4c])
/** The layout version this client writes and reads. */
export const MEMBERS_INDEX_VERSION = 0x01
/** Magic, version and the pack hash. */
export const MEMBERS_INDEX_HEADER_LEN = 4 + 1 + 32

/** A parsed members-only index: the pack it indexes and its rows, all at `packRef` 0. */
export interface MembersIndexPlain {
  /** The `packHash` of the kind-64 pack it indexes, lowercase hex. */
  readonly packHash: string
  readonly locator: ObjectLocator
}

/** Whether every row of `locator` is at `packRef` 0 (an empty locator's are). */
function onePack(locator: ObjectLocator): boolean {
  return [...locator.packRefsCovered()].every((r) => r === 0)
}

/**
 * The plaintext of the members-only index of pack `packHash` (32 bytes), `locator` built at
 * `packRef` 0. Throws for a locator with a row at another `packRef`. Parity: forge-core
 * `members_index::encode`.
 */
export function encodeMembersIndex(packHash: Uint8Array, locator: ObjectLocator): Uint8Array {
  if (packHash.length !== 32) throw new Error('members-only index: a packHash is 32 bytes')
  if (!onePack(locator)) throw new Error('a members-only index covers one pack: every row is at packRef 0')
  const rows = locator.asBytes()
  const out = new Uint8Array(MEMBERS_INDEX_HEADER_LEN + rows.length)
  out.set(MEMBERS_INDEX_MAGIC, 0)
  out[4] = MEMBERS_INDEX_VERSION
  out.set(packHash, 5)
  out.set(rows, MEMBERS_INDEX_HEADER_LEN)
  return out
}

/**
 * Parse a members-only index's plaintext. Null for a later layout version (skipped, as a later
 * envelope is, never fatal); throws for anything malformed: another magic, a short header, a
 * locator that does not parse (a fanout that is not cumulative, a row outside its bucket or out
 * of order, a length the fanout does not describe), or a row at a `packRef` other than 0.
 * Parity: forge-core `members_index::parse` (with `ObjectLocator::parse`'s checks).
 */
export function parseMembersIndex(bytes: Uint8Array): MembersIndexPlain | null {
  const bad = (what: string) => new Error(`members-only index: ${what}`)
  if (bytes.length < MEMBERS_INDEX_HEADER_LEN || MEMBERS_INDEX_MAGIC.some((b, i) => bytes[i] !== b)) {
    throw bad('not a members-only index')
  }
  if (bytes[4] !== MEMBERS_INDEX_VERSION) return null
  const rows = bytes.subarray(MEMBERS_INDEX_HEADER_LEN)
  if (rows.length < FANOUT_LEN || fanoutCount(rows.subarray(0, FANOUT_LEN)) === null) throw bad('the fanout is not cumulative')
  const locator = ObjectLocator.parse(rows)
  for (let b = 0; b < 256; b++) {
    if (!wellFormedSlice(locator.bucketRows(b), b)) throw bad('a row is outside its bucket or out of order')
  }
  if (!onePack(locator)) throw bad('a row is not at packRef 0')
  return { packHash: bytesToHex(bytes.subarray(5, MEMBERS_INDEX_HEADER_LEN)), locator }
}

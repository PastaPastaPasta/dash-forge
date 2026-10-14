/**
 * The mainnet fields clients write and read (mixed-visibility DESIGN §4.11, §8.3 items 1, 4, 6, 9
 * and 10; phase M-B part 2): `aud` and `mRole` on issues, PRs, comments and reviews, `tAud` on
 * events and author events, and the `r` of a maintainer-only pack manifest.
 *
 * Every field is written only where the loaded contract declares it (feature detection,
 * {@link AudShape}): sakura's three-contract set declares none, so a client writes the same
 * documents there as before. Pure; the `aud__*` vectors (`tools/private-repos-vectors/aud.py`)
 * judge both shapes. Parity: forge-core `rules::aud`.
 */

import { WRITER_ROLE_CODE } from './roles'
import type { Role } from './v2'

/** What the loaded contracts declare of the mainnet fields (the vectors' `input.shape`). */
export interface AudShape {
  /** The content type declares `aud` (L1). */
  readonly aud?: boolean
  /** The content type declares `mRole` (L2). */
  readonly mRole?: boolean
  /** `event` / `authorEvent` declares `tAud` (M4, M3). */
  readonly tAud?: boolean
  /** `authorEvent` declares `enc` (M3). */
  readonly authorEnc?: boolean
  /** `packManifest.r` admits 0 (C3). */
  readonly maintKinds?: boolean
}

/** The `aud` of members-only content (`enc` v0x01, v0x03, v0x05). */
export const AUD_MEMBERS = 1
/** The `aud` of a message to specific people (`enc` v0x04). */
export const AUD_LETTER = 2

/**
 * The pack-manifest kinds only a maintainer writes on mainnet (C3): a make-public bundle (7), an
 * environment snapshot (8), the reserved kind 9 and an access notice (11).
 */
export const MAINTAINER_KINDS: readonly number[] = [7, 8, 9, 11]

/**
 * The `aud` an `enc` of `version` states, or null for a version no content document carries (a
 * config's 0x02, a narrower branch's 0x06, anything unknown).
 */
export function audOfVersion(version: number): number | null {
  if (version === 0x01 || version === 0x03 || version === 0x05) return AUD_MEMBERS
  return version === 0x04 ? AUD_LETTER : null
}

/** The `aud` and `mRole` a content write carries (the vectors' `content` op). null = absent: left out of a create, removed by a replace. */
export interface ContentFields {
  readonly aud: number | null
  readonly mRole: number | null
}

/** Why a content write's fields cannot be stated: its `enc` is of a version no content document carries. Refused before signing. */
export type ContentRefusal = 'unknownEnc'

/**
 * The `aud` and `mRole` an issue, PR, comment or review carries, from the document as it will be
 * stored (a replace's changes applied): `encVersion` its `enc`'s first byte, `asMember` whether it
 * carries `asMember`, and `role` the signer's current role. `aud` follows the version byte and is
 * absent exactly when `enc` is (the author's replace may only drop it); `mRole` restates the
 * signer's `writer` row role whenever the document carries `asMember`, and a maintainer, whose
 * operand checks no role, leaves it out.
 */
export function contentFields(shape: AudShape, encVersion: number | null, asMember: boolean, role: Role | null): ContentFields | { readonly error: ContentRefusal } {
  const aud = encVersion === null ? null : audOfVersion(encVersion)
  if (encVersion !== null && aud === null) return { error: 'unknownEnc' }
  return {
    aud: shape.aud === true ? aud : null,
    mRole: shape.mRole === true && asMember && role !== null && role !== 'maintainer' ? WRITER_ROLE_CODE[role] : null,
  }
}

/**
 * Whether a stored document's `aud` agrees with its `enc` (the vectors' `read` op). A document
 * without `aud` is judged by `enc` alone (sakura's, or written before the registration); `aud`
 * without `enc`, outside 1..2, or naming the other class than `enc`'s version is malformed, and
 * readers show the document as a placeholder, never as text.
 */
export function audAgrees(aud: number | null, encVersion: number | null): boolean {
  if (aud === null) return true
  if (encVersion === null) return false
  return audOfVersion(encVersion) === aud
}

/**
 * {@link audAgrees} on a stored document's raw `aud` and `enc` (as the SDK hands them: `aud` a
 * number or absent, `enc` bytes). A present `aud` that is no integer disagrees.
 */
export function storedAudAgrees(aud: unknown, enc: Uint8Array | null | undefined): boolean {
  if (aud === undefined || aud === null) return true
  const n = typeof aud === 'bigint' ? Number(aud) : aud
  if (typeof n !== 'number' || !Number.isInteger(n)) return false
  return audAgrees(n, enc != null && enc.length > 0 ? (enc[0] as number) : null)
}

/** An `event`'s or `authorEvent`'s target, as {@link eventFields} reads it. */
export interface EventTarget {
  /** The target's stored `aud`. */
  readonly aud?: number | null
  /** Its `enc`'s version byte, when it has one. */
  readonly enc?: number | null
  /** A maintainer's bundle made its current revision public. */
  readonly bundled?: boolean
}

/**
 * What happens to an event's `value`: none, plaintext (a public target), encrypted under the
 * members key as its target is, or refused before signing (a letter target, whose people an event
 * does not carry; an author event's value on a members-only target where `authorEvent` has no `enc`).
 */
export type EventValue = 'none' | 'plain' | 'sealed' | 'refused'

/** The `tAud` and the value's treatment of an event (the vectors' `event` op). */
export interface EventFields {
  readonly tAud: number | null
  readonly value: EventValue
}

/**
 * The `tAud` an event (`author` for an `authorEvent`) on `target` carries, and what happens to its
 * value (`hasValue`). `tAud` is the target's stored `aud` (an absent `aud` and an absent `tAud`
 * agree); a value is plaintext on a public target, encrypted on a members-only one (on mainnet
 * also after a maintainer's bundle, whose target keeps `aud = 1`), and refused on a letter; an
 * author event is encrypted only where `authorEvent` declares `enc`.
 */
export function eventFields(shape: AudShape, author: boolean, target: EventTarget, hasValue: boolean): EventFields {
  const aud = target.aud ?? null
  const enc = target.enc ?? null
  const tAud = shape.tAud === true ? aud : null
  const sealedTarget = enc !== null || aud !== null
  const letter = aud === AUD_LETTER || enc === 0x04
  let value: EventValue
  if (!hasValue) value = 'none'
  else if (!sealedTarget || (target.bundled === true && tAud === null)) value = 'plain'
  else if (letter || (author && shape.authorEnc !== true)) value = 'refused'
  else value = 'sealed'
  return { tAud, value }
}

/**
 * The `r` a pack manifest of `kind` claims (the vectors' `manifestR` op): 0 for a maintainer-only
 * kind where the contract admits it (only the maintainer operand passes `r = 0`), else `claimed`.
 */
export function manifestR(shape: AudShape, kind: number, claimed: number): number {
  return shape.maintKinds === true && MAINTAINER_KINDS.includes(kind) ? 0 : claimed
}

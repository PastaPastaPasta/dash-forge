/**
 * Make-public bundles: the plaintext artifact of a `packManifest` of kind 7
 * (`docs/security/private-repos.md` §17.6, §18.3; forge-core `private::bundle`). A bundle lists
 * keys that make sealed content readable to everyone:
 *
 * ```text
 * bundle = "DFRV" ‖ 0x01 ‖ count(u16) ‖ count × entry ‖ note (UTF-8, at most 1 KiB, may be empty)
 * entry  = type(u8) ‖ target(32) ‖ revision(u32) ‖ key(32)                                  (69 B)
 * ```
 *
 * Integers are big-endian. Entry types: 0x01 comment, 0x02 issue, 0x03 review, 0x04 patch (a
 * document's per-object key at `revision`), **0x06 an epoch key** (`target` = the repository id,
 * `revision` = the epoch, `key` = `K_e`, written by the owner of a repository made public), and
 * 0x40 a sealed artifact (`target` = its `packHash`, `revision` 0). Readers skip entry types they
 * do not know.
 */

import { bytes, concat, u16, u32, utf8, type Bytes } from './bytes'
import { MalformedError } from './tlv'

const MAGIC = [0x44, 0x46, 0x52, 0x56] // "DFRV"
/** The bundle layout version. */
export const BUNDLE_VERSION = 0x01
/** Magic, version and count. */
export const BUNDLE_HEADER_LEN = 7
/** One entry. */
export const BUNDLE_ENTRY_LEN = 69
/** The longest note, in bytes. */
export const MAX_BUNDLE_NOTE = 1024
/** Entry type: an epoch key of a repository made public (§18.3). */
export const ENTRY_EPOCH_KEY = 0x06

/** One bundle entry. */
export interface BundleEntry {
  /** The entry type. */
  readonly kind: number
  /** A document `$id`, a `packHash`, or (type 0x06) the repository id. */
  readonly target: Uint8Array
  /** A document revision, or (type 0x06) the epoch. */
  readonly revision: number
  /** The key it publishes. */
  readonly key: Uint8Array
}

/** A parsed bundle. */
export interface Bundle {
  readonly entries: readonly BundleEntry[]
  /** The writer's note. */
  readonly note: string
}

/**
 * Parse a bundle's bytes: magic, version, `count` entries that fit, then a UTF-8 note of at most
 * {@link MAX_BUNDLE_NOTE} bytes. Anything else throws {@link MalformedError} (the whole bundle is
 * ignored).
 */
export function parseBundle(raw: Uint8Array): Bundle {
  if (raw.length < BUNDLE_HEADER_LEN || MAGIC.some((b, i) => raw[i] !== b) || raw[4] !== BUNDLE_VERSION) {
    throw new MalformedError('not a make-public bundle')
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const end = BUNDLE_HEADER_LEN + view.getUint16(5) * BUNDLE_ENTRY_LEN
  if (end > raw.length) throw new MalformedError('a bundle entry past the end')
  if (raw.length - end > MAX_BUNDLE_NOTE) throw new MalformedError('a bundle note over 1 KiB')
  let note: string
  try {
    note = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.subarray(end))
  } catch {
    throw new MalformedError('a bundle note that is not UTF-8')
  }
  const entries: BundleEntry[] = []
  for (let o = BUNDLE_HEADER_LEN; o < end; o += BUNDLE_ENTRY_LEN) {
    entries.push({
      kind: raw[o] as number,
      target: bytes(raw.slice(o + 1, o + 33)),
      revision: view.getUint32(o + 33),
      key: bytes(raw.slice(o + 37, o + 69)),
    })
  }
  return { entries, note }
}

/**
 * The bytes of a bundle of `entries` with `note`. Throws {@link MalformedError} for more than
 * 65535 entries, a note over {@link MAX_BUNDLE_NOTE} bytes, or an entry of the wrong lengths.
 */
export function encodeBundle(entries: readonly BundleEntry[], note: string): Bytes {
  const n = utf8(note)
  if (entries.length > 0xffff) throw new MalformedError('over 65535 bundle entries')
  if (n.length > MAX_BUNDLE_NOTE) throw new MalformedError('a bundle note over 1 KiB')
  const parts: Uint8Array[] = [new Uint8Array([...MAGIC, BUNDLE_VERSION]), u16(entries.length)]
  for (const e of entries) {
    if (e.target.length !== 32 || e.key.length !== 32) throw new MalformedError('a bundle entry is 69 bytes')
    parts.push(new Uint8Array([e.kind]), e.target, u32(e.revision), e.key)
  }
  return concat(...parts, n)
}

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
 * Integers are big-endian. Entry types: **0x01 comment, 0x02 issue, 0x03 review** (a document
 * revision's per-object key `K_obj` at `revision`: a maintainer's bundle, DESIGN §4.6), 0x04 patch
 * (reserved for members-only PRs, phase 3), **0x06 an epoch key** (`target` = the repository id,
 * `revision` = the epoch, `key` = `K_e`, written by the owner of a repository made public), and
 * 0x40 a sealed artifact (`target` = its `packHash`, `revision` 0). Readers skip entry types they
 * do not know.
 *
 * **Maintainer bundles** ({@link docEntries}, {@link readRevision}): readers honour a document
 * entry only in a public repository, only from a current maintainer (the repository's owner
 * included; anyone else's bundle is ignored, and consensus refuses it on mainnet, C3), and only
 * when its key commits to the document revision it names: `K_obj` is bound to the document's AD,
 * so it opens that revision and nothing else, and a key that does not commit is a lying entry,
 * raised as an alert and ignored. forge-core `private::bundle`; the `make_public__bundle_*`
 * vectors hold the two stacks equal.
 */

import { bytes, bytesToHex, concat, u16, u32, utf8, type Bytes } from './bytes'
import type { PublishedBundle } from './convert'
import { V3, V4, V5, openMembersWithKey, type PrivateDoc } from './doc'
import { IdSet, type PrivateId } from './ids'
import { openLetterWithKey } from './named'
import { MalformedError, type DocFields, type PrivateDocType } from './tlv'

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
/** Entry type: a comment revision's `K_obj`. */
export const ENTRY_COMMENT = 0x01
/** Entry type: an issue revision's `K_obj`. */
export const ENTRY_ISSUE = 0x02
/** Entry type: a review's `K_obj`. */
export const ENTRY_REVIEW = 0x03
/**
 * The most document entries one maintainer's bundle carries (a whole thread with its edit
 * history; about 200 fit one Platform chunk).
 */
export const MAX_DOC_ENTRIES = 1000

/** The entry type of a `type` document revision, for the kinds a bundle publishes; null otherwise. */
export function entryKind(type: PrivateDocType): number | null {
  switch (type) {
    case 'comment':
      return ENTRY_COMMENT
    case 'issue':
      return ENTRY_ISSUE
    case 'review':
      return ENTRY_REVIEW
    default:
      return null
  }
}

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

/** One document entry a reader honours: the maintainer who published it, the revision and its key. */
export interface DocEntry {
  /** The bundle's author (its manifest's `$ownerId`), a current maintainer or the repository's owner. */
  readonly by: PrivateId
  /** The document revision (`$revision`) it publishes. */
  readonly revision: number
  /** `K_obj` of that revision. */
  readonly key: Uint8Array
}

/** The document entries of a repository's make-public bundles that readers honour, by entry type and document id. */
export interface DocEntries {
  /** How many document entries are honoured. */
  readonly size: number
  /** The honoured entries of the `type` document `id`, in bundle and entry order. */
  ofDoc(type: PrivateDocType, id: Uint8Array): readonly DocEntry[]
}

/**
 * The honoured document entries of `bundles` (forge-core `DocEntries::of`): none in a private
 * repository (`isPublic` false); else every entry of a comment, issue or review in a bundle that
 * parses, written by one of `maintainers` (the repository's owner and its current maintainers).
 */
export function docEntries(isPublic: boolean, maintainers: Iterable<PrivateId>, bundles: readonly PublishedBundle[]): DocEntries {
  const byTarget = new Map<string, DocEntry[]>()
  if (isPublic) {
    const honoured = new IdSet(maintainers)
    for (const b of bundles) {
      if (!honoured.has(b.owner)) continue
      let parsed: Bundle
      try {
        parsed = parseBundle(b.bytes)
      } catch {
        continue
      }
      for (const e of parsed.entries) {
        if (e.kind !== ENTRY_COMMENT && e.kind !== ENTRY_ISSUE && e.kind !== ENTRY_REVIEW) continue
        const k = `${e.kind}:${bytesToHex(e.target)}`
        const list = byTarget.get(k)
        const entry: DocEntry = { by: b.owner, revision: e.revision, key: e.key }
        if (list === undefined) byTarget.set(k, [entry])
        else list.push(entry)
      }
    }
  }
  let size = 0
  for (const list of byTarget.values()) size += list.length
  return {
    size,
    ofDoc(type, id) {
      const kind = entryKind(type)
      return kind === null ? [] : (byTarget.get(`${kind}:${bytesToHex(id)}`) ?? [])
    },
  }
}

/** What the honoured entries do to one revision of a sealed document. */
export type BundleRead =
  /** It is public: an entry's key opened it. */
  | { readonly state: 'public'; readonly by: PrivateId; readonly fields: DocFields }
  /**
   * No entry opens this revision, but `by` published an earlier one (`publishedRevision`): its
   * author sealed it again after it was made public (DESIGN §4.6, "edited after it was made
   * public").
   */
  | { readonly state: 'editedAfter'; readonly by: PrivateId; readonly publishedRevision: number }
  /** No entry names it. */
  | { readonly state: 'none' }

/** A bundle entry whose key does not commit to the revision it names: a lying entry, ignored. */
export interface EntryMismatch {
  /** The bundle's author. */
  readonly by: PrivateId
  /** The revision it named. */
  readonly revision: number
}

/**
 * Open revision `revision` of the sealed document `doc` (with `enc`) of repository `repoId`
 * through its honoured `entries` ({@link DocEntries.ofDoc}; forge-core `bundle::read_revision`):
 * the first entry naming this revision whose key commits and opens it makes it `public`; an entry
 * whose key does not commit is an {@link EntryMismatch} and is ignored, as is one whose key commits
 * to a document that does not open (it is malformed whatever the key). Members-only (`enc` v0x03,
 * and a bot's post, v0x05) and letter (`enc` v0x04) documents both open this way. With none, the newest earlier revision an
 * entry names makes it `editedAfter`.
 */
export async function readRevision(
  repoId: Uint8Array,
  doc: PrivateDoc,
  revision: number,
  enc: Uint8Array,
  entries: readonly DocEntry[],
): Promise<{ readonly read: BundleRead; readonly alerts: readonly EntryMismatch[] }> {
  const alerts: EntryMismatch[] = []
  for (const e of entries) {
    if (e.revision !== revision) continue
    const opened =
      enc[0] === V3 || enc[0] === V5
        ? await openMembersWithKey(repoId, doc, enc, e.key)
        : enc[0] === V4
          ? await openLetterWithKey(repoId, doc, enc, e.key)
          : null
    if (opened?.status === 'readable') return { read: { state: 'public', by: e.by, fields: opened.fields }, alerts }
    if (opened?.status === 'unreadable' && opened.reason === 'commitMismatch') alerts.push({ by: e.by, revision })
  }
  // the newest earlier revision; among equals the last entry, as Rust's `max_by_key` picks
  let earlier: DocEntry | undefined
  for (const e of entries) if (e.revision < revision && (earlier === undefined || e.revision >= earlier.revision)) earlier = e
  return { read: earlier === undefined ? { state: 'none' } : { state: 'editedAfter', by: earlier.by, publishedRevision: earlier.revision }, alerts }
}

/** One entry of a maintainer's bundle: a document revision and its `K_obj`. */
export interface DocBundleEntry {
  readonly kind: number
  /** The document `$id`. */
  readonly target: Uint8Array
  /** Its `$revision`. */
  readonly revision: number
  readonly key: Uint8Array
}

/**
 * The bytes of a maintainer's bundle publishing `entries`, with no note (forge-core
 * `bundle::encode_doc_bundle`). Throws {@link MalformedError} for an empty bundle or more than
 * {@link MAX_DOC_ENTRIES} entries.
 */
export function encodeDocBundle(entries: readonly DocBundleEntry[]): Bytes {
  if (entries.length === 0 || entries.length > MAX_DOC_ENTRIES) throw new MalformedError(`a bundle carries 1 to ${MAX_DOC_ENTRIES} entries`)
  return encodeBundle(entries, '')
}

/**
 * Opening one snapshot, and (for the conformance vectors) sealing one. Every snapshot is written
 * as a letter to specific people (DFPK 0x02); the phase-1 Members form under the repository's
 * members key (DFPK 0x01) is only read. The reader's checks of D24, in order. The Rust twin is
 * `crates/forge-core/src/env/codec.rs`. The web never writes a snapshot.
 */

import { base58Encode } from '../auth/base58'
import {
  ARTIFACT_VERSION,
  ArtifactError,
  PackError,
  bytesToHex,
  openLetterArtifact,
  openPack,
  sealLetterArtifact,
  sealPack,
  type Bytes,
  type EpochKeyring,
  type EpochKeys,
  type LetterReader,
  type LetterRecipient,
  type OwnerKey,
} from '../private'
import { decodeSnapshot, encodeSnapshot, membersKey, type Snapshot } from './format'

const PACK_VERSION = 0x01
const MAGIC = [0x44, 0x46, 0x50, 0x4b] // "DFPK"

export type OpenErrorCode =
  | 'packHashMismatch'
  | 'sizeMismatch'
  | 'sealedPackCorrupt'
  | 'noKey'
  | 'notARecipient'
  | 'malformed'

/** Why a snapshot does not open. */
export class SnapshotOpenError extends Error {
  constructor(readonly code: OpenErrorCode) {
    super(`environment snapshot: ${code}`)
    this.name = 'SnapshotOpenError'
  }
}

/** What a person is told (never "sealed", "lane" or "named"). */
export function openErrorReason(code: OpenErrorCode): string {
  switch (code) {
    case 'packHashMismatch':
    case 'sizeMismatch':
    case 'sealedPackCorrupt':
      return 'its stored copy is damaged or does not match what its author recorded'
    case 'noKey':
      return "you don't hold the members key it was saved under"
    case 'notARecipient':
      return 'it was not sent to you'
    case 'malformed':
      return 'it is not a valid environment snapshot'
  }
}

/** The manifest fields a reader checks a snapshot against. */
export interface ManifestCheck {
  /** `$ownerId`, base58. */
  readonly ownerId: string
  /** `packHash`, lowercase hex. */
  readonly packHash: string
  readonly sizeBytes: number
}

/** What the reader opens with. */
export interface OpenKeys {
  readonly repoId: Uint8Array
  /** The manifest owner's identity keys: a Maintainers snapshot's sender key is taken from these only. */
  readonly ownerKeys: readonly OwnerKey[]
  /** The reader and its ENCRYPTION secrets (`null`: nothing addressed to people opens). */
  readonly reader: LetterReader | null
  /** The members keys held, by epoch. */
  readonly epochKeys: EpochKeyring
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b))))
}

/**
 * Open `sealed` (one copy of a kind-8 artifact) for `manifest`, in D24's order: the bytes must
 * hash to the owner-signed `packHash` before anything is decrypted, then the envelope opens with
 * `keys`, then the content must agree with the envelope. Throws {@link SnapshotOpenError}.
 */
export async function openSnapshot(manifest: ManifestCheck, sealed: Uint8Array, keys: OpenKeys): Promise<Snapshot> {
  if ((await sha256Hex(sealed)) !== manifest.packHash.toLowerCase()) throw new SnapshotOpenError('packHashMismatch')
  if (sealed.length !== manifest.sizeBytes) throw new SnapshotOpenError('sizeMismatch')
  if (sealed.length < 9 || MAGIC.some((b, i) => sealed[i] !== b)) throw new SnapshotOpenError('sealedPackCorrupt')
  let plain: Uint8Array
  const version = sealed[4]
  try {
    if (version === PACK_VERSION) {
      plain = await openPack(sealed, manifest.sizeBytes, keys.epochKeys)
    } else if (version === ARTIFACT_VERSION) {
      const reader = keys.reader ?? { identityId: new Uint8Array(32), secrets: [] }
      plain = await openLetterArtifact(keys.repoId, sealed, manifest.sizeBytes, keys.ownerKeys, reader)
    } else {
      throw new SnapshotOpenError('sealedPackCorrupt')
    }
  } catch (e) {
    if (e instanceof SnapshotOpenError) throw e
    if (e instanceof PackError) {
      throw new SnapshotOpenError(e.code === 'noKey' || e.code === 'sizeMismatch' ? e.code : 'sealedPackCorrupt')
    }
    if (e instanceof ArtifactError) throw new SnapshotOpenError(e.code)
    throw e
  }
  try {
    const s = decodeSnapshot(plain)
    if (s === null) throw new SnapshotOpenError('malformed')
    // A DFPK 0x01 file holds only an old-format Members snapshot; a 0x02 letter anything else, its
    // `to` one entry per slot with the manifest owner first.
    const letter = version === ARTIFACT_VERSION
    if (membersKey(s) === letter) throw new SnapshotOpenError('malformed')
    if (letter && (s.to.length !== sealed[8] || s.to[0] !== manifest.ownerId)) throw new SnapshotOpenError('malformed')
    return s
  } finally {
    plain.fill(0)
  }
}

/**
 * Seal an old-format Members snapshot under `keys` (the members key at an epoch) as a DFPK 0x01
 * file. Test and conformance-vector use only: nothing writes this form any more (revision 4, D9).
 */
export async function sealOldMembersSnapshotForVectors(keys: EpochKeys, snap: Snapshot): Promise<Bytes> {
  if (!membersKey(snap)) throw new RangeError('not an old-format Members snapshot')
  const pt = encodeSnapshot(snap)
  try {
    return await sealPack(keys, pt)
  } finally {
    pt.fill(0)
  }
}

/** The recipients must be exactly the snapshot's `to`, in order, the writer (`ownerId`) first. */
export function recipientsMatch(snap: Snapshot, ownerId: Uint8Array, recipients: readonly LetterRecipient[]): boolean {
  const first = recipients[0]
  return (
    !membersKey(snap) &&
    first !== undefined &&
    base58Encode(first.identityId) === base58Encode(ownerId) &&
    recipients.length === snap.to.length &&
    recipients.every((r, i) => base58Encode(r.identityId) === snap.to[i])
  )
}

/**
 * Seal `snap` from the writer's ENCRYPTION secret (key `senderKeyId`; the writer is `ownerId`)
 * to `recipients` in slot order, the writer first, as a DFPK 0x02 file. The web never writes a
 * snapshot, so this is for tests and the conformance vectors; like Rust `seal_letter_with` it
 * does not insist on version 2 (the vectors also seal version-1 Maintainers letters).
 */
export async function sealLetterSnapshot(
  repoId: Uint8Array,
  senderSecret: Uint8Array,
  senderKeyId: number,
  ownerId: Uint8Array,
  recipients: readonly LetterRecipient[],
  snap: Snapshot,
): Promise<Bytes> {
  if (!recipientsMatch(snap, ownerId, recipients)) throw new RangeError('the recipients do not match the snapshot, with the writer first')
  const pt = encodeSnapshot(snap)
  try {
    return await sealLetterArtifact(repoId, senderSecret, senderKeyId, ownerId, recipients, pt)
  } finally {
    pt.fill(0)
  }
}

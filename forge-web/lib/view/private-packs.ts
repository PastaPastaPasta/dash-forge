/**
 * A private repo's sealed artifacts on the browse plane (`docs/security/private-repos.md` §3.5,
 * §8.2). Every `packManifest` artifact (git pack, objectLocator, flatIndex) is stored sealed;
 * locator rows index PLAINTEXT offsets, so the reader asks for plaintext ranges and this module
 * maps them to sealed segments:
 *
 * - ranged reads go through `readPackRange` with the session's `PackHeaderCache` (keyed per
 *   `(packHash, copy)`, filled only once a segment tag verified), then the existing inflate /
 *   delta path, whose git OID check runs after inflate;
 * - whole reads (a locator, a flat index, the fallback clone's packs) check the sealed bytes
 *   against `packHash` first, then decrypt segment by segment;
 * - before any decrypted byte is used, the copy's standing is checked (§8.2): a manifest whose
 *   header epoch is older than the epoch current at its block height is suspect ("uploaded
 *   under an old key"), and a suspect or late one is read only if its uploader is a current
 *   member. A copy that fails is treated like one that failed verification: the next is tried.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import {
  PackError,
  manifestStanding,
  openPackStream,
  parseHeader,
  privateId,
  readPackRange,
  concatBytes,
} from '../private'
import type { PackManifest } from '../repo'
import type { PrivateSession } from '../repo/private-session'

/** A copy the §8.2 rule says not to read. */
export class SuspectPackError extends Error {
  constructor(readonly packHash: string) {
    super(`pack ${packHash.slice(0, 12)}… was uploaded under an old key by someone who is no longer a member; it is not read`)
    this.name = 'SuspectPackError'
  }
}

/** Throw unless the copy's standing lets it be read; record a suspect upload on the session. */
function assertStanding(session: PrivateSession, copy: PackManifest, headerEpoch: number): void {
  // Every copy names the same sealed bytes: the pack is read if ANY copy qualifies (a current
  // member attesting the bytes makes them readable whoever else uploaded them; parity with
  // forge-core `open_artifact_of`). A manifest with no block height cannot be judged (§8.1): it
  // never qualifies.
  let readable = false
  for (const m of copy.copies ?? [copy]) {
    if (m.createdAtBlockHeight === undefined || m.createdAtBlockHeight <= 0) continue
    let owner: Uint8Array
    try {
      owner = privateId(m.uploader)
    } catch {
      continue
    }
    const standing = manifestStanding(session.resolution, headerEpoch, m.createdAtBlockHeight, owner)
    if (standing.suspect) session.suspectManifests.add(m.documentId)
    readable ||= standing.readable
  }
  if (!readable) throw new SuspectPackError(copy.packHash)
}

/**
 * Plaintext `[a, b)` of one sealed copy, `fetchSealed` reading its sealed bytes. Throws
 * `PackError` (`sealedPackCorrupt` evicts the copy's cached header) or {@link SuspectPackError}.
 */
export async function readPrivateRange(
  session: PrivateSession,
  copy: PackManifest,
  fetchSealed: (start: number, end: number) => Promise<Uint8Array>,
  a: number,
  b: number,
): Promise<Uint8Array> {
  if (session.closed) throw new Error('this private-repo session has ended; reload')
  const bytes = await readPackRange(
    { packHash: copy.packHash.toLowerCase(), copy: copy.documentId, sizeBytes: copy.sizeBytes, fetchRange: fetchSealed },
    a,
    b,
    session.ctx.keys,
    session.headerCache,
  )
  const header = session.headerCache.get(copy.packHash.toLowerCase(), copy.documentId)
  if (header === undefined) throw new PackError('sealedPackCorrupt')
  try {
    assertStanding(session, copy, header.epoch)
  } catch (e) {
    bytes.fill(0)
    throw e
  }
  return bytes
}

/**
 * The plaintext of a whole sealed copy: its sealed bytes must hash to `packHash` (§3.4, checked
 * here), then its standing, then every segment decrypts. `sealed` is not kept.
 */
export async function openPrivateArtifact(session: PrivateSession, copy: PackManifest, sealed: Uint8Array): Promise<Uint8Array> {
  if (session.closed) throw new Error('this private-repo session has ended; reload')
  if (sealed.length !== copy.sizeBytes || bytesToHex(sha256(sealed)) !== copy.packHash.toLowerCase()) {
    throw new PackError('sealedPackCorrupt')
  }
  assertStanding(session, copy, parseHeader(sealed).epoch)
  const parts: Uint8Array[] = []
  for await (const segment of openPackStream(sealed, copy.sizeBytes, session.ctx.keys)) parts.push(segment)
  return concatBytes(...parts)
}

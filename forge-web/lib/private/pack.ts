/**
 * Sealed artifacts (`docs/security/private-repos.md` §3): segmented AES-256-GCM under a
 * per-file key, with whole, ranged and streaming reads.
 */

import { bytes, concat, isU32, randomBytes, sha256, u32, u64, type Bytes } from './bytes'
import { PACK_VERSION, hedgeFileId, type EpochKeyring, type EpochKeys } from './keys'

export const HEADER_LEN = 36
const MAGIC = [0x44, 0x46, 0x50, 0x4b] // "DFPK"
const TAG_LEN = 16
/** The segment size writers use: `L = 14`, 16 KiB. */
export const WRITER_SEG_LOG2 = 14
const MIN_SEG_LOG2 = 10
const MAX_SEG_LOG2 = 20

/** Why a sealed artifact cannot be read (§3.5). */
export type PackErrorCode = 'sizeMismatch' | 'sealedPackCorrupt' | 'noKey' | 'outOfRange'

export class PackError extends Error {
  constructor(readonly code: PackErrorCode) {
    super(`sealed artifact: ${code}`)
    this.name = 'PackError'
  }
}

/** The 36-byte header of a sealed artifact. */
export interface PackHeader {
  readonly segLog2: number
  readonly epoch: number
  readonly plaintextLen: number
  readonly fileId: Bytes
  /** The exact header bytes: the AD of every segment. */
  readonly raw: Bytes
}

export function segmentCount(plaintextLen: number, segLog2: number): number {
  return Math.max(1, Math.ceil(plaintextLen / 2 ** segLog2))
}

/** `36 + plaintextLen + 16·nSeg`. */
export function sealedLength(plaintextLen: number, segLog2: number): number {
  return HEADER_LEN + plaintextLen + TAG_LEN * segmentCount(plaintextLen, segLog2)
}

export function encodeHeader(epoch: number, plaintextLen: number, fileId: Uint8Array, segLog2 = WRITER_SEG_LOG2): Bytes {
  if (!isU32(epoch)) throw new RangeError('epoch must be a u32')
  if (!Number.isInteger(segLog2) || segLog2 < MIN_SEG_LOG2 || segLog2 > MAX_SEG_LOG2) throw new RangeError('bad segLog2')
  if (fileId.length !== 16) throw new RangeError('fileId must be 16 bytes')
  if (!Number.isSafeInteger(plaintextLen) || plaintextLen < 0) throw new RangeError('bad plaintext length')
  return concat(new Uint8Array([...MAGIC, PACK_VERSION, segLog2, 0, 0]), u32(epoch), u64(plaintextLen), fileId)
}

/**
 * Parse and check a header (§3.5 step 2, without the length check, which needs the sealed
 * length). Throws `sealedPackCorrupt`.
 */
export function parseHeader(sealed: Uint8Array): PackHeader {
  if (sealed.length < HEADER_LEN) throw new PackError('sealedPackCorrupt')
  const raw = sealed.slice(0, HEADER_LEN)
  const view = new DataView(raw.buffer)
  const segLog2 = raw[5] as number
  if (
    MAGIC.some((b, i) => raw[i] !== b) ||
    raw[4] !== PACK_VERSION ||
    segLog2 < MIN_SEG_LOG2 ||
    segLog2 > MAX_SEG_LOG2 ||
    view.getUint16(6) !== 0
  ) {
    throw new PackError('sealedPackCorrupt')
  }
  const len = view.getBigUint64(12)
  if (len > BigInt(Number.MAX_SAFE_INTEGER)) throw new PackError('sealedPackCorrupt')
  return { segLog2, epoch: view.getUint32(8), plaintextLen: Number(len), fileId: raw.slice(20, 36), raw }
}

function segmentNonce(i: number, final: boolean): Bytes {
  return concat(u64(i), new Uint8Array([0, 0, 0, final ? 1 : 0]))
}

/** Seal `plain` segment by segment under `fileId`. Not exported: see {@link sealPack}. */
async function sealPackWith(keys: EpochKeys, plain: Uint8Array, fileId: Uint8Array): Promise<Bytes> {
  const header = encodeHeader(keys.epoch, plain.length, fileId)
  const key = await keys.packKey(fileId)
  const S = 2 ** WRITER_SEG_LOG2
  const n = segmentCount(plain.length, WRITER_SEG_LOG2)
  const out = new Uint8Array(sealedLength(plain.length, WRITER_SEG_LOG2))
  out.set(header)
  let o = HEADER_LEN
  for (let i = 0; i < n; i++) {
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: segmentNonce(i, i === n - 1), additionalData: header },
      key,
      bytes(plain.subarray(i * S, (i + 1) * S)),
    )
    out.set(new Uint8Array(ct), o)
    o += ct.byteLength
  }
  return out
}

/** Seal a pack, locator or flat index under `keys` with a hedged random `fileId` (§3.6). */
export async function sealPack(keys: EpochKeys, plain: Uint8Array): Promise<Bytes> {
  return sealPackWith(keys, plain, await hedgeFileId(keys, randomBytes(32), await sha256(plain)))
}

/**
 * INTERNAL, TEST-ONLY: {@link sealPack} with a caller-chosen `fileId`, for the §11 vectors.
 * Only `lib/private/testing.ts` may import it (ESLint enforces that); it is not re-exported
 * from `index.ts`.
 */
export function __unsafeSealPackWithFileId(keys: EpochKeys, plain: Uint8Array, fileId: Uint8Array): Promise<Bytes> {
  return sealPackWith(keys, plain, fileId)
}

/** `packHash`: the SHA-256 of the sealed bytes (§3.4), lowercase hex. */
export async function packHash(sealed: Uint8Array): Promise<string> {
  return [...(await sha256(sealed))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A header checked against the sealed length (§3.5 steps 1–2), with its key (step 3). */
interface Opened {
  readonly header: PackHeader
  readonly key: CryptoKey
  readonly nSeg: number
}

async function checkAndKey(header: PackHeader, sealedLen: number, keys: EpochKeyring): Promise<Opened> {
  if (sealedLength(header.plaintextLen, header.segLog2) !== sealedLen) throw new PackError('sealedPackCorrupt')
  const epochKeys = keys.get(header.epoch)
  if (epochKeys === undefined) throw new PackError('noKey')
  return {
    header,
    key: await epochKeys.packKey(header.fileId),
    nSeg: segmentCount(header.plaintextLen, header.segLog2),
  }
}

async function decryptSegment(o: Opened, i: number, sealedSegment: Uint8Array): Promise<Bytes> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: segmentNonce(i, i === o.nSeg - 1), additionalData: o.header.raw },
        o.key,
        bytes(sealedSegment),
      ),
    )
  } catch {
    throw new PackError('sealedPackCorrupt')
  }
}

/** The sealed byte range `[start, end)` of segment `i`. */
function segmentSpan(o: Opened, i: number, sealedLen: number): [number, number] {
  const stride = 2 ** o.header.segLog2 + TAG_LEN
  const start = HEADER_LEN + i * stride
  return [start, Math.min(start + stride, sealedLen)]
}

/**
 * Open a whole sealed artifact (§3.5): `sealed.length` must equal the manifest's
 * `sizeBytes`. Throws {@link PackError}.
 */
export async function openPack(sealed: Uint8Array, sizeBytes: number, keys: EpochKeyring): Promise<Bytes> {
  const chunks: Uint8Array[] = []
  for await (const plain of openPackStream(sealed, sizeBytes, keys)) chunks.push(plain)
  return concat(...chunks)
}

/**
 * Open a sealed artifact segment by segment, yielding each segment's plaintext once its tag
 * has verified (§9: the fallback clone streams packs into its store this way). `sealed` is
 * either the whole artifact or a {@link RangeFetcher} over it.
 */
export async function* openPackStream(
  sealed: Uint8Array | RangeFetcher,
  sizeBytes: number,
  keys: EpochKeyring,
): AsyncGenerator<Bytes, void, undefined> {
  const fetchRange: RangeFetcher =
    sealed instanceof Uint8Array ? async (start, end) => sealed.subarray(start, end) : sealed
  if (sealed instanceof Uint8Array && sealed.length !== sizeBytes) throw new PackError('sizeMismatch')
  const o = await checkAndKey(parseHeader(await fetchRange(0, Math.min(HEADER_LEN, sizeBytes))), sizeBytes, keys)
  for (let i = 0; i < o.nSeg; i++) {
    const [start, end] = segmentSpan(o, i, sizeBytes)
    const seg = await fetchRange(start, end)
    if (seg.length !== end - start) throw new PackError('sealedPackCorrupt')
    yield await decryptSegment(o, i, seg)
  }
}

/** Reads sealed bytes `[start, end)` (an HTTP `Range`, or Platform chunks). */
export type RangeFetcher = (start: number, end: number) => Promise<Uint8Array>

/** The segments and sealed bytes a plaintext range `[a, b)` needs (§3.5). */
export interface RangePlan {
  readonly segments: readonly [number, number]
  readonly sealedRange: readonly [number, number]
}

/** Plan the read of plaintext `[a, b)`. Throws `outOfRange` for an empty or past-the-end range. */
export function planRange(header: PackHeader, a: number, b: number): RangePlan {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || a >= b || b > header.plaintextLen) {
    throw new PackError('outOfRange')
  }
  const L = header.segLog2
  const s0 = Math.floor(a / 2 ** L)
  const s1 = Math.floor((b - 1) / 2 ** L)
  const stride = 2 ** L + TAG_LEN
  const sealedLen = sealedLength(header.plaintextLen, L)
  return {
    segments: [s0, s1],
    sealedRange: [HEADER_LEN + s0 * stride, Math.min(HEADER_LEN + (s1 + 1) * stride, sealedLen)],
  }
}

/**
 * The session's authenticated headers by `(packHash, copy)` (§3.5). A header enters only after
 * it has been checked against the manifest's `sizeBytes` and a segment tag has verified under
 * it (the header is every segment's AD, so a verified tag authenticates it); a
 * `sealedPackCorrupt` from a copy evicts that copy's entry. A ranged read cannot check
 * `packHash`, so caching earlier would let one hostile copy poison every honest copy.
 */
export class PackHeaderCache {
  private readonly headers = new Map<string, PackHeader>()

  private static key(packHash: string, copy: string): string {
    return JSON.stringify([packHash, copy])
  }

  get(packHash: string, copy: string): PackHeader | undefined {
    return this.headers.get(PackHeaderCache.key(packHash, copy))
  }

  has(packHash: string, copy: string): boolean {
    return this.headers.has(PackHeaderCache.key(packHash, copy))
  }

  /** Only for a header a segment tag has verified under. */
  set(packHash: string, copy: string, header: PackHeader): void {
    this.headers.set(PackHeaderCache.key(packHash, copy), header)
  }

  evict(packHash: string, copy: string): void {
    this.headers.delete(PackHeaderCache.key(packHash, copy))
  }

  clear(): void {
    this.headers.clear()
  }
}

/** One stored copy of a sealed artifact: its manifest's `packHash` and `sizeBytes`, and a reader. */
export interface PackCopySource {
  readonly packHash: string
  /** The caller's id for this copy (its manifest `$id`, or a storage URI). */
  readonly copy: string
  /** The manifest's `sizeBytes`. */
  readonly sizeBytes: number
  readonly fetchRange: RangeFetcher
}

/**
 * Read plaintext `[a, b)` of one copy of a sealed artifact: the header (cached per copy once
 * authenticated), then only the segments covering the range. Throws {@link PackError}; on
 * `sealedPackCorrupt` the copy's cached header is evicted, and the caller tries another copy.
 */
export async function readPackRange(
  source: PackCopySource,
  a: number,
  b: number,
  keys: EpochKeyring,
  cache: PackHeaderCache,
): Promise<Bytes> {
  const { packHash, copy, sizeBytes, fetchRange } = source
  const cached = cache.get(packHash, copy)
  try {
    const header = cached ?? parseHeader(await fetchRange(0, HEADER_LEN))
    const o = await checkAndKey(header, sizeBytes, keys)
    const plan = planRange(header, a, b)
    const [s0, s1] = plan.segments
    const [start, end] = plan.sealedRange
    const sealed = await fetchRange(start, end)
    if (sealed.length !== end - start) throw new PackError('sealedPackCorrupt')
    const parts: Uint8Array[] = []
    for (let i = s0; i <= s1; i++) {
      const [ss, se] = segmentSpan(o, i, sizeBytes)
      parts.push(await decryptSegment(o, i, sealed.subarray(ss - start, se - start)))
      if (cached === undefined && i === s0) cache.set(packHash, copy, header)
    }
    const S = 2 ** header.segLog2
    return concat(...parts).slice(a - s0 * S, b - s0 * S)
  } catch (e) {
    if (e instanceof PackError && e.code === 'sealedPackCorrupt') cache.evict(packHash, copy)
    throw e
  }
}

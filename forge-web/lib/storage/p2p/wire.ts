/**
 * The two wire formats the browser's IPFS peer reads: bitswap 1.2.0 messages
 * (github.com/ipfs/specs `BITSWAP.md`, boxo `bitswap/message/pb/message.proto`) and the
 * dag-pb / UnixFS nodes of a file (`DAG-PB` and `UNIXFS` specs). Only what a block-by-CID
 * reader needs: a wantlist out; blocks and presences in; a file node's data, links and sizes.
 */

import { sha256 } from '@noble/hashes/sha2.js'

export const CODEC_RAW = 0x55
export const CODEC_DAG_PB = 0x70
export const MH_SHA2_256 = 0x12

/** A sha2-256 CID as bitswap names it: version, codec and the 32-byte digest. */
export interface BlockId {
  readonly version: 0 | 1
  readonly codec: number
  readonly digest: Uint8Array
}

export function blockKey(id: Pick<BlockId, 'codec' | 'digest'>): string {
  let hex = id.codec.toString(16) + ':'
  for (const b of id.digest) hex += b.toString(16).padStart(2, '0')
  return hex
}

function pushVarint(out: number[], v: number): void {
  let n = v
  while (n >= 0x80) {
    out.push((n % 128) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
}

function readVarint(b: Uint8Array, at: number): [number, number] {
  let n = 0
  let scale = 1
  let i = at
  for (;;) {
    if (i >= b.length || i - at > 8) throw new Error('bad varint')
    const x = b[i++] as number
    n += (x & 0x7f) * scale
    if ((x & 0x80) === 0) return [n, i]
    scale *= 128
  }
}

/** The binary CID of `id`. */
export function cidBytes(id: BlockId): Uint8Array {
  const out: number[] = []
  if (id.version === 1) {
    pushVarint(out, 1)
    pushVarint(out, id.codec)
  }
  out.push(MH_SHA2_256, 32, ...id.digest)
  return Uint8Array.from(out)
}

/** A binary CID (v0 or v1, sha2-256 only), or null. */
function parseCidBytes(b: Uint8Array): BlockId | null {
  if (b.length === 34 && b[0] === MH_SHA2_256 && b[1] === 32) return { version: 0, codec: CODEC_DAG_PB, digest: b.slice(2) }
  try {
    const [version, a] = readVarint(b, 0)
    const [codec, c] = readVarint(b, a)
    if (version !== 1 || b[c] !== MH_SHA2_256 || b[c + 1] !== 32 || b.length !== c + 34) return null
    return { version: 1, codec, digest: b.slice(c + 2) }
  } catch {
    return null
  }
}

type Field = readonly [field: number, value: number | Uint8Array]

/** The fields of a protobuf message (varint and length-delimited only, as both formats use). */
export function protoFields(b: Uint8Array): Field[] {
  const out: Field[] = []
  let i = 0
  while (i < b.length) {
    const [key, a] = readVarint(b, i)
    const wire = key & 7
    const field = Math.floor(key / 8)
    if (wire === 0) {
      const [v, c] = readVarint(b, a)
      out.push([field, v])
      i = c
    } else if (wire === 2) {
      const [len, c] = readVarint(b, a)
      if (c + len > b.length) throw new Error('truncated field')
      out.push([field, b.subarray(c, c + len)])
      i = c + len
    } else if (wire === 1) {
      i = a + 8
    } else if (wire === 5) {
      i = a + 4
    } else {
      throw new Error(`unsupported wire type ${wire}`)
    }
  }
  return out
}

function lenField(out: number[], field: number, body: ArrayLike<number>): void {
  pushVarint(out, field * 8 + 2)
  pushVarint(out, body.length)
  for (let i = 0; i < body.length; i++) out.push(body[i] as number)
}

function intField(out: number[], field: number, v: number): void {
  pushVarint(out, field * 8)
  pushVarint(out, v)
}

/**
 * A bitswap message asking for `want` (each as a whole block, with DONT_HAVE asked for, so a
 * peer without it says so at once) and cancelling `cancel`.
 */
export function encodeWantlist(want: readonly BlockId[], cancel: readonly BlockId[] = []): Uint8Array {
  const entries: number[] = []
  const entry = (id: BlockId, ...flags: number[]): void => {
    const e: number[] = []
    lenField(e, 1, cidBytes(id))
    for (const f of flags) intField(e, f, 1)
    lenField(entries, 1, e)
  }
  for (const id of want) entry(id, 2, 5)
  for (const id of cancel) entry(id, 3)
  const msg: number[] = []
  lenField(msg, 1, entries)
  return Uint8Array.from(msg)
}

/** A block whose bytes hash to the CID it is filed under (the hash is checked here, always). */
export interface VerifiedBlock {
  readonly key: string
  readonly data: Uint8Array
}

export interface BitswapMessage {
  readonly blocks: VerifiedBlock[]
  /** Keys a peer said it does not have. */
  readonly dontHave: string[]
}

/**
 * The blocks and DONT_HAVEs in one bitswap message; a block under another hash function is dropped. A block's CID is its prefix plus the
 * sha2-256 of its bytes, so it is computed here, never taken from the sender: a peer cannot
 * file other bytes under a CID it was asked for.
 */
export function decodeMessage(b: Uint8Array): BitswapMessage {
  const blocks: VerifiedBlock[] = []
  const dontHave: string[] = []
  for (const [field, v] of protoFields(b)) {
    if (field === 3 && v instanceof Uint8Array) {
      let prefix: Uint8Array | undefined
      let data: Uint8Array | undefined
      for (const [f2, v2] of protoFields(v)) {
        if (f2 === 1 && v2 instanceof Uint8Array) prefix = v2
        if (f2 === 2 && v2 instanceof Uint8Array) data = v2
      }
      const codec = prefix === undefined ? null : prefixCodec(prefix)
      if (codec === null || data === undefined) continue
      blocks.push({ key: blockKey({ codec, digest: sha256(data) }), data })
    } else if (field === 4 && v instanceof Uint8Array) {
      let cid: BlockId | null = null
      let type = 0
      for (const [f2, v2] of protoFields(v)) {
        if (f2 === 1 && v2 instanceof Uint8Array) cid = parseCidBytes(v2)
        if (f2 === 2 && typeof v2 === 'number') type = v2
      }
      if (cid !== null && type === 1) dontHave.push(blockKey(cid))
    }
  }
  return { blocks, dontHave }
}

/** The codec of a sha2-256 block prefix (`version, codec, mh type, mh length`), or null. */
function prefixCodec(prefix: Uint8Array): number | null {
  try {
    const [version, a] = readVarint(prefix, 0)
    const [codec, c] = readVarint(prefix, a)
    const [mh, d] = readVarint(prefix, c)
    const [len] = readVarint(prefix, d)
    if (mh !== MH_SHA2_256 || len !== 32 || (version !== 0 && version !== 1)) return null
    return version === 0 ? CODEC_DAG_PB : codec
  } catch {
    return null
  }
}

/** One length-prefixed (unsigned varint) frame. */
export function frame(msg: Uint8Array): Uint8Array {
  const head: number[] = []
  pushVarint(head, msg.length)
  const out = new Uint8Array(head.length + msg.length)
  out.set(head)
  out.set(msg, head.length)
  return out
}

/** Splits a byte stream into length-prefixed frames; refuses one over `max` bytes. */
export class FrameReader {
  private buf = new Uint8Array(0)
  private start = 0
  private end = 0
  constructor(private readonly max: number) {}

  push(chunk: Uint8Array): Uint8Array[] {
    this.append(chunk)
    const out: Uint8Array[] = []
    for (;;) {
      let len: number
      let body: number
      try {
        ;[len, body] = readVarint(this.buf.subarray(0, this.end), this.start)
      } catch (e) {
        if (this.end - this.start < 9) break
        throw e
      }
      if (len > this.max) throw new Error(`bitswap message of ${len} bytes`)
      if (body + len > this.end) break
      out.push(this.buf.slice(body, body + len))
      this.start = body + len
    }
    return out
  }

  /**
   * Appends `chunk`, first dropping what was read, and growing the buffer by doubling only when
   * the unread bytes do not fit: it stays about the size of the largest message, and a message
   * costs linear copying.
   */
  private append(chunk: Uint8Array): void {
    const pending = this.end - this.start
    if (this.end + chunk.length > this.buf.length) {
      if (pending + chunk.length <= this.buf.length) {
        this.buf.copyWithin(0, this.start, this.end)
      } else {
        const next = new Uint8Array(Math.max(pending + chunk.length, this.buf.length * 2, 4096))
        next.set(this.buf.subarray(this.start, this.end))
        this.buf = next
      }
      this.start = 0
      this.end = pending
    }
    this.buf.set(chunk, this.end)
    this.end += chunk.length
  }
}

/** A UnixFS file node: its own bytes, then its children's, each `sizes[i]` bytes long. */
export interface FileNode {
  readonly data: Uint8Array
  readonly links: readonly BlockId[]
  readonly sizes: readonly number[]
}

/**
 * A dag-pb block as a UnixFS file (or raw) node. Throws for anything else (a directory, a
 * symlink, a node whose `blocksizes` do not match its links): a pack is one file.
 */
export function parseFileNode(block: Uint8Array): FileNode {
  const links: BlockId[] = []
  let unixfs: Uint8Array | undefined
  for (const [field, v] of protoFields(block)) {
    if (field === 2 && v instanceof Uint8Array) {
      let id: BlockId | null = null
      for (const [f2, v2] of protoFields(v)) if (f2 === 1 && v2 instanceof Uint8Array) id = parseCidBytes(v2)
      if (id === null) throw new Error('dag-pb link without a sha2-256 CID')
      links.push(id)
    } else if (field === 1 && v instanceof Uint8Array) {
      unixfs = v
    }
  }
  if (unixfs === undefined) throw new Error('dag-pb node without UnixFS data')
  let type = -1
  let data: Uint8Array = new Uint8Array(0)
  const sizes: number[] = []
  for (const [field, v] of protoFields(unixfs)) {
    if (field === 1 && typeof v === 'number') type = v
    else if (field === 2 && v instanceof Uint8Array) data = v
    else if (field === 4 && typeof v === 'number') sizes.push(v)
    else if (field === 4 && v instanceof Uint8Array) {
      for (let i = 0; i < v.length; ) {
        const [n, next] = readVarint(v, i)
        sizes.push(n)
        i = next
      }
    }
  }
  // 0 Raw, 2 File (UNIXFS spec `DataType`).
  if (type !== 0 && type !== 2) throw new Error(`UnixFS node of type ${type}, not a file`)
  if (sizes.length !== links.length) throw new Error('UnixFS blocksizes do not match the links')
  return { data, links, sizes }
}

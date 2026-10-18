/**
 * Local CIDv1 derivation for the exact import parameters Forge asks kubo for
 * (`cid-version=1&raw-leaves=true&chunker=size-262144&hash=sha2-256`, balanced layout, 174
 * links per node). A port of forge-core `backends/cid.rs`: the CID kubo returns must equal this
 * re-derivation, so the CID a manifest records is a second integrity check next to its sha256.
 */

import { base58Decode } from '../auth/base58'
import { sha256 } from '@noble/hashes/sha2.js'

/** kubo's fixed-size chunker (`size-262144`). */
export const CID_CHUNK_SIZE = 262_144
/** Links per UnixFS node in the balanced layout (go-unixfs `DefaultLinksPerBlock`). */
export const CID_MAX_LINKS = 174

const CODEC_RAW = 0x55
const CODEC_DAG_PB = 0x70
const MH_SHA2_256 = 0x12

interface Block {
  readonly cid: Uint8Array
  readonly tsize: number
  readonly content: number
}

function varint(out: number[], v: number): void {
  let n = v
  for (;;) {
    const byte = n % 128
    n = Math.floor(n / 128)
    if (n === 0) {
      out.push(byte)
      return
    }
    out.push(byte | 0x80)
  }
}

function key(out: number[], field: number, wire: number): void {
  varint(out, field * 8 + wire)
}

function cidBytes(codec: number, block: Uint8Array): Uint8Array {
  const out: number[] = []
  varint(out, 1)
  varint(out, codec)
  varint(out, MH_SHA2_256)
  varint(out, 32)
  return Uint8Array.from([...out, ...sha256(block)])
}

function leaf(chunk: Uint8Array): Block {
  return { cid: cidBytes(CODEC_RAW, chunk), tsize: chunk.length, content: chunk.length }
}

/** A dag-pb UnixFS `File` node linking `children` (links before data, the canonical order). */
function fileNode(children: readonly Block[]): Block {
  const content = children.reduce((s, c) => s + c.content, 0)
  const unixfs: number[] = []
  key(unixfs, 1, 0)
  varint(unixfs, 2)
  key(unixfs, 3, 0)
  varint(unixfs, content)
  for (const c of children) {
    key(unixfs, 4, 0)
    varint(unixfs, c.content)
  }
  const node: number[] = []
  for (const c of children) {
    const link: number[] = []
    key(link, 1, 2)
    varint(link, c.cid.length)
    link.push(...c.cid)
    key(link, 2, 2)
    varint(link, 0)
    key(link, 3, 0)
    varint(link, c.tsize)
    key(node, 2, 2)
    varint(node, link.length)
    node.push(...link)
  }
  key(node, 1, 2)
  varint(node, unixfs.length)
  node.push(...unixfs)
  const bytes = Uint8Array.from(node)
  return { cid: cidBytes(CODEC_DAG_PB, bytes), tsize: bytes.length + children.reduce((s, c) => s + c.tsize, 0), content }
}

function base32(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let out = 'b'
  let buffer = 0
  let bits = 0
  for (const b of bytes) {
    buffer = ((buffer << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += alphabet[(buffer >> bits) & 31]
    }
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31]
  return out
}

/** The CIDv1 (base32, `b…`) kubo produces for `bytes` under Forge's pinned import parameters. */
export function cidV1RawLeaves(bytes: Uint8Array): string {
  let level: Block[] = []
  if (bytes.length === 0) level.push(leaf(bytes))
  for (let i = 0; i < bytes.length; i += CID_CHUNK_SIZE) level.push(leaf(bytes.subarray(i, i + CID_CHUNK_SIZE)))
  while (level.length > 1) {
    const next: Block[] = []
    for (let i = 0; i < level.length; i += CID_MAX_LINKS) next.push(fileNode(level.slice(i, i + CID_MAX_LINKS)))
    level = next
  }
  return base32((level[0] as Block).cid)
}

/** Whether `s` is a plausible CID (base-encoded: letters and digits only). */
export function isCid(s: string): boolean {
  return /^[A-Za-z0-9]+$/.test(s)
}

/** Parse a CID and use one spelling for comparisons, preserving the legacy CIDv0 spelling. */
export function normalizeCid(value: string): string | null {
  if (!value || value.length > 512 || !/^[\x00-\x7f]+$/.test(value)) return null
  try {
    let bytes: Uint8Array
    if (value.startsWith('Qm')) {
      bytes = base58Decode(value)
      if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 32) return null
      return value
    }
    const prefix = value[0]
    const body = value.slice(1)
    if (prefix === 'z') bytes = base58Decode(body)
    else if (prefix === 'b' || prefix === 'B') {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
      let buffer = 0, bits = 0
      const out: number[] = []
      for (const char of body.toLowerCase()) {
        const digit = alphabet.indexOf(char)
        if (digit < 0) return null
        buffer = (buffer << 5) | digit; bits += 5
        if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 255) }
      }
      if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) return null
      bytes = Uint8Array.from(out)
    } else if (prefix === 'k' || prefix === 'K') {
      // A leading zero encodes a zero byte, which cannot start CIDv1.
      if (!/^[1-9a-z][0-9a-z]*$/i.test(body)) return null
      let number = 0n
      for (const char of body.toLowerCase()) number = number * 36n + BigInt(parseInt(char, 36))
      const out: number[] = []
      while (number > 0n) { out.unshift(Number(number & 255n)); number >>= 8n }
      bytes = Uint8Array.from(out)
    } else return null
    let at = 0
    const read = (): bigint => {
      let result = 0n
      for (let i = 0; i < 10; i++) {
        const byte = bytes[at++]
        if (byte === undefined || (i === 9 && byte > 1)) throw new Error('invalid CID varint')
        result |= BigInt(byte & 127) << BigInt(i * 7)
        if (byte < 128) {
          if (i > 0 && byte === 0) throw new Error('noncanonical CID varint')
          return result
        }
      }
      throw new Error('invalid CID varint')
    }
    if (read() !== 1n || read() === 0n) return null
    const hash = read(), size = read()
    if (size !== BigInt(bytes.length - at) || (hash === BigInt(MH_SHA2_256) && size !== 32n)) return null
    return base32(bytes)
  } catch { return null }
}

/** Compare the same CID returned by nodes in either CIDv0 or CIDv1 form. */
export function sameCid(a: string, b: string): boolean {
  const canonical = (s: string): string | null => {
    const normalized = normalizeCid(s)
    return normalized?.startsWith('Qm') ? base32(Uint8Array.from([1, CODEC_DAG_PB, ...base58Decode(normalized)])) : normalized
  }
  const left = canonical(a)
  return left !== null && left === canonical(b)
}

/**
 * DAPI Core over gRPC-web, straight from the browser: the Core service every evonode serves
 * next to Platform (dapi-grpc `protos/core/v0/core.proto`). The evo-sdk exposes Platform only,
 * so the few calls identity creation needs are framed here by hand:
 *
 *   broadcastTransaction  { bytes transaction = 1 } → { string transaction_id = 1 }
 *   getTransaction        { string id = 1 } → { bytes transaction = 1; bytes block_hash = 2;
 *                          uint32 height = 3; uint32 confirmations = 4;
 *                          bool is_instant_locked = 5; bool is_chain_locked = 6 }
 *   getBestBlockHeight    {} → { uint32 height = 1 }
 *   subscribeToTransactionsWithProofs (server stream)
 *                         { BloomFilter bloom_filter = 1; uint32 from_block_height = 3;
 *                          uint32 count = 4 } → { RawTransactions raw_transactions = 1 | … }
 *
 * The evonodes' gateway allows cross-origin gRPC-web (`x-grpc-web`, `content-type`), so no
 * block explorer or proxy is involved.
 */

import { concatBytes } from '@noble/hashes/utils.js'

const SERVICE = 'org.dash.platform.dapi.v0.Core'
const CALL_TIMEOUT_MS = 20_000
const GRPC_NOT_FOUND = 5
/** gRPC codes worth another node: CANCELLED, UNKNOWN, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE. */
const RETRYABLE = new Set([1, 2, 4, 8, 13, 14])

export class DapiError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
    this.name = 'DapiError'
  }
}

// ---------------------------------------------------------------------------
// Protobuf (the flat subset these messages use)
// ---------------------------------------------------------------------------

function varint(n: number): Uint8Array {
  const out: number[] = []
  let v = n >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return Uint8Array.from(out)
}

/** One field: bytes/string as length-delimited, numbers and booleans as varints. */
export function field(no: number, value: Uint8Array | string | number | boolean): Uint8Array {
  if (typeof value === 'string') value = new TextEncoder().encode(value)
  if (value instanceof Uint8Array) return concatBytes(varint((no << 3) | 2), varint(value.length), value)
  return concatBytes(varint(no << 3), varint(typeof value === 'boolean' ? Number(value) : value))
}

/** Decode a message into field number → every value (repeated fields keep their order). */
export function decode(buf: Uint8Array): Map<number, (number | Uint8Array)[]> {
  const out = new Map<number, (number | Uint8Array)[]>()
  let at = 0
  const readVarint = (): number => {
    let result = 0
    let mul = 1
    for (;;) {
      if (at >= buf.length) throw new Error('truncated protobuf')
      const b = buf[at++] as number
      result += (b & 0x7f) * mul
      if ((b & 0x80) === 0) return result
      mul *= 128
    }
  }
  while (at < buf.length) {
    const key = readVarint()
    const no = Math.floor(key / 8)
    const wire = key & 7
    let value: number | Uint8Array
    if (wire === 0) value = readVarint()
    else if (wire === 2) {
      const len = readVarint()
      if (at + len > buf.length) throw new Error('truncated protobuf')
      value = buf.slice(at, at + len)
      at += len
    } else if (wire === 1) {
      at += 8
      continue
    } else if (wire === 5) {
      at += 4
      continue
    } else throw new Error(`unsupported protobuf wire type ${wire}`)
    out.set(no, [...(out.get(no) ?? []), value])
  }
  return out
}

const bytesOf = (m: Map<number, (number | Uint8Array)[]>, no: number): Uint8Array => {
  const v = m.get(no)?.[0]
  return v instanceof Uint8Array ? v : new Uint8Array(0)
}
const numOf = (m: Map<number, (number | Uint8Array)[]>, no: number): number => {
  const v = m.get(no)?.[0]
  return typeof v === 'number' ? v : 0
}

// ---------------------------------------------------------------------------
// BIP37 bloom filter (murmur3, as Dash Core computes it)
// ---------------------------------------------------------------------------

export function murmur3(seed: number, data: Uint8Array): number {
  const c1 = 0xcc9e2d51
  const c2 = 0x1b873593
  let h = seed >>> 0
  const blocks = data.length >> 2
  const rotl = (x: number, r: number): number => (x << r) | (x >>> (32 - r))
  for (let i = 0; i < blocks; i++) {
    const j = i * 4
    let k = ((data[j] as number) | ((data[j + 1] as number) << 8) | ((data[j + 2] as number) << 16) | ((data[j + 3] as number) << 24)) >>> 0
    k = Math.imul(rotl(Math.imul(k, c1), 15), c2)
    h = (Math.imul(rotl(h ^ k, 13), 5) + 0xe6546b64) >>> 0
  }
  const tail = blocks * 4
  let k = 0
  switch (data.length & 3) {
    case 3:
      k ^= (data[tail + 2] as number) << 16
    // falls through
    case 2:
      k ^= (data[tail + 1] as number) << 8
    // falls through
    case 1:
      k ^= data[tail] as number
      h ^= Math.imul(rotl(Math.imul(k, c1), 15), c2)
  }
  h ^= data.length
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

export interface BloomFilter {
  readonly data: Uint8Array
  readonly hashFuncs: number
  readonly tweak: number
  /** BIP37 nFlags; 1 = BLOOM_UPDATE_ALL (the node adds matched outputs, so their spends match too). */
  readonly flags: number
}

/**
 * A filter holding `elements`, sized like Dash Core's CBloomFilter for `capacity` elements
 * (default: just these) at `fpRate`.
 */
export function bloomFilter(
  elements: readonly Uint8Array[],
  fpRate = 0.0001,
  tweak = crypto.getRandomValues(new Uint32Array(1))[0] as number,
  capacity = elements.length,
): BloomFilter {
  const n = Math.max(1, capacity, elements.length)
  const size = Math.max(1, Math.min(Math.floor((-1 / (Math.LN2 * Math.LN2)) * n * Math.log(fpRate) / 8), 36_000))
  const hashFuncs = Math.max(1, Math.min(Math.floor(((size * 8) / n) * Math.LN2), 50))
  const data = new Uint8Array(size)
  for (const e of elements) {
    for (let i = 0; i < hashFuncs; i++) {
      const bit = murmur3((Math.imul(i, 0xfba4c795) + tweak) >>> 0, e) % (size * 8)
      data[bit >> 3] = (data[bit >> 3] as number) | (1 << (bit & 7))
    }
  }
  return { data, hashFuncs, tweak: tweak >>> 0, flags: 1 }
}

export function bloomContains(f: BloomFilter, e: Uint8Array): boolean {
  for (let i = 0; i < f.hashFuncs; i++) {
    const bit = murmur3((Math.imul(i, 0xfba4c795) + f.tweak) >>> 0, e) % (f.data.length * 8)
    if (((f.data[bit >> 3] as number) & (1 << (bit & 7))) === 0) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// gRPC-web transport
// ---------------------------------------------------------------------------

function frame(message: Uint8Array): Uint8Array {
  const head = new Uint8Array(5)
  new DataView(head.buffer).setUint32(1, message.length)
  return concatBytes(head, message)
}

function parseTrailers(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of new TextDecoder().decode(bytes).split('\r\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

/** Pull complete frames off `buf`: messages, trailers, and the unconsumed rest. */
export function takeFrames(buf: Uint8Array): { messages: Uint8Array[]; trailers: Record<string, string> | null; rest: Uint8Array } {
  const messages: Uint8Array[] = []
  let trailers: Record<string, string> | null = null
  let at = 0
  while (at + 5 <= buf.length) {
    const len = new DataView(buf.buffer, buf.byteOffset + at + 1, 4).getUint32(0)
    if (at + 5 + len > buf.length) break
    const payload = buf.slice(at + 5, at + 5 + len)
    if (((buf[at] as number) & 0x80) !== 0) trailers = { ...(trailers ?? {}), ...parseTrailers(payload) }
    else messages.push(payload)
    at += 5 + len
  }
  return { messages, trailers, rest: buf.slice(at) }
}

function statusError(method: string, status: number, message: string | null | undefined): DapiError {
  return new DapiError(`${method}: ${message ? decodeURIComponent(message) : `gRPC status ${status}`}`, status)
}

function shuffled<T>(list: readonly T[]): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j] as T, a[i] as T]
  }
  return a
}

export interface CoreTx {
  readonly raw: Uint8Array
  /** Mined height; null while in the mempool. */
  readonly height: number | null
  readonly chainLocked: boolean
  readonly instantLocked: boolean
}

export class DapiCore {
  constructor(
    readonly nodes: readonly string[],
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly maxNodes = 4,
  ) {
    if (nodes.length === 0) throw new Error('no DAPI nodes configured')
  }

  private async post(node: string, method: string, request: Uint8Array, signal?: AbortSignal): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(`${node}/${SERVICE}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
        body: frame(request) as Uint8Array<ArrayBuffer>,
        signal,
      })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' && !signal?.aborted) throw new DapiError(`${method} to ${node} timed out`, 4)
      if (signal?.aborted) throw e
      throw new DapiError(`${method} to ${node}: ${(e as Error)?.message ?? e}`, 14)
    }
    if (!res.ok) throw new DapiError(`${method} to ${node}: HTTP ${res.status}`, 14)
    const status = res.headers.get('grpc-status')
    if (status !== null && status !== '0') throw statusError(method, Number(status), res.headers.get('grpc-message'))
    return res
  }

  /** A unary call on up to `maxNodes` random nodes; only transport failures move on. */
  private async unary(method: string, request: Uint8Array): Promise<Map<number, (number | Uint8Array)[]>> {
    let last: unknown
    for (const node of shuffled(this.nodes).slice(0, this.maxNodes)) {
      try {
        const res = await this.post(node, method, request, AbortSignal.timeout(CALL_TIMEOUT_MS))
        const { messages, trailers } = takeFrames(new Uint8Array(await res.arrayBuffer()))
        const status = Number(trailers?.['grpc-status'] ?? 0)
        if (status !== 0) throw statusError(method, status, trailers?.['grpc-message'])
        return decode(messages[0] ?? new Uint8Array(0))
      } catch (e) {
        last = e
        if (!(e instanceof DapiError) || !RETRYABLE.has(e.code)) throw e
      }
    }
    throw last
  }

  async bestHeight(): Promise<number> {
    return numOf(await this.unary('getBestBlockHeight', new Uint8Array(0)), 1)
  }

  async broadcast(raw: Uint8Array): Promise<void> {
    await this.unary('broadcastTransaction', field(1, raw))
  }

  /** The transaction, or null when no node knows it. */
  async transaction(txid: string): Promise<CoreTx | null> {
    try {
      const m = await this.unary('getTransaction', field(1, txid))
      const raw = bytesOf(m, 1)
      if (raw.length === 0) return null
      const height = numOf(m, 3)
      return { raw, height: bytesOf(m, 2).length > 0 && height > 0 ? height : null, instantLocked: numOf(m, 5) === 1, chainLocked: numOf(m, 6) === 1 }
    } catch (e) {
      if (e instanceof DapiError && e.code === GRPC_NOT_FOUND) return null
      throw e
    }
  }

  /**
   * Stream the raw transactions `filter` matches from block `fromHeight`: history, then (with
   * `count` 0) the mempool and new blocks. Yields one batch per RawTransactions message and
   * returns when the node ends the stream.
   */
  async *watch(filter: BloomFilter, fromHeight: number, opts: { count?: number; signal?: AbortSignal } = {}): AsyncGenerator<Uint8Array[]> {
    const bloom = concatBytes(field(1, filter.data), field(2, filter.hashFuncs), field(3, filter.tweak), field(4, filter.flags))
    const request = concatBytes(field(1, bloom), field(3, Math.max(1, fromHeight)), ...(opts.count ? [field(4, opts.count)] : []))
    const node = shuffled(this.nodes)[0] as string
    const res = await this.post(node, 'subscribeToTransactionsWithProofs', request, opts.signal)
    if (!res.body) throw new DapiError('subscribeToTransactionsWithProofs: no response stream', 14)
    const reader = res.body.getReader()
    let buf: Uint8Array = new Uint8Array(0)
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        const { messages, trailers, rest } = takeFrames(concatBytes(buf, value))
        buf = rest
        for (const msg of messages) {
          const raw = bytesOf(decode(msg), 1)
          if (raw.length > 0) {
            const txs = (decode(raw).get(1) ?? []).filter((t): t is Uint8Array => t instanceof Uint8Array)
            if (txs.length > 0) yield txs
          }
        }
        if (trailers) {
          const status = Number(trailers['grpc-status'] ?? 0)
          if (status !== 0) throw statusError('subscribeToTransactionsWithProofs', status, trailers['grpc-message'])
          return
        }
      }
    } finally {
      reader.cancel().catch(() => undefined)
    }
  }
}

/**
 * Core-chain side of creating an identity in the browser (`ux-dx-spec.md` §2.2 tile 2), ported
 * from `tools/mint-identity` (tx.mjs, lock.mjs, dapi-core.mjs) and aligned with govhub and
 * mainnet-bridge:
 *
 *   1. watch the deposit address through DAPI (the evonodes' Core service, `dapi-core.ts`): a
 *      bloom-filtered `subscribeToTransactionsWithProofs` feed from the height the creation
 *      started at, on two nodes at once;
 *   2. build and sign a type-8 asset-lock transaction spending them to one credit output
 *      controlled by the asset-lock key, and broadcast it;
 *   3. prove the lock: its InstantSend lock, taken off feeds opened on three nodes before the
 *      broadcast (an islock is sent once, live, and never replayed), else a chain-lock proof
 *      once DAPI reports the transaction mined and Platform's chain-locked Core height
 *      reaches its block.
 *
 * Only the evonodes are asked: no block explorer or JSON-RPC service. No node is trusted with
 * amounts. Every input is derived from a raw funding transaction whose txid is computed here,
 * and parsed for the output's value and script before anything is signed. (The legacy sighash
 * does not commit to input values: trusting a claimed amount would let a lying source turn the
 * deposit into miner fees.) A node can delay the user or hide funds, but not take them or
 * learn a key, and Platform checks an islock's signature itself.
 */

import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'

import { ACTIVE_NETWORK, NETWORKS, type Network } from '../constants'
import { anyOf } from '../sdk/budget'
import { sleep } from '../sdk/facade'
import { base58CheckDecode } from './base58'
import { DapiCore, bloomFilter, shuffled, type BloomFilter } from './dapi-core'
import { decodeWif } from './wif'

// @noble/secp256k1 v3 needs sync hashes wired for sign/getPublicKey.
secp.hashes.sha256 = sha256
secp.hashes.hmacSha256 = (k, m) => hmac(sha256, k, m)

/** The Core endpoints per network. */
export interface CoreEndpoints {
  /** DAPI nodes (`https://host:port`) serving the Core gRPC-web service. */
  readonly dapi: readonly string[]
}

/** The endpoints this build uses. */
export function coreEndpoints(network: Network = ACTIVE_NETWORK.network): CoreEndpoints {
  return { dapi: NETWORKS[network].dapiAddresses }
}

function dapiOf(ep: CoreEndpoints): DapiCore {
  return new DapiCore(ep.dapi)
}

export interface Utxo {
  readonly txid: string
  readonly vout: number
  readonly satoshis: number
  readonly scriptPubKey: string
  readonly confirmations: number
}

/** The value and script of each output of a raw transaction (Dash; special payload skipped). */
export function parseOutputs(raw: Uint8Array): { value: bigint; script: Uint8Array }[] {
  let at = 0
  const need = (n: number): void => {
    if (at + n > raw.length) throw new Error('truncated transaction')
  }
  const u8 = (): number => {
    need(1)
    return raw[at++] as number
  }
  const bytes = (n: number): Uint8Array => {
    need(n)
    const b = raw.slice(at, at + n)
    at += n
    return b
  }
  const varint = (): number => {
    const first = u8()
    if (first < 0xfd) return first
    const b = bytes(first === 0xfd ? 2 : first === 0xfe ? 4 : 8)
    let n = 0
    for (let i = b.length - 1; i >= 0; i--) n = n * 256 + (b[i] as number)
    return n
  }
  bytes(4) // version | type
  const inputs = varint()
  for (let i = 0; i < inputs; i++) {
    bytes(36)
    bytes(varint())
    bytes(4)
  }
  const count = varint()
  const out: { value: bigint; script: Uint8Array }[] = []
  for (let i = 0; i < count; i++) {
    const v = bytes(8)
    let value = 0n
    for (let j = 7; j >= 0; j--) value = value * 256n + BigInt(v[j] as number)
    out.push({ value, script: bytes(varint()) })
  }
  return out
}

/** The height `txid` was mined at (null while unconfirmed or unknown). */
export async function getTxHeight(ep: CoreEndpoints, txid: string): Promise<number | null> {
  return (await dapiOf(ep).transaction(txid))?.height ?? null
}

/**
 * Broadcast through DAPI. Re-sending an accepted transaction is harmless; a transaction the
 * network already has counts as sent, so a lost response never strands the deposit.
 */
export async function broadcastTx(ep: CoreEndpoints, rawHex: string, txid: string): Promise<void> {
  const dapi = dapiOf(ep)
  try {
    await dapi.broadcast(hexToBytes(rawHex))
  } catch (e) {
    if (!(await dapi.transaction(txid).catch(() => null))) throw e
  }
}

// ---------------------------------------------------------------------------
// Keys and addresses
// ---------------------------------------------------------------------------

export function hash160(b: Uint8Array): Uint8Array {
  return ripemd160(sha256(b))
}

function hash256(b: Uint8Array): Uint8Array {
  return sha256(sha256(b))
}

/** Private key bytes from a WIF (compressed keys only). */
export function wifBytes(wif: string): Uint8Array {
  const d = decodeWif(wif)
  if (!d.compressed) throw new Error('uncompressed keys are not supported')
  return d.privateKey
}

/** P2PKH address → its 20-byte pubkey hash. */
function addressHash(address: string): Uint8Array {
  return base58CheckDecode(address).slice(1)
}

// ---------------------------------------------------------------------------
// Transactions (Dash special tx v3; type 8 = asset lock)
// ---------------------------------------------------------------------------

interface TxIn {
  readonly txid: Uint8Array
  readonly vout: number
  scriptSig: Uint8Array
}
interface TxOut {
  readonly value: bigint
  readonly script: Uint8Array
}
interface Tx {
  readonly type: number
  vin: TxIn[]
  readonly vout: TxOut[]
  readonly payload: Uint8Array
}

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8)
  const b = new Uint8Array(5)
  b[0] = 0xfe
  new DataView(b.buffer).setUint32(1, n, true)
  return b
}
function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0, true)
  return b
}
function i64(n: bigint): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigInt64(0, n, true)
  return b
}
function withLen(b: Uint8Array): Uint8Array {
  return concatBytes(varint(b.length), b)
}
function p2pkh(hash: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac))
}
function serOut(o: TxOut): Uint8Array {
  return concatBytes(i64(o.value), withLen(o.script))
}

function serialize(tx: Tx): Uint8Array {
  const parts: Uint8Array[] = [u32(3 | (tx.type << 16)), varint(tx.vin.length)]
  for (const i of tx.vin) parts.push(i.txid, u32(i.vout), withLen(i.scriptSig), u32(0xffffffff))
  parts.push(varint(tx.vout.length))
  for (const o of tx.vout) parts.push(serOut(o))
  parts.push(u32(0))
  if (tx.type !== 0 && tx.payload.length > 0) parts.push(withLen(tx.payload))
  return concatBytes(...parts)
}

export function txid(raw: Uint8Array): string {
  return bytesToHex(hash256(raw).reverse())
}

function derSig(compact: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): Uint8Array => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.slice(i)
    if ((v[0] as number) & 0x80) v = concatBytes(Uint8Array.of(0), v)
    return concatBytes(Uint8Array.of(0x02, v.length), v)
  }
  const r = int(compact.slice(0, 32))
  const s = int(compact.slice(32, 64))
  return concatBytes(Uint8Array.of(0x30, r.length + s.length), r, s)
}

/** Sign every input (all P2PKH to the same key), SIGHASH_ALL. */
function signAll(tx: Tx, utxos: readonly Utxo[], priv: Uint8Array): void {
  const pub = secp.getPublicKey(priv, true)
  const signed: Uint8Array[] = []
  for (let i = 0; i < tx.vin.length; i++) {
    const copy: Tx = { ...tx, vin: tx.vin.map((v, j) => ({ ...v, scriptSig: j === i ? hexToBytes((utxos[i] as Utxo).scriptPubKey) : new Uint8Array(0) })) }
    const digest = hash256(concatBytes(serialize(copy), u32(1)))
    const sig = secp.sign(digest, priv, { prehash: false, lowS: true })
    const der = concatBytes(derSig(sig), Uint8Array.of(0x01))
    signed.push(concatBytes(withLen(der), withLen(pub)))
  }
  tx.vin = tx.vin.map((v, i) => ({ ...v, scriptSig: signed[i] as Uint8Array }))
}

/** The fee an asset-lock transaction pays (duffs), per input. */
const ASSET_LOCK_FEE_PER_INPUT = 1000

/**
 * Build and sign a type-8 asset lock spending `utxos` (all owned by `priv`) into one credit
 * output controlled by that same key. Returns the raw transaction and its id.
 */
export function buildAssetLock(utxos: readonly Utxo[], priv: Uint8Array): { raw: Uint8Array; txid: string; lockedDuffs: number } {
  if (utxos.length === 0) throw new Error('no funds to lock')
  const total = utxos.reduce((s, u) => s + u.satoshis, 0)
  const fee = ASSET_LOCK_FEE_PER_INPUT * utxos.length
  const locked = total - fee
  if (locked <= 0) throw new Error('deposit too small to cover the fee')
  // Every input's script must be the lock key's own P2PKH (the values come from the raw transactions, `DepositTracker`).
  const own = bytesToHex(p2pkh(hash160(secp.getPublicKey(priv, true))))
  if (utxos.some((u) => u.scriptPubKey !== own)) throw new Error('an input is not paid to the deposit key')
  if (locked + fee !== total) throw new Error('asset-lock fee mismatch')
  const pubHash = hash160(secp.getPublicKey(priv, true))
  const payload = concatBytes(Uint8Array.of(1), varint(1), serOut({ value: BigInt(locked), script: p2pkh(pubHash) }))
  const tx: Tx = {
    type: 8,
    vin: utxos.map((u) => ({ txid: hexToBytes(u.txid).reverse(), vout: u.vout, scriptSig: new Uint8Array(0) })),
    vout: [{ value: BigInt(locked), script: Uint8Array.of(0x6a, 0x00) }],
    payload,
  }
  signAll(tx, utxos, priv)
  const raw = serialize(tx)
  return { raw, txid: txid(raw), lockedDuffs: locked }
}

/** A plain P2PKH payment (the test harness funds a deposit address with it). */
export function buildPayment(
  utxos: readonly Utxo[],
  priv: Uint8Array,
  to: { address: string; duffs: number },
  changeAddress: string,
  fee = 2000,
): { raw: Uint8Array; txid: string } {
  const total = utxos.reduce((s, u) => s + u.satoshis, 0)
  const change = total - to.duffs - fee
  if (change < 0) throw new Error('insufficient funds')
  const vout: TxOut[] = [{ value: BigInt(to.duffs), script: p2pkh(addressHash(to.address)) }]
  if (change > 546) vout.push({ value: BigInt(change), script: p2pkh(addressHash(changeAddress)) })
  const tx: Tx = {
    type: 0,
    vin: utxos.map((u) => ({ txid: hexToBytes(u.txid).reverse(), vout: u.vout, scriptSig: new Uint8Array(0) })),
    vout,
    payload: new Uint8Array(0),
  }
  signAll(tx, utxos, priv)
  const raw = serialize(tx)
  return { raw, txid: txid(raw) }
}

// ---------------------------------------------------------------------------
// Lock proofs
// ---------------------------------------------------------------------------

export type LockProof =
  | { readonly type: 'instant'; readonly txid: string; readonly raw: Uint8Array; readonly islock: Uint8Array }
  | { readonly type: 'chain'; readonly txid: string; readonly height: number }

/** How long, after the broadcast, an InstantSend lock is waited for before a chain-lock proof. */
const ISLOCK_WAIT_MS = 60_000
/** Feeds watching for the islock, each on its own node: one can be down or drop the lock. */
const ISLOCK_FEEDS = 3
/** The longest the broadcast waits for an islock feed to open. */
const ISLOCK_OPEN_MS = 10_000

/** The txid (display hex) an ISDLOCK locks: version 1 | inputs (36 bytes each) | txid | cycle hash | BLS signature. */
export function islockTxid(islock: Uint8Array): string | null {
  if (islock[0] !== 1 || islock.length < 2) return null
  let at = 2
  let inputs = islock[1] as number
  if (inputs === 0xfd) {
    inputs = (islock[2] as number) | ((islock[3] as number) << 8)
    at = 4
  } else if (inputs > 0xfd) return null
  at += inputs * 36
  if (islock.length !== at + 32 + 32 + 96) return null
  return bytesToHex(islock.slice(at, at + 32).reverse())
}

/**
 * A filter matching the asset lock: its txid and the outpoints it spends, each in Core's byte
 * order (what rs-dapi matches) and as displayed (what the older JS DAPI matched).
 */
export function lockFilter(lock: { txid: string; raw: Uint8Array }): BloomFilter {
  const both = (display: string, tail: Uint8Array = new Uint8Array(0)): Uint8Array[] => {
    const b = hexToBytes(display)
    return [concatBytes(b.slice().reverse(), tail), concatBytes(b, tail)]
  }
  const elements = both(lock.txid)
  for (const i of parseTx(lock.raw).inputs) elements.push(...both(i.txid, u32(i.vout)))
  return bloomFilter(elements)
}

/** `p`, or null once `ms` pass first. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/**
 * Run `feed` on up to `lanes` nodes at once. A lane whose feed fails or ends with null moves to
 * the next untried node (with `forever`, round the list again), `retryMs` later. Resolves with
 * the first non-null result, or null once every lane gave up or `signal` stopped them.
 */
function onNodes<T>(
  nodes: readonly string[],
  lanes: number,
  signal: AbortSignal,
  feed: (node: string) => Promise<T | null>,
  opts: { forever?: boolean; retryMs?: number } = {},
): Promise<T | null> {
  const order = shuffled(nodes)
  let next = 0
  let done = false
  return new Promise((resolve) => {
    const lane = async (): Promise<void> => {
      while (!done && !signal.aborted) {
        if (next >= order.length) {
          if (!opts.forever) return
          next = 0
        }
        const result = await feed(order[next++] as string).catch(() => null)
        if (result !== null) {
          done = true
          resolve(result)
          return
        }
        if (opts.retryMs) await sleep(opts.retryMs, signal).catch(() => undefined)
      }
    }
    const n = Math.max(1, Math.min(lanes, order.length))
    let left = n
    for (let i = 0; i < n; i++) {
      void lane().finally(() => {
        if (--left === 0) resolve(null)
      })
    }
  })
}

/**
 * The first islock for `lock` on feeds from `from`, on {@link ISLOCK_FEEDS} nodes at once;
 * null once they all fail or `signal` stops them. `onOpen` fires when a feed is listening.
 */
function watchInstantLock(
  dapi: DapiCore,
  lock: { txid: string; raw: Uint8Array },
  from: number,
  signal: AbortSignal,
  onOpen: () => void,
): Promise<Uint8Array | null> {
  const filter = lockFilter(lock)
  return onNodes(dapi.nodes, ISLOCK_FEEDS, signal, async (node) => {
    for await (const ev of dapi.watch(filter, from, { node, signal, onOpen })) {
      if (ev.kind !== 'islocks') continue
      const hit = ev.locks.find((l) => islockTxid(l) === lock.txid)
      if (hit) return hit
    }
    return null
  })
}

/**
 * Broadcast the asset lock and wait until it is provable. Feeds watching for its InstantSend
 * lock open first (an islock is sent once, live); the first matching one within a minute of
 * the broadcast makes an instant proof. Otherwise, and for a lock already mined or locked, a chain-lock
 * proof once the lock is mined and Platform's chain-locked Core height reaches it
 * (`platformChainLockedHeight` is read from Platform status). Re-sending an accepted lock is
 * harmless, so a resumed creation calls this again.
 */
export async function sendAndProveLock(
  ep: CoreEndpoints,
  lock: { txid: string; raw: Uint8Array },
  platformChainLockedHeight: () => Promise<number | null>,
  opts: { signal?: AbortSignal; onStatus?: (s: string) => void; timeoutMs?: number; islockWaitMs?: number } = {},
): Promise<LockProof> {
  opts.signal?.throwIfAborted()
  const dapi = dapiOf(ep)
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60 * 1000)
  const known = await dapi.transaction(lock.txid).catch(() => null)
  let height = known?.height ?? null
  // Mined, or already InstantSend-locked on a resumed run (the islock is not sent again): a
  // chain-lock proof.
  if (height === null && known?.instantLocked !== true) {
    opts.onStatus?.('Waiting for InstantSend…')
    const stop = new AbortController()
    const signal = opts.signal ? anyOf(opts.signal, stop.signal) : stop.signal
    try {
      const tip = await dapi.bestHeight().catch(() => null)
      let opened = (): void => undefined
      const open = new Promise<void>((r) => {
        opened = r
      })
      // A couple of blocks back, so every node's history is short and its live feed starts at once.
      const islock = tip === null ? Promise.resolve(null) : watchInstantLock(dapi, lock, tip - 2, signal, opened)
      // Listening before the broadcast; a feed that never opens only costs the chain-lock wait.
      await within(Promise.race([open, islock]), ISLOCK_OPEN_MS)
      opts.signal?.throwIfAborted()
      await broadcastTx(ep, bytesToHex(lock.raw), lock.txid)
      const found = await within(islock, opts.islockWaitMs ?? ISLOCK_WAIT_MS)
      opts.signal?.throwIfAborted()
      if (found) return { type: 'instant', txid: lock.txid, raw: lock.raw, islock: found }
    } finally {
      stop.abort()
    }
  }
  while (Date.now() < deadline) {
    if (height === null) {
      opts.onStatus?.('Waiting for the deposit to be mined…')
      height = await getTxHeight(ep, lock.txid).catch(() => null)
    }
    if (height !== null) {
      opts.onStatus?.(`Mined at ${height}; waiting for Platform to chain-lock it…`)
      const clh = await platformChainLockedHeight().catch(() => null)
      if (clh !== null && clh >= height) return { type: 'chain', txid: lock.txid, height }
    }
    await sleep(5000, opts.signal)
  }
  throw new Error('timed out waiting for the asset lock to be provable; it is saved — try again later')
}

/**
 * The unspent outputs paying `address`, built from raw transactions (their txid computed
 * here): outputs to the address's P2PKH script, minus any a later transaction spends.
 */
export class DepositTracker {
  private readonly script: string
  private readonly unspent = new Map<string, Utxo>()
  private readonly spent = new Set<string>()

  constructor(address: string) {
    this.script = bytesToHex(p2pkh(addressHash(address)))
  }

  ingest(raw: Uint8Array): void {
    let parsed: { inputs: { txid: string; vout: number }[]; outputs: { value: bigint; script: Uint8Array }[] }
    try {
      parsed = parseTx(raw)
    } catch {
      return // a bloom false positive we cannot parse
    }
    for (const i of parsed.inputs) {
      const k = `${i.txid}:${i.vout}`
      this.unspent.delete(k)
      this.spent.add(k)
    }
    const id = txid(raw)
    parsed.outputs.forEach((o, vout) => {
      const k = `${id}:${vout}`
      if (bytesToHex(o.script) !== this.script || this.spent.has(k)) return
      if (o.value > BigInt(Number.MAX_SAFE_INTEGER)) return
      this.unspent.set(k, { txid: id, vout, satoshis: Number(o.value), scriptPubKey: this.script, confirmations: 0 })
    })
  }

  get total(): number {
    let t = 0
    for (const u of this.unspent.values()) t += u.satoshis
    return t
  }

  get utxos(): Utxo[] {
    return [...this.unspent.values()]
  }
}

/** Parse inputs' outpoints and outputs of a raw Dash transaction. */
function parseTx(raw: Uint8Array): { inputs: { txid: string; vout: number }[]; outputs: { value: bigint; script: Uint8Array }[] } {
  const inputs: { txid: string; vout: number }[] = []
  let at = 4
  const need = (n: number): void => {
    if (at + n > raw.length) throw new Error('truncated transaction')
  }
  const varintAt = (): number => {
    need(1)
    const first = raw[at++] as number
    if (first < 0xfd) return first
    const len = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    need(len)
    let n = 0
    for (let i = len - 1; i >= 0; i--) n = n * 256 + (raw[at + i] as number)
    at += len
    return n
  }
  const count = varintAt()
  for (let i = 0; i < count; i++) {
    need(36)
    const id = bytesToHex(raw.slice(at, at + 32).reverse())
    const vout = new DataView(raw.buffer, raw.byteOffset + at + 32, 4).getUint32(0, true)
    at += 36
    const len = varintAt()
    need(len + 4)
    at += len + 4
    inputs.push({ txid: id, vout })
  }
  return { inputs, outputs: parseOutputs(raw) }
}

/**
 * The Core height to start a deposit watch from (the tip, before the address is shown): null
 * when no node answers. A build with no DAPI nodes throws, so no address is shown that nothing
 * could watch.
 */
export async function currentHeight(ep: CoreEndpoints): Promise<number | null> {
  const dapi = dapiOf(ep)
  return dapi.bestHeight().catch(() => null)
}

/** Where a deposit watch starts: a recorded height, else a height or start time. */
export type WatchStart = number | { readonly startedAt: number }

/** Blocks added to a rewind from a start time (2.5-minute target spacing). */
const REWIND_MARGIN_BLOCKS = 50
/** The deepest rewind, about a week: a longer replay would not reach the live feed. */
const MAX_REWIND_BLOCKS = 4032
/** Blocks subtracted from a recorded height: nodes' tips differ by a block or two. */
const START_HEIGHT_MARGIN = 6

/** The block to replay from: the recorded height, else far enough back to cover `startedAt`. */
export async function watchFrom(dapi: DapiCore, start: WatchStart): Promise<number> {
  if (typeof start === 'number') return Math.max(1, start - START_HEIGHT_MARGIN)
  const elapsedBlocks = Math.ceil(Math.max(0, Date.now() - start.startedAt) / 150_000)
  return Math.max(1, (await dapi.bestHeight()) - Math.min(elapsedBlocks + REWIND_MARGIN_BLOCKS, MAX_REWIND_BLOCKS))
}

/**
 * A filter for `address`. With BLOOM_UPDATE_ALL the node inserts each matched outpoint, so
 * one sized for the address hash alone would saturate after a match or two and stream every
 * transaction: it has room for 50 elements (the 200-byte floor).
 */
function addressFilter(address: string): BloomFilter {
  return bloomFilter([addressHash(address)], 0.0001, undefined, 50)
}

/** How long a deposit check's feed must be quiet, once its history is in, before a payment stands. */
const SETTLE_MS = 3_000
/**
 * The same for "nothing there": longer, since a node sends its mempool's matches in one batch
 * once it has read them all, and a false zero could leave a payment behind.
 */
const SETTLE_EMPTY_MS = 15_000
/** How long the second node is waited for once the first has answered. */
const SECOND_OPINION_MS = 5_000

/**
 * What one node's feed from `height` says `address` holds: its history block by block, then
 * its mempool. The total stands once (about) every block to the tip is in and the feed has been
 * quiet for {@link SETTLE_MS} ({@link SETTLE_EMPTY_MS} for zero); null if the feed ends first.
 */
async function heldOn(dapi: DapiCore, node: string, address: string, height: number, blocks: number, signal: AbortSignal): Promise<number | null> {
  const tracker = new DepositTracker(address)
  const feed = dapi.watch(addressFilter(address), height, { node, signal })
  let seen = 0
  let quietSince = Date.now()
  let pending = feed.next()
  for (;;) {
    // Returning (or failing) aborts the fetch under a read still in flight: observe it.
    pending.catch(() => undefined)
    const next = await within(pending, SETTLE_MS)
    if (next === null) {
      if (seen >= blocks && (tracker.total > 0 || Date.now() - quietSince >= SETTLE_EMPTY_MS)) return tracker.total
      continue
    }
    if (next.done) return null
    quietSince = Date.now()
    if (next.value.kind === 'block') seen++
    else if (next.value.kind === 'txs') for (const raw of next.value.txs) tracker.ingest(raw)
    pending = feed.next()
  }
}

/**
 * What `address` holds (duffs), confirmed or in the mempool, from DAPI feeds from `from`: the
 * larger of what two nodes say (one can lag or hide a payment). Throws when no node answers
 * within `timeoutMs`.
 */
export async function depositHeld(ep: CoreEndpoints, address: string, from: WatchStart, timeoutMs = 60_000): Promise<number> {
  const dapi = dapiOf(ep)
  const run = new AbortController()
  const timer = setTimeout(() => run.abort(), timeoutMs)
  try {
    const height = await watchFrom(dapi, from)
    // A node a block or two behind the tip sends that many fewer.
    const blocks = (await dapi.bestHeight()) - height - 1
    const order = shuffled(dapi.nodes)
    const answers: number[] = []
    let answered = (): void => undefined
    const first = new Promise<void>((r) => {
      answered = r
    })
    const lanes = [0, 1].map(async (start) => {
      for (let i = start; i < order.length && !run.signal.aborted; i += 2) {
        const held = await heldOn(dapi, order[i] as string, address, height, blocks, run.signal).catch(() => null)
        if (held !== null) {
          answers.push(held)
          answered()
          return
        }
      }
    })
    const all = Promise.all(lanes)
    await Promise.race([all, first.then(() => within(all, SECOND_OPINION_MS))])
    if (answers.length > 0) return Math.max(...answers)
  } catch {
    // no node answered; reported below
  } finally {
    clearTimeout(timer)
    run.abort()
  }
  throw new Error('could not check the deposit address (no Dash network node answered)')
}

/** Feeds watching a deposit, each on its own node. */
const DEPOSIT_FEEDS = 2
/** A feed silent this long is replaced (a merkle block arrives for every new block, ~2.5 minutes). */
const FEED_IDLE_MS = 10 * 60_000

/**
 * Wait until `address` holds at least `minDuffs`, and return its outputs. The deposit is seen
 * on DAPI bloom-filtered transaction feeds from `from` (history, then the mempool and new
 * blocks) on two nodes at once; a feed that fails, ends or goes silent moves to another node.
 */
export async function waitForDeposit(
  ep: CoreEndpoints,
  address: string,
  minDuffs: number,
  opts: { signal?: AbortSignal; onSeen?: (duffs: number) => void; from?: WatchStart } = {},
): Promise<Utxo[]> {
  const dapi = dapiOf(ep)
  const tracker = new DepositTracker(address)
  const from = opts.from ?? { startedAt: Date.now() }
  const stop = new AbortController()
  const signal = opts.signal ? anyOf(opts.signal, stop.signal) : stop.signal
  try {
    const found = await onNodes(
      dapi.nodes,
      DEPOSIT_FEEDS,
      signal,
      async (node) => {
        // Ended on return too: a read still pending under an idle feed would otherwise hold it open.
        const run = new AbortController()
        try {
          const feed = dapi.watch(addressFilter(address), await watchFrom(dapi, from), { node, signal: anyOf(signal, run.signal) })
          let pending = feed.next()
          for (;;) {
            pending.catch(() => undefined)
            const next = await within(pending, FEED_IDLE_MS)
            if (next === null || next.done) return null
            if (next.value.kind === 'txs') {
              for (const raw of next.value.txs) tracker.ingest(raw)
              opts.onSeen?.(tracker.total)
              if (tracker.total >= minDuffs) return tracker.utxos
            }
            pending = feed.next()
          }
        } finally {
          run.abort()
        }
      },
      { forever: true, retryMs: 5000 },
    )
    if (found) return found
    throw new DOMException('cancelled', 'AbortError')
  } finally {
    stop.abort()
  }
}

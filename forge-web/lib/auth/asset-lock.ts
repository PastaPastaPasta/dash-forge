/**
 * Core-chain side of creating an identity in the browser (`ux-dx-spec.md` §2.2 tile 2), ported
 * from `tools/mint-identity` (tx.mjs, lock.mjs, dapi-core.mjs):
 *
 *   1. watch the deposit address through DAPI (the evonodes' Core service, `dapi-core.ts`): a
 *      bloom-filtered `subscribeToTransactionsWithProofs` feed from the height the creation
 *      started at. A block explorer (Insight; configurable) is asked only when the feed is
 *      idle or unavailable;
 *   2. build and sign a type-8 asset-lock transaction spending them to one credit output
 *      controlled by the asset-lock key, and broadcast it (DAPI first, the explorer as
 *      fallback);
 *   3. prove the lock: an InstantSend lock where a public `getislocks` endpoint exists
 *      (testnet), else a chain-lock proof once DAPI reports the transaction mined and
 *      Platform's chain-locked Core height reaches its block (devnets).
 *
 * Neither source is trusted with amounts. Every input is derived from a raw funding
 * transaction whose txid is computed here — for the explorer, fetched and checked against the
 * txid it named — and parsed for the output's value and script before anything is signed.
 * (The legacy sighash does not commit to input values: trusting a claimed amount would let a
 * lying source turn the deposit into miner fees.) A node or explorer can delay the user or
 * hide funds, but not take them or learn a key.
 */

import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'

import { ACTIVE_NETWORK, NETWORKS, type Network } from '../constants'
import { isAbort, sleep } from '../sdk/facade'
import { base58CheckDecode } from './base58'
import { DapiCore, bloomFilter } from './dapi-core'
import { decodeWif } from './wif'

// @noble/secp256k1 v3 needs sync hashes wired for sign/getPublicKey.
secp.hashes.sha256 = sha256
secp.hashes.hmacSha256 = (k, m) => hmac(sha256, k, m)

/** DAPI, the fallback explorer, and the lock-proof endpoint per network. */
export interface CoreEndpoints {
  /** DAPI nodes (`https://host:port`) serving the Core gRPC-web service; empty = explorer only. */
  readonly dapi: readonly string[]
  /** Insight API base URL, asked only when DAPI cannot answer. */
  readonly insight: string
  /** JSON-RPC with `getislocks` (InstantSend proof), or null to use chain-lock proofs. */
  readonly islockRpc: string | null
}

/** Where Settings stores a user-chosen block explorer (Insight API base URL). */
export const INSIGHT_OVERRIDE_KEY = 'forge:insight-url'

/** The endpoints this build uses (Settings may override the explorer, spec §2.2). */
export function coreEndpoints(network: Network = ACTIVE_NETWORK.network): CoreEndpoints {
  const override = typeof window !== 'undefined' ? window.localStorage.getItem(INSIGHT_OVERRIDE_KEY) : null
  const dapi = NETWORKS[network].dapiAddresses
  if (network === 'devnet') {
    return { dapi, insight: override ?? `https://insight.${ACTIVE_NETWORK.devnetName}.networks.dash.org/insight-api`, islockRpc: null }
  }
  if (network === 'testnet') {
    return { dapi, insight: override ?? 'https://insight.testnet.networks.dash.org/insight-api', islockRpc: 'https://trpc.digitalcash.dev' }
  }
  return { dapi, insight: override ?? 'https://insight.dash.org/insight-api', islockRpc: null }
}

function dapiOf(ep: CoreEndpoints): DapiCore | null {
  return ep.dapi.length > 0 ? new DapiCore(ep.dapi) : null
}

// ---------------------------------------------------------------------------
// Insight
// ---------------------------------------------------------------------------

export interface Utxo {
  readonly txid: string
  readonly vout: number
  readonly satoshis: number
  readonly scriptPubKey: string
  readonly confirmations: number
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`)
  return (await res.json()) as T
}

export async function getUtxos(ep: CoreEndpoints, address: string): Promise<Utxo[]> {
  const rows = await getJson<Utxo[]>(`${ep.insight}/addr/${address}/utxo`)
  return rows.map((u) => ({ txid: u.txid, vout: u.vout, satoshis: u.satoshis, scriptPubKey: u.scriptPubKey, confirmations: u.confirmations ?? 0 }))
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

/**
 * The deposit's spendable outputs, each proven from its raw funding transaction: the raw
 * bytes must hash to the txid the explorer named, and the value and script come from those
 * bytes. Outputs that do not pay `address`'s P2PKH script are dropped.
 */
export async function verifiedUtxos(ep: CoreEndpoints, address: string, listed: readonly Utxo[]): Promise<Utxo[]> {
  const script = bytesToHex(p2pkh(addressHash(address)))
  const out: Utxo[] = []
  const rawCache = new Map<string, Uint8Array>()
  for (const u of listed) {
    let raw = rawCache.get(u.txid)
    if (!raw) {
      raw = hexToBytes((await getJson<{ rawtx: string }>(`${ep.insight}/rawtx/${u.txid}`)).rawtx)
      if (txid(raw) !== u.txid) throw new Error(`the block explorer returned a transaction that is not ${u.txid}`)
      rawCache.set(u.txid, raw)
    }
    const o = parseOutputs(raw)[u.vout]
    if (!o || bytesToHex(o.script) !== script) continue
    if (o.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('deposit output too large')
    out.push({ ...u, satoshis: Number(o.value), scriptPubKey: script })
  }
  return out
}

/** The height `txid` was mined at (null while unconfirmed): DAPI first, the explorer if DAPI fails. */
export async function getTxHeight(ep: CoreEndpoints, txid: string): Promise<number | null> {
  const dapi = dapiOf(ep)
  if (dapi) {
    try {
      return (await dapi.transaction(txid))?.height ?? null
    } catch {
      // fall through to the explorer
    }
  }
  const tx = await getJson<{ blockheight?: number }>(`${ep.insight}/tx/${txid}`)
  return typeof tx.blockheight === 'number' && tx.blockheight >= 0 ? tx.blockheight : null
}

/** Whether the network knows `txid` (mempool or chain), through DAPI or the explorer. */
async function txKnown(ep: CoreEndpoints, txid: string): Promise<boolean> {
  const dapi = dapiOf(ep)
  if (dapi && (await dapi.transaction(txid).catch(() => null))) return true
  return getJson(`${ep.insight}/tx/${txid}`).then(
    () => true,
    () => false,
  )
}

/**
 * Broadcast through DAPI, else the explorer. Re-sending an accepted transaction is harmless;
 * a transaction the network already has counts as sent, so a lost response never strands the
 * deposit.
 */
export async function broadcastTx(ep: CoreEndpoints, rawHex: string, txid: string): Promise<void> {
  const dapi = dapiOf(ep)
  let dapiError: unknown = null
  if (dapi) {
    try {
      await dapi.broadcast(hexToBytes(rawHex))
      return
    } catch (e) {
      dapiError = e
    }
  }
  try {
    await getJson(`${ep.insight}/tx/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawtx: rawHex }),
    })
  } catch (e) {
    if (!(await txKnown(ep, txid))) throw dapiError ?? e
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
  // Every input's script must be the lock key's own P2PKH (verifiedUtxos checked the values).
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

async function fetchIslock(rpc: string, id: string): Promise<Uint8Array | null> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getislocks', params: [[id]] }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { result?: { txid?: string; hex?: string }[] }
  const hit = data.result?.find((r) => r?.txid === id && r.hex)
  return hit?.hex ? hexToBytes(hit.hex) : null
}

/**
 * Wait until the asset lock is provable: an InstantSend lock where the network offers one
 * (up to 90 s), else a chain-lock proof once the tx is mined and Platform's chain-locked Core
 * height reaches it (`platformChainLockedHeight` is read from Platform status).
 */
export async function obtainLockProof(
  ep: CoreEndpoints,
  lock: { txid: string; raw: Uint8Array },
  platformChainLockedHeight: () => Promise<number | null>,
  opts: { signal?: AbortSignal; onStatus?: (s: string) => void; timeoutMs?: number } = {},
): Promise<LockProof> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60 * 1000)
  if (ep.islockRpc) {
    opts.onStatus?.('Waiting for InstantSend…')
    const until = Date.now() + 90_000
    while (Date.now() < until) {
      const islock = await fetchIslock(ep.islockRpc, lock.txid).catch(() => null)
      if (islock) return { type: 'instant', txid: lock.txid, raw: lock.raw, islock }
      await sleep(3000, opts.signal)
    }
  }
  let height: number | null = null
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

/** The explorer's view of the deposit, every output proven from its raw transaction. */
async function explorerDeposit(ep: CoreEndpoints, address: string): Promise<Utxo[]> {
  return verifiedUtxos(ep, address, await getUtxos(ep, address))
}

/** The Core height to start a deposit watch from (the tip, before the address is shown). */
export async function currentHeight(ep: CoreEndpoints): Promise<number | null> {
  const dapi = dapiOf(ep)
  return dapi ? dapi.bestHeight().catch(() => null) : null
}

/** Where a deposit watch starts: a recorded height, else a height or start time. */
export type WatchStart = number | { readonly startedAt: number }

/** Blocks added to a rewind from a start time (2.5-minute target spacing). */
const REWIND_MARGIN_BLOCKS = 50

/** The block to replay from: the recorded height, else far enough back to cover `startedAt`. */
export async function watchFrom(dapi: DapiCore, start: WatchStart): Promise<number> {
  if (typeof start === 'number') return start
  const elapsedBlocks = Math.ceil(Math.max(0, Date.now() - start.startedAt) / 150_000)
  return Math.max(1, (await dapi.bestHeight()) - elapsedBlocks - REWIND_MARGIN_BLOCKS)
}

/**
 * What `address` holds (duffs): DAPI's history from `from`, else the explorer.
 * Throws when neither can say.
 */
export async function depositHeld(ep: CoreEndpoints, address: string, from: WatchStart): Promise<number> {
  const dapi = dapiOf(ep)
  if (dapi) {
    try {
      const height = await watchFrom(dapi, from)
      const tracker = new DepositTracker(address)
      const count = (await dapi.bestHeight()) - height + 1
      for await (const txs of dapi.watch(bloomFilter([addressHash(address)]), height, { count: Math.max(1, count) })) {
        for (const raw of txs) tracker.ingest(raw)
      }
      return tracker.total
    } catch {
      // fall through to the explorer
    }
  }
  return (await getUtxos(ep, address)).reduce((s, u) => s + u.satoshis, 0)
}

/** How long the DAPI feed may be silent before the explorer is asked as well. */
const FEED_IDLE_MS = 30_000

/**
 * Wait until `address` holds at least `minDuffs`, and return its outputs. The deposit is seen
 * on a DAPI bloom-filtered transaction feed from `from` (history, then the mempool and
 * new blocks); the explorer is asked whenever the feed is idle, fails, or DAPI is not
 * configured.
 */
export async function waitForDeposit(
  ep: CoreEndpoints,
  address: string,
  minDuffs: number,
  opts: { signal?: AbortSignal; onSeen?: (duffs: number) => void; intervalMs?: number; from?: WatchStart } = {},
): Promise<Utxo[]> {
  const dapi = dapiOf(ep)
  const tracker = new DepositTracker(address)
  const askExplorer = async (): Promise<Utxo[] | null> => {
    const utxos = await explorerDeposit(ep, address).catch(() => null)
    if (utxos) {
      const total = utxos.reduce((s, u) => s + u.satoshis, 0)
      opts.onSeen?.(Math.max(total, tracker.total))
      if (total >= minDuffs) return utxos
    }
    return null
  }
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError')
    if (dapi) {
      const run = new AbortController()
      const stop = (): void => run.abort()
      opts.signal?.addEventListener('abort', stop, { once: true })
      try {
        const height = await watchFrom(dapi, opts.from ?? { startedAt: Date.now() })
        const feed = dapi.watch(bloomFilter([addressHash(address)]), height, { signal: run.signal })
        // One read in flight at a time: an idle timeout asks the explorer, then keeps waiting
        // on the same read (a second next() would queue behind it and drop its batch).
        let pending = feed.next()
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const idle = new Promise<'idle'>((r) => {
            timer = setTimeout(() => r('idle'), FEED_IDLE_MS)
          })
          const next = await Promise.race([pending, idle])
          clearTimeout(timer)
          if (next === 'idle') {
            const found = await askExplorer()
            if (found) return found
            continue
          }
          if (next.done) break
          for (const raw of next.value) tracker.ingest(raw)
          opts.onSeen?.(tracker.total)
          if (tracker.total >= minDuffs) return tracker.utxos
          pending = feed.next()
        }
      } catch (e) {
        if (isAbort(e) && opts.signal?.aborted) throw e
        // The feed failed or ended: ask the explorer, then reconnect.
      } finally {
        run.abort()
        opts.signal?.removeEventListener('abort', stop)
      }
    }
    const found = await askExplorer()
    if (found) return found
    await sleep(dapi ? 5000 : (opts.intervalMs ?? 4000), opts.signal)
  }
}

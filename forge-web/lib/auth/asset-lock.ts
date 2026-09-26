/**
 * Core-chain side of creating an identity in the browser (`ux-dx-spec.md` §2.2 tile 2), ported
 * from `tools/mint-identity` (tx.mjs, lock.mjs, insight.mjs):
 *
 *   1. watch the deposit address through a block explorer (Insight; configurable) until funds
 *      arrive;
 *   2. build and sign a type-8 asset-lock transaction spending them to one credit output
 *      controlled by the asset-lock key, and broadcast it;
 *   3. prove the lock: an InstantSend lock where a public `getislocks` endpoint exists
 *      (testnet), else a chain-lock proof once Platform's chain-locked Core height reaches the
 *      transaction's block (devnets).
 *
 * The explorer can delay the user but not take funds or keys: it only sees the address and
 * the signed transaction.
 */

import * as secp from '@noble/secp256k1'
import { hmac } from '@noble/hashes/hmac.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'

import { ACTIVE_NETWORK, type Network } from '../constants'
import { sleep } from '../sdk/facade'
import { base58CheckDecode } from './base58'
import { decodeWif } from './wif'

// @noble/secp256k1 v3 needs sync hashes wired for sign/getPublicKey.
secp.hashes.sha256 = sha256
secp.hashes.hmacSha256 = (k, m) => hmac(sha256, k, m)

/** Explorer + lock-proof endpoints per network. */
export interface CoreEndpoints {
  readonly insight: string
  /** JSON-RPC with `getislocks` (InstantSend proof), or null to use chain-lock proofs. */
  readonly islockRpc: string | null
}

/** Where Settings stores a user-chosen block explorer (Insight API base URL). */
export const INSIGHT_OVERRIDE_KEY = 'forge:insight-url'

/** The endpoints this build uses (Settings may override the explorer, spec §2.2). */
export function coreEndpoints(network: Network = ACTIVE_NETWORK.network): CoreEndpoints {
  const override = typeof window !== 'undefined' ? window.localStorage.getItem(INSIGHT_OVERRIDE_KEY) : null
  if (network === 'devnet') {
    return { insight: override ?? `https://insight.${ACTIVE_NETWORK.devnetName}.networks.dash.org/insight-api`, islockRpc: null }
  }
  if (network === 'testnet') {
    return { insight: override ?? 'https://insight.testnet.networks.dash.org/insight-api', islockRpc: 'https://trpc.digitalcash.dev' }
  }
  return { insight: override ?? 'https://insight.dash.org/insight-api', islockRpc: null }
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

export async function getTxHeight(ep: CoreEndpoints, txid: string): Promise<number | null> {
  const tx = await getJson<{ blockheight?: number }>(`${ep.insight}/tx/${txid}`)
  return typeof tx.blockheight === 'number' && tx.blockheight >= 0 ? tx.blockheight : null
}

export async function broadcastTx(ep: CoreEndpoints, rawHex: string, txid: string): Promise<void> {
  try {
    await getJson(`${ep.insight}/tx/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawtx: rawHex }),
    })
  } catch (e) {
    // A lost response can hide an accepted broadcast: never strand the deposit over it.
    const known = await getJson(`${ep.insight}/tx/${txid}`).then(
      () => true,
      () => false,
    )
    if (!known) throw e
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

/** Wait until `address` holds at least `minDuffs` (polling the explorer). */
export async function waitForDeposit(
  ep: CoreEndpoints,
  address: string,
  minDuffs: number,
  opts: { signal?: AbortSignal; onSeen?: (duffs: number) => void; intervalMs?: number } = {},
): Promise<Utxo[]> {
  for (;;) {
    const utxos = await getUtxos(ep, address).catch(() => [] as Utxo[])
    const total = utxos.reduce((s, u) => s + u.satoshis, 0)
    opts.onSeen?.(total)
    if (total >= minDuffs && utxos.length > 0) return utxos
    await sleep(opts.intervalMs ?? 4000, opts.signal)
  }
}

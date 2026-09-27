/**
 * Identity creation without a block explorer: DAPI Core over gRPC-web (framing, bloom filter,
 * the transaction feed) and the asset-lock helpers falling back from a down Insight — the
 * 2026-09-27 moutai outage, where every explorer request returned 503.
 */

import * as secp from '@noble/secp256k1'
import { concatBytes } from '@noble/hashes/utils.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DapiCore, bloomContains, bloomFilter, decode, field, murmur3, takeFrames } from './dapi-core'
import { DepositTracker, broadcastTx, buildPayment, getTxHeight, hash160, txid, waitForDeposit, type CoreEndpoints, type Utxo } from './asset-lock'
import { base58CheckEncode } from './base58'

const SERVICE = 'org.dash.platform.dapi.v0.Core'

function frame(flag: number, payload: Uint8Array): Uint8Array {
  const h = new Uint8Array(5)
  h[0] = flag
  new DataView(h.buffer).setUint32(1, payload.length)
  return concatBytes(h, payload)
}
const trailer = (status: number, message = ''): Uint8Array =>
  frame(0x80, new TextEncoder().encode(`grpc-status:${status}\r\n${message ? `grpc-message:${message}\r\n` : ''}`))

/** A deposit key, its address, and a funding transaction paying it `duffs` (output 0). */
function deposit(duffs: number): { address: string; raw: Uint8Array; id: string; script: string } {
  const priv = new Uint8Array(32).fill(9)
  const pub = secp.getPublicKey(priv, true)
  const script = `76a914${Array.from(hash160(pub), (b) => b.toString(16).padStart(2, '0')).join('')}88ac`
  const address = base58CheckEncode(new Uint8Array([140, ...hash160(pub)]))
  const utxo: Utxo = { txid: 'cd'.repeat(32), vout: 0, satoshis: duffs + 10_000, scriptPubKey: script, confirmations: 9 }
  const pay = buildPayment([utxo], priv, { address, duffs }, address, 10_000)
  return { address, raw: pay.raw, id: pay.txid, script }
}

/**
 * A fetch that plays a down Insight (503 for every explorer URL) and a DAPI node serving the
 * Core service from `txs`, a transaction feed of `feed`, and a broadcast log.
 */
function network(opts: { feed?: Uint8Array[][]; txs?: Map<string, { raw: Uint8Array; height: number }> }) {
  const broadcasts: Uint8Array[] = []
  const explorerHits: string[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith('https://insight.invalid')) {
      explorerHits.push(url)
      return new Response('Back-end server is at capacity', { status: 503 })
    }
    const method = url.slice(url.indexOf(SERVICE) + SERVICE.length + 1)
    const body = (init?.body as Uint8Array).slice(5)
    const req = decode(body)
    if (method === 'getBestBlockHeight') return new Response(concatBytes(frame(0, field(1, 88_900)), trailer(0)))
    if (method === 'broadcastTransaction') {
      broadcasts.push(req.get(1)?.[0] as Uint8Array)
      return new Response(concatBytes(frame(0, field(1, 'ok')), trailer(0)))
    }
    if (method === 'getTransaction') {
      const id = new TextDecoder().decode(req.get(1)?.[0] as Uint8Array)
      const tx = opts.txs?.get(id)
      if (!tx) return new Response(null, { headers: { 'grpc-status': '5', 'grpc-message': 'Transaction%20not%20found' } })
      const msg = concatBytes(field(1, tx.raw), field(2, new Uint8Array(32).fill(1)), field(3, tx.height), field(6, true))
      return new Response(concatBytes(frame(0, msg), trailer(0)))
    }
    if (method === 'subscribeToTransactionsWithProofs') {
      const chunks = (opts.feed ?? []).map((txs) => frame(0, field(1, concatBytes(...txs.map((t) => field(1, t))))))
      // A merkle block (field 3) and an islock batch (field 2) must be skipped.
      chunks.unshift(frame(0, field(3, new Uint8Array(80))))
      chunks.push(frame(0, field(2, field(1, new Uint8Array(4)))))
      const history = (req.get(4)?.[0] ?? 0) as number
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of chunks) c.enqueue(ch)
          // History mode (count > 0) ends with OK trailers; a live subscription stays open.
          if (history > 0) {
            c.enqueue(trailer(0))
            c.close()
          }
        },
      })
      return new Response(stream)
    }
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchImpl)
  return { fetchImpl, broadcasts, explorerHits }
}

const EP: CoreEndpoints = { dapi: ['https://dapi.invalid:1443'], insight: 'https://insight.invalid/insight-api', islockRpc: null }

describe('DAPI Core client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('frames a gRPC-web request and reads the reply, trailers and NOT_FOUND', async () => {
    const d = deposit(1_000_000)
    network({ txs: new Map([[d.id, { raw: d.raw, height: 88_861 }]]) })
    const core = new DapiCore(EP.dapi)
    expect(await core.bestHeight()).toBe(88_900)
    const tx = await core.transaction(d.id)
    expect(tx?.height).toBe(88_861)
    expect(tx?.chainLocked).toBe(true)
    expect(txid(tx?.raw ?? new Uint8Array(0))).toBe(d.id)
    expect(await core.transaction('ee'.repeat(32))).toBeNull()
  })

  it('splits frames across chunk boundaries', () => {
    const all = concatBytes(frame(0, field(1, 7)), trailer(0))
    const first = takeFrames(all.slice(0, 4))
    expect(first.messages).toEqual([])
    const second = takeFrames(concatBytes(first.rest, all.slice(4)))
    expect(second.messages.length).toBe(1)
    expect(second.trailers?.['grpc-status']).toBe('0')
  })

  it('murmur3 matches the BIP37 reference vectors', () => {
    // Vectors from rust-dashcore dash/src/bloom/hash.rs (Dash Core's MurmurHash3).
    const enc = (t: string): Uint8Array => new TextEncoder().encode(t)
    expect(murmur3(0, new Uint8Array(0))).toBe(0)
    expect(murmur3(0xfba4c795, new Uint8Array(0))).toBe(0x6a396f08)
    expect(murmur3(0xffffffff, new Uint8Array(0))).toBe(0x81f16f39)
    expect(murmur3(0, Uint8Array.of(0x00))).toBe(0x514e28b7)
    expect(murmur3(0, Uint8Array.of(0xff))).toBe(0xfd6cf10d)
    expect(murmur3(0, Uint8Array.of(0x21, 0x43, 0x65, 0x87))).toBe(0xf55b516b)
    expect(murmur3(0x5082edee, Uint8Array.of(0x21, 0x43, 0x65, 0x87))).toBe(0x2362f9de)
    expect(murmur3(0, enc('Hello, world!'))).toBe(0xc0363e43)
    expect(murmur3(0xdeadbeef, enc('test'))).toBe(0xaa22d41a)
  })

  it('builds a bloom filter that holds the address hash (update-all)', () => {
    const hash = new Uint8Array(20).fill(3)
    const f = bloomFilter([hash], 0.0001, 7)
    expect(bloomContains(f, hash)).toBe(true)
    expect(bloomContains(f, new Uint8Array(20).fill(4))).toBe(false)
    expect(f.flags).toBe(1)
    expect(f.data.length).toBeLessThanOrEqual(36_000)
    // Room for the outpoints BLOOM_UPDATE_ALL adds: 50 elements at 1e-4 is 119 bytes.
    expect(bloomFilter([hash], 0.0001, 7, 50).data.length).toBe(119)
  })
})

describe('identity creation with Insight down (HTTP 503)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sees the deposit on the DAPI feed, broadcasts and reads the height through DAPI', async () => {
    const d = deposit(3_000_000)
    const net = network({ feed: [[d.raw]], txs: new Map([['ab'.repeat(32), { raw: d.raw, height: 88_861 }]]) })
    const seen: number[] = []
    const utxos = await waitForDeposit(EP, d.address, 2_000_000, { onSeen: (n) => seen.push(n), from: 88_850 })
    expect(utxos).toEqual([{ txid: d.id, vout: 0, satoshis: 3_000_000, scriptPubKey: d.script, confirmations: 0 }])
    expect(seen.at(-1)).toBe(3_000_000)
    const sub = net.fetchImpl.mock.calls.find(([u]) => String(u).endsWith('subscribeToTransactionsWithProofs'))
    const req = decode(((sub?.[1] as RequestInit).body as Uint8Array).slice(5))
    expect(req.get(3)?.[0]).toBe(88_850 - 6) // a few blocks of slack for node tips

    await broadcastTx(EP, '00', 'ab'.repeat(32))
    expect(net.broadcasts.length).toBe(1)
    expect(await getTxHeight(EP, 'ab'.repeat(32))).toBe(88_861)
    expect(net.explorerHits).toEqual([])
  })

  it('without DAPI the explorer outage is still an error (nothing silently succeeds)', async () => {
    network({})
    await expect(broadcastTx({ ...EP, dapi: [] }, '00', 'ab'.repeat(32))).rejects.toThrow(/503/)
  })

  it('the tracker drops outputs a later transaction spends', () => {
    const d = deposit(1_000_000)
    const t = new DepositTracker(d.address)
    t.ingest(d.raw)
    expect(t.total).toBe(1_000_000)
    // A spend of output 0 (built by hand: one input, no outputs).
    const idLE = Uint8Array.from(d.id.match(/../g)!.map((h) => parseInt(h, 16))).reverse()
    const spend = concatBytes(Uint8Array.of(3, 0, 0, 0, 1), idLE, Uint8Array.of(0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0), new Uint8Array(4))
    t.ingest(spend)
    expect(t.total).toBe(0)
    t.ingest(Uint8Array.of(1, 2))
    expect(t.total).toBe(0)
  })
})

describe('where a deposit watch starts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the recorded height, else rewinds past the creation start', async () => {
    network({})
    const { watchFrom } = await import('./asset-lock')
    const core = new DapiCore(EP.dapi)
    expect(await watchFrom(core, 88_000)).toBe(88_000 - 6)
    // Started an hour ago: 24 blocks at 2.5 minutes, plus the 50-block margin, from tip 88_900.
    expect(await watchFrom(core, { startedAt: Date.now() - 3_600_000 })).toBe(88_900 - 24 - 50)
    // Long ago: at most about a week.
    expect(await watchFrom(core, { startedAt: 0 })).toBe(88_900 - 4032)
  })

  it('a DAPI-only zero is not "empty" (the mempool is not in its history); a payment is seen', async () => {
    const { depositHeld } = await import('./asset-lock')
    const d = deposit(4_000_000)
    network({})
    await expect(depositHeld(EP, d.address, 88_000)).rejects.toThrow(/could not check/)
    network({ feed: [[d.raw]] })
    expect(await depositHeld(EP, d.address, 88_000)).toBe(4_000_000)
  })
})

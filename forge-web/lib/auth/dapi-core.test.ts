/**
 * Identity creation through the evonodes alone: DAPI Core over gRPC-web (framing, bloom filter,
 * the transaction feed and its InstantSend locks) and the asset-lock helpers built on it. No
 * block explorer or JSON-RPC service is asked (the 2026-09-27 moutai outage had every explorer
 * request return 503; testnet's public `getislocks` RPC stopped following the chain).
 */

import * as secp from '@noble/secp256k1'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DapiCore, bloomContains, bloomFilter, decode, field, murmur3, takeFrames, type FeedEvent } from './dapi-core'
import {
  DepositTracker,
  broadcastTx,
  buildAssetLock,
  buildPayment,
  currentHeight,
  depositHeld,
  getTxHeight,
  hash160,
  islockTxid,
  lockFilter,
  sendAndProveLock,
  txid,
  waitForDeposit,
  watchFrom,
  type CoreEndpoints,
  type Utxo,
} from './asset-lock'
import { base58CheckEncode } from './base58'

const SERVICE = 'org.dash.platform.dapi.v0.Core'
const TIP = 88_900

function frame(flag: number, payload: Uint8Array): Uint8Array {
  const h = new Uint8Array(5)
  h[0] = flag
  new DataView(h.buffer).setUint32(1, payload.length)
  return concatBytes(h, payload)
}
const trailer = (status: number, message = ''): Uint8Array =>
  frame(0x80, new TextEncoder().encode(`grpc-status:${status}\r\n${message ? `grpc-message:${message}\r\n` : ''}`))
const islockFrame = (lock: Uint8Array): Uint8Array => frame(0, field(2, field(1, lock)))

const PRIV = new Uint8Array(32).fill(9)

/** A deposit key, its address, and a funding transaction paying it `duffs` (output 0). */
function deposit(duffs: number): { address: string; raw: Uint8Array; id: string; script: string } {
  const pub = secp.getPublicKey(PRIV, true)
  const script = `76a914${bytesToHex(hash160(pub))}88ac`
  const address = base58CheckEncode(new Uint8Array([140, ...hash160(pub)]))
  const utxo: Utxo = { txid: 'cd'.repeat(32), vout: 0, satoshis: duffs + 10_000, scriptPubKey: script, confirmations: 9 }
  const pay = buildPayment([utxo], PRIV, { address, duffs }, address, 10_000)
  return { address, raw: pay.raw, id: pay.txid, script }
}

/** An ISDLOCK (version 1) for `txid` spending `inputs`. */
function islock(id: string, inputs = 1): Uint8Array {
  return concatBytes(Uint8Array.of(1, inputs), new Uint8Array(36 * inputs).fill(7), hexToBytes(id).reverse(), new Uint8Array(32).fill(8), new Uint8Array(96).fill(9))
}

/**
 * A fetch that plays DAPI nodes serving the Core service: transactions in `txs`, a transaction
 * feed (one merkle block per historical block to {@link TIP}, then `feed`, then live), and a
 * broadcast log. A broadcast sends `islocksOnBroadcast(raw)` down every open live feed and,
 * with `mineOnBroadcast`, makes the transaction known at that height.
 */
function network(opts: {
  feed?: Uint8Array[][]
  txs?: Map<string, { raw: Uint8Array; height: number; instantLocked?: boolean }>
  /** The feed's transactions come this long after its history (a slow mempool read). */
  feedDelayMs?: number
  islocksOnBroadcast?: (raw: Uint8Array) => Uint8Array[]
  mineOnBroadcast?: number
  broadcastFails?: boolean
}) {
  const broadcasts: Uint8Array[] = []
  const calls: string[] = []
  const live = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const txs = opts.txs ?? new Map<string, { raw: Uint8Array; height: number; instantLocked?: boolean }>()
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = url.slice(url.indexOf(SERVICE) + SERVICE.length + 1)
    calls.push(method)
    const body = (init?.body as Uint8Array).slice(5)
    const req = decode(body)
    if (method === 'getBestBlockHeight') return new Response(concatBytes(frame(0, field(1, TIP)), trailer(0)))
    if (method === 'broadcastTransaction') {
      const raw = req.get(1)?.[0] as Uint8Array
      if (opts.broadcastFails) return new Response(null, { headers: { 'grpc-status': '3', 'grpc-message': 'txn-already-known' } })
      broadcasts.push(raw)
      if (opts.mineOnBroadcast) txs.set(txid(raw), { raw, height: opts.mineOnBroadcast })
      for (const c of live) for (const l of opts.islocksOnBroadcast?.(raw) ?? []) c.enqueue(islockFrame(l))
      return new Response(concatBytes(frame(0, field(1, 'ok')), trailer(0)))
    }
    if (method === 'getTransaction') {
      const id = new TextDecoder().decode(req.get(1)?.[0] as Uint8Array)
      const tx = txs.get(id)
      if (!tx) return new Response(null, { headers: { 'grpc-status': '5', 'grpc-message': 'Transaction%20not%20found' } })
      const mined = tx.height > 0
      const msg = concatBytes(
        field(1, tx.raw),
        ...(mined ? [field(2, new Uint8Array(32).fill(1)), field(3, tx.height), field(6, true)] : []),
        ...(tx.instantLocked ? [field(5, true)] : []),
      )
      return new Response(concatBytes(frame(0, msg), trailer(0)))
    }
    if (method === 'subscribeToTransactionsWithProofs') {
      const from = (req.get(3)?.[0] ?? 1) as number
      const count = (req.get(4)?.[0] ?? 0) as number
      const blocks = Array.from({ length: Math.max(0, (count || TIP - from + 1)) }, () => frame(0, field(3, new Uint8Array(80))))
      const feed = (opts.feed ?? []).map((t) => frame(0, field(1, concatBytes(...t.map((x) => field(1, x))))))
      const chunks = opts.feedDelayMs ? blocks : [...blocks, ...feed]
      const signal = init?.signal
      let ctl: ReadableStreamDefaultController<Uint8Array> | undefined
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c
          for (const ch of chunks) c.enqueue(ch)
          // History mode (count > 0) ends with OK trailers; a live subscription stays open.
          if (count > 0) {
            c.enqueue(trailer(0))
            c.close()
          } else live.add(c)
          if (opts.feedDelayMs) {
            setTimeout(() => {
              try {
                for (const ch of feed) c.enqueue(ch)
              } catch {
                // closed meanwhile
              }
            }, opts.feedDelayMs)
          }
        },
        cancel() {
          if (ctl) live.delete(ctl)
        },
      })
      signal?.addEventListener('abort', () => {
        if (ctl) live.delete(ctl)
        try {
          ctl?.error(new DOMException('aborted', 'AbortError'))
        } catch {
          // already closed
        }
      })
      return new Response(stream)
    }
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchImpl)
  return { fetchImpl, broadcasts, calls, live }
}

const NODES = ['https://dapi-a.invalid:1443', 'https://dapi-b.invalid:1443', 'https://dapi-c.invalid:1443', 'https://dapi-d.invalid:1443']
const EP: CoreEndpoints = { dapi: NODES }

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
    // Never under DAPI's 200-byte floor (50 elements at 1e-4 alone would be 119 bytes).
    expect(f.data.length).toBe(200)
    expect(bloomFilter([hash], 0.0001, 7, 50).data.length).toBe(200)
    expect(bloomFilter([hash], 0.0001, 7, 500).data.length).toBe(1198)
  })

  it('yields matched transactions, islocks and merkle blocks from the feed', async () => {
    const d = deposit(1_000_000)
    network({ feed: [[d.raw]] })
    const core = new DapiCore(EP.dapi)
    const events: FeedEvent[] = []
    let opened = false
    for await (const ev of core.watch(bloomFilter([new Uint8Array(20)]), TIP - 1, { count: 2, node: NODES[1], onOpen: () => (opened = true) })) events.push(ev)
    expect(opened).toBe(true)
    expect(events.map((e) => e.kind)).toEqual(['block', 'block', 'txs'])
    const sub = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('subscribeToTransactionsWithProofs'))
    expect(String(sub?.[0]).startsWith(NODES[1] as string)).toBe(true)
  })
})

describe('identity creation through DAPI alone', () => {
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
  })

  it('a refused broadcast of a transaction the network has counts as sent; an unknown one throws', async () => {
    const d = deposit(1_000_000)
    network({ broadcastFails: true, txs: new Map([[d.id, { raw: d.raw, height: 0 }]]) })
    await broadcastTx(EP, bytesToHex(d.raw), d.id)
    await expect(broadcastTx(EP, '00', 'ee'.repeat(32))).rejects.toThrow(/already-known/)
  })

  it('without DAPI nodes nothing silently succeeds, and no watch start is offered', async () => {
    await expect(broadcastTx({ dapi: [] }, '00', 'ab'.repeat(32))).rejects.toThrow(/no DAPI nodes/)
    await expect(currentHeight({ dapi: [] })).rejects.toThrow(/no DAPI nodes/)
    // A node that does not answer is only "height unknown".
    vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }))
    expect(await currentHeight(EP)).toBeNull()
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
    const core = new DapiCore(EP.dapi)
    expect(await watchFrom(core, 88_000)).toBe(88_000 - 6)
    // Started 59 minutes ago: 24 blocks at 2.5 minutes (rounded up), plus the 50-block margin, from
    // tip 88_900. Not exactly an hour: the milliseconds the test takes would round up to 25.
    expect(await watchFrom(core, { startedAt: Date.now() - 3_540_000 })).toBe(88_900 - 24 - 50)
    // Long ago: at most about a week.
    expect(await watchFrom(core, { startedAt: 0 })).toBe(88_900 - 4032)
  })

  /** `depositHeld`, with fake timers run until it settles. */
  async function held(address: string): Promise<number> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      let out: number | Error | undefined
      depositHeld(EP, address, TIP - 3).then(
        (n) => (out = n),
        (e: Error) => (out = e),
      )
      for (let i = 0; i < 200 && out === undefined; i++) await vi.advanceTimersByTimeAsync(500)
      if (out instanceof Error) throw out
      if (out === undefined) throw new Error('depositHeld did not settle')
      return out
    } finally {
      vi.useRealTimers()
    }
  }

  it('what the address holds: zero once the history is in, else what the feed paid it (mempool included)', async () => {
    const d = deposit(4_000_000)
    network({})
    expect(await held(d.address)).toBe(0)
    network({ feed: [[d.raw]] })
    expect(await held(d.address)).toBe(4_000_000)
  })

  it('a mempool batch that comes seconds after the history still counts (no false zero)', async () => {
    const d = deposit(4_000_000)
    network({ feed: [[d.raw]], feedDelayMs: 8_000 })
    expect(await held(d.address)).toBe(4_000_000)
  })

  it('no node answering is an error, not "empty"', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }))
    await expect(depositHeld(EP, deposit(1).address, TIP - 3)).rejects.toThrow(/could not check/)
  })
})

describe('the asset lock\'s InstantSend proof', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A signed asset lock spending a deposit, and its funding output. */
  function assetLock(): { txid: string; raw: Uint8Array; funding: string } {
    const d = deposit(3_000_000)
    const lock = buildAssetLock([{ txid: d.id, vout: 0, satoshis: 3_000_000, scriptPubKey: d.script, confirmations: 0 }], PRIV)
    return { txid: lock.txid, raw: lock.raw, funding: d.id }
  }

  it('reads the txid an ISDLOCK locks, and refuses malformed ones', () => {
    const id = 'ab'.repeat(31) + 'cd'
    expect(islockTxid(islock(id))).toBe(id)
    expect(islockTxid(islock(id, 3))).toBe(id)
    expect(islockTxid(islock(id).slice(1))).toBeNull()
    expect(islockTxid(islock(id).slice(0, -1))).toBeNull()
    expect(islockTxid(new Uint8Array(0))).toBeNull()
  })

  it('the lock filter matches its txid and the outpoint it spends in both byte orders', () => {
    const lock = assetLock()
    const f = lockFilter(lock)
    const vout = Uint8Array.of(0, 0, 0, 0)
    expect(f.data.length).toBeGreaterThanOrEqual(200)
    for (const id of [lock.txid, lock.funding]) {
      const display = hexToBytes(id)
      const internal = display.slice().reverse()
      const tail = id === lock.txid ? new Uint8Array(0) : vout
      expect(bloomContains(f, concatBytes(internal, tail))).toBe(true)
      expect(bloomContains(f, concatBytes(display, tail))).toBe(true)
    }
    expect(bloomContains(f, new Uint8Array(32).fill(1))).toBe(false)
  })

  it('opens feeds on three nodes before the broadcast and proves with the islock they carry', async () => {
    const lock = assetLock()
    const net = network({ islocksOnBroadcast: (raw) => [islock('ee'.repeat(32)), islock(txid(raw))] })
    const proof = await sendAndProveLock(EP, lock, async () => null)
    expect(proof).toEqual({ type: 'instant', txid: lock.txid, raw: lock.raw, islock: islock(lock.txid) })
    expect(net.broadcasts).toEqual([lock.raw])
    const subs = net.fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('subscribeToTransactionsWithProofs')).map(([u]) => String(u).split('/org.')[0])
    expect(new Set(subs).size).toBe(3)
    expect(net.calls.indexOf('subscribeToTransactionsWithProofs')).toBeLessThan(net.calls.indexOf('broadcastTransaction'))
    // A couple of blocks back from the tip, live (count 0).
    const req = decode(((net.fetchImpl.mock.calls.find(([u]) => String(u).endsWith('subscribeToTransactionsWithProofs'))?.[1] as RequestInit).body as Uint8Array).slice(5))
    expect(req.get(3)?.[0]).toBe(TIP - 2)
    expect(req.get(4)).toBeUndefined()
    // Every feed is closed once the proof is in.
    await vi.waitFor(() => expect(net.live.size).toBe(0))
  })

  it('without a matching islock, proves with a chain lock once Platform reaches the block', async () => {
    const lock = assetLock()
    const net = network({ islocksOnBroadcast: () => [islock('ee'.repeat(32))], mineOnBroadcast: 88_901 })
    const status: string[] = []
    const proof = await sendAndProveLock(EP, lock, async () => 88_901, { islockWaitMs: 50, onStatus: (s) => status.push(s) })
    expect(proof).toEqual({ type: 'chain', txid: lock.txid, height: 88_901 })
    expect(net.broadcasts.length).toBe(1)
    expect(status[0]).toMatch(/InstantSend/)
    await vi.waitFor(() => expect(net.live.size).toBe(0))
  })

  it('a resumed lock already InstantSend-locked in the mempool goes straight to a chain lock', async () => {
    const lock = assetLock()
    const net = network({ txs: new Map([[lock.txid, { raw: lock.raw, height: 0, instantLocked: true }]]) })
    const proof = await sendAndProveLock(EP, lock, async () => null, { timeoutMs: 100 }).catch((e: Error) => e)
    // Not mined yet: no islock wait, no broadcast, no feed; the chain-lock wait times out.
    expect(proof).toBeInstanceOf(Error)
    expect(net.broadcasts).toEqual([])
    expect(net.calls).not.toContain('subscribeToTransactionsWithProofs')
  }, 10_000) // one 5-second chain-lock poll

  it('an aborted signal stops before anything is asked', async () => {
    const net = network({})
    await expect(sendAndProveLock(EP, assetLock(), async () => null, { signal: AbortSignal.abort() })).rejects.toThrow()
    expect(net.calls).toEqual([])
  })

  it('a lock already mined is neither re-sent nor waited on for an islock', async () => {
    const lock = assetLock()
    const net = network({ txs: new Map([[lock.txid, { raw: lock.raw, height: 88_870 }]]) })
    const proof = await sendAndProveLock(EP, lock, async () => 88_880)
    expect(proof).toEqual({ type: 'chain', txid: lock.txid, height: 88_870 })
    expect(net.broadcasts).toEqual([])
    expect(net.calls).not.toContain('subscribeToTransactionsWithProofs')
  })
})

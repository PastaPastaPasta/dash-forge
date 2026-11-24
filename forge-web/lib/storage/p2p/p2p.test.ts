import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { CID } from 'multiformats/cid'
import { cidV1RawLeaves } from '../cid'
import { NodeCache, readFileRange } from './dag'
import {
  blockKey,
  cidBytes,
  CODEC_DAG_PB,
  CODEC_RAW,
  decodeMessage,
  encodeWantlist,
  frame,
  FrameReader,
  parseFileNode,
  protoFields,
  type BlockId,
} from './wire'
import { browserDialable, IpfsPeer, type PeerNode } from './peer'
import { ipfsCidOf, peerFirst, peerReadStats, resetPeerReads } from '.'

function varint(out: number[], v: number): void {
  let n = v
  while (n >= 0x80) {
    out.push((n % 128) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
}
function lenField(out: number[], field: number, body: ArrayLike<number>): void {
  varint(out, field * 8 + 2)
  varint(out, body.length)
  for (let i = 0; i < body.length; i++) out.push(body[i] as number)
}
function intField(out: number[], field: number, v: number): void {
  varint(out, field * 8)
  varint(out, v)
}

/** A kubo-layout UnixFS DAG (raw leaves, balanced, `links` per node) in a block map. */
function buildDag(bytes: Uint8Array, chunk: number, links: number, type = 2): { root: BlockId; blocks: Map<string, Uint8Array> } {
  const blocks = new Map<string, Uint8Array>()
  let level: { id: BlockId; size: number }[] = []
  for (let i = 0; i < Math.max(1, bytes.length); i += chunk) {
    const data = bytes.slice(i, i + chunk)
    const id: BlockId = { version: 1, codec: CODEC_RAW, digest: sha256(data) }
    blocks.set(blockKey(id), data)
    level.push({ id, size: data.length })
  }
  while (level.length > 1) {
    const next: typeof level = []
    for (let i = 0; i < level.length; i += links) {
      const kids = level.slice(i, i + links)
      const unixfs: number[] = []
      intField(unixfs, 1, type)
      intField(unixfs, 3, kids.reduce((s, k) => s + k.size, 0))
      for (const k of kids) intField(unixfs, 4, k.size)
      const node: number[] = []
      for (const k of kids) {
        const link: number[] = []
        lenField(link, 1, cidBytes(k.id))
        lenField(link, 2, [])
        intField(link, 3, k.size)
        lenField(node, 2, link)
      }
      lenField(node, 1, unixfs)
      const block = Uint8Array.from(node)
      const id: BlockId = { version: 1, codec: CODEC_DAG_PB, digest: sha256(block) }
      blocks.set(blockKey(id), block)
      next.push({ id, size: kids.reduce((s, k) => s + k.size, 0) })
    }
    level = next
  }
  return { root: (level[0] as { id: BlockId }).id, blocks }
}

function randomBytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

/** A bitswap 1.2 `payload` block for `data` under codec `codec`. */
function payloadMessage(data: Uint8Array, codec: number): Uint8Array {
  const prefix: number[] = []
  varint(prefix, 1)
  varint(prefix, codec)
  varint(prefix, 0x12)
  varint(prefix, 32)
  const block: number[] = []
  lenField(block, 1, prefix)
  lenField(block, 2, data)
  const msg: number[] = []
  lenField(msg, 3, block)
  return Uint8Array.from(msg)
}

describe('readFileRange', () => {
  const bytes = randomBytes(5000)
  const { root, blocks } = buildDag(bytes, 37, 4)
  const asked: string[] = []
  const get = async (id: BlockId): Promise<Uint8Array> => {
    asked.push(blockKey(id))
    const b = blocks.get(blockKey(id))
    if (b === undefined) throw new Error('missing block')
    return b
  }

  it('reads any range of a multi-level DAG', async () => {
    const nodes = new NodeCache(64)
    for (const [s, e] of [[0, 5000], [0, 1], [36, 38], [4999, 5000], [1234, 4321], [100, 100]] as const) {
      expect(await readFileRange(root, s, e, get, nodes)).toEqual(bytes.slice(s, e))
    }
  })

  it('asks only for the blocks under the range', async () => {
    asked.length = 0
    await readFileRange(root, 40, 70, get, new NodeCache(64))
    const leaves = asked.filter((k) => k.startsWith('55:'))
    expect(leaves).toHaveLength(1)
  })

  it('refuses a range past the end, before asking for any child', async () => {
    asked.length = 0
    await expect(readFileRange(root, 4990, 5001, get, new NodeCache(64))).rejects.toThrow(/past the end/)
    expect(asked).toEqual([blockKey(root)])
  })

  it('walks the DAG kubo builds for a Forge pack (same root CID as cidV1RawLeaves)', async () => {
    const pack = randomBytes(700_000, 3)
    const dag = buildDag(pack, 262_144, 174)
    expect(CID.decode(cidBytes(dag.root)).toString()).toBe(cidV1RawLeaves(pack))
    const getPack = async (id: BlockId): Promise<Uint8Array> => dag.blocks.get(blockKey(id)) as Uint8Array
    expect(await readFileRange(dag.root, 262_000, 530_000, getPack, new NodeCache(8))).toEqual(pack.slice(262_000, 530_000))
  })

  it('refuses a directory', async () => {
    const dir = buildDag(randomBytes(100), 30, 4, 1)
    const getDir = async (id: BlockId): Promise<Uint8Array> => dir.blocks.get(blockKey(id)) as Uint8Array
    await expect(readFileRange(dir.root, 0, 10, getDir, new NodeCache(8))).rejects.toThrow(/not a file/)
  })
})

describe('bitswap messages', () => {
  it('files a block under the CID of its own bytes', () => {
    const data = randomBytes(300)
    const { blocks } = decodeMessage(payloadMessage(data, CODEC_RAW))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.key).toBe(blockKey({ codec: CODEC_RAW, digest: sha256(data) }))
  })

  it('cannot pass other bytes off as a wanted block', () => {
    const wanted = randomBytes(300, 1)
    const other = randomBytes(300, 2)
    const { blocks } = decodeMessage(payloadMessage(other, CODEC_RAW))
    expect(blocks[0]?.key).not.toBe(blockKey({ codec: CODEC_RAW, digest: sha256(wanted) }))
  })

  it('reads DONT_HAVE presences', () => {
    const id: BlockId = { version: 1, codec: CODEC_RAW, digest: sha256(randomBytes(5)) }
    const presence: number[] = []
    lenField(presence, 1, cidBytes(id))
    intField(presence, 2, 1)
    const msg: number[] = []
    lenField(msg, 4, presence)
    expect(decodeMessage(Uint8Array.from(msg)).dontHave).toEqual([blockKey(id)])
  })

  it('wants blocks whole, with DONT_HAVE asked for, and cancels', () => {
    const a: BlockId = { version: 1, codec: CODEC_RAW, digest: sha256(randomBytes(5, 1)) }
    const b: BlockId = { version: 0, codec: CODEC_DAG_PB, digest: sha256(randomBytes(5, 2)) }
    const [[field, wantlist]] = protoFields(encodeWantlist([a], [b])) as [[number, Uint8Array]]
    expect(field).toBe(1)
    const entries = protoFields(wantlist).map(([, e]) => Object.fromEntries(protoFields(e as Uint8Array)))
    expect(entries[0]?.[1]).toEqual(cidBytes(a))
    expect(entries[0]?.[5]).toBe(1)
    expect(entries[0]?.[3]).toBeUndefined()
    expect(entries[1]?.[1]).toEqual(cidBytes(b))
    expect(entries[1]?.[3]).toBe(1)
  })

  it('splits frames across chunks and refuses an oversized one', () => {
    const r = new FrameReader(100)
    const f = [...frame(Uint8Array.of(1, 2, 3)), ...frame(Uint8Array.of(4))]
    expect(r.push(Uint8Array.from(f.slice(0, 2)))).toEqual([])
    expect(r.push(Uint8Array.from(f.slice(2)))).toEqual([Uint8Array.of(1, 2, 3), Uint8Array.of(4)])
    expect(() => new FrameReader(10).push(frame(new Uint8Array(11)))).toThrow(/bitswap message/)
  })

  it('keeps its buffer the size of a message, however much a stream carries', () => {
    const r = new FrameReader(100_000)
    const f = frame(new Uint8Array(1000).fill(7))
    for (let i = 0; i < 5000; i++) expect(r.push(f.subarray(0, 600)).length + r.push(f.subarray(600)).length).toBe(1)
    expect((r as unknown as { buf: Uint8Array }).buf.length).toBeLessThanOrEqual(4096)
  })

  it('parses a node with packed blocksizes', () => {
    const unixfs: number[] = []
    intField(unixfs, 1, 2)
    const packed: number[] = []
    varint(packed, 10)
    varint(packed, 20)
    lenField(unixfs, 4, packed)
    const node: number[] = []
    for (const seed of [1, 2]) {
      const link: number[] = []
      lenField(link, 1, cidBytes({ version: 1, codec: CODEC_RAW, digest: sha256(randomBytes(3, seed)) }))
      lenField(node, 2, link)
    }
    lenField(node, 1, unixfs)
    expect(parseFileNode(Uint8Array.from(node)).sizes).toEqual([10, 20])
  })
})

describe('browserDialable', () => {
  const id = '/p2p/12D3KooWStivEr79LLQWg8xH8ynEc8tit1GWrDFaxXtE6QNVBmQR'
  it('takes WebSockets over TLS and WebTransport with certhashes', () => {
    expect(browserDialable(`/dns4/x.libp2p.direct/tcp/4001/tls/ws${id}`)).toBe(true)
    expect(browserDialable(`/dns4/x.example/tcp/443/wss${id}`)).toBe(true)
    expect(browserDialable(`/ip4/1.2.3.4/udp/4001/quic-v1/webtransport/certhash/uEiA${id}`)).toBe(true)
  })
  it('refuses what a browser cannot dial', () => {
    expect(browserDialable(`/ip4/1.2.3.4/tcp/4001${id}`)).toBe(false)
    expect(browserDialable(`/ip4/1.2.3.4/tcp/4001/ws${id}`)).toBe(false)
    expect(browserDialable(`/ip4/1.2.3.4/udp/4001/quic-v1/webtransport${id}`)).toBe(false)
    expect(browserDialable('/dns4/x.libp2p.direct/tcp/4001/tls/ws')).toBe(false)
  })
})

describe('ipfsCidOf', () => {
  it('takes the first ipfs:// URI', () => {
    const one = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    const two = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
    expect(ipfsCidOf(['https://a.example/x', `ipfs://${one}`, `ipfs://${two}`])).toBe(one)
    expect(ipfsCidOf(['s3://b/x'])).toBeNull()
  })

  it('skips CIDs the peer cannot verify (not sha2-256)', () => {
    expect(ipfsCidOf(['ipfs://bafkqaaa', 'ipfs://bafyone', 'ipfs://bafkr4ihkr4ld3m4gqkjf4reryxsy2s5tkbxprqkow6fin2iiyvreuzzab4'])).toBeNull()
  })
})

describe('peerFirst', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetPeerReads()
  })
  const later = <T>(ms: number, v: T, fail = false): Promise<T> =>
    new Promise((resolve, reject) => setTimeout(() => (fail ? reject(new Error(String(v))) : resolve(v)), ms))

  it('takes the peer and never asks the gateway when the peer answers in time', async () => {
    vi.useFakeTimers()
    const gateway = vi.fn(() => later(10, 'gw'))
    const got = peerFirst(() => later(300, 'peer'), gateway, { headStartMs: 1000, size: () => 1 })
    await vi.advanceTimersByTimeAsync(400)
    await expect(got).resolves.toBe('peer')
    expect(gateway).not.toHaveBeenCalled()
  })

  it('starts the gateway once the head start runs out, and the first to finish wins', async () => {
    vi.useFakeTimers()
    let peerSignal: AbortSignal | undefined
    const gateway = vi.fn(() => later(100, 'gw'))
    const got = peerFirst(({ signal }) => ((peerSignal = signal), later(5000, 'peer')), gateway, { headStartMs: 1000, size: () => 1 })
    await vi.advanceTimersByTimeAsync(999)
    expect(gateway).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    await expect(got).resolves.toBe('gw')
    expect(peerSignal?.aborted).toBe(true)
  })

  it('goes to the gateway at once when the peer fails', async () => {
    vi.useFakeTimers()
    const gateway = vi.fn(() => later(50, 'gw'))
    const got = peerFirst(() => later(10, 'down', true), gateway, { headStartMs: 1000, size: () => 1 })
    await vi.advanceTimersByTimeAsync(70)
    await expect(got).resolves.toBe('gw')
  })

  it('keeps waiting on a peer that is making progress', async () => {
    vi.useFakeTimers()
    const gateway = vi.fn(() => later(10, 'gw'))
    const got = peerFirst(
      ({ progress }) =>
        new Promise((resolve) => {
          let n = 0
          const tick = setInterval(() => {
            progress()
            if (++n === 10) {
              clearInterval(tick)
              resolve('peer')
            }
          }, 400)
        }),
      gateway,
      { headStartMs: 1000, stallMs: 800, size: () => 1 },
    )
    await vi.advanceTimersByTimeAsync(4100)
    await expect(got).resolves.toBe('peer')
    expect(gateway).not.toHaveBeenCalled()
  })

  it('races a peer that trickles once its bytes are overdue at the floor rate', async () => {
    vi.useFakeTimers()
    const gateway = vi.fn(() => later(10, 'gw'))
    const ctl: { signal?: AbortSignal } = {}
    const got = peerFirst(
      ({ progress, signal }) =>
        new Promise((_, reject) => {
          ctl.signal = signal
          const tick = setInterval(progress, 700)
          signal.addEventListener('abort', () => (clearInterval(tick), reject(new Error('cancelled'))))
        }),
      gateway,
      { headStartMs: 1000, stallMs: 800, bytes: 3_000_000 },
    )
    await vi.advanceTimersByTimeAsync(3900)
    expect(gateway).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(gateway).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20)
    await expect(got).resolves.toBe('gw')
    expect(ctl.signal?.aborted).toBe(true)
  })

  it('starts the gateway at once when the peer hurries it, and still takes the peer if it finishes first', async () => {
    vi.useFakeTimers()
    const gateway = vi.fn(() => later(500, 'gw'))
    const got = peerFirst(({ hurry }) => (setTimeout(hurry, 10), later(200, 'peer')), gateway, { headStartMs: 1000, size: () => 1 })
    await vi.advanceTimersByTimeAsync(20)
    expect(gateway).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    await expect(got).resolves.toBe('peer')
  })

  it('stops both reads when the caller cancels, and counts no failure', async () => {
    vi.useFakeTimers()
    const cancel = new AbortController()
    let gatewaySignal: AbortSignal | undefined
    const got = peerFirst(() => later(5000, 'peer'), (s) => ((gatewaySignal = s), later(5000, 'gw')), { headStartMs: 100, cancel: cancel.signal })
    const check = expect(got).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(150)
    cancel.abort()
    await check
    expect(gatewaySignal?.aborted).toBe(true)
    expect(peerReadStats().fellBack).toBe(0)
  })

  it('reports the gateway error when neither serves', async () => {
    vi.useFakeTimers()
    const got = peerFirst(() => later(10, 'peer down', true), () => later(10, 'gateway down', true), { headStartMs: 1000 })
    const check = expect(got).rejects.toThrow('gateway down')
    await vi.advanceTimersByTimeAsync(50)
    await check
  })
})

const PEER_ID = '12D3KooWStivEr79LLQWg8xH8ynEc8tit1GWrDFaxXtE6QNVBmQR'
const BOOTSTRAP = `/dns4/x.libp2p.direct/tcp/4001/tls/ws/p2p/${PEER_ID}`

/** A kubo stand-in: serves `blocks` over bitswap, each message on an inbound stream of its own. */
function fakeKubo(blocks: Map<string, Uint8Array>) {
  const state = { dials: 0, failDials: 0, sendThrows: 0, silent: false, closedInbound: 0, wants: [] as string[], cancels: [] as string[] }
  let handler: ((stream: unknown, conn: unknown) => Promise<void>) | undefined
  const listeners: ((e: { detail: { toString: () => string } }) => void)[] = []
  const keyOf = (cid: Uint8Array): string => blockKey({ codec: cid[1] as number, digest: cid.slice(-32) })
  const conn = {
    remotePeer: { toString: () => PEER_ID },
    newStream: async () => ({
      send: (bytes: Uint8Array) => {
        if (state.sendThrows > 0) {
          state.sendThrows -= 1
          throw new Error('stream reset')
        }
        const [msg] = new FrameReader(1 << 24).push(bytes)
        for (const [, wl] of protoFields(msg as Uint8Array)) {
          for (const [, entry] of protoFields(wl as Uint8Array)) {
            const fields = Object.fromEntries(protoFields(entry as Uint8Array))
            const key = keyOf(fields[1] as Uint8Array)
            if (fields[3] === 1) {
              state.cancels.push(key)
              continue
            }
            state.wants.push(key)
            if (state.silent) continue
            const data = blocks.get(key)
            const reply = data !== undefined ? payloadMessage(data, Number(key.split(':')[0] === '55' ? CODEC_RAW : CODEC_DAG_PB)) : dontHaveMessage(fields[1] as Uint8Array)
            queueMicrotask(() =>
              void handler?.(
                {
                  async *[Symbol.asyncIterator]() {
                    yield frame(reply)
                  },
                  close: async () => {
                    state.closedInbound += 1
                  },
                  abort: () => undefined,
                },
                conn,
              ),
            )
          }
        }
        return true
      },
    }),
  }
  const node = {
    handle: async (_p: unknown, h: typeof handler) => {
      handler = h
    },
    addEventListener: (_t: string, fn: (typeof listeners)[number]) => listeners.push(fn),
    stop: async () => undefined,
    dial: async () => {
      state.dials += 1
      if (state.failDials > 0) {
        state.failDials -= 1
        throw new Error('refused')
      }
      return conn
    },
  }
  const disconnect = (): void => listeners.forEach((fn) => fn({ detail: { toString: () => PEER_ID } }))
  return { node: node as unknown as PeerNode, state, disconnect }
}

function dontHaveMessage(cid: Uint8Array): Uint8Array {
  const presence: number[] = []
  lenField(presence, 1, cid)
  intField(presence, 2, 1)
  const msg: number[] = []
  lenField(msg, 4, presence)
  return Uint8Array.from(msg)
}

describe('IpfsPeer against a kubo stand-in', () => {
  const pack = randomBytes(600_000, 9)
  const dag = buildDag(pack, 262_144, 174)
  const root = CID.decode(cidBytes(dag.root)).toString()
  const start = (kubo: ReturnType<typeof fakeKubo>) => IpfsPeer.start({ bootstrap: [BOOTSTRAP], routers: [] }, kubo.node)

  afterEach(() => vi.useRealTimers())

  it('reads a range block by block, and closes every inbound stream', async () => {
    const kubo = fakeKubo(dag.blocks)
    const peer = await start(kubo)
    expect(await peer.readRange(root, 100_000, 400_000)).toEqual(pack.slice(100_000, 400_000))
    expect(kubo.state.wants).toHaveLength(3)
    expect(kubo.state.closedInbound).toBe(3)
  })

  it('dials again after the peer disconnects', async () => {
    const kubo = fakeKubo(dag.blocks)
    const peer = await start(kubo)
    await peer.readRange(root, 0, 10)
    kubo.disconnect()
    expect(await peer.readRange(root, 300_000, 300_010)).toEqual(pack.slice(300_000, 300_010))
    expect(kubo.state.dials).toBe(2)
  })

  it('drops a link whose stream broke, and the next read dials again', async () => {
    const kubo = fakeKubo(dag.blocks)
    const peer = await start(kubo)
    kubo.state.sendThrows = 1
    await expect(peer.readRange(root, 0, 10)).rejects.toThrow(/no IPFS peer served the block/)
    expect(await peer.readRange(root, 0, 10)).toEqual(pack.slice(0, 10))
    expect(kubo.state.dials).toBe(2)
  })

  it('waits before dialling a peer that refused, then dials it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const kubo = fakeKubo(dag.blocks)
    kubo.state.failDials = 1
    const peer = await start(kubo)
    await expect(peer.readRange(root, 0, 10)).rejects.toThrow(/no IPFS peer/)
    await expect(peer.readRange(root, 0, 10)).rejects.toThrow(/no IPFS peer/)
    expect(kubo.state.dials).toBe(1)
    vi.setSystemTime(Date.now() + 11_000)
    expect(await peer.readRange(root, 0, 10)).toEqual(pack.slice(0, 10))
    expect(kubo.state.dials).toBe(2)
  })

  it('sends a CANCEL when the last read of a block gives up, and asks afresh later', async () => {
    const kubo = fakeKubo(dag.blocks)
    const peer = await start(kubo)
    await peer.readRange(root, 0, 1)
    kubo.state.silent = true
    const ctl = new AbortController()
    const pending = peer.readRange(root, 300_000, 300_010, { signal: ctl.signal })
    await new Promise((r) => setTimeout(r, 5))
    ctl.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(kubo.state.cancels).toHaveLength(1)
    kubo.state.silent = false
    expect(await peer.readRange(root, 300_000, 300_010)).toEqual(pack.slice(300_000, 300_010))
  })

  it('hurries the gateway on DONT_HAVE, and a root prefetch looks up no providers', async () => {
    const kubo = fakeKubo(new Map())
    const peer = await start(kubo)
    const onSlow = vi.fn()
    await expect(peer.readRange(root, 0, 10, { onSlow })).rejects.toThrow(/does not have the block/)
    expect(onSlow).toHaveBeenCalledTimes(1)
    peer.prefetchRoot(root)
    await new Promise((r) => setTimeout(r, 5))
    expect(peer.stats.routingLookups).toBe(0)
  })

  it('hurries every read waiting on a shared block, and one that joins after', async () => {
    const kubo = fakeKubo(new Map())
    let answer: (r: Response) => void = () => undefined
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => (answer = resolve)))
    try {
      const peer = await IpfsPeer.start({ bootstrap: [BOOTSTRAP], routers: ['https://r.example'] }, kubo.node)
      const slow = [vi.fn(), vi.fn(), vi.fn()]
      const reads = slow.slice(0, 2).map((onSlow, i) => peer.readRange(root, i * 10, i * 10 + 5, { onSlow }))
      await vi.waitFor(() => expect(slow[0]).toHaveBeenCalledTimes(1))
      expect(slow[1]).toHaveBeenCalledTimes(1)
      reads.push(peer.readRange(root, 20, 25, { onSlow: slow[2] }))
      expect(slow[2]).toHaveBeenCalledTimes(1)
      answer(new Response('', { status: 404 }))
      await Promise.allSettled(reads)
      expect(slow.map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

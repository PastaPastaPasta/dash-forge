/**
 * The browser's IPFS peer: a js-libp2p node (WebSockets over TLS and WebTransport, Noise,
 * yamux) that asks peers for blocks over bitswap 1.2.0 and reads byte ranges of UnixFS files
 * from them. Loaded on demand ({@link ./index.ts}); nothing here runs until a pack is read.
 *
 * Every block is hashed against the CID it was asked for before it is used ({@link decodeMessage}),
 * and a file's bytes are reached only through the links of its root CID, so a peer can withhold
 * bytes but never change them. Callers still check a whole pack against its manifest sha256.
 */

import { createLibp2p, type Libp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { webTransport } from '@libp2p/webtransport'
import { noise } from '@libp2p/noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import type { Connection, Stream } from '@libp2p/interface'
import { CID } from 'multiformats/cid'
import { blockKey, CODEC_RAW, decodeMessage, encodeWantlist, frame, FrameReader, MH_SHA2_256, type BlockId } from './wire'
import { NodeCache, readFileRange } from './dag'

const PROTOCOLS = ['/ipfs/bitswap/1.2.0', '/ipfs/bitswap/1.1.0']
/** Wants outstanding per peer: kubo stalled on a 107-block wantlist sent at once. */
const WANT_WINDOW = 16
/** A want unanswered (no block, no DONT_HAVE) this long fails on that peer. */
const BLOCK_TIMEOUT_MS = 6_000
const DIAL_TIMEOUT_MS = 5_000
/** A peer that could not be dialled is not dialled again for this long. */
const REDIAL_AFTER_MS = 10_000
/** A root's providers are looked up again after this long, when none of them is still connected. */
const PROVIDERS_KEPT_MS = 60_000
/** Delegated routing lookups in flight at once. */
const ROUTING_LOOKUPS = 2
/** Bitswap messages carry blocks of at most 2 MiB (boxo `maxBlockSize`) plus framing. */
const MAX_MESSAGE = 4 * 1024 * 1024 + 4096
/** Interior (dag-pb) nodes kept: a range read walks the same root again and again. */
const NODES_KEPT = 512
/** Leaf bytes kept, for small reads landing in a leaf already fetched. */
const LEAF_BYTES_KEPT = 8 * 1024 * 1024
/** Providers found through delegated routing dialled per root, at most. */
const PROVIDERS_DIALLED = 3
/** Roots whose providers, and dial targets whose failure, are remembered at most. */
const ROOTS_KEPT = 256

export interface PeerStats {
  /** Verified block bytes received. */
  bytes: number
  blocks: number
  /** Bitswap messages sent (each one carries up to {@link WANT_WINDOW} wants). */
  messages: number
  dials: number
  routingLookups: number
  /** When the node started and first connected to a peer (ms since the page started). */
  startedAt?: number
  connectedAt?: number
}

export interface PeerOptions {
  /** Multiaddrs (with `/p2p/<id>`) dialled first, in order of preference. */
  readonly bootstrap: readonly string[]
  /** Delegated routing endpoints (`/routing/v1`, IPIP-337) asked for providers when no bootstrap peer has a root. */
  readonly routers: readonly string[]
}

/** One range read: the root its blocks hang from, its cancel, a tick per block, and what to do when the bootstrap peers cannot serve it. */
export interface ReadOptions {
  readonly signal?: AbortSignal
  readonly onBlock?: () => void
  /** The bootstrap peers did not serve a block: a gateway may start now, while providers are looked up. */
  readonly onSlow?: () => void
  /** Look up other providers through delegated routing when the bootstrap peers do not serve a block (default true). */
  readonly routing?: boolean
}

interface Read extends ReadOptions {
  readonly root: string
}

interface Pending {
  readonly id: BlockId
  resolve: (b: Uint8Array) => void
  reject: (e: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

class PeerError extends Error {}

const now = (): number => Math.round(globalThis.performance?.now() ?? 0)

/** A block being asked for, shared by every read that needs it; the want is withdrawn when the last of them gives up. */
interface Asking {
  p: Promise<Uint8Array>
  readonly ctl: AbortController
  readers: number
  /** Some read waiting on it may look up providers. */
  routing: boolean
  /** The bootstrap peers did not serve it: every read waiting on it is told, and so is each that joins later. */
  slow: boolean
  readonly onSlow: Set<() => void>
}

/** The subset of a libp2p node the peer uses (a fake one in tests). */
export type PeerNode = Pick<Libp2p, 'handle' | 'dial' | 'stop' | 'addEventListener'>

/** One connected peer: a want window and the one outbound stream it is sent over. */
class Link {
  private out: Promise<Stream> | null = null
  private readonly queue: Pending[] = []
  private readonly inflight = new Map<string, Pending>()
  private flushQueued = false
  dead = false

  constructor(
    readonly peer: string,
    private readonly conn: Connection,
    private readonly stats: PeerStats,
    private readonly gone: (link: Link) => void,
  ) {}

  /** Block `id` from this peer; `signal` withdraws the want (a CANCEL once it was sent). */
  get(id: BlockId, signal: AbortSignal): Promise<Uint8Array> {
    if (this.dead) return Promise.reject(new PeerError(`${this.peer} is gone`))
    if (signal.aborted) return Promise.reject(new PeerError('cancelled'))
    return new Promise((resolve, reject) => {
      const p: Pending = { id, resolve, reject }
      const key = blockKey(id)
      const onAbort = (): void => {
        const queued = this.queue.indexOf(p)
        if (queued >= 0) this.queue.splice(queued, 1)
        else if (this.inflight.get(key) === p) this.withdraw(key, p)
        reject(new PeerError('cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      p.resolve = (b) => (signal.removeEventListener('abort', onAbort), resolve(b))
      p.reject = (e) => (signal.removeEventListener('abort', onAbort), reject(e))
      this.queue.push(p)
      this.pump()
    })
  }

  received(key: string, data: Uint8Array): boolean {
    const p = this.inflight.get(key)
    if (p === undefined) return false
    this.settle(key, p)
    p.resolve(data)
    return true
  }

  dontHave(key: string): void {
    const p = this.inflight.get(key)
    if (p === undefined) return
    this.settle(key, p)
    p.reject(new PeerError(`${this.peer} does not have the block`))
  }

  close(why: string): void {
    if (this.dead) return
    this.dead = true
    for (const [key, p] of this.inflight) {
      clearTimeout(p.timer)
      this.inflight.delete(key)
      p.reject(new PeerError(why))
    }
    for (const p of this.queue.splice(0)) p.reject(new PeerError(why))
    this.gone(this)
  }

  /** Stops waiting for `p` and tells the peer it is no longer wanted. */
  private withdraw(key: string, p: Pending): void {
    this.settle(key, p)
    this.send([], [p.id])
  }

  private settle(key: string, p: Pending): void {
    clearTimeout(p.timer)
    this.inflight.delete(key)
    this.pump()
  }

  private pump(): void {
    if (this.flushQueued || this.dead) return
    this.flushQueued = true
    // One message per turn of the event loop: every want a range read makes at once goes together.
    queueMicrotask(() => {
      this.flushQueued = false
      const batch: Pending[] = []
      while (!this.dead && this.inflight.size < WANT_WINDOW && this.queue.length > 0) {
        const p = this.queue.shift() as Pending
        const key = blockKey(p.id)
        // IpfsPeer asks for a block once at a time (its own in-flight map); a repeat is refused.
        if (this.inflight.has(key)) {
          p.reject(new PeerError('block already asked for'))
          continue
        }
        p.timer = setTimeout(() => {
          if (this.inflight.get(key) !== p) return
          this.withdraw(key, p)
          p.reject(new PeerError(`${this.peer} did not answer in ${BLOCK_TIMEOUT_MS / 1000} s`))
        }, BLOCK_TIMEOUT_MS)
        this.inflight.set(key, p)
        batch.push(p)
      }
      if (batch.length > 0) this.send(batch.map((p) => p.id), [])
    })
  }

  private send(want: readonly BlockId[], cancel: readonly BlockId[]): void {
    if (this.dead) return
    const out = (this.out ??= this.conn.newStream(PROTOCOLS))
    this.stats.messages += 1
    const fail = (e: unknown): void => this.close(`${this.peer}: ${e instanceof Error ? e.message : String(e)}`)
    out.then((s) => {
      try {
        s.send(frame(encodeWantlist(want, cancel)))
      } catch (e) {
        // The stream was reset or closed: the link is dropped, and the next read dials again.
        fail(e)
      }
    }, fail)
  }
}

/** A browser-dialable multiaddr: WebSockets over TLS, or WebTransport with its certhashes. */
export function browserDialable(addr: string): boolean {
  return addr.includes('/p2p/') && (/\/tls\/(sni\/[^/]+\/)?ws(\/|$)/.test(addr) || /\/wss(\/|$)/.test(addr) || (/\/webtransport\//.test(addr) && addr.includes('/certhash/')))
}

export class IpfsPeer {
  readonly stats: PeerStats = { bytes: 0, blocks: 0, messages: 0, dials: 0, routingLookups: 0 }
  private readonly links = new Map<string, Link>()
  /** Dials in progress, by their multiaddrs. */
  private readonly dialing = new Map<string, Promise<Link | null>>()
  /** When a dial (by its multiaddrs) last failed. */
  private readonly failedAt = new Map<string, number>()
  private readonly inflight = new Map<string, Asking>()
  private readonly nodes = new NodeCache(NODES_KEPT)
  private readonly leaves = new Map<string, Uint8Array>()
  private leafBytes = 0
  private readonly rootPeers = new Map<string, { readonly at: number; readonly peers: Promise<string[]> }>()
  private lookups = 0
  private readonly lookupQueue: (() => void)[] = []

  private constructor(
    private readonly node: PeerNode,
    private readonly opts: PeerOptions,
  ) {}

  static async start(opts: PeerOptions, node?: PeerNode): Promise<IpfsPeer> {
    const libp2p =
      node ??
      (await createLibp2p({
        transports: [webSockets(), webTransport()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        connectionManager: { maxConnections: 16 },
      }))
    const peer = new IpfsPeer(libp2p, opts)
    peer.stats.startedAt = now()
    const onStream = (stream: Stream, conn: Connection): Promise<void> => peer.read(stream, conn.remotePeer.toString())
    try {
      await libp2p.handle(PROTOCOLS, onStream)
    } catch (e) {
      await Promise.resolve(libp2p.stop()).catch(() => undefined)
      throw e
    }
    libp2p.addEventListener('peer:disconnect', (e) => peer.links.get(e.detail.toString())?.close('disconnected'))
    return peer
  }

  /** The bootstrap peers this node is connected to, dialling (again) those it is not. */
  async connect(): Promise<Link[]> {
    const links = await Promise.all(
      this.opts.bootstrap.map((addr) => {
        const live = this.bootstrapLink(addr)
        return live !== undefined && !live.dead ? live : this.dial([addr])
      }),
    )
    return links.filter((l): l is Link => l !== null && !l.dead)
  }

  /** Whether a bootstrap peer is connected. */
  reachable(): boolean {
    return this.opts.bootstrap.some((addr) => this.bootstrapLink(addr)?.dead === false)
  }

  private bootstrapLink(addr: string): Link | undefined {
    return this.links.get(/\/p2p\/([^/]+)$/.exec(addr)?.[1] ?? '')
  }

  async stop(): Promise<void> {
    for (const l of [...this.links.values()]) l.close('stopped')
    await this.node.stop()
  }

  /** Bytes `[start, end)` of the UnixFS file (or raw block) `root` (a CID string). */
  readRange(root: string, start: number, end: number, opts: ReadOptions = {}): Promise<Uint8Array> {
    const read: Read = { ...opts, root }
    return readFileRange(rootId(root), start, end, (id) => this.block(read, id), this.nodes)
  }

  /** Fetch and keep the root node of the file `root`, from the bootstrap peers only (nothing for a single raw block, which is the content). */
  prefetchRoot(root: string): void {
    let id: BlockId
    try {
      id = rootId(root)
    } catch {
      return
    }
    if (id.codec === CODEC_RAW) return
    const read: Read = { root, routing: false }
    this.nodes.get(id, (b) => this.block(read, b)).catch(() => undefined)
  }

  /** One verified block of `root`'s DAG: from memory, from a read already asking, or from a peer that has the root. */
  private async block(read: Read, id: BlockId): Promise<Uint8Array> {
    const key = blockKey(id)
    const kept = this.leaves.get(key)
    if (kept !== undefined) return kept
    let asking = this.inflight.get(key)
    if (asking === undefined) {
      const ctl = new AbortController()
      const a: Asking = { p: Promise.resolve(new Uint8Array(0)), ctl, readers: 0, routing: read.routing !== false, slow: false, onSlow: new Set() }
      a.p = this.fromPeers(read.root, a, id, ctl.signal)
      const forget = (): void => {
        if (this.inflight.get(key) === a) this.inflight.delete(key)
      }
      a.p.then(forget, forget)
      this.inflight.set(key, a)
      asking = a
    }
    if (read.routing !== false) asking.routing = true
    const onSlow = read.onSlow
    if (onSlow !== undefined) {
      if (asking.slow) onSlow()
      else asking.onSlow.add(onSlow)
    }
    asking.readers += 1
    let data: Uint8Array
    try {
      data = await abortable(asking.p, read.signal)
    } finally {
      if (onSlow !== undefined) asking.onSlow.delete(onSlow)
      asking.readers -= 1
      // The last read waiting on a block gave up: the peers stop sending it, and a later read asks afresh.
      if (asking.readers === 0 && read.signal?.aborted === true) {
        asking.ctl.abort()
        if (this.inflight.get(key) === asking) this.inflight.delete(key)
      }
    }
    read.onBlock?.()
    if (id.codec === CODEC_RAW && !this.leaves.has(key)) {
      // A copy: the block is a view into its whole bitswap message.
      this.leaves.set(key, data.slice())
      this.leafBytes += data.length
      for (const [k, v] of this.leaves) {
        if (this.leafBytes <= LEAF_BYTES_KEPT) break
        this.leaves.delete(k)
        this.leafBytes -= v.length
      }
    }
    return data
  }

  private async fromPeers(root: string, asking: Asking, id: BlockId, signal: AbortSignal): Promise<Uint8Array> {
    const tried = new Set<string>()
    const reasons: string[] = []
    const ask = async (links: readonly Link[]): Promise<Uint8Array | null> => {
      for (const link of links) {
        if (tried.has(link.peer) || link.dead) continue
        tried.add(link.peer)
        if (signal.aborted) throw new PeerError('cancelled')
        try {
          const data = await link.get(id, signal)
          this.stats.blocks += 1
          this.stats.bytes += data.length
          return data
        } catch (e) {
          reasons.push(e instanceof Error ? e.message : String(e))
        }
      }
      return null
    }
    const fromBootstrap = await ask(await this.connect())
    if (fromBootstrap !== null) return fromBootstrap
    if (signal.aborted) throw new PeerError('cancelled')
    if (asking.routing) {
      asking.slow = true
      for (const f of [...asking.onSlow]) f()
      const fromProviders = await ask(await this.providers(root))
      if (fromProviders !== null) return fromProviders
    }
    throw new PeerError(`no IPFS peer served the block${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}`)
  }

  /** Connected peers that provide `root` (delegated routing); looked up again once those are gone. */
  private async providers(root: string): Promise<Link[]> {
    let entry = this.rootPeers.get(root)
    if (entry !== undefined && Date.now() - entry.at > PROVIDERS_KEPT_MS) {
      const ids = await entry.peers
      if (!ids.some((id) => this.links.get(id)?.dead === false)) entry = undefined
    }
    if (entry === undefined) {
      entry = { at: Date.now(), peers: this.findProviders(root).catch(() => []) }
      this.rootPeers.delete(root)
      this.rootPeers.set(root, entry)
      if (this.rootPeers.size > ROOTS_KEPT) this.rootPeers.delete(this.rootPeers.keys().next().value as string)
    }
    const ids = await entry.peers
    return ids.map((id) => this.links.get(id)).filter((l): l is Link => l !== undefined && !l.dead)
  }

  private async findProviders(root: string): Promise<string[]> {
    if (this.lookups >= ROUTING_LOOKUPS) await new Promise<void>((resolve) => this.lookupQueue.push(resolve))
    this.lookups += 1
    try {
      for (const router of this.opts.routers) {
        this.stats.routingLookups += 1
        const resp = await fetch(`${router.replace(/\/+$/, '')}/routing/v1/providers/${root}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
        }).catch(() => null)
        if (resp === null || !resp.ok) continue
        const body = (await resp.json().catch(() => null)) as { Providers?: { ID?: string; Addrs?: string[]; Protocols?: string[] }[] | null } | null
        const candidates: string[][] = []
        for (const prov of body?.Providers ?? []) {
          if (typeof prov.ID !== 'string' || !Array.isArray(prov.Addrs)) continue
          if (Array.isArray(prov.Protocols) && !prov.Protocols.includes('transport-bitswap')) continue
          const addrs = prov.Addrs.filter((a): a is string => typeof a === 'string').map((a) => (a.includes('/p2p/') ? a : `${a}/p2p/${prov.ID}`)).filter(browserDialable)
          if (addrs.length > 0) candidates.push(addrs)
          if (candidates.length >= PROVIDERS_DIALLED) break
        }
        const links = await Promise.all(candidates.map((addrs) => this.dial(addrs)))
        return links.filter((l): l is Link => l !== null).map((l) => l.peer)
      }
      return []
    } finally {
      this.lookups -= 1
      this.lookupQueue.shift()?.()
    }
  }

  private dial(addrs: readonly string[]): Promise<Link | null> {
    const key = addrs.join(' ')
    const pending = this.dialing.get(key)
    if (pending !== undefined) return pending
    if (Date.now() - (this.failedAt.get(key) ?? -Infinity) < REDIAL_AFTER_MS) return Promise.resolve(null)
    const p = this.dialOnce(addrs).then((link) => {
      this.dialing.delete(key)
      if (link === null) {
        this.failedAt.set(key, Date.now())
        if (this.failedAt.size > ROOTS_KEPT) for (const [k, at] of this.failedAt) if (Date.now() - at >= REDIAL_AFTER_MS) this.failedAt.delete(k)
      } else {
        this.failedAt.delete(key)
      }
      return link
    })
    this.dialing.set(key, p)
    return p
  }

  private async dialOnce(addrs: readonly string[]): Promise<Link | null> {
    let mas: Multiaddr[]
    try {
      mas = addrs.map((a) => multiaddr(a))
    } catch {
      return null
    }
    this.stats.dials += 1
    try {
      const conn = await this.node.dial(mas, { signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) })
      this.stats.connectedAt ??= now()
      const id = conn.remotePeer.toString()
      const known = this.links.get(id)
      if (known !== undefined && !known.dead) return known
      const link = new Link(id, conn, this.stats, (l) => {
        if (this.links.get(l.peer) === l) this.links.delete(l.peer)
      })
      this.links.set(id, link)
      return link
    } catch {
      return null
    }
  }

  private async read(stream: Stream, peer: string): Promise<void> {
    const frames = new FrameReader(MAX_MESSAGE)
    try {
      for await (const chunk of stream) {
        for (const msg of frames.push(chunk.subarray())) {
          const { blocks, dontHave } = decodeMessage(msg)
          const sender = this.links.get(peer)
          for (const b of blocks) {
            // A block another peer was asked for too is taken from whoever sent it first.
            if (!sender?.received(b.key, b.data)) for (const l of this.links.values()) if (l.received(b.key, b.data)) break
          }
          for (const key of dontHave) sender?.dontHave(key)
        }
      }
      // kubo sends each message on a stream of its own and closes its side: closing ours frees the
      // stream, which otherwise stays half open and counts against the inbound stream limit.
      await stream.close()
    } catch {
      stream.abort(new Error('bad bitswap message'))
    }
  }
}

function rootId(root: string): BlockId {
  const cid = CID.parse(root)
  if (cid.multihash.code !== MH_SHA2_256 || cid.multihash.digest.length !== 32) throw new Error('not a sha2-256 CID')
  return { version: cid.version === 0 ? 0 : 1, codec: cid.code, digest: cid.multihash.digest }
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return p
  if (signal.aborted) return Promise.reject(new PeerError('cancelled'))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new PeerError('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => (signal.removeEventListener('abort', onAbort), resolve(v)),
      (e: unknown) => (signal.removeEventListener('abort', onAbort), reject(e)),
    )
  })
}

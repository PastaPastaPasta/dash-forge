/**
 * Peer-to-peer reads of `ipfs://` packs: the browser joins IPFS as a libp2p peer and fetches
 * the pack's blocks over bitswap, from the peers in `storage-defaults.json` (`ipfsPeers`) and
 * then from providers found through delegated routing. HTTP gateways stay the fallback
 * ({@link peerFirst}): a peer read that stalls hands over to them quickly, and one that keeps
 * failing is switched off for the session.
 *
 * The libp2p code is its own chunk ({@link ./peer.ts}), loaded the first time a repo with an
 * `ipfs://` pack is opened ({@link warmPeer}).
 */

import storageDefaults from '../../../../forge-contracts/config/storage-defaults.json'
import type { IpfsPeer, PeerStats } from './peer'

export const IPFS_PEERS: readonly string[] = storageDefaults.ipfsPeers
export const IPFS_ROUTERS: readonly string[] = storageDefaults.ipfsRouters

/** The `onServed` URL a peer read reports, so the trust panel names the source `ipfs peer`. */
export const PEER_SOURCE = 'ipfs-peer://bitswap'

/** localStorage key: `off` turns peer reads off in this browser. */
export const PEER_SETTING_KEY = 'forge.ipfsPeer'

/** Failed or stalled peer reads in a row that switch peer reads off for {@link BREAKER_MS}. */
const BREAKER_FAILURES = 3
const BREAKER_MS = 5 * 60_000

let peer: Promise<IpfsPeer | null> | null = null
let resolvedPeer: IpfsPeer | null = null
let failuresInRow = 0
let offUntil = 0
const totals = { reads: 0, served: 0, fellBack: 0, bytes: 0 }

function settingOff(): boolean {
  try {
    return globalThis.localStorage?.getItem(PEER_SETTING_KEY) === 'off'
  } catch {
    return false
  }
}

let forced: boolean | null = null

/** Test hook: peer reads off, or on whatever the environment (the breaker and the setting still apply); null: as the app decides. */
export function overridePeerReads(on: boolean | null): void {
  forced = on
}

/** Whether a pack read should ask IPFS peers first now. */
export function peerReadsOn(): boolean {
  if (forced === false) return false
  // js-libp2p needs Promise.withResolvers (Chrome 119, Firefox 121, Safari 17.4), newer than the app's oldest browsers.
  if (forced === null && (IPFS_PEERS.length === 0 || typeof window === 'undefined' || typeof WebSocket === 'undefined' || typeof Promise.withResolvers !== 'function')) return false
  return !settingOff() && Date.now() >= offUntil
}

/** Start loading the peer and dialling the bootstrap peers, if peer reads are on. */
export async function warmPeer(): Promise<void> {
  if (peerReadsOn()) await startedPeer()
}

/** Packs whose root nodes are asked for ahead of their first read, at most. */
const ROOTS_PREFETCHED = 32

/** Fetch the root nodes of the files `cids` (no leaves), if peer reads are on. */
export function prefetchPackRoots(cids: readonly string[]): void {
  if (!peerReadsOn() || cids.length === 0) return
  void startedPeer().then((p) => {
    for (const cid of [...new Set(cids)].slice(0, ROOTS_PREFETCHED)) p?.prefetchRoot(cid)
  })
}

function startedPeer(): Promise<IpfsPeer | null> {
  peer ??= import('./peer')
    .then(async ({ IpfsPeer }) => {
      const p = await IpfsPeer.start({ bootstrap: IPFS_PEERS, routers: IPFS_ROUTERS })
      void p.connect()
      resolvedPeer = p
      return p
    })
    .catch(() => {
      offUntil = Date.now() + BREAKER_MS
      peer = null
      return null
    })
  return peer
}

/** The CID of a pack's first `ipfs://` URI whose CID the peer can verify (sha2-256: CIDv0, or CIDv1 dag-pb or raw in base32), or null. */
export function ipfsCidOf(uris: readonly string[]): string | null {
  for (const uri of uris) {
    const m = /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf(?:ybei|krei)[a-z2-7]{52})$/.exec(uri)
    if (m !== null) return m[1] as string
  }
  return null
}

/** Bytes `[start, end)` of `cid` from IPFS peers, for {@link peerFirst}. No bootstrap peer connected yet: `race` at once, so a gateway races the dial. */
export async function peerReadRange(cid: string, start: number, end: number, { signal, progress, hurry, race }: PeerReadControl): Promise<Uint8Array> {
  const cold = resolvedPeer === null || !resolvedPeer.reachable()
  if (cold) race()
  const p = await startedPeer()
  if (p === null) throw new Error('the IPFS peer did not start')
  // A cold read the gateway wins is not held against the peer, unless the dial then fails too:
  // otherwise an unreachable bootstrap peer would never trip the breaker.
  if (cold) void p.connect().then(() => p.reachable() || noteFailure())
  return p.readRange(cid, start, end, { signal, onBlock: progress, onSlow: hurry })
}

export interface PeerReadStats extends PeerStats {
  /** Pack reads that asked peers first. */
  readonly reads: number
  /** Of those, the ones a peer served. */
  readonly served: number
  /** Of those, the ones a gateway served instead. */
  readonly fellBack: number
  /** Bytes the peer reads delivered to the reader (pack bytes, not blocks). */
  readonly deliveredBytes: number
  /** The latest reads' timelines. */
  readonly log: readonly ReadEvent[]
}

const EMPTY: PeerStats = { bytes: 0, blocks: 0, messages: 0, dials: 0, routingLookups: 0 }

/** Counters for the measurements and the trust panel. */
export function peerReadStats(): PeerReadStats {
  return { ...(resolvedPeer?.stats ?? EMPTY), reads: totals.reads, served: totals.served, fellBack: totals.fellBack, deliveredBytes: totals.bytes, log: log.slice() }
}

/** One pack read's timeline (ms since the page started): when it began, saw a block, asked a gateway, and ended. */
export interface ReadEvent {
  readonly what: string
  readonly start: number
  firstBlock?: number
  gateway?: number
  end?: number
  by?: 'peer' | 'gateway' | 'neither' | 'cancelled'
  peerError?: string
}
const log: ReadEvent[] = []
const now = (): number => Math.round(globalThis.performance?.now() ?? 0)

if (typeof window !== 'undefined') {
  // Read-only counters, for checking in a browser's console that pack bytes come over libp2p.
  ;(window as unknown as { __forgePeerStats?: () => PeerReadStats }).__forgePeerStats = peerReadStats
}

/** How long a peer read may go without its first byte, and then between blocks, before a gateway joins it. */
export const PEER_HEAD_START_MS = 1_500
export const PEER_STALL_MS = 800
/** The slowest a streaming peer may be (bytes per ms, about 1 MiB/s) before a gateway joins it anyway. */
export const PEER_FLOOR_BYTES_PER_MS = 1_000

/** What a peer read is given: its cancel, a tick per block, and a call that starts the gateway at once. */
export interface PeerReadControl {
  readonly signal: AbortSignal
  readonly progress: () => void
  /** The peers cannot serve this quickly (the bootstrap peers lack it): start the gateway now. */
  readonly hurry: () => void
  /** The peer is not connected yet: start the gateway now too, and a gateway win does not count against peer reads. */
  readonly race: () => void
}

/**
 * Read with the peer first and a gateway as the fallback. The gateway read starts when the peer
 * read fails or hurries it, or has not finished within `headStartMs`; then both run and the first
 * to finish wins (the other is cancelled). Neither serving: the gateway's error, which names the
 * hosts. `cancel` (the caller gave up) stops both and leaves the breaker and counters alone.
 *
 * Each `progress` call (a block arrived) pushes the gateway's start back by `stallMs` once the
 * head start is used, so a peer that is streaming is not raced; but no further than the head start
 * plus `bytes` (when given) at {@link PEER_FLOOR_BYTES_PER_MS}, so one that trickles is.
 */
export function peerFirst<T>(
  peerRead: (control: PeerReadControl) => Promise<T>,
  gatewayRead: (signal: AbortSignal) => Promise<T>,
  {
    headStartMs = PEER_HEAD_START_MS,
    stallMs = PEER_STALL_MS,
    size = (v: T) => (v instanceof Uint8Array ? v.length : 0),
    what = '',
    cancel,
    bytes = Infinity,
  }: { headStartMs?: number; stallMs?: number; size?: (v: T) => number; what?: string; cancel?: AbortSignal; bytes?: number } = {},
): Promise<T> {
  if (cancel?.aborted) return Promise.reject(new Error('cancelled'))
  totals.reads += 1
  const event: ReadEvent = { what, start: now() }
  log.push(event)
  if (log.length > 100) log.shift()
  const peerCtl = new AbortController()
  const gatewayCtl = new AbortController()
  return new Promise<T>((resolve, reject) => {
    let done = false
    let gatewayStarted = false
    let peerFailed = false
    let cold = false
    let gatewayError: { e: unknown } | null = null
    let deadline = Date.now() + headStartMs
    const latest = deadline + bytes / PEER_FLOOR_BYTES_PER_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (by: NonNullable<ReadEvent['by']>): boolean => {
      if (done) return false
      done = true
      clearTimeout(timer)
      cancel?.removeEventListener('abort', onCancel)
      event.end = now()
      event.by = by
      if (by !== 'peer') peerCtl.abort()
      if (by !== 'gateway') gatewayCtl.abort()
      return true
    }
    const onCancel = (): void => {
      if (finish('cancelled')) reject(new Error('cancelled'))
    }
    cancel?.addEventListener('abort', onCancel, { once: true })
    const win = (v: T, byPeer: boolean): void => {
      if (!finish(byPeer ? 'peer' : 'gateway')) return
      if (byPeer) {
        totals.served += 1
        totals.bytes += size(v)
        failuresInRow = 0
      } else {
        totals.fellBack += 1
        if (!cold || peerFailed) noteFailure()
      }
      resolve(v)
    }
    const lose = (): void => {
      if (!peerFailed || gatewayError === null || !finish('neither')) return
      noteFailure()
      reject(gatewayError.e)
    }
    const startGateway = (): void => {
      if (gatewayStarted || done) return
      gatewayStarted = true
      event.gateway = now()
      clearTimeout(timer)
      gatewayRead(gatewayCtl.signal).then(
        (v) => win(v, false),
        (e: unknown) => {
          gatewayError = { e }
          lose()
        },
      )
    }
    const arm = (): void => {
      timer = setTimeout(() => {
        if (Date.now() >= deadline) startGateway()
        else arm()
      }, Math.max(0, deadline - Date.now()))
    }
    arm()
    peerRead({
      signal: peerCtl.signal,
      progress: () => {
        event.firstBlock ??= now()
        deadline = Math.min(latest, Math.max(deadline, Date.now() + stallMs))
      },
      hurry: startGateway,
      race: () => {
        cold = true
        startGateway()
      },
    }).then(
      (v) => win(v, true),
      (e: unknown) => {
        if (done) return
        event.peerError = e instanceof Error ? e.message : String(e)
        peerFailed = true
        // Whatever the failed read still has in flight (its sibling blocks) stops too.
        peerCtl.abort()
        startGateway()
        lose()
      },
    )
  })
}

function noteFailure(): void {
  failuresInRow += 1
  if (failuresInRow >= BREAKER_FAILURES) {
    offUntil = Date.now() + BREAKER_MS
    failuresInRow = 0
  }
}

/** Test hook: forget the peer, its counters and the breaker. */
export function resetPeerReads(): void {
  void peer?.then((p) => p?.stop())
  peer = null
  resolvedPeer = null
  failuresInRow = 0
  offUntil = 0
  totals.reads = 0
  totals.served = 0
  totals.fellBack = 0
  totals.bytes = 0
  log.length = 0
}

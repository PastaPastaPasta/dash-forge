/**
 * Storage status (view glue): the reader's own IPFS gateways, and the plain description of
 * where an unreadable pack was looked for (`ux-dx-spec.md` §6.3):
 * `pub-9a1.r2.dev (timed out)`, `ipfs gateway ipfs.io (down: HTTP 429)`,
 * `the parent repo's chunks on Platform (missing)`.
 */

import { z } from 'zod'

import { IPFS_GATEWAYS } from '../constants'
import { isPublicHttpsUrl } from '../net'
import type { UnavailablePack } from './browse-source'
import { urlHost } from './format'

// ---------------------------------------------------------------------------
// User gateways (localStorage; a list of public URLs, nothing secret)
// ---------------------------------------------------------------------------

const GATEWAYS_KEY = 'forge.ipfsGateways'
const GatewayList = z.array(z.string().url()).max(16)

/** A gateway as typed (`https://gw.example`, `gw.example/`) → its canonical https URL, or null. */
export function normalizeGateway(input: string): string | null {
  const raw = input.trim()
  if (raw === '') return null
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
    // The app's CSP (`connect-src https:`) blocks anything else.
    if (url.protocol !== 'https:') return null
    // A gateway serves `<base>/ipfs/<cid>`: accept a pasted `…/ipfs/` and drop it.
    const path = url.pathname.replace(/\/+$/, '').replace(/\/ipfs$/, '')
    return `${url.protocol}//${url.host}${path}`
  } catch {
    return null
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The gateways this reader added (Settings / "Add a gateway"), in their order. */
export function userGateways(): string[] {
  const raw = storage()?.getItem(GATEWAYS_KEY)
  if (!raw) return []
  try {
    const parsed = GatewayList.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.flatMap((g) => normalizeGateway(g) ?? []) : []
  } catch {
    return []
  }
}

/** Replace the reader's gateway list. */
export function setUserGateways(list: readonly string[]): void {
  const clean = [...new Set(list.flatMap((g) => normalizeGateway(g) ?? []))].slice(0, 16)
  storage()?.setItem(GATEWAYS_KEY, JSON.stringify(clean))
}

/** Test hook: the shared default list, replaced (`null` restores the real one). */
let defaultsOverride: readonly string[] | null = null
export function overrideDefaultGateways(list: readonly string[] | null): void {
  defaultsOverride = list
}

/** The gateways every `ipfs://` read tries: the reader's own first, then the shared defaults. */
export function readGateways(): string[] {
  return [...new Set([...userGateways(), ...(defaultsOverride ?? IPFS_GATEWAYS)])]
}

// ---------------------------------------------------------------------------
// A repo's own gateways (recorded on chain)
// ---------------------------------------------------------------------------

/**
 * The public IPFS gateways `uris` name: the base of every `https://<gw>/ipfs/…` URL (a pack
 * manifest's recorded gateway copy, or a `config.backend.uris` entry `https://<gw>/ipfs/`).
 * Public https only: a manifest is written by whoever pushed, and must not point every
 * reader's browser at a loopback or LAN host.
 */
export function gatewaysIn(uris: readonly string[]): string[] {
  const out: string[] = []
  for (const uri of uris) {
    const at = uri.indexOf('/ipfs/')
    if (at < 0) continue
    let base: string
    try {
      // Scheme, host, port and path only: a query or fragment is not part of a gateway.
      const u = new URL(uri.slice(0, at))
      base = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, '')
    } catch {
      continue
    }
    if (isPublicHttpsUrl(base) && !out.includes(base)) out.push(base)
  }
  return out
}

/**
 * At most this many of a repo's own gateways go ahead of the shared list (parity with
 * forge-core `MAX_REPO_GATEWAYS`): each is tried before any default.
 */
export const MAX_REPO_GATEWAYS = 3

/** Where a repo's own gateways were read from. */
export type RepoGatewaySource = 'config' | 'manifests'

/** Per repo (`repoKey`): the latest gateways each trusted source names. */
const repoGatewayMap = new Map<string, Record<RepoGatewaySource, string[]>>()

/**
 * Record the gateways `uris` name for repo `key` from `source`, replacing that source's
 * previous snapshot (so a gateway no longer recorded is dropped). Callers pass only trusted
 * records: `config` is the repo config's `backend.uris` (maintainer-written), `manifests` the
 * uris of manifests uploaded by a CURRENT member — a past writer or a stranger must not put
 * a stalling gateway ahead of every pack.
 */
export function noteRepoGateways(key: string, source: RepoGatewaySource, uris: readonly string[]): void {
  const sources = repoGatewayMap.get(key) ?? { config: [], manifests: [] }
  repoGatewayMap.set(key, { ...sources, [source]: gatewaysIn(uris) })
}

/** A repo's own gateways: the config's first, then the members' manifests', capped. */
function repoGateways(key: string): string[] {
  const s = repoGatewayMap.get(key)
  if (s === undefined) return []
  return [...new Set([...s.config, ...s.manifests])].slice(0, MAX_REPO_GATEWAYS)
}

/**
 * The gateways an `ipfs://` read of repo `key` tries: the repo's OWN public gateways first
 * (they reach the node that holds its content; a shared default may not), then the reader's,
 * then the shared defaults.
 */
export function readGatewaysFor(key: string): string[] {
  return [...new Set([...repoGateways(key), ...readGateways()])]
}

/** Test hook: forget every repo's recorded gateways. */
export function resetRepoGateways(): void {
  repoGatewayMap.clear()
}

// ---------------------------------------------------------------------------
// Gateway liveness (once per session)
// ---------------------------------------------------------------------------

/**
 * The empty identity CID: a working gateway answers it (0 bytes) without searching the IPFS
 * network, so the answer measures the gateway, not whether some node holds a CID.
 */
const IDENTITY_CID = 'bafkqaaa'

/** How long a gateway gets to answer the liveness probe. */
const GATEWAY_PROBE_TIMEOUT_MS = 8_000

/** A gateway's liveness: `null` unless it answered 429/410/5xx, else why (`HTTP 429`). */
type GatewayDown = string | null

/** How long a "down" verdict stands before the gateway is probed again. */
const GATEWAY_DOWN_TTL_MS = 60_000

/** The failure line for a URL skipped because its gateway is down (read back by {@link describePack}). */
export function gatewayDownReason(host: string, why: string): string {
  return `${host}: gateway down (${why})`
}

/** The `why` of a {@link gatewayDownReason} message, or null. */
function gatewayDownWhy(message: string): string | null {
  const m = /^gateway down \((.*)\)$/.exec(message)
  return m === null ? null : (m[1] as string)
}

/** How {@link describePack} names a failed IPFS gateway (and how {@link onlyGatewaysFailed} spots one). */
const GATEWAY_PLACE = 'ipfs gateway '

const gatewayHealthCache = new Map<string, { readonly at: number; readonly verdict: Promise<GatewayDown> }>()

/**
 * Whether `gateway` is known to be down: it answered the identity-CID probe with 429/410
 * (rate-limited or retired: ipfs.io and dweb.link since 2026-09-21) or 5xx. Anything else is
 * NOT a down verdict: a thrown error (a network failure, or a 403/404 that came back without
 * CORS headers, which a dedicated gateway sends for CIDs it does not pin) or a timeout is
 * unknown, and the gateway stays in the race. A down verdict expires after
 * {@link GATEWAY_DOWN_TTL_MS}; an "up" one is kept for the session.
 */
export function gatewayHealth(gateway: string, now = Date.now()): Promise<GatewayDown> {
  const key = gateway.replace(/\/+$/, '')
  const hit = gatewayHealthCache.get(key)
  if (hit !== undefined) {
    const stale = now - hit.at > GATEWAY_DOWN_TTL_MS
    // A settled "down" past its TTL is probed again; everything else is reused.
    if (!stale) return hit.verdict
    const expired = hit.verdict.then((down) => down !== null)
    return expired.then((wasDown) => (wasDown ? probeGateway(key, now) : hit.verdict))
  }
  return probeGateway(key, now)
}

function probeGateway(key: string, now: number): Promise<GatewayDown> {
  const verdict = (async (): Promise<GatewayDown> => {
    try {
      const resp = await fetch(`${key}/ipfs/${IDENTITY_CID}`, {
        signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS),
        cache: 'no-store',
      })
      return resp.status === 429 || resp.status === 410 || resp.status >= 500 ? `HTTP ${resp.status}` : null
    } catch {
      return null
    }
  })()
  gatewayHealthCache.set(key, { at: now, verdict })
  return verdict
}

/** "Try again" / tests: probe every gateway afresh. */
export function resetGatewayHealth(): void {
  gatewayHealthCache.clear()
}

/** The gateway base of a path-style gateway URL (`https://gw/ipfs/<cid>` → `https://gw`), else null. */
export function gatewayOf(url: string): string | null {
  const m = /^(https:\/\/[^?#]+?)\/ipfs\/[A-Za-z0-9]+$/.exec(url)
  return m === null ? null : (m[1] as string)
}

// ---------------------------------------------------------------------------
// Describing an unreadable pack
// ---------------------------------------------------------------------------

type Why = 'timed out' | 'not found' | 'served bad data' | 'missing' | "didn't answer"

function classify(message: string, platform: boolean): Why {
  if (/sha256|do not match|does not hash/i.test(message)) return 'served bad data'
  if (/no data for|timed? ?out|abort/i.test(message)) return 'timed out'
  if (/HTTP 404|not found|missing chunk/i.test(message)) return platform ? 'missing' : 'not found'
  return "didn't answer"
}

/**
 * Per-host failure reasons from a {@link UnavailablePack}. The whole-pack fetch records
 * `host: message` segments; a ranged read records one message for every host.
 */
function reasonsByHost(pack: UnavailablePack): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of pack.reason.split('; ')) {
    const m = /^([^\s:]+(?::\d+)?): (.*)$/.exec(part)
    if (m !== null && pack.hosts.includes(m[1] as string)) out.set(m[1] as string, m[2] as string)
  }
  for (const host of pack.hosts) if (!out.has(host)) out.set(host, pack.reason)
  return out
}


/**
 * Where one pack was looked for and why each place failed. Order: Platform chunks, then
 * mirrors, then each IPFS gateway by name (`ipfs gateway ipfs.io (down: HTTP 429)`), so a
 * reader can tell a retired gateway from content no gateway can find.
 */
export function describePack(pack: UnavailablePack, gateways: readonly string[]): string[] {
  const gatewayHosts = new Set(gateways.map(urlHost))
  const places: string[] = []
  const ipfs: string[] = []
  for (const [host, message] of reasonsByHost(pack)) {
    if (host === 'platform') {
      places.push(`the parent repo's chunks on Platform (${classify(message, true)})`)
    } else if (gatewayHosts.has(host) || gatewayDownWhy(message) !== null) {
      const down = gatewayDownWhy(message)
      ipfs.push(`${GATEWAY_PLACE}${host} (${down !== null ? `down: ${down}` : classify(message, false)})`)
    } else {
      places.push(`${host} (${classify(message, false)})`)
    }
  }
  places.push(...ipfs)
  if (places.length === 0) places.push('no place a browser can fetch from is recorded')
  return places
}

/** Whether every failed place for `packs` is an IPFS gateway (so adding a gateway may help). */
export function onlyGatewaysFailed(places: readonly string[]): boolean {
  return places.length > 0 && places.every((p) => p.startsWith(GATEWAY_PLACE))
}

/** Every distinct place, over a set of unreadable packs (`gateways`: the repo's, {@link readGatewaysFor}). */
export function describeUnavailable(packs: readonly UnavailablePack[], gateways: readonly string[]): string[] {
  return [...new Set(packs.flatMap((p) => describePack(p, gateways)))]
}

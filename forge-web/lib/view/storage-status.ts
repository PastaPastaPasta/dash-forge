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
    const base = uri.slice(0, at).replace(/\/+$/, '')
    if (isPublicHttpsUrl(base) && !out.includes(base)) out.push(base)
  }
  return out
}

/** Per repo (`repoKey`): the gateways its owner recorded on chain, in first-seen order. */
const repoGatewayMap = new Map<string, string[]>()

/** Remember the gateways `uris` (a repo's manifests, its `config.backend.uris`) name. */
export function noteRepoGateways(key: string, uris: readonly string[]): void {
  const known = repoGatewayMap.get(key) ?? []
  const merged = [...new Set([...known, ...gatewaysIn(uris)])]
  if (merged.length > 0) repoGatewayMap.set(key, merged)
}

/**
 * The gateways an `ipfs://` read of repo `key` tries: the repo's OWN public gateways first
 * (they reach the node that holds its content; a shared default may not), then the reader's,
 * then the shared defaults.
 */
export function readGatewaysFor(key: string): string[] {
  return [...new Set([...(repoGatewayMap.get(key) ?? []), ...readGateways()])]
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

/** A gateway's liveness: `null` when it answered, else why not (`HTTP 429`, `no answer in 8s`). */
export type GatewayDown = string | null

const gatewayHealthCache = new Map<string, Promise<GatewayDown>>()

/**
 * Whether `gateway` answers at all (cached for the session). A retired gateway (ipfs.io and
 * dweb.link answer 429 since 2026-09-21) or an unreachable one is then skipped at once, rather
 * than costing every pack a timeout, and the storage card can name it.
 */
export function gatewayHealth(gateway: string): Promise<GatewayDown> {
  const key = gateway.replace(/\/+$/, '')
  const hit = gatewayHealthCache.get(key)
  if (hit !== undefined) return hit
  const probe = (async (): Promise<GatewayDown> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GATEWAY_PROBE_TIMEOUT_MS)
    try {
      const resp = await fetch(`${key}/ipfs/${IDENTITY_CID}`, { signal: controller.signal })
      // Down: rate-limited or retired (429, 410) or broken (5xx). Any other answer means the
      // gateway is there; a 403/404 is a restricted gateway serving only its own pins.
      return resp.status === 429 || resp.status === 410 || resp.status >= 500 ? `HTTP ${resp.status}` : null
    } catch {
      return controller.signal.aborted
        ? `no answer in ${GATEWAY_PROBE_TIMEOUT_MS / 1000}s`
        : "didn't answer (down, or refused this site)"
    } finally {
      clearTimeout(timer)
    }
  })()
  gatewayHealthCache.set(key, probe)
  return probe
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

/** Why one IPFS gateway failed: its liveness verdict when it was skipped as down, else the read's. */
function gatewayWhy(message: string): string {
  const down = /gateway down \(([^)]*)\)/.exec(message)
  return down !== null ? `down: ${down[1]}` : classify(message, false)
}

/**
 * Where one pack was looked for and why each place failed. Order: Platform chunks, then
 * mirrors, then each IPFS gateway by name (`ipfs gateway ipfs.io (down: HTTP 429)`), so a
 * reader can tell a retired gateway from content no gateway can find.
 */
export function describePack(pack: UnavailablePack, gateways: readonly string[] = readGateways()): string[] {
  const gatewayHosts = new Set(gateways.map(urlHost))
  const places: string[] = []
  const ipfs: string[] = []
  for (const [host, message] of reasonsByHost(pack)) {
    if (host === 'platform') {
      places.push(`the parent repo's chunks on Platform (${classify(message, true)})`)
    } else if (gatewayHosts.has(host) || /gateway down \(/.test(message)) {
      ipfs.push(`ipfs gateway ${host} (${gatewayWhy(message)})`)
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
  return places.length > 0 && places.every((p) => p.startsWith('ipfs gateway '))
}

/** Every distinct place, over a set of unreadable packs. */
export function describeUnavailable(packs: readonly UnavailablePack[], gateways?: readonly string[]): string[] {
  return [...new Set(packs.flatMap((p) => describePack(p, gateways)))]
}

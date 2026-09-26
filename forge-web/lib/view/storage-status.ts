/**
 * Storage status (view glue): the reader's own IPFS gateways, and the plain description of
 * where an unreadable pack was looked for (`ux-dx-spec.md` §6.3):
 * `pub-9a1.r2.dev (timed out)`, `ipfs (not found on 3 gateways)`,
 * `the parent repo's chunks on Platform (missing)`.
 */

import { z } from 'zod'

import { IPFS_GATEWAYS } from '../constants'
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

/** The gateways every `ipfs://` read tries: the reader's own first, then the shared defaults. */
export function readGateways(): string[] {
  return [...new Set([...userGateways(), ...IPFS_GATEWAYS])]
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
 * Where one pack was looked for and why each place failed, gateways grouped as `ipfs`.
 * Order: Platform chunks, then mirrors, then IPFS.
 */
export function describePack(pack: UnavailablePack, gateways: readonly string[] = readGateways()): string[] {
  const gatewayHosts = new Set(gateways.map(urlHost))
  const places: string[] = []
  const ipfs: Why[] = []
  for (const [host, message] of reasonsByHost(pack)) {
    if (host === 'platform') {
      places.push(`the parent repo's chunks on Platform (${classify(message, true)})`)
    } else if (gatewayHosts.has(host)) {
      ipfs.push(classify(message, false))
    } else {
      places.push(`${host} (${classify(message, false)})`)
    }
  }
  if (ipfs.length > 0) {
    const n = `${ipfs.length} ${ipfs.length === 1 ? 'gateway' : 'gateways'}`
    const all = ipfs.every((w) => w === ipfs[0]) ? ipfs[0] : undefined
    places.push(
      all === 'not found'
        ? `ipfs (not found on ${n})`
        : all === 'timed out'
          ? `ipfs (timed out on ${n})`
          : `ipfs (no copy from ${n})`,
    )
  }
  if (places.length === 0) places.push('no place a browser can fetch from is recorded')
  return places
}

/** Every distinct place, over a set of unreadable packs. */
export function describeUnavailable(packs: readonly UnavailablePack[], gateways?: readonly string[]): string[] {
  return [...new Set(packs.flatMap((p) => describePack(p, gateways)))]
}

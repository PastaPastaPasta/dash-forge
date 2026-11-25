/**
 * The `prefs` slot (docs/design/identity-synced-state.md §4) against this browser's preference
 * keys. Synced: `diff` and `mergeIdentity` (`forge.prefs.v1`), `fiat` (`forge:fiat:v1`), `trending`
 * (`forge.trending.v1`), `imageHosts` (`forge.imageHosts.v1`), `ipfsGateways`
 * (`forge.ipfsGateways`) and `orgs` (`forge:orgs:<network>`). Not synced: `ipfsPeer`
 * (`forge.ipfsPeer`, peer reads on or off in this browser: a choice about this device's network
 * and battery, not the person); another client's entry for it is kept in the map untouched.
 *
 * A key never set here is absent (not its default), so a fresh device takes the synced values.
 */

import { isCurrency } from '../fiat/providers'
import { FIAT_SETTINGS_KEY } from '../fiat/store'
import { TRENDING_PREF_KEY } from '../repo/trending'
import { IMAGE_HOSTS_KEY, parseImageHosts } from '../view/markdown-links'
import { PREFS_KEY, parsePrefs, type Prefs } from '../view/prefs'
import { GATEWAYS_KEY, normalizeGateway } from '../view/storage-status'
import type { PlanOptions } from './lww'

export const orgsKey = (network: string): string => `forge:orgs:${network}`

/** The preference keys the slot reads, for `network` (the org list is per network). */
export function prefKeys(network: string): string[] {
  return [PREFS_KEY, FIAT_SETTINGS_KEY, TRENDING_PREF_KEY, IMAGE_HOSTS_KEY, GATEWAYS_KEY, orgsKey(network)]
}

function json(raw: string | null): unknown {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function gatewaysOf(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  return [...new Set(v.flatMap((g) => (typeof g === 'string' ? (normalizeGateway(g) ?? []) : [])))].slice(0, 16)
}

function orgsOf(v: unknown, network: string): Record<string, unknown>[] | null {
  if (!Array.isArray(v)) return null
  return v.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && typeof (r as Record<string, unknown>)['orgId'] === 'string' && (r as Record<string, unknown>)['network'] === network)
}

/** The slot's entries for the local raw values (`raw[key]` null: not set here). */
export function prefsEntries(raw: Readonly<Record<string, string | null>>, network: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const prefsRaw = raw[PREFS_KEY] ?? null
  if (prefsRaw !== null) {
    const p = parsePrefs(prefsRaw)
    out['diff'] = { diffLayout: p.diffLayout, ignoreWhitespace: p.ignoreWhitespace, palette: p.palette }
    if (p.mergeName !== '' || p.mergeEmail !== '') out['mergeIdentity'] = { name: p.mergeName, email: p.mergeEmail }
  }
  const fiat = json(raw[FIAT_SETTINGS_KEY] ?? null) as Record<string, unknown> | undefined
  if (fiat && typeof fiat === 'object' && typeof fiat['enabled'] === 'boolean' && isCurrency(fiat['currency'])) out['fiat'] = { enabled: fiat['enabled'], currency: fiat['currency'] }
  const trending = raw[TRENDING_PREF_KEY] ?? null
  if (trending === 'on' || trending === 'off') out['trending'] = trending === 'on'
  if ((raw[IMAGE_HOSTS_KEY] ?? null) !== null) out['imageHosts'] = parseImageHosts(raw[IMAGE_HOSTS_KEY] ?? null)
  const gateways = gatewaysOf(json(raw[GATEWAYS_KEY] ?? null))
  if (gateways !== null) out['ipfsGateways'] = gateways
  const orgs = orgsOf(json(raw[orgsKey(network)] ?? null), network)
  if (orgs !== null) out['orgs'] = orgs
  return out
}

/** List keys merge element by element: hosts and gateways by value, organizations by id. */
export const PREFS_PLAN: PlanOptions = {
  tombstoneRemoved: false,
  lists: {
    imageHosts: (e) => String(e),
    ipfsGateways: (e) => String(e),
    orgs: (e) => String((e as Record<string, unknown>)['orgId']),
  },
}

/**
 * The raw value each preference key shows for the merged `view`, built over the local raw values
 * (a key the view does not name keeps its local value: no entry here). Each reader still parses
 * and checks it as it does a stored value.
 */
export function prefsViewRaw(view: Readonly<Record<string, unknown>>, raw: Readonly<Record<string, string | null>>, network: string): Record<string, string> {
  const out: Record<string, string> = {}
  const diff = view['diff'] as Partial<Prefs> | undefined
  const merge = view['mergeIdentity'] as { name?: unknown; email?: unknown } | undefined
  if (diff !== undefined || merge !== undefined) {
    const base = parsePrefs(raw[PREFS_KEY] ?? null)
    const next = parsePrefs(
      JSON.stringify({
        ...base,
        ...(diff && typeof diff === 'object' ? { diffLayout: diff.diffLayout, ignoreWhitespace: diff.ignoreWhitespace, palette: diff.palette } : {}),
        ...(merge && typeof merge === 'object' ? { mergeName: merge.name, mergeEmail: merge.email } : {}),
      }),
    )
    out[PREFS_KEY] = JSON.stringify(next)
  }
  const fiat = view['fiat'] as Record<string, unknown> | undefined
  if (fiat && typeof fiat['enabled'] === 'boolean' && isCurrency(fiat['currency'])) out[FIAT_SETTINGS_KEY] = JSON.stringify({ v: 1, enabled: fiat['enabled'], currency: fiat['currency'] })
  if (typeof view['trending'] === 'boolean') out[TRENDING_PREF_KEY] = view['trending'] ? 'on' : 'off'
  if (Array.isArray(view['imageHosts'])) out[IMAGE_HOSTS_KEY] = JSON.stringify(parseImageHosts(JSON.stringify(view['imageHosts'])))
  const gateways = gatewaysOf(view['ipfsGateways'])
  if (gateways !== null) out[GATEWAYS_KEY] = JSON.stringify(gateways)
  const orgs = orgsOf(view['orgs'], network)
  if (orgs !== null) out[orgsKey(network)] = JSON.stringify(orgs)
  return out
}

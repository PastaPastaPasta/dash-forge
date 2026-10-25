/**
 * Where a passkey that holds a key on Platform may be made and used (PLAN-passkey-vault.md §3,
 * "RP ID policy"). Its relying party id is exactly the page's host, and only two hosts qualify:
 * `forge.dashhq.org` and `localhost` (development and the e2e suite). Never a parent domain such
 * as `dashhq.org`: every subdomain could then ask the browser for the same PRF output, so any of
 * them could open every Forge passkey's entry. IPFS subdomain gateways are refused too: each CID is
 * its own origin, so a passkey made there would be lost with the next release.
 *
 * The browser vault's own passkeys (`../vault`) are unaffected: they stay on the page's origin.
 */

import type { ForgeIds } from '../../deployments'
import { passkeysAvailable, sharedOriginProblem } from '../vault'

/** The only relying party ids a vault passkey is made for. */
const PASSKEY_VAULT_RP_IDS: readonly string[] = ['forge.dashhq.org', 'localhost']

type PageLocation = { readonly hostname: string; readonly pathname: string }

const currentLocation = (): PageLocation | null => (typeof window === 'undefined' ? null : window.location)

/** An IPFS or IPNS subdomain gateway host (`<cid>.ipfs.<gateway>`): one origin per release. */
const IPFS_SUBDOMAIN = /\.ip[fn]s\./i

/** The relying party id for vault passkeys on this page, or null when the page may not have one. */
export function passkeyVaultRpId(location: PageLocation | null = currentLocation()): string | null {
  if (location === null) return null
  const host = location.hostname.toLowerCase()
  if (IPFS_SUBDOMAIN.test(host) || sharedOriginProblem(location) !== null) return null
  return PASSKEY_VAULT_RP_IDS.includes(host) ? host : null
}

/**
 * Why passkeys that hold a key on Platform are not offered here (a sentence for the UI), or null
 * when they are. The vault's entries live in forge-meta: a network without it has none.
 */
export function passkeyVaultProblem(forge: Pick<ForgeIds, 'meta'> | null, location: PageLocation | null = currentLocation(), available: () => boolean = passkeysAvailable): string | null {
  if (forge?.meta === undefined) return "Passkeys that work on your other devices aren't available on this network yet."
  if (location === null || !available()) return "This browser can't use passkeys on this page."
  const shared = sharedOriginProblem(location)
  if (shared !== null) return shared
  if (passkeyVaultRpId(location) === null) return 'Passkeys that work on your other devices need Forge’s own address: open https://forge.dashhq.org.'
  return null
}

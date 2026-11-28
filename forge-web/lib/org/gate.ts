import { ACTIVE_NETWORK, type Network } from '../constants'

export const RELAY_ORIGIN = 'https://multisig.dashhq.org'

export function orgsEnabled(network: Network): boolean {
  return network !== 'mainnet'
}

export function orgNetworkName(): string {
  return ACTIVE_NETWORK.key
}

export function multisigAppUrl(network = orgNetworkName()): string {
  return `${RELAY_ORIGIN}/?network=${encodeURIComponent(network)}`
}

export function declaredOrgLink(network: string, threshold: number, size: number): string {
  return `${RELAY_ORIGIN}/?network=${network}#org=${threshold}of${size}`
}

const decodedOrNull = (s: string): string | null => {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

export function parseDeclaredOrg(link: string, network: string): { threshold: number; size: number } | null {
  const m = /^https:\/\/multisig\.dashhq\.org\/\?network=([^#&]+)#org=(\d{1,2})of(\d{1,2})$/.exec(link.trim())
  if (!m || decodedOrNull(m[1] as string) !== network) return null
  const threshold = Number(m[2])
  const size = Number(m[3])
  return threshold >= 2 && threshold <= size && size <= 64 ? { threshold, size } : null
}

/** Whether `link` claims to declare an organization, whatever its network and counts. */
export const isDeclaredLink = (link: unknown): link is string => typeof link === 'string' && link.trim().startsWith(`${RELAY_ORIGIN}/`) && link.includes('#org=')

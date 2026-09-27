/**
 * What the confirmation step shows about the identity that answered a wallet request, so a
 * person can tell their identity from a stranger's that answered the same QR first (the legacy
 * key-exchange contract keeps only the first answer: docs/design/wallet-login.md).
 *
 * Platform stores no creation time for an identity. The DPNS name's `$createdAt` (a required
 * field of `domain`) is the age proxy: an identity that got its name minutes ago is suspicious
 * in the same way a brand-new one is. No name at all is flagged too.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { queryDocuments } from '../sdk'

/** Named less than this long ago: "new". */
export const NEW_IDENTITY_MS = 24 * 60 * 60 * 1000

export interface ResponderProfile {
  readonly identityId: string
  /** `label.parent`, or null when the identity has no DPNS name (or the read failed). */
  readonly name: string | null
  /** When that name was registered (ms), or null. */
  readonly namedAt: number | null
  /** Warnings to show, most important first. */
  readonly warnings: readonly string[]
}

/**
 * The profile of `identityId`, with warnings: no DPNS name, a name registered in the last day,
 * or an identity other than the one this device already holds a key for (`storedIdentities`).
 */
export async function responderProfile(
  sdk: EvoSDK,
  identityId: string,
  network: Network,
  storedIdentities: readonly string[],
  now = Date.now(),
): Promise<ResponderProfile> {
  let name: string | null = null
  let namedAt: number | null = null
  try {
    const [doc] = await queryDocuments(sdk, {
      dataContractId: NETWORKS[network].dpnsContractId,
      documentTypeName: 'domain',
      where: [['records.identity', '==', identityId]],
      limit: 1,
    })
    if (doc && typeof doc['label'] === 'string') {
      const parent = typeof doc['normalizedParentDomainName'] === 'string' && doc['normalizedParentDomainName'] ? `.${doc['normalizedParentDomainName']}` : ''
      name = `${doc['label']}${parent}`
      const created = Number(doc['$createdAt'])
      namedAt = Number.isFinite(created) && created > 0 ? created : null
    }
  } catch {
    /* no name shown; flagged below */
  }
  return { identityId, name, namedAt, warnings: responderWarnings({ identityId, name, namedAt }, storedIdentities, now) }
}

/** The warnings for a profile (pure; exported for tests). */
export function responderWarnings(
  p: { identityId: string; name: string | null; namedAt: number | null },
  storedIdentities: readonly string[],
  now = Date.now(),
): string[] {
  const out: string[] = []
  const others = storedIdentities.filter((id) => id !== p.identityId)
  if (others.length > 0 && !storedIdentities.includes(p.identityId)) {
    out.push(
      `This is NOT the identity this device already holds a key for (${others.map((id) => `${id.slice(0, 10)}…`).join(', ')}). If you meant to sign in as that one, someone else answered your QR code: close this and start again.`,
    )
  }
  if (p.name === null) {
    out.push('This identity has no DPNS username. Make sure the start and end of the id above match what your wallet showed when you approved.')
  }
  else if (p.namedAt !== null && now - p.namedAt < NEW_IDENTITY_MS) {
    out.push(`The username ${p.name} was registered less than a day ago. If your identity is older, someone else answered your QR code.`)
  }
  return out
}

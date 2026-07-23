/**
 * DPNS name resolution (view glue) — reverse-resolve an identity id to its primary name.
 *
 * DPNS stores `domain` documents whose `records.identity` points at an identity. A reverse
 * lookup (`records.identity == id`) yields the human name shown in the identity pill. Results
 * are cached per session; failures degrade to the abbreviated id (never throw to the UI).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { queryDocuments } from '../sdk'

const cache = new Map<string, string | null>()

function nameOf(doc: Record<string, unknown>): string | null {
  const label = doc['label']
  const parent = doc['normalizedParentDomainName']
  if (typeof label === 'string' && label.length > 0) {
    const suffix = typeof parent === 'string' && parent.length > 0 ? `.${parent}` : ''
    return `${label}${suffix}`
  }
  return null
}

/** Reverse-resolve an identity id to a DPNS name, or null. Never throws. */
export async function resolveDpnsName(
  sdk: EvoSDK,
  identityId: string,
  network: Network,
): Promise<string | null> {
  const key = `${network}:${identityId}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const dpns = NETWORKS[network].dpnsContractId
  if (dpns === null) {
    cache.set(key, null)
    return null
  }
  try {
    const docs = await queryDocuments(sdk, {
      dataContractId: dpns,
      documentTypeName: 'domain',
      where: [['records.identity', '==', identityId]],
      limit: 1,
    })
    const name = docs[0] ? nameOf(docs[0]) : null
    cache.set(key, name)
    return name
  } catch {
    cache.set(key, null)
    return null
  }
}

/** Resolve many identity ids to names in parallel (deduped, cache-backed). */
export async function resolveDpnsNames(
  sdk: EvoSDK,
  ids: readonly string[],
  network: Network,
): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)]
  const entries = await Promise.all(
    unique.map(async (id) => [id, await resolveDpnsName(sdk, id, network)] as const),
  )
  return new Map(entries)
}

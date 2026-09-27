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
/** The cache key of `id`'s name on `network`. */
const keyOf = (network: Network, id: string): string => `${network}:${id}`
/** Batched lookups in flight ({@link prefetchDpnsNames}), per key: a per-id read waits for them. */
const pending = new Map<string, Promise<void>>()

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
  const key = keyOf(network, identityId)
  await pending.get(key)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const dpns = NETWORKS[network].dpnsContractId
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

/** The primary name of each identity among DPNS `domain` documents (`records.identity`). */
export function namesFromDomains(docs: readonly Record<string, unknown>[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const d of docs) {
    const records = d['records']
    const id = records !== null && typeof records === 'object' ? (records as Record<string, unknown>)['identity'] : undefined
    const name = nameOf(d)
    if (typeof id === 'string' && name !== null && !out.has(id)) out.set(id, name)
  }
  return out
}

/**
 * Record names read elsewhere (a composite's bound DPNS lookup): each of `looked` gets its
 * name from `names`, or null. A bound lookup proves absence too, so an identity without a
 * domain is cached as nameless and never asked about again.
 */
export function seedDpnsNames(network: Network, looked: Iterable<string>, names: ReadonlyMap<string, string>): void {
  for (const id of looked) {
    const key = keyOf(network, id)
    if (!cache.has(key)) cache.set(key, names.get(id) ?? null)
  }
}

/**
 * Record the names a lookup of `looked` returned (`domains`: DPNS `domain` documents). A short
 * page (< 100) is the whole answer, so an id it does not name is nameless (a proven absence);
 * a full page may have cut names off, so only the names it holds are recorded.
 */
export function seedFromDomains(network: Network, looked: readonly string[], domains: readonly Record<string, unknown>[]): void {
  const names = namesFromDomains(domains)
  if (domains.length < 100) {
    seedDpnsNames(network, looked, names)
    return
  }
  for (const [id, name] of names) cache.set(keyOf(network, id), name)
}

/** Forget every cached name (tests). */
export function clearDpnsCache(): void {
  cache.clear()
}

/** A cached name: undefined when unknown, null when proven nameless (tests, views). */
export function cachedDpnsName(network: Network, id: string): string | null | undefined {
  return cache.get(keyOf(network, id))
}

/**
 * Resolve every uncached id in one `records.identity in [...]` query per 100 (instead of one
 * query per id). Never throws: a failed batch leaves its ids to the per-id resolver.
 */
export async function prefetchDpnsNames(sdk: EvoSDK, ids: Iterable<string>, network: Network): Promise<void> {
  const todo = [...new Set(ids)].filter((id) => id !== '' && !cache.has(keyOf(network, id)) && !pending.has(keyOf(network, id)))
  const batches: Promise<void>[] = []
  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100)
    const run = readBatch(sdk, batch, network)
    for (const id of batch) pending.set(keyOf(network, id), run)
    batches.push(run.finally(() => batch.forEach((id) => pending.delete(keyOf(network, id)))))
  }
  await Promise.all(batches)
}

async function readBatch(sdk: EvoSDK, batch: readonly string[], network: Network): Promise<void> {
  try {
    const docs = await queryDocuments(sdk, {
      dataContractId: NETWORKS[network].dpnsContractId,
      documentTypeName: 'domain',
      where: [['records.identity', 'in', [...batch]]],
      orderBy: [['records.identity', 'asc']],
      limit: 100,
    })
    seedFromDomains(network, batch, docs)
  } catch {
    /* the per-id resolver still works */
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

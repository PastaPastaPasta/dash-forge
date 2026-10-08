/**
 * DPNS name resolution (view glue) — reverse-resolve an identity id to its primary name, and
 * forward-resolve a name to its identity id.
 *
 * DPNS stores `domain` documents whose `records.identity` points at an identity. A reverse
 * lookup (`records.identity == id`) yields the human name shown in the identity pill. Results
 * are cached per session; failures degrade to the abbreviated id (never throw to the UI). A failed
 * read is not a name that does not exist: it is remembered for {@link DPNS_FAILURE_TTL_MS} only,
 * so a later render reads again.
 *
 * Forward resolution (name -> id, L-43) uses the contract's unique `parentNameAndLabel` index
 * (`normalizedParentDomainName asc, normalizedLabel asc` — dpns-contract schema v2) and the same
 * homograph-safe normalization the contract itself applies before indexing (lowercase, then
 * `o`->`0`, `l`/`i`->`1`; verified against `js-dash-sdk`'s `convertToHomographSafeChars` and
 * `rs-dpp`'s `convert_to_homograph_safe_chars`, which agree). A bare name with no `.` is a
 * subdomain of `dash`, same as typing it anywhere else in this app. A value that could not be a
 * DPNS label at all ({@link looksLikeDpnsName}) is rejected before it ever reaches a query; a hit
 * seeds the reverse (id -> name) cache too, for free, since the doc is already in hand.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import { queryDocuments } from '../sdk'

const cache = new Map<string, string | null>()
/** How long a failed read is believed: it is not proof of "no name", so after this a read retries. */
export const DPNS_FAILURE_TTL_MS = 15_000
/** When each id's last read failed (key -> time). Never read as a name: see {@link dpnsReadFailed}. */
const failedAt = new Map<string, number>()
/** The cache key of `id`'s name on `network`. */
const keyOf = (network: Network, id: string): string => `${network}:${id}`
/** Batched lookups in flight ({@link prefetchDpnsNames}), per key: a per-id read waits for them. */
const pending = new Map<string, Promise<void>>()

/** The identity a DPNS `domain` document's `records.identity` points at, or null. */
function identityOf(doc: Record<string, unknown> | undefined): string | null {
  const records = doc?.['records']
  const id = records !== null && typeof records === 'object' ? (records as Record<string, unknown>)['identity'] : undefined
  return typeof id === 'string' ? id : null
}

function nameOf(doc: Record<string, unknown>): string | null {
  const label = doc['label']
  const parent = doc['normalizedParentDomainName']
  if (typeof label === 'string' && label.length > 0) {
    const suffix = typeof parent === 'string' && parent.length > 0 ? `.${parent}` : ''
    return `${label}${suffix}`
  }
  return null
}

/**
 * Whether the last read of `id`'s name failed, recently enough to be believed. Such an id has no
 * cached answer: null from {@link resolveDpnsName} then means "could not read", not "no name".
 */
export function dpnsReadFailed(network: Network, id: string): boolean {
  const at = failedAt.get(keyOf(network, id))
  return at !== undefined && Date.now() - at < DPNS_FAILURE_TTL_MS
}

/**
 * Reverse-resolve an identity id to a DPNS name, or null. Never throws. A failed read answers null
 * without caching it: callers that must tell it from "no name" ask {@link dpnsReadFailed}, and
 * the next read after {@link DPNS_FAILURE_TTL_MS} tries again (until then it is not repeated, so a
 * page of failing pills does not hammer a node that is down).
 */
export async function resolveDpnsName(
  sdk: EvoSDK,
  identityId: string,
  network: Network,
): Promise<string | null> {
  const key = keyOf(network, identityId)
  await pending.get(key)
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  if (dpnsReadFailed(network, identityId)) return null

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
    failedAt.delete(key)
    return name
  } catch {
    failedAt.set(key, Date.now())
    return null
  }
}

/**
 * {@link resolveDpnsName} for a page that acts on "no name" (offering a way to get one): a failed
 * read throws instead of reading as none, and a cached "none" is read again (it may have been a
 * failure). A name found is cached for every caller.
 */
export async function lookupDpnsName(sdk: EvoSDK, identityId: string, network: Network): Promise<string | null> {
  const key = keyOf(network, identityId)
  await pending.get(key)
  const cached = cache.get(key)
  if (typeof cached === 'string') return cached
  const docs = await queryDocuments(sdk, {
    dataContractId: NETWORKS[network].dpnsContractId,
    documentTypeName: 'domain',
    where: [['records.identity', '==', identityId]],
    limit: 1,
  })
  const name = docs[0] ? nameOf(docs[0]) : null
  cache.set(key, name)
  failedAt.delete(key)
  return name
}

/** The primary name of each identity among DPNS `domain` documents (`records.identity`). */
export function namesFromDomains(docs: readonly Record<string, unknown>[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const d of docs) {
    const id = identityOf(d)
    const name = nameOf(d)
    if (id !== null && name !== null && !out.has(id)) out.set(id, name)
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
  failedAt.clear()
  idLookups.clear()
}

/**
 * Forward lookups by normalized name, per network. A lookup never rejects, so its promise is
 * both the in-flight dedupe and the cached answer (null for an unknown name or a failed read).
 */
const idLookups = new Map<string, Promise<string | null>>()

/** Lowercase, then `o`->`0`, `l`/`i`->`1` — the contract's homograph-safe normalization. */
function homographSafe(s: string): string {
  return s.toLowerCase().replace(/[oli]/g, (m) => (m === 'o' ? '0' : '1'))
}

/** `name` split into a label and parent domain; a bare name (no `.`) parents to `dash`. */
function splitDpnsName(name: string): { label: string; parent: string } {
  const trimmed = name.trim().replace(/^@/, '')
  const dot = trimmed.indexOf('.')
  return dot === -1 ? { label: trimmed, parent: 'dash' } : { label: trimmed.slice(0, dot), parent: trimmed.slice(dot + 1) }
}

/**
 * A DPNS label's shape: 3-63 characters (the platform's own minimum label length), alphanumeric
 * at each end, hyphens allowed between — close to but stricter than the pattern `splitRefs`
 * (markdown.ts) uses to recognize an `@name` mention for rendering (that one allows a 1-2
 * character label too, since a too-short mention still renders as a mention even though it can
 * never resolve to a real name). Checked before a value is normalized and queried, so a value
 * that plainly cannot be a label (spaces, punctuation, too short, an empty string) never spends a
 * read.
 */
const LABEL_SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]$/

/** Whether `name` (a bare label, or `label.parent`) is shaped like a name worth a DPNS lookup. */
export function looksLikeDpnsName(name: string): boolean {
  return LABEL_SHAPE.test(splitDpnsName(name).label)
}

/** `name` normalized for display only (no homograph substitution): a bare label defaults to `.dash`. */
export function displayDpnsName(name: string): string {
  const { label, parent } = splitDpnsName(name)
  return `${label}.${parent}`
}

/**
 * Forward-resolve a DPNS name (`label` or `label.parent`) to its identity id, or null when no
 * domain document has that normalized label and parent (a proven absence: cached) — or when
 * `name` is not {@link looksLikeDpnsName}-shaped, or the read itself failed (neither is cached;
 * a shape it can already reject costs nothing, and a transient failure is not proof of absence,
 * so the next call retries instead of caching a false "no such name" forever). Never throws.
 */
export async function resolveDpnsId(sdk: EvoSDK, name: string, network: Network): Promise<string | null> {
  const { label, parent } = splitDpnsName(name)
  if (!LABEL_SHAPE.test(label)) return null
  const normalizedLabel = homographSafe(label)
  const normalizedParentDomainName = homographSafe(parent)
  const key = keyOf(network, `${normalizedLabel}.${normalizedParentDomainName}`)

  let lookup = idLookups.get(key)
  if (!lookup) {
    // Not `sdk.dpns.resolveName`: it calls the wasm binding directly, bypassing this app's
    // proof-verified, dedup'd, stale-contract-retried `queryDocuments` path (and its test seam).
    lookup = queryDocuments(sdk, {
      dataContractId: NETWORKS[network].dpnsContractId,
      documentTypeName: 'domain',
      where: [
        ['normalizedParentDomainName', '==', normalizedParentDomainName],
        ['normalizedLabel', '==', normalizedLabel],
      ],
      limit: 1,
    }).then(
      (docs) => {
        const doc = docs[0]
        const id = identityOf(doc)
        // A hit proves the reverse direction too, for free: seed it (never overwrite an
        // already-cached answer) so the byline/pill for this identity does not ask again.
        if (id !== null && doc !== undefined) {
          const reverseKey = keyOf(network, id)
          if (!cache.has(reverseKey)) cache.set(reverseKey, nameOf(doc))
        }
        return id
      },
      () => {
        // Review: only delete this call's own entry. `clearDpnsCache()` (or a fresh lookup of the
        // same key started after this one failed) may already have replaced it by the time this
        // rejection handler runs; deleting unconditionally would evict that newer entry instead.
        if (idLookups.get(key) === lookup) idLookups.delete(key)
        return null
      },
    )
    idLookups.set(key, lookup)
  }
  return lookup
}

/**
 * Whether two names (`label`, `@label`, `label.parent`) are the same DPNS domain, as the contract
 * normalizes them (case and homographs: `Alice` and `a1ice` are `alice`).
 */
export function sameDpnsName(a: string, b: string): boolean {
  const x = splitDpnsName(a)
  const y = splitDpnsName(b)
  return homographSafe(x.label) === homographSafe(y.label) && homographSafe(x.parent) === homographSafe(y.parent)
}

/**
 * Forward-resolve many names at once ({@link resolveDpnsId} for each, but one
 * `normalizedLabel in [...]` query per parent domain and 100 names instead of one per name). A
 * name not shaped like one, or not registered, maps to null; a failed read rejects (it proves
 * nothing about the name). The batch answers seed the per-name cache, so a later
 * {@link resolveDpnsId} costs nothing.
 */
export async function resolveDpnsIds(sdk: EvoSDK, names: readonly string[], network: Network): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  // Per parent: the normalized labels still to look up, and the names that asked for each.
  const todo = new Map<string, Map<string, string[]>>()
  for (const name of new Set(names)) {
    const { label, parent } = splitDpnsName(name)
    if (!LABEL_SHAPE.test(label)) {
      out.set(name, null)
      continue
    }
    const normalizedLabel = homographSafe(label)
    const normalizedParent = homographSafe(parent)
    const known = idLookups.get(keyOf(network, `${normalizedLabel}.${normalizedParent}`))
    if (known !== undefined) {
      out.set(name, await known)
      continue
    }
    const labels = todo.get(normalizedParent) ?? new Map<string, string[]>()
    labels.set(normalizedLabel, [...(labels.get(normalizedLabel) ?? []), name])
    todo.set(normalizedParent, labels)
  }
  const reads: Promise<void>[] = []
  for (const [parent, labels] of todo) {
    const all = [...labels.keys()]
    for (let i = 0; i < all.length; i += 100) {
      const batch = all.slice(i, i + 100)
      reads.push(
        queryDocuments(sdk, {
          dataContractId: NETWORKS[network].dpnsContractId,
          documentTypeName: 'domain',
          where: [
            ['normalizedParentDomainName', '==', parent],
            ['normalizedLabel', 'in', batch],
          ],
          orderBy: [['normalizedLabel', 'asc']],
          limit: 100,
        }).then((docs) => {
          const found = new Map<string, Record<string, unknown>>()
          for (const d of docs) if (typeof d['normalizedLabel'] === 'string') found.set(d['normalizedLabel'], d)
          for (const label of batch) {
            const doc = found.get(label)
            const id = identityOf(doc)
            // A whole answer (each label is unique, so at most 100 docs for 100 labels) proves
            // absence: cached like a single lookup's.
            idLookups.set(keyOf(network, `${label}.${parent}`), Promise.resolve(id))
            if (id !== null && doc !== undefined && !cache.has(keyOf(network, id))) cache.set(keyOf(network, id), nameOf(doc))
            for (const name of labels.get(label) ?? []) out.set(name, id)
          }
        }),
      )
    }
  }
  await Promise.all(reads)
  return out
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

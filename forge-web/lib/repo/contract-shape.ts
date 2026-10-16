/**
 * Whether the deployment's forge-collab declares an optional property a `build.py` flag adds (the
 * RC2 riders, decided at registration: `transition.reason` / `dupNumber`, QW-069, and
 * `comment.diffHunk`, QW2-010). A writer sets one only where the registered contract has it: an
 * RC1 contract, or RC2 with the rider off, refuses an unknown property. Likewise an index a flag
 * adds (RC2 S2/S3 `review.toAuthor` / `review.author`): a reader queries one only where the
 * registered contract has it, and Drive refuses a query no index serves.
 *
 * Read from the contract itself (fetched once per contract id, as `star-shape.ts` reads the star),
 * not from a build flag, so a build writes whichever contract the deployment registered.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

/** A document type's top-level property names, index names and integer `minimum`s and `maximum`s. */
interface TypeShape {
  readonly properties: ReadonlySet<string>
  readonly indexes: ReadonlySet<string>
  readonly minimums: ReadonlyMap<string, number>
  readonly maxima: ReadonlyMap<string, number>
  /**
   * Each property its `immutable` list names, first entry wins: true when frozen outright (a bare
   * name, or an entry without `when`), false when only under a `when` condition.
   */
  readonly immutable: ReadonlyMap<string, boolean>
}

/** The `immutable` list of a type's schema as {@link TypeShape.immutable} reads it (forge-core `immutable_when`). */
function immutableOf(list: unknown): ReadonlyMap<string, boolean> {
  const out = new Map<string, boolean>()
  if (!Array.isArray(list)) return out
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (!out.has(entry)) out.set(entry, true)
    } else if (entry !== null && typeof entry === 'object') {
      const e = entry instanceof Map ? Object.fromEntries(entry as Map<string, unknown>) : (entry as Record<string, unknown>)
      const property = e['property']
      if (typeof property === 'string' && !out.has(property)) out.set(property, e['when'] === undefined || e['when'] === null)
    }
  }
  return out
}

const shapes = new Map<string, Promise<ReadonlyMap<string, TypeShape>>>()

/** Each document type's shape, read once per contract id (a failed read is retried next call). */
function shapeOf(sdk: EvoSDK, contractId: string): Promise<ReadonlyMap<string, TypeShape>> {
  const cached = shapes.get(contractId)
  if (cached) return cached
  const read = (async () => {
    const contract = await sdk.contracts.fetch(contractId)
    if (!contract) throw new Error(`contract ${contractId} was not found`)
    const schemas = contract.schemas as Record<string, { properties?: Record<string, unknown>; indices?: readonly { name?: unknown }[]; immutable?: unknown } | undefined>
    const boundOf = (p: unknown, bound: 'minimum' | 'maximum'): number | undefined => {
      const m = p !== null && typeof p === 'object' ? (p as Record<string, unknown>)[bound] : undefined
      return typeof m === 'number' ? m : typeof m === 'bigint' ? Number(m) : undefined
    }
    const bounds = (s: { properties?: Record<string, unknown> } | undefined, bound: 'minimum' | 'maximum'): ReadonlyMap<string, number> =>
      new Map(
        Object.entries(s?.properties ?? {}).flatMap(([name, p]) => {
          const m = boundOf(p, bound)
          return m === undefined ? [] : [[name, m] as const]
        }),
      )
    return new Map(
      Object.entries(schemas).map(([type, s]) => [
        type,
        {
          properties: new Set(Object.keys(s?.properties ?? {})),
          indexes: new Set((s?.indices ?? []).map((i) => i.name).filter((n): n is string => typeof n === 'string')),
          minimums: bounds(s, 'minimum'),
          maxima: bounds(s, 'maximum'),
          immutable: immutableOf(s?.immutable),
        },
      ] as const),
    )
  })()
  shapes.set(contractId, read)
  read.catch(() => shapes.delete(contractId))
  return read
}

/** Whether `documentType` of contract `contractId` declares the top-level `property`. */
export async function contractHasProperty(sdk: EvoSDK, contractId: string, documentType: string, property: string): Promise<boolean> {
  return (await shapeOf(sdk, contractId)).get(documentType)?.properties.has(property) ?? false
}

/**
 * The `minimum` `documentType`'s top-level integer `property` declares, as the contract states it
 * (feature-detects a bound a build flag moves: mainnet C3 lets `packManifest.r` be 0); null for an
 * unknown type or property, or no `minimum`. Parity: forge-core `LoadedContract::property_minimum`.
 */
export async function contractPropertyMinimum(sdk: EvoSDK, contractId: string, documentType: string, property: string): Promise<number | null> {
  return (await shapeOf(sdk, contractId)).get(documentType)?.minimums.get(property) ?? null
}

/** Whether `documentType` of contract `contractId` declares the index named `index`. */
export async function contractHasIndex(sdk: EvoSDK, contractId: string, documentType: string, index: string): Promise<boolean> {
  return (await shapeOf(sdk, contractId)).get(documentType)?.indexes.has(index) ?? false
}

/** The `maximum` the top-level integer `property` of `documentType` declares, or null. */
export async function contractPropertyMaximum(sdk: EvoSDK, contractId: string, documentType: string, property: string): Promise<number | null> {
  return (await shapeOf(sdk, contractId)).get(documentType)?.maxima.get(property) ?? null
}

/**
 * Whether the registered forge-core `coreId` admits the Bot role: `writer.role` up to 4 (C2, the
 * mainnet registration). Sakura's live contract stops at 3, so a bot there is an identity outside
 * the members (DESIGN §4.9). Parity: forge-core `members::admits_bots`.
 */
export async function contractAdmitsBots(sdk: EvoSDK, coreId: string): Promise<boolean> {
  return ((await contractPropertyMaximum(sdk, coreId, 'writer', 'role')) ?? 0) >= 4
}

/**
 * How `documentType`'s `immutable` list freezes `property`: `true` outright, `false` only under a
 * `when` condition, null when it is not listed (or the type is unknown). Parity: forge-core
 * `LoadedContract::immutable_when`.
 */
export async function contractImmutableWhen(sdk: EvoSDK, contractId: string, documentType: string, property: string): Promise<boolean | null> {
  return (await shapeOf(sdk, contractId)).get(documentType)?.immutable.get(property) ?? null
}

/**
 * Whether the registered forge-core `coreId` lets a private repo become public (mainnet C1:
 * `repo.visibility` frozen only once public, `{"property": "visibility", "when": …}`). The live
 * sakura contract freezes it outright, so a private repo stays private there. Parity: forge-core
 * `RepoService::can_make_public`.
 */
export async function contractVisibilityOneWay(sdk: EvoSDK, coreId: string): Promise<boolean> {
  return (await contractImmutableWhen(sdk, coreId, 'repo', 'visibility')) === false
}

/** Whether contract `contractId` declares the document type `documentType`. */
export async function contractHasType(sdk: EvoSDK, contractId: string, documentType: string): Promise<boolean> {
  return (await shapeOf(sdk, contractId)).has(documentType)
}

/** Forget every cached shape (tests). */
export function resetContractShapes(): void {
  shapes.clear()
}

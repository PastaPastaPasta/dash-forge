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

/** A document type's top-level property names and index names. */
interface TypeShape {
  readonly properties: ReadonlySet<string>
  readonly indexes: ReadonlySet<string>
}

const shapes = new Map<string, Promise<ReadonlyMap<string, TypeShape>>>()

/** Each document type's shape, read once per contract id (a failed read is retried next call). */
function shapeOf(sdk: EvoSDK, contractId: string): Promise<ReadonlyMap<string, TypeShape>> {
  const cached = shapes.get(contractId)
  if (cached) return cached
  const read = (async () => {
    const contract = await sdk.contracts.fetch(contractId)
    if (!contract) throw new Error(`contract ${contractId} was not found`)
    const schemas = contract.schemas as Record<string, { properties?: Record<string, unknown>; indices?: readonly { name?: unknown }[] } | undefined>
    return new Map(
      Object.entries(schemas).map(([type, s]) => [
        type,
        {
          properties: new Set(Object.keys(s?.properties ?? {})),
          indexes: new Set((s?.indices ?? []).map((i) => i.name).filter((n): n is string => typeof n === 'string')),
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

/** Whether `documentType` of contract `contractId` declares the index named `index`. */
export async function contractHasIndex(sdk: EvoSDK, contractId: string, documentType: string, index: string): Promise<boolean> {
  return (await shapeOf(sdk, contractId)).get(documentType)?.indexes.has(index) ?? false
}

/** Whether contract `contractId` declares the document type `documentType`. */
export async function contractHasType(sdk: EvoSDK, contractId: string, documentType: string): Promise<boolean> {
  return (await shapeOf(sdk, contractId)).has(documentType)
}

/** Forget every cached shape (tests). */
export function resetContractShapes(): void {
  shapes.clear()
}

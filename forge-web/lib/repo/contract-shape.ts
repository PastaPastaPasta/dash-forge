/**
 * Whether the deployment's forge-collab declares an optional property a `build.py` flag adds (the
 * RC2 riders, decided at registration: `transition.reason` / `dupNumber`, QW-069, and
 * `comment.diffHunk`, QW2-010). A writer sets one only where the registered contract has it: an
 * RC1 contract, or RC2 with the rider off, refuses an unknown property.
 *
 * Read from the contract itself (fetched once per contract id, as `star-shape.ts` reads the star),
 * not from a build flag, so a build writes whichever contract the deployment registered.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

const shapes = new Map<string, Promise<ReadonlyMap<string, ReadonlySet<string>>>>()

/** Each document type's top-level properties, read once per contract id (a failed read is retried next call). */
function propertiesOf(sdk: EvoSDK, contractId: string): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const cached = shapes.get(contractId)
  if (cached) return cached
  const read = (async () => {
    const contract = await sdk.contracts.fetch(contractId)
    if (!contract) throw new Error(`contract ${contractId} was not found`)
    const schemas = contract.schemas as Record<string, { properties?: Record<string, unknown> } | undefined>
    return new Map(Object.entries(schemas).map(([type, s]) => [type, new Set(Object.keys(s?.properties ?? {}))] as const))
  })()
  shapes.set(contractId, read)
  read.catch(() => shapes.delete(contractId))
  return read
}

/** Whether `documentType` of contract `contractId` declares the top-level `property`. */
export async function contractHasProperty(sdk: EvoSDK, contractId: string, documentType: string, property: string): Promise<boolean> {
  return (await propertiesOf(sdk, contractId)).get(documentType)?.has(property) ?? false
}

/** Forget every cached shape (tests). */
export function resetContractShapes(): void {
  shapes.clear()
}

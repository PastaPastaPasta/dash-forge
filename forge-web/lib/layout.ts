/**
 * The RC1 layout (`forge-contracts/schema/build.py`, `forge-contracts/contracts/*.json`): which
 * forge-v2 contract holds each document type, and which types carry the `vis` stamp.
 *
 * Dependency-free on purpose: the write engine (`lib/sdk/write.ts`) checks every create against
 * it ({@link rc1WriteProblem}), below the repo layer that builds the documents, so no writer can
 * route a type to the wrong contract or forget its stamp. Parity: forge-core `layout`
 * (`stamp_vis_for`, the contract check in `Collab::write`).
 */

import type { ForgeContractKind, ForgeIds } from './deployments'

/** Each forge-v2 document type's contract. */
const CONTRACT_OF_TYPE: Readonly<Record<string, ForgeContractKind>> = {
  // forge-core: code, membership and consent, releases, labels, topics
  repo: 'core',
  maintainer: 'core',
  writer: 'core',
  consent: 'core',
  refUpdate: 'core',
  protectedRefUpdate: 'core',
  config: 'core',
  packManifest: 'core',
  chunk: 'core',
  release: 'core',
  label: 'core',
  topic: 'core',
  // forge-collab: issues, PRs and their threads; repo keys (O-03)
  issue: 'collab',
  patch: 'collab',
  transition: 'collab',
  comment: 'collab',
  review: 'collab',
  repoKey: 'collab',
  // forge-community: member and author events, milestones (O-01), runners (O-02), social, CI
  event: 'community',
  authorEvent: 'community',
  milestone: 'community',
  runner: 'community',
  checkRun: 'community',
  policy: 'community',
  webhook: 'community',
  profile: 'community',
  star: 'community',
  watch: 'community',
  follow: 'community',
  starBeat: 'community',
}

const typesOf = (kind: ForgeContractKind): ReadonlySet<string> =>
  new Set(Object.entries(CONTRACT_OF_TYPE).flatMap(([t, k]) => (k === kind ? [t] : [])))

export const CORE_TYPES: ReadonlySet<string> = typesOf('core')
export const COLLAB_TYPES: ReadonlySet<string> = typesOf('collab')
export const COMMUNITY_TYPES: ReadonlySet<string> = typesOf('community')

/** The contract that holds `type`, or null for a type no forge-v2 contract has (e.g. the retired `manifestPart`). */
export function contractKindOfType(type: string): ForgeContractKind | null {
  return CONTRACT_OF_TYPE[type] ?? null
}

/**
 * The types RC1 stamps with their repo's visibility (`vis`, required): consensus proves it
 * against the repo (or the signer's member document) and refuses plaintext under `private`
 * (R-02, R-03, R-18, R-19).
 */
export const VIS_TYPES: ReadonlySet<string> = new Set([
  'maintainer',
  'writer',
  'refUpdate',
  'protectedRefUpdate',
  'config',
  'release',
  'issue',
  'patch',
  'comment',
  'review',
  'checkRun',
  'webhook',
])

/** The types whose `vis` may only be `"public"` (a topic or a trending beat of a private repo is refused). */
export const PUBLIC_ONLY_TYPES: ReadonlySet<string> = new Set(['topic', 'starBeat'])

/**
 * `data` with the `vis` stamp a create of `documentType` in a repo of `visibility` carries, or
 * `data` itself for a type that has none. A stamp already set is kept.
 */
export function withVis(visibility: 'public' | 'private', documentType: string, data: Record<string, unknown>): Record<string, unknown> {
  if (data['vis'] !== undefined) return data
  if (PUBLIC_ONLY_TYPES.has(documentType)) return { ...data, vis: 'public' }
  return VIS_TYPES.has(documentType) ? { ...data, vis: visibility } : data
}

/**
 * Why a create of `documentType` with `data` to `contractId` breaks the RC1 layout, or null.
 * Judged only for a write to one of `forge`'s contracts (any other contract, such as DPNS, is
 * not Forge's to judge): the type must be one that contract holds, and a stamped type must
 * carry a valid `vis`.
 */
export function rc1WriteProblem(forge: ForgeIds | null, contractId: string, documentType: string, data: Readonly<Record<string, unknown>>): string | null {
  if (forge === null || (contractId !== forge.core && contractId !== forge.collab && contractId !== forge.community)) return null
  const kind = contractKindOfType(documentType)
  if (kind === null) return `no forge-v2 contract holds the document type ${JSON.stringify(documentType)}`
  if (forge[kind] !== contractId) return `a ${documentType} belongs in forge-${kind}, not the contract it was sent to`
  const vis = data['vis']
  if (PUBLIC_ONLY_TYPES.has(documentType) && vis !== 'public') return `a ${documentType} must carry vis "public"`
  if (VIS_TYPES.has(documentType) && vis !== 'public' && vis !== 'private') return `a ${documentType} must carry its repo's visibility (vis)`
  return null
}

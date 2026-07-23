/**
 * Repo home view-model (view glue) — composes the reads a repo page needs into one shape.
 *
 * The cold home view is size-independent: resolve the repo from the registry, read its
 * current config + default branch, resolve refs (skip-scan), and read the O(1) star count.
 * The root tree / README ride the browse plane (locator) and are loaded separately so the
 * header can paint immediately.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { NETWORKS, type Network } from '../constants'
import {
  branchesOf,
  readConfig,
  readRefs,
  readStarCount,
  resolveRepoWithListing,
  tagsOf,
  type RepoConfig,
  type RepoRef,
  type ResolvedRef,
} from '../repo'

/** Backend descriptor for the repo header badge / clone box. */
export interface BackendInfo {
  readonly mode: number
  /** `⛓ platform` / `🌐 ipfs` / … */
  readonly label: string
  readonly glyph: string
  readonly kind: 'platform' | 'ipfs' | 's3' | 'https' | 'mixed'
  readonly uris: readonly string[]
}

const BACKEND_BY_MODE: Readonly<
  Record<number, { kind: BackendInfo['kind']; label: string; glyph: string }>
> = {
  0: { kind: 'platform', label: 'platform', glyph: '⛓' },
  1: { kind: 'ipfs', label: 'ipfs', glyph: '🌐' },
  2: { kind: 's3', label: 's3', glyph: '🌐' },
  3: { kind: 'https', label: 'https', glyph: '🌐' },
  4: { kind: 'mixed', label: 'mixed', glyph: '⛓+🌐' },
}

/** Describe a repo backend from its config for the badge + clone box. */
export function backendInfo(config: RepoConfig | null): BackendInfo {
  const mode = config?.backendMode ?? 0
  const meta = BACKEND_BY_MODE[mode] ?? BACKEND_BY_MODE[0]
  const info = meta ?? { kind: 'platform', label: 'platform', glyph: '⛓' }
  return { mode, ...info, uris: config?.backendUris ?? [] }
}

/** Everything the repo header + rail render (excludes browse-plane tree/README). */
export interface RepoHome {
  readonly repo: RepoRef
  readonly listingId: string | null
  readonly config: RepoConfig | null
  readonly defaultBranch: string
  readonly branches: readonly ResolvedRef[]
  readonly tags: readonly ResolvedRef[]
  readonly starCount: number
  readonly backend: BackendInfo
}

/** Resolve + compose a repo home view-model by `(owner, name)`. Returns null if unresolved. */
export async function loadRepoHome(
  sdk: EvoSDK,
  params: { network: Network; ownerId: string; name: string },
): Promise<RepoHome | null> {
  // One registry lookup serves both §4-verified resolution and the stars listing id.
  const resolved = await resolveRepoWithListing(
    sdk,
    requireRegistry(params.network),
    params.ownerId,
    params.name,
  )
  if (resolved === null) return null
  const { repo, listing } = resolved
  const listingId = listing.listingId || null

  const [config, refs, starCount] = await Promise.all([
    readConfig(sdk, repo),
    readRefs(sdk, repo),
    listingId
      ? readStarCount(sdk, listingId, { network: params.network }).catch(() => 0)
      : Promise.resolve(0),
  ])

  return {
    repo,
    listingId,
    config,
    defaultBranch: config?.defaultBranch ?? 'main',
    branches: branchesOf(refs),
    tags: tagsOf(refs),
    starCount,
    backend: backendInfo(config),
  }
}

function requireRegistry(network: Network): string {
  const id = NETWORKS[network].registryContractId
  if (id === null) throw new Error('no registry contract id configured for this network')
  return id
}

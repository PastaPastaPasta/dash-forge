/**
 * Repo home view-model (view glue) — composes the reads a repo page needs into one shape.
 *
 * The cold home view is size-independent: resolve the repo (a forge-v2 `repo` document, else
 * the v1 registry), read its current config + default branch, resolve refs, and read the
 * O(1) star count. The root tree / README ride the browse plane (locator) and are loaded
 * separately so the header can paint immediately.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { Network } from '../constants'
import {
  branchesOf,
  readConfigBundle,
  readRefs,
  readStarCount,
  readV2StarCount,
  resolveAnyRepo,
  tagsOf,
  type RepoAddressParams,
  type RepoConfig,
  type RepoRef,
  type ResolvedRef,
  type V2RepoDoc,
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
  /** The v1 registry listing id (stars live on it), or null (forge-v2, or no listing). */
  readonly listingId: string | null
  /** The forge-v2 `repo` document (description, display name, topics, fork), else null. */
  readonly v2: V2RepoDoc | null
  /** The repo description: the v2 `repo` document's, else the v1 listing's. */
  readonly description: string
  readonly config: RepoConfig | null
  readonly defaultBranch: string
  readonly branches: readonly ResolvedRef[]
  readonly tags: readonly ResolvedRef[]
  /** `null` when the count read failed — rendered as unknown, never as a false 0. */
  readonly starCount: number | null
  readonly backend: BackendInfo
}

/**
 * Resolve + compose a repo home view-model from its route address (`owner`, `name`, and an
 * optional `?repo=` / `?contract=` pin). Returns null if nothing authentic resolves.
 */
export async function loadRepoHome(
  sdk: EvoSDK,
  params: RepoAddressParams & { readonly network: Network },
): Promise<RepoHome | null> {
  const resolved = await resolveAnyRepo(sdk, params)
  if (resolved === null) return null
  const { repo } = resolved
  const v2 = 'doc' in resolved ? resolved.doc : null
  const listing = 'listing' in resolved ? resolved.listing : null
  const listingId = listing?.listingId || null

  const readStars = (): Promise<number | null> => {
    if (repo.kind === 'v2') return readV2StarCount(sdk, repo.forge, repo.repoId).catch(() => null)
    // Stars live on the registry listing; a repo addressed without one has an unknown count.
    return listingId
      ? readStarCount(sdk, listingId, { network: params.network }).catch(() => null)
      : Promise.resolve(null)
  }

  // One config query serves both the current config and the history readRefs folds with.
  const bundlePromise = readConfigBundle(sdk, repo)
  const [{ config }, refs, starCount] = await Promise.all([
    bundlePromise,
    readRefs(sdk, repo, undefined, bundlePromise.then((b) => b.history)),
    readStars(),
  ])

  return {
    repo,
    listingId,
    v2,
    description: v2?.description ?? listing?.description ?? '',
    config,
    defaultBranch: config?.defaultBranch ?? v2?.defaultBranch ?? 'main',
    branches: branchesOf(refs),
    tags: tagsOf(refs),
    starCount,
    backend: backendInfo(config),
  }
}

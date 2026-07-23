/**
 * Ref reads — branch/tag enumeration + tip resolution (data-contracts §2.3, §4).
 *
 * Enumeration uses **skip-scan** (`refNameHash > last limit 1` hops) across both the
 * `refUpdate` and `protectedRefUpdate` types — O(distinct refs), not O(total pushes). Tip
 * resolution folds a ref's full update history (both types, with the `protected` flag set
 * per source) through {@link resolveRef}, honoring as-of protected-pattern config.
 *
 * Divergence resolution that turns on real commit ancestry (a merge superseding both racing
 * heads) needs a commit-graph predicate from the browse plane; callers may pass one via
 * `isAncestor`. Without it, linear/fast-forward/force/delete cases still resolve correctly
 * (the prevOid causal DAG carries those); only unmerged three-way races stay `Diverged`.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { resolveRef, type ConfigDoc, type IsAncestor, type RefState, type RefUpdate } from '../rules'
import { base64ToHex, queryDocumentsWithProof, skipScanDistinct } from '../sdk'
import { DOC, toRefUpdate, type RepoRef } from './contract'
import { readConfigHistory } from './config'

const NO_ANCESTRY: IsAncestor = () => false

/** A resolved ref for list views. */
export interface ResolvedRef {
  /** The ref name, e.g. `refs/heads/main`. */
  readonly refName: string
  /** `sha256(refName)` hex — the indexed key. */
  readonly refNameHash: string
  /** Resolved state (resolved / diverged / unborn). */
  readonly state: RefState
}

/** Enumerate the distinct `refNameHash` values across both ref document types (base64). */
export async function enumerateRefHashes(sdk: EvoSDK, repo: RepoRef): Promise<string[]> {
  const [plain, protectedHashes] = await Promise.all([
    skipScanDistinct(sdk, {
      dataContractId: repo.contractId,
      documentTypeName: DOC.refUpdate,
      keyField: 'refNameHash',
    }),
    skipScanDistinct(sdk, {
      dataContractId: repo.contractId,
      documentTypeName: DOC.protectedRefUpdate,
      keyField: 'refNameHash',
    }),
  ])
  return [...new Set([...plain, ...protectedHashes])]
}

/** Fetch a single ref's full update history (both types), converted to rules inputs. */
export async function readRefUpdates(
  sdk: EvoSDK,
  repo: RepoRef,
  refNameHashB64: string,
): Promise<RefUpdate[]> {
  const [plain, prot] = await Promise.all([
    queryDocumentsWithProof(sdk, {
      dataContractId: repo.contractId,
      documentTypeName: DOC.refUpdate,
      where: [['refNameHash', '==', refNameHashB64]],
      orderBy: [['$createdAt', 'asc']],
      limit: 100,
    }),
    queryDocumentsWithProof(sdk, {
      dataContractId: repo.contractId,
      documentTypeName: DOC.protectedRefUpdate,
      where: [['refNameHash', '==', refNameHashB64]],
      orderBy: [['$createdAt', 'asc']],
      limit: 100,
    }),
  ])
  return [
    ...plain.documents.map((d) => toRefUpdate(d, false)),
    ...prot.documents.map((d) => toRefUpdate(d, true)),
  ]
}

/** Resolve a single ref by its (base64) `refNameHash`. */
export async function resolveRefByHash(
  sdk: EvoSDK,
  repo: RepoRef,
  refNameHashB64: string,
  configHistory: readonly ConfigDoc[],
  isAncestor: IsAncestor = NO_ANCESTRY,
): Promise<ResolvedRef | null> {
  const updates = await readRefUpdates(sdk, repo, refNameHashB64)
  if (updates.length === 0) return null
  const refNameHashHex = base64ToHex(refNameHashB64)
  const state = resolveRef(updates, configHistory, refNameHashHex, isAncestor)
  const refName = updates[updates.length - 1]?.refName ?? ''
  return { refName, refNameHash: refNameHashHex, state }
}

/**
 * Read every ref of a repo (skip-scan enumeration + per-ref resolution, parallelized).
 * Fetches the config history once and reuses it across refs.
 */
export async function readRefs(
  sdk: EvoSDK,
  repo: RepoRef,
  isAncestor: IsAncestor = NO_ANCESTRY,
): Promise<ResolvedRef[]> {
  const [hashes, configHistory] = await Promise.all([
    enumerateRefHashes(sdk, repo),
    readConfigHistory(sdk, repo),
  ])
  const resolved = await Promise.all(
    hashes.map((h) => resolveRefByHash(sdk, repo, h, configHistory, isAncestor)),
  )
  return resolved.filter((r): r is ResolvedRef => r !== null)
}

/** Filter helper: only `refs/heads/*` branches. */
export function branchesOf(refs: readonly ResolvedRef[]): ResolvedRef[] {
  return refs.filter((r) => r.refName.startsWith('refs/heads/'))
}

/** Filter helper: only `refs/tags/*` tags. */
export function tagsOf(refs: readonly ResolvedRef[]): ResolvedRef[] {
  return refs.filter((r) => r.refName.startsWith('refs/tags/'))
}

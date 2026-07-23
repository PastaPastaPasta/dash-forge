/**
 * Ref reads — branch/tag enumeration + tip resolution (data-contracts §2.3, §4).
 *
 * Small repos (update set ≤ one query page per type) load everything in two parallel
 * queries and resolve locally. Larger repos enumerate via **skip-scan**
 * (`refNameHash > last limit 1` hops) across both the `refUpdate` and `protectedRefUpdate`
 * types — O(distinct refs), not O(total pushes). Tip resolution folds a ref's full update
 * history (both types, with the `protected` flag set per source) through
 * {@link resolveRef}, honoring as-of protected-pattern config.
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

/** One query page — also the Platform per-query document cap. */
const PAGE = 100

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

/** Fold a ref's full (`$createdAt asc`) update history into its resolved list-view state. */
function toResolvedRef(
  updates: readonly RefUpdate[],
  configHistory: readonly ConfigDoc[],
  refNameHashHex: string,
  isAncestor: IsAncestor,
): ResolvedRef {
  const state = resolveRef(updates, configHistory, refNameHashHex, isAncestor)
  const refName = updates[updates.length - 1]?.refName ?? ''
  return { refName, refNameHash: refNameHashHex, state }
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
  return toResolvedRef(updates, configHistory, base64ToHex(refNameHashB64), isAncestor)
}

/**
 * Fast path: fetch ONE page of each ref-update type ordered by the `refState` index
 * (`refNameHash asc, $createdAt asc`). A short page (< {@link PAGE}) proves the type's
 * update set is complete, so the per-ref histories can be grouped locally with zero further
 * queries. Returns null when either type overflows the page — callers fall back to skip-scan.
 *
 * This matters because skip-scan costs one sequential round-trip per distinct ref (~450ms
 * each on testnet — measured 8s for 18 refs), while a small repo's ENTIRE update set fits
 * in two parallel queries (~0.5s).
 */
async function readAllRefUpdatesOnePage(
  sdk: EvoSDK,
  repo: RepoRef,
): Promise<Map<string, RefUpdate[]> | null> {
  const pageOf = (documentTypeName: string): ReturnType<typeof queryDocumentsWithProof> =>
    queryDocumentsWithProof(sdk, {
      dataContractId: repo.contractId,
      documentTypeName,
      orderBy: [
        ['refNameHash', 'asc'],
        ['$createdAt', 'asc'],
      ],
      limit: PAGE,
    })
  const [plain, prot] = await Promise.all([pageOf(DOC.refUpdate), pageOf(DOC.protectedRefUpdate)])
  if (plain.documents.length >= PAGE || prot.documents.length >= PAGE) return null

  // Group per ref, plain updates before protected — the same per-ref order
  // readRefUpdates produces (each source is already `$createdAt asc`).
  const byHash = new Map<string, RefUpdate[]>()
  const add = (update: RefUpdate): void => {
    const group = byHash.get(update.refNameHash)
    if (group === undefined) byHash.set(update.refNameHash, [update])
    else group.push(update)
  }
  for (const doc of plain.documents) add(toRefUpdate(doc, false))
  for (const doc of prot.documents) add(toRefUpdate(doc, true))
  return byHash
}

/**
 * Read every ref of a repo. Small repos (whole update set ≤ one query page per type) resolve
 * from two parallel queries; larger repos fall back to skip-scan enumeration + per-ref
 * resolution (parallelized). Fetches the config history once and reuses it across refs —
 * or accepts the caller's in-flight fetch (`configHistoryPromise`) so a composed read like
 * `loadRepoHome` issues only ONE config query total.
 */
export async function readRefs(
  sdk: EvoSDK,
  repo: RepoRef,
  isAncestor: IsAncestor = NO_ANCESTRY,
  configHistoryPromise?: Promise<readonly ConfigDoc[]>,
): Promise<ResolvedRef[]> {
  const [complete, configHistory] = await Promise.all([
    readAllRefUpdatesOnePage(sdk, repo),
    configHistoryPromise ?? readConfigHistory(sdk, repo),
  ])
  if (complete !== null) {
    return [...complete].map(([refNameHashHex, updates]) =>
      toResolvedRef(updates, configHistory, refNameHashHex, isAncestor),
    )
  }

  const hashes = await enumerateRefHashes(sdk, repo)
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

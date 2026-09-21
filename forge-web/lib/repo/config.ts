/**
 * Repo config reads — the `config` append-only timeline (data-contracts §2.2/§4).
 *
 * Current config = newest doc; historical configs resolve protected-ref protection as-of
 * any past update (fed into {@link resolveRef}). `config` is non-deletable, so the history
 * is a total, gap-free timeline.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { compareKey, type ConfigDoc } from '../rules'
import { queryAllDocuments, queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { DOC, parseJsonList, type RepoRef } from './contract'

/** The current repo config surface most views need. */
export interface RepoConfig {
  readonly defaultBranch: string
  readonly protectedPatterns: readonly string[]
  readonly archived: boolean
  readonly backendUris: readonly string[]
  readonly backendMode: number
}

function toConfigDoc(doc: PlainDocument): ConfigDoc {
  return {
    id: typeof doc['$id'] === 'string' ? doc['$id'] : '',
    createdAt: typeof doc['$createdAt'] === 'number' ? doc['$createdAt'] : 0,
    protectedPatterns: parseJsonList(doc, 'protectedPatterns'),
  }
}

/** Surface a raw `config` document as the {@link RepoConfig} most views need. */
function toRepoConfig(doc: PlainDocument): RepoConfig {
  const backend = doc['backend']
  let backendMode = 0
  let backendUris: string[] = []
  if (backend !== null && typeof backend === 'object') {
    const b = backend as Record<string, unknown>
    if (typeof b['mode'] === 'number') backendMode = b['mode']
    if (Array.isArray(b['uris'])) {
      backendUris = b['uris'].filter((x): x is string => typeof x === 'string')
    }
  }
  return {
    defaultBranch: typeof doc['defaultBranch'] === 'string' ? doc['defaultBranch'] : 'main',
    protectedPatterns: parseJsonList(doc, 'protectedPatterns'),
    archived: doc['archived'] === true,
    backendUris,
    backendMode,
  }
}

/** The current config AND the complete history, from one paged read of the timeline. */
export interface ConfigBundle {
  readonly config: RepoConfig | null
  readonly history: ConfigDoc[]
}

/**
 * Fetch the **complete** config timeline once and surface both the current config and the
 * history.
 *
 * Completeness matters here for a security reason, not just freshness: `configAsOf` picks the
 * newest config at or before an update's `$createdAt`, and a ref update that finds NO config
 * in force is treated as unprotected. Dropping the oldest configs — which is what a
 * newest-first single page does once the timeline passes one page — therefore silently
 * disables protected-branch enforcement for every historical update older than the window,
 * re-admitting plain `refUpdate`s that the rules layer had correctly rendered inert.
 *
 * Read ascending so the `$id` cursor advances over the whole timeline; the newest doc is then
 * the last row. `history` order is irrelevant to callers ({@link resolveRef}'s `configAsOf`
 * scans for a maximum), but ascending is the same order forge-core returns.
 */
export async function readConfigBundle(sdk: EvoSDK, repo: RepoRef): Promise<ConfigBundle> {
  const documents = await queryAllDocuments(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.config,
    orderBy: [['$createdAt', 'asc']],
  })
  // Do NOT take the wire order's last row as "newest". Drive orders the terminal
  // document-id subtree by the RAW 32 bytes of `$id`, while `configAsOf` — the rule that
  // decides which config is in force — tie-breaks on the base58 `$id` STRING. For two
  // configs sharing a `$createdAt` those orders can disagree, so the config this surfaces
  // and the config `resolveRef` considers in force could be different documents. Pick the
  // maximum with the same comparison the fold uses, and the three agree by construction.
  const history = documents.map(toConfigDoc)
  const newest = history.reduce<ConfigDoc | undefined>(
    (best, c) => (best === undefined || compareKey(c, best) > 0 ? c : best),
    undefined,
  )
  const newestDoc =
    newest === undefined ? undefined : documents.find((d) => d['$id'] === newest.id)
  return {
    config: newestDoc === undefined ? null : toRepoConfig(newestDoc),
    history,
  }
}

/**
 * Fetch the full `config` history (ascending). Feed this to {@link resolveRef} as
 * `configHistory`; the resolver is order-independent.
 */
export async function readConfigHistory(sdk: EvoSDK, repo: RepoRef): Promise<ConfigDoc[]> {
  return (await readConfigBundle(sdk, repo)).history
}

/**
 * The current config, from a single cheap `$createdAt desc limit 1` read.
 *
 * This is an approximation of {@link readConfigBundle}'s `config`, and can differ from it in
 * exactly one case: two configs written in the same block, where this returns whichever Drive
 * orders first by raw `$id` bytes while the rules layer picks the greater base58 `$id`
 * string. Resolving that would cost a full paged read of the timeline for what is usually a
 * default-branch lookup. Use {@link readConfigBundle} where the answer must match the config
 * `resolveRef` considers in force. forge-core `read_default_branch` makes the same trade.
 */
export async function readConfig(sdk: EvoSDK, repo: RepoRef): Promise<RepoConfig | null> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.config,
    orderBy: [['$createdAt', 'desc']],
    limit: 1,
  })
  const doc = documents[0]
  return doc === undefined ? null : toRepoConfig(doc)
}

/** Convenience: the default branch name (falls back to `main`). */
export async function readDefaultBranch(sdk: EvoSDK, repo: RepoRef): Promise<string> {
  const config = await readConfig(sdk, repo)
  return config?.defaultBranch ?? 'main'
}

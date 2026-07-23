/**
 * Repo config reads — the `config` append-only timeline (data-contracts §2.2/§4).
 *
 * Current config = newest doc; historical configs resolve protected-ref protection as-of
 * any past update (fed into {@link resolveRef}). `config` is non-deletable, so the history
 * is a total, gap-free timeline.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { ConfigDoc } from '../rules'
import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
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

/** The current config AND the full history, from ONE query — the timeline is ≤ one page
 *  (config is append-rarely), so the newest doc serves both surfaces. */
export interface ConfigBundle {
  readonly config: RepoConfig | null
  readonly history: ConfigDoc[]
}

/** Fetch the config timeline once and surface both the current config and the history. */
export async function readConfigBundle(sdk: EvoSDK, repo: RepoRef): Promise<ConfigBundle> {
  const { documents } = await queryDocumentsWithProof(sdk, {
    dataContractId: repo.contractId,
    documentTypeName: DOC.config,
    orderBy: [['$createdAt', 'desc']],
    limit: 100,
  })
  const newest = documents[0]
  return {
    config: newest === undefined ? null : toRepoConfig(newest),
    history: documents.map(toConfigDoc),
  }
}

/**
 * Fetch the full `config` history (newest first on the wire, returned as-is). Feed this to
 * {@link resolveRef} as `configHistory`; the resolver is order-independent.
 */
export async function readConfigHistory(sdk: EvoSDK, repo: RepoRef): Promise<ConfigDoc[]> {
  return (await readConfigBundle(sdk, repo)).history
}

/** The current (newest) config, surfaced as a {@link RepoConfig}. */
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

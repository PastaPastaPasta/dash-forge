/**
 * Repo config reads — the `config` append-only timeline (`forge-v2.md` §2, §5).
 *
 * Current config = newest doc; historical configs resolve protected-ref protection as-of
 * any past update (fed into {@link resolveRef}). `config` is non-deletable, so the history
 * is a total, gap-free timeline.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { compareKey, type ConfigDoc } from '../rules'
import { queryAllDocuments, queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { DOC, asIdentifierString, gitPlaneDocWellFormed, stringArray, wellFormed, type RepoRef } from './contract'
import { repoSource } from './source'
import { recordConfigTimeline } from './members-key-cache'
import { recordConversion } from './converted'

/** The current repo config surface most views need. */
export interface RepoConfig {
  readonly defaultBranch: string
  readonly protectedPatterns: readonly string[]
  readonly archived: boolean
  readonly backendUris: readonly string[]
  readonly backendMode: number
  /**
   * The repo a maintainer marked this one as moved to (`movedTo`, a repo id). Read on public repos
   * only; absent when not moved, and on a document written before the field existed.
   */
  readonly movedTo?: string
}

function toConfigDoc(doc: PlainDocument): ConfigDoc {
  return {
    id: typeof doc['$id'] === 'string' ? doc['$id'] : '',
    createdAt: typeof doc['$createdAt'] === 'number' ? doc['$createdAt'] : 0,
    protectedPatterns: stringArray(doc, 'protectedPatterns') ?? [],
    ...(typeof doc['$ownerId'] === 'string' ? { author: doc['$ownerId'] } : {}),
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
  const movedTo = asIdentifierString(doc['movedTo'])
  return {
    ...(movedTo !== '' ? { movedTo } : {}),
    defaultBranch: typeof doc['defaultBranch'] === 'string' ? doc['defaultBranch'] : 'main',
    protectedPatterns: stringArray(doc, 'protectedPatterns') ?? [],
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
  // A private repo's config is sealed: a member's session holds the decrypted timeline, and
  // nobody else reads any of it (only the plaintext backend, via readConfig).
  if (repo.session !== undefined) return { config: repo.session.config, history: [...repo.session.configHistory] }
  if (repo.visibility === 'private') return { config: await readConfig(sdk, repo), history: [] }
  return configBundleOf(
    repo,
    await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.config, { orderBy: [['$createdAt', 'asc']] })),
  )
}

/** A public repo's {@link ConfigBundle} from its complete config timeline, however it was read. */
export function configBundleOf(repo: RepoRef, rows: readonly PlainDocument[]): ConfigBundle {
  // The whole timeline: whether it holds a members-key anchor is known now, for the content gate.
  if (repo.visibility === 'public') {
    recordConfigTimeline(repo.repoId, rows)
    // and whether it was made public (its earlier documents and packs then open as private ones)
    recordConversion(repo, rows)
  }
  // The settings fold is the git plane: plaintext only. A sealed config of a public repo (its
  // members-key anchor) is never a settings row (DESIGN D1), whatever lane session is loaded.
  const documents = rows.filter((d) => configWellFormed(repo, d))
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
  if (repo.session !== undefined) return repo.session.config
  // A malformed config is skipped (`forge-v2.md` §5), so read a few to find the newest
  // well-formed one.
  const { documents } = await queryDocumentsWithProof(
    sdk,
    repoSource(repo).repoQuery(DOC.config, {
      orderBy: [['$createdAt', 'desc']],
      limit: 10,
    }),
  )
  const doc = documents.find((d) => configWellFormed(repo, d))
  // A public repo whose members key rotated often: the newest plaintext config sits behind more
  // than one page of sealed anchors. The full timeline still holds it.
  if (doc === undefined && repo.visibility === 'public' && documents.length >= 10) return (await readConfigBundle(sdk, repo)).config
  if (doc === undefined) return null
  // Without a session a private config shows only what is plaintext by design: the backend.
  if (repo.visibility === 'private') {
    const { movedTo: _ignored, ...plain } = toRepoConfig(doc)
    return { ...plain, defaultBranch: 'main', protectedPatterns: [] }
  }
  return toRepoConfig(doc)
}

/** A config row of `repo`'s settings timeline: sealed in a private repo, plaintext (git plane) in a public one. */
function configWellFormed(repo: RepoRef, doc: PlainDocument): boolean {
  return repo.visibility === 'private' ? wellFormed(repo, 'config', doc) : gitPlaneDocWellFormed('config', doc)
}

/** Convenience: the default branch name (falls back to `main`). */
export async function readDefaultBranch(sdk: EvoSDK, repo: RepoRef): Promise<string> {
  const config = await readConfig(sdk, repo)
  return config?.defaultBranch ?? 'main'
}

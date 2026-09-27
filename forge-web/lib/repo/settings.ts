/**
 * Repository settings writes and reads (QA D-503: nothing wrote `config` after creation).
 *
 * - `config` (forge-core; maintainers only at consensus; append-only, newest wins): the default
 *   branch, the protected patterns and the archived flag. A change appends a new config carrying
 *   every other field over. Parity: forge-core `RepoService::update_config` / `ConfigChange`.
 * - The `repo` document (its owner only; `name`, `visibility`, `forkOf` immutable): description
 *   and topics, through {@link replaceDocumentIdempotent}. Parity: `RepoService::edit_repo`.
 * - `policy` (forge-collab; maintainers only; newest by `($createdAt, $id)` wins): read here,
 *   written by `setPolicy` (`review-writes.ts`). A client rule: consensus requires no approvals.
 *
 * A private repo's config is sealed (`docs/security/private-repos.md` §4): a plaintext config
 * there would publish the branch names and be malformed for members. The web has no private
 * key loader yet, so {@link updateConfig} refuses a private repo; the CLI writes it sealed.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { decodeIdentifier } from '../auth/base58'
import { compareKey, isLegalRefName, matchesProtected } from '../rules'
import type { Policy } from '../rules/v2'
import {
  createDocumentIdempotent,
  previewCreate,
  previewCredits,
  previewReplace,
  queryAllDocuments,
  replaceDocumentIdempotent,
  type CostPreview,
  type PlainDocument,
  type ReplaceResult,
  type WriteAuth,
  type WriteResult,
} from '../sdk'
import { readConfigBundle, type RepoConfig } from './config'
import { DOC, num, type RepoRef } from './contract'
import { repoSource } from './source'

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested; forge-core `repo.rs` holds the same limits)
// ---------------------------------------------------------------------------------------------

/** `config.protectedPatterns`: at most 8 globs of 1–100 characters (forge-core schema). */
export const MAX_PROTECTED_PATTERNS = 8
export const MAX_PATTERN_CHARS = 100
/** `repo.topics`: at most 10, unique, `^[a-z0-9][a-z0-9-]*$`, 1–30 characters. */
export const MAX_TOPICS = 10
/** `repo.description`: at most 500 characters and 1000 UTF-8 bytes. */
export const DESCRIPTION_LIMITS = { chars: 500, bytes: 1000 } as const

/**
 * A change to a repo's config, as a delta: set the default branch, add or remove one protected
 * pattern, set the archived flag. Every other field carries over from the config it is applied
 * to, which {@link updateConfig} reads fresh at write time, so a change made elsewhere since the
 * page loaded (another pattern, the storage backend) is kept, not overwritten.
 */
export interface ConfigChange {
  readonly defaultBranch?: string
  readonly addPattern?: string
  readonly removePattern?: string
  readonly archived?: boolean
}

/** `refs/heads/main` → `main` (the form `config.defaultBranch` stores). */
export function shortBranch(name: string): string {
  return name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name
}

/**
 * The full ref pattern a user entry protects: a bare branch (`main`, `release/*`) becomes
 * `refs/heads/…`; anything already under `refs/` is kept. Consensus routing matches full ref
 * names, so a bare `main` would protect nothing.
 */
export function fullPattern(entry: string): string {
  const p = entry.trim()
  return p.startsWith('refs/') ? p : `refs/heads/${p}`
}

/** Why `name` cannot be a default branch, or null. */
export function branchProblem(name: string): string | null {
  const short = shortBranch(name.trim())
  const full = `refs/heads/${short}`
  if (short === '') return 'Name a branch.'
  if (new TextEncoder().encode(full).length > 255 || !isLegalRefName(full)) {
    return 'Not a branch name: no spaces or control characters, at most 244 bytes.'
  }
  return null
}

/** Why `patterns` would be refused by the `config` schema, or null. */
export function patternsProblem(patterns: readonly string[]): string | null {
  if (patterns.length > MAX_PROTECTED_PATTERNS) return `A repo holds at most ${MAX_PROTECTED_PATTERNS} protected patterns.`
  const seen = new Set<string>()
  for (const p of patterns) {
    const chars = [...p].length
    if (chars === 0 || chars > MAX_PATTERN_CHARS) return `A pattern is 1–${MAX_PATTERN_CHARS} characters.`
    // eslint-disable-next-line no-control-regex
    if (/[\s\u0000-\u001f\u007f]/.test(p)) return `${p} holds whitespace or a control character.`
    if (seen.has(p)) return `${p} is already protected.`
    seen.add(p)
  }
  return null
}

/** `current` with `change` applied (the next config). */
export function applyConfigChange(current: RepoConfig, change: ConfigChange): RepoConfig {
  let patterns = [...current.protectedPatterns]
  if (change.addPattern !== undefined && !patterns.includes(change.addPattern)) patterns.push(change.addPattern)
  if (change.removePattern !== undefined) patterns = patterns.filter((p) => p !== change.removePattern)
  return {
    ...current,
    ...(change.defaultBranch !== undefined ? { defaultBranch: shortBranch(change.defaultBranch.trim()) } : {}),
    protectedPatterns: patterns,
    ...(change.archived !== undefined ? { archived: change.archived } : {}),
  }
}

/** The refusal when a setting being edited changed elsewhere after the page loaded. */
export const STALE_SETTINGS = 'These settings changed since you opened this page — reload and try again.'

/**
 * Why `change`, planned against `seen` (the config the page showed), must not be applied to
 * `fresh` (the config in force now), or null: the field being edited moved since, so the user
 * decided on a state that no longer holds.
 */
export function staleProblem(seen: RepoConfig, fresh: RepoConfig, change: ConfigChange): string | null {
  const patternsMoved =
    seen.protectedPatterns.length !== fresh.protectedPatterns.length || seen.protectedPatterns.some((p, i) => p !== fresh.protectedPatterns[i])
  const moved =
    (change.defaultBranch !== undefined && seen.defaultBranch !== fresh.defaultBranch) ||
    (change.archived !== undefined && seen.archived !== fresh.archived) ||
    ((change.addPattern !== undefined || change.removePattern !== undefined) && patternsMoved)
  return moved ? STALE_SETTINGS : null
}

/** Whether two configs hold the same fields (a write of `b` over `a` would change nothing). */
export function sameConfig(a: RepoConfig, b: RepoConfig): boolean {
  return (
    a.defaultBranch === b.defaultBranch &&
    a.archived === b.archived &&
    a.backendMode === b.backendMode &&
    a.protectedPatterns.length === b.protectedPatterns.length &&
    a.protectedPatterns.every((p, i) => p === b.protectedPatterns[i]) &&
    a.backendUris.length === b.backendUris.length &&
    a.backendUris.every((u, i) => u === b.backendUris[i])
  )
}

/** The config a repo without one has (forge-core `CurrentConfig::default`). */
export const DEFAULT_CONFIG: RepoConfig = {
  defaultBranch: 'main',
  protectedPatterns: [],
  archived: false,
  backendUris: [],
  backendMode: 0,
}

/** The `config` document data for `next` (without `repoId`). */
export function configData(next: RepoConfig): Record<string, unknown> {
  const backend: Record<string, unknown> = { mode: next.backendMode }
  if (next.backendUris.length > 0) backend['uris'] = [...next.backendUris]
  const data: Record<string, unknown> = {
    defaultBranch: next.defaultBranch,
    backend,
    archived: next.archived,
  }
  // An empty list is the same as none (`is_well_formed`), and omitting it is smaller.
  if (next.protectedPatterns.length > 0) data['protectedPatterns'] = [...next.protectedPatterns]
  return data
}

/** The pre-sign cost of appending `next` as a config. */
export function previewConfig(next: RepoConfig): CostPreview {
  return previewCreate(DOC.config, configData(next))
}

/** The branches (short names) each pattern matches, in `branches` order. */
export function patternMatches(pattern: string, branches: readonly string[]): string[] {
  return branches.filter((b) => matchesProtected(`refs/heads/${b}`, [pattern]))
}

/** Why `topics` would be refused by the `repo` schema, or null. */
export function topicsProblem(topics: readonly string[]): string | null {
  if (topics.length > MAX_TOPICS) return `A repo has at most ${MAX_TOPICS} topics.`
  const seen = new Set<string>()
  for (const t of topics) {
    if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(t)) return `${t}: use 1–30 of a–z, 0–9 and -, not starting with -.`
    if (seen.has(t)) return `${t} is listed twice.`
    seen.add(t)
  }
  return null
}

/** `a, b,c` → `['a', 'b', 'c']`. */
export function parseTopics(input: string): string[] {
  return input
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
}

/** Why `description` would be refused by the `repo` schema, or null. */
export function descriptionProblem(description: string): string | null {
  const chars = [...description].length
  const bytes = new TextEncoder().encode(description).length
  if (chars > DESCRIPTION_LIMITS.chars || bytes > DESCRIPTION_LIMITS.bytes) {
    return `A description is at most ${DESCRIPTION_LIMITS.chars} characters and ${DESCRIPTION_LIMITS.bytes} bytes (accented letters and emoji take more than one).`
  }
  return null
}

/** Merge-method bits (review-parity spec §3.6). 0 means any. */
export const MERGE_METHODS = [
  { bit: 1, key: 'ff', label: 'Fast-forward' },
  { bit: 2, key: 'merge', label: 'Merge commit' },
  { bit: 4, key: 'squash', label: 'Squash' },
  { bit: 8, key: 'rebase', label: 'Rebase' },
] as const

/** The newest policy by `($createdAt, $id)` — the one in force — or null. */
export function newestPolicy(docs: readonly { createdAt: number; id: string; policy: Policy }[]): Policy | null {
  let best: { createdAt: number; id: string; policy: Policy } | null = null
  for (const d of docs) if (best === null || compareKey(d, best) > 0) best = d
  return best?.policy ?? null
}

/** A raw `policy` document as a {@link Policy}. */
export function toPolicy(doc: PlainDocument): Policy {
  const small = (field: string): number => (typeof doc[field] === 'number' ? num(doc, field) : 0)
  return {
    requiredApprovals: small('requiredApprovals'),
    approverRole: small('approverRole'),
    requireChecks: doc['requireChecks'] === true,
    mergeMethods: small('mergeMethods'),
  }
}

// ---------------------------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------------------------

/** The branch policy in force for `repo` (newest `policy`), or null. */
export async function readPolicy(sdk: EvoSDK, repo: RepoRef): Promise<Policy | null> {
  const docs = await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.policy, { orderBy: [['$createdAt', 'asc']] }))
  return newestPolicy(
    docs.map((d) => ({
      createdAt: typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0,
      id: typeof d['$id'] === 'string' ? d['$id'] : '',
      policy: toPolicy(d),
    })),
  )
}

/** Thrown for a config write the web cannot make in a private repo (its config is sealed). */
export class SealedConfigError extends Error {
  constructor() {
    super("This repo is private: its config is sealed, and this browser can't seal it yet. Use the CLI (`dg repo edit`, `dg repo protect`, `dg repo archive`), which writes it encrypted.")
    this.name = 'SealedConfigError'
  }
}

/** The config in force now, read fresh (the complete timeline, the rule's newest). */
async function readFreshConfig(sdk: EvoSDK, repo: RepoRef): Promise<RepoConfig | null> {
  return (await readConfigBundle(sdk, repo)).config
}

/**
 * Append a config applying `change` (maintainers only at consensus). The config in force is read
 * fresh right before signing and the change applied to it, so everything else (patterns added
 * elsewhere, the storage backend) carries over; if the field being edited moved since `seen`
 * (what the page showed), it refuses with {@link STALE_SETTINGS}. Returns null, signing nothing,
 * when the config already holds the change. Refuses a private repo ({@link SealedConfigError}):
 * a plaintext config there would be public and malformed. `read` / `write` are injectable for tests.
 */
export async function updateConfig(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  seen: RepoConfig | null,
  change: ConfigChange,
  intent?: string,
  read: (sdk: EvoSDK, repo: RepoRef) => Promise<RepoConfig | null> = readFreshConfig,
  write: typeof createDocumentIdempotent = createDocumentIdempotent,
): Promise<WriteResult | null> {
  if (repo.visibility === 'private') throw new SealedConfigError()
  if (change.defaultBranch !== undefined) {
    const problem = branchProblem(change.defaultBranch)
    if (problem) throw new Error(problem)
  }
  const fresh = await read(sdk, repo)
  const stale = staleProblem(seen ?? DEFAULT_CONFIG, fresh ?? DEFAULT_CONFIG, change)
  if (stale) throw new Error(stale)
  const now = fresh ?? DEFAULT_CONFIG
  const next = applyConfigChange(now, change)
  const problem = patternsProblem(next.protectedPatterns)
  if (problem) throw new Error(problem)
  if (fresh !== null && sameConfig(now, next)) return null
  return write(sdk, auth, {
    contractId: repo.forge.core,
    documentType: DOC.config,
    data: { repoId: decodeIdentifier(repo.repoId), ...configData(next) },
    ...(intent ? { intent } : {}),
  })
}

/** An edit of the `repo` document; unset fields are left alone, empty clears. */
export interface RepoDocEdit {
  readonly description?: string
  readonly topics?: readonly string[]
}

/** The `replace` changes an edit makes (an empty value removes the property). */
export function repoEditChanges(edit: RepoDocEdit): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  if (edit.description !== undefined) changes['description'] = edit.description === '' ? undefined : edit.description
  if (edit.topics !== undefined) changes['topics'] = edit.topics.length === 0 ? undefined : [...edit.topics]
  return changes
}

/** The pre-sign cost of an edit of the repo document. */
export function previewRepoEdit(edit: RepoDocEdit): CostPreview {
  const changes = repoEditChanges(edit)
  return Object.keys(changes).length === 0 ? previewCredits(0) : previewReplace(DOC.repo, changes)
}

/**
 * Edit the repo document's description and topics (its owner only; consensus refuses anyone
 * else and any change to `name`, `visibility` or `forkOf`). Signs nothing when it already holds
 * them. Plaintext by design, private repos included (`private-repos.md` §7).
 */
export async function editRepoDoc(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, edit: RepoDocEdit): Promise<ReplaceResult> {
  if (edit.description !== undefined) {
    const problem = descriptionProblem(edit.description)
    if (problem) throw new Error(problem)
  }
  if (edit.topics !== undefined) {
    const problem = topicsProblem(edit.topics)
    if (problem) throw new Error(problem)
  }
  return replaceDocumentIdempotent(sdk, auth, {
    contractId: repo.forge.core,
    documentType: DOC.repo,
    documentId: repo.repoId,
    changes: repoEditChanges(edit),
    repo: repo.repoId,
  })
}


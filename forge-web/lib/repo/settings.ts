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
import { compareKey, isRc1BranchName, isRc1RefName, matchesProtected, missingDefaultProtection as missingDefaultFor } from '../rules'
import type { Policy } from '../rules/v2'
import { branchName } from '../view/format'
import {
  ConsensusRefusal,
  DUPLICATE_UNIQUE_CODE,
  sumPreviews,
  createDocumentIdempotent,
  deleteDocumentIdempotent,
  previewCreate,
  previewCredits,
  previewDelete,
  previewReplace,
  queryAllDocuments,
  replaceDocumentIdempotent,
  type CostPreview,
  type FirstWrite,
  type PlainDocument,
  type ReplaceResult,
  type WriteAuth,
  type WriteResult,
} from '../sdk'
import { readConfigBundle, type RepoConfig } from './config'
import { repoContentWritten } from './push'
import { DOC, asIdentifierString, num, str, stringArray, withVis, type RepoRef } from './contract'
import { repoSource } from './source'

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested; forge-core `repo.rs` holds the same limits)
// ---------------------------------------------------------------------------------------------

/** `config.protectedPatterns`: at most 8 globs of 1–100 characters (forge-core schema). */
export const MAX_PROTECTED_PATTERNS = 8
export const MAX_PATTERN_CHARS = 100
/**
 * `repo.topics` (RC1 R-20): at most 20, unique, 1–30 characters of {@link TOPIC_PATTERN}. A
 * public repo has one `topic` document per topic, and consensus caps those at 20 per repo too
 * (`atMost20`).
 */
export const MAX_TOPICS = 20
/** A topic: lowercase words of a–z and 0–9 joined by single dashes (`repo.topics.items`, `topic.name`). */
export const TOPIC_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
/** `topic.name` / `repo.topics.items` `maxLength`. */
export const MAX_TOPIC_CHARS = 30
/** `repo.description`: at most 500 characters and 1000 UTF-8 bytes. */
export const DESCRIPTION_LIMITS = { chars: 500, bytes: 1000 } as const

/**
 * A change to a repo's config, as a delta: set the default branch, add protected patterns or
 * remove one, set the archived flag. Every other field carries over from the config it is applied
 * to, which {@link updateConfig} reads fresh at write time, so a change made elsewhere since the
 * page loaded (another pattern, the storage backend) is kept, not overwritten.
 */
export interface ConfigChange {
  readonly defaultBranch?: string
  readonly addPatterns?: readonly string[]
  readonly removePattern?: string
  readonly archived?: boolean
}

/** `refs/heads/main` → `main` (the form `config.defaultBranch` stores). */
export const shortBranch = branchName

/**
 * The full ref pattern a user entry protects: a bare branch (`main`, `release/*`) becomes
 * `refs/heads/…`; anything already under `refs/` is kept. Consensus routing matches full ref
 * names, so a bare `main` would protect nothing.
 */
export function fullPattern(entry: string): string {
  const p = entry.trim()
  return p.startsWith('refs/') ? p : `refs/heads/${p}`
}

/**
 * Why `name` cannot be a default branch, or null: `config.defaultBranch` must match RC1
 * `$defs.branch` ({@link isRc1BranchName}: git's ref grammar, no leading `-`), and the branch it
 * names must be one a push can create (`refs/heads/<name>`, {@link isRc1RefName}).
 */
export function branchProblem(name: string): string | null {
  const short = shortBranch(name.trim())
  if (short === '') return 'Name a branch.'
  if (!isRc1BranchName(short) || !isRc1RefName(`refs/heads/${short}`)) {
    return 'Not a branch name git accepts: no spaces, control characters or any of ~ ^ : ? * [ \\; no leading - or .; no .. or @{; not ending in /, . or .lock; at most 244 bytes.'
  }
  return null
}

/** What of the new-repository default protection `config` leaves uncovered (settings' one-click offer). */
export function missingDefaultProtection(config: RepoConfig): string[] {
  return missingDefaultFor(config.defaultBranch, config.protectedPatterns)
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
  for (const p of change.addPatterns ?? []) if (!patterns.includes(p)) patterns.push(p)
  if (change.removePattern !== undefined) patterns = patterns.filter((p) => p !== change.removePattern)
  return {
    ...current,
    ...(change.defaultBranch !== undefined ? { defaultBranch: shortBranch(change.defaultBranch.trim()) } : {}),
    protectedPatterns: patterns,
    ...(change.archived !== undefined ? { archived: change.archived } : {}),
  }
}

/**
 * Whether `config` shows `change` applied: only the edited field is compared, so a landed write
 * confirms even when an unrelated field (another pattern, the backend) changed elsewhere.
 */
export function changeHolds(config: RepoConfig, change: ConfigChange): boolean {
  return (
    (change.defaultBranch === undefined || config.defaultBranch === shortBranch(change.defaultBranch.trim())) &&
    (change.archived === undefined || config.archived === change.archived) &&
    (change.addPatterns ?? []).every((p) => config.protectedPatterns.includes(p)) &&
    (change.removePattern === undefined || !config.protectedPatterns.includes(change.removePattern))
  )
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
    ((change.addPatterns !== undefined || change.removePattern !== undefined) && patternsMoved)
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

/**
 * The pre-sign cost of appending `next` as a config. `first`: what is known of the subtrees it
 * builds (a repo that has a config already: none of its own).
 */
export function previewConfig(next: RepoConfig, first: FirstWrite = {}): CostPreview {
  return previewCreate(DOC.config, configData(next), first)
}

/**
 * The refs a pattern matches, in `refNames` order, by short name (`main`, `v1.0`): `refNames`
 * are full ref names (`refs/heads/main`, `refs/tags/v1.0`).
 */
export function patternMatches(pattern: string, refNames: readonly string[]): string[] {
  return refNames.filter((r) => matchesProtected(r, [pattern])).map((r) => r.replace(/^refs\/(heads|tags)\//, ''))
}

/** "main", "main, dev and 3 more": a short list of matched names for one line. */
export function matchList(names: readonly string[], shown = 3): string {
  if (names.length <= shown) return names.join(', ')
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`
}

/** Why `topics` would be refused by the `repo` schema (or its `topic` documents), or null. */
export function topicsProblem(topics: readonly string[]): string | null {
  if (topics.length > MAX_TOPICS) return `A repo has at most ${MAX_TOPICS} topics.`
  const seen = new Set<string>()
  for (const t of topics) {
    if (t.length > MAX_TOPIC_CHARS || !TOPIC_PATTERN.test(t)) {
      return `${t}: use up to ${MAX_TOPIC_CHARS} of a–z and 0–9, words joined by single dashes (no leading, trailing or double -).`
    }
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

/**
 * A raw `policy` document as a {@link Policy}. Required checks and their sources (RC1 R-08,
 * paired by position; set by `dg`) are read so the merge box pins them and a rewrite keeps them.
 */
export function toPolicy(doc: PlainDocument): Policy {
  const small = (field: string): number => (typeof doc[field] === 'number' ? num(doc, field) : 0)
  const checks = stringArray(doc, 'requiredChecks') ?? []
  const raw = doc['requiredCheckSources']
  const sources = Array.isArray(raw) ? raw.map(asIdentifierString).filter((id) => id !== '') : []
  return {
    requiredApprovals: small('requiredApprovals'),
    approverRole: small('approverRole'),
    requireChecks: doc['requireChecks'] === true,
    mergeMethods: small('mergeMethods'),
    ...(checks.length > 0 ? { requiredChecks: checks } : {}),
    // Kept only when paired with the names one for one (the contract's rule), else ignored.
    ...(sources.length > 0 && sources.length === checks.length ? { requiredCheckSources: sources } : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------------------------

/** The policy in force among `policy` documents (newest by `($createdAt, $id)`), or null. */
export function policyFromDocs(docs: readonly PlainDocument[]): Policy | null {
  return newestPolicy(
    docs.map((d) => ({
      createdAt: typeof d['$createdAt'] === 'number' ? d['$createdAt'] : 0,
      id: typeof d['$id'] === 'string' ? d['$id'] : '',
      policy: toPolicy(d),
    })),
  )
}

/** The branch policy in force for `repo` (newest `policy`), or null. */
export async function readPolicy(sdk: EvoSDK, repo: RepoRef): Promise<Policy | null> {
  return policyFromDocs(await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.policy, { orderBy: [['$createdAt', 'asc']] })))
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
  try {
    return await write(sdk, auth, {
      contractId: repo.forge.core,
      documentType: DOC.config,
      // RC1 stamps the repo's visibility (always public here: a private repo was refused above).
      data: withVis(repo.visibility, DOC.config, { repoId: decodeIdentifier(repo.repoId), ...configData(next) }),
      ...(intent ? { intent } : {}),
    })
  } finally {
    // Landed, refused or unknown: the repo's cached config (the chrome store, the home, the browse
    // context) is read again, never answered by a read issued before this write.
    repoContentWritten(repo)
  }
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

/**
 * The pre-sign cost of an edit of the repo document, and of the `topic` documents a topics edit
 * creates and deletes so Explore can count repos per topic (a public repo only: see
 * {@link syncTopicDocs}). `held`: the topic documents the repo has ({@link readTopicDocNames});
 * null while unknown, priced as the worst case (every listed topic created, none deleted).
 */
export function previewRepoEdit(
  edit: RepoDocEdit,
  held: readonly string[] | null = [],
  visibility: RepoRef['visibility'] = 'public',
): CostPreview {
  const changes = repoEditChanges(edit)
  if (Object.keys(changes).length === 0) return previewCredits(0)
  if (edit.topics === undefined || visibility === 'private') return previewReplace(DOC.repo, changes)
  const { added, removed } = held === null ? { added: [...edit.topics], removed: [] } : topicChanges(held, edit.topics)
  // Only the owner edits, and they wrote the repo document to forge-core; only the repo's first
  // topic builds its subtree (QW3-037).
  return sumPreviews([
    previewReplace(DOC.repo, changes),
    ...added.map((name, i) => previewCreate(DOC.topic, withVis('public', DOC.topic, { name }), { contract: false, ...(held !== null && (held.length > 0 || i > 0) ? { repo: false } : {}) })),
    ...removed.map(() => previewDelete(DOC.topic)),
  ])
}

/** The topic names an edit from `before` to `after` adds and removes. */
export function topicChanges(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  return { added: after.filter((t) => !before.includes(t)), removed: before.filter((t) => !after.includes(t)) }
}

/** The repo's `topic` documents: name to document id. */
async function readTopicDocs(sdk: EvoSDK, repo: RepoRef): Promise<Map<string, string>> {
  const docs = await queryAllDocuments(sdk, repoSource(repo).repoQuery(DOC.topic, { orderBy: [['repoId', 'asc'], ['name', 'asc']] }))
  return new Map(docs.map((d) => [str(d, 'name'), str(d, '$id')]))
}

/** The names of the repo's `topic` documents (what a topics edit prices against). */
export async function readTopicDocNames(sdk: EvoSDK, repo: RepoRef): Promise<string[]> {
  return [...(await readTopicDocs(sdk, repo)).keys()]
}

/**
 * Bring the repo's `topic` documents (forge-core, owner-granted, C-1: what Explore counts per
 * topic) in line with `topics`: delete the extra ones, then create the missing ones. Idempotent;
 * the owner only (consensus refuses anyone else).
 *
 * RC1 R-20: a topic document is public-only (`vis: "public"`, proved against the repo's
 * visibility), so a private repo has none; its `repo.topics` stays, unindexed. Consensus caps a
 * repo at 20 topic documents (`atMost20`), so the deletes go first: on a full repo, swapping a
 * topic would otherwise be refused as a 21st.
 */
export async function syncTopicDocs(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, topics: readonly string[]): Promise<void> {
  if (repo.visibility === 'private') return
  const held = await readTopicDocs(sdk, repo)
  const { added, removed } = topicChanges([...held.keys()], topics)
  for (const name of removed) {
    await deleteDocumentIdempotent(sdk, auth, { contractId: repo.forge.core, documentType: DOC.topic, documentId: held.get(name) as string, repo: repo.repoId })
  }
  for (const name of added) {
    try {
      await createDocumentIdempotent(sdk, auth, {
        contractId: repo.forge.core,
        documentType: DOC.topic,
        // `repoId` as the identifier's 32 bytes, like every other write.
        data: withVis(repo.visibility, DOC.topic, { repoId: decodeIdentifier(repo.repoId), name }),
      })
    } catch (e) {
      // Tagged in between (another device): the (repoId, name) index is unique.
      if (!(e instanceof ConsensusRefusal && e.code === DUPLICATE_UNIQUE_CODE)) throw e
    }
  }
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
  const result = await replaceDocumentIdempotent(sdk, auth, {
    contractId: repo.forge.core,
    documentType: DOC.repo,
    documentId: repo.repoId,
    changes: repoEditChanges(edit),
    repo: repo.repoId,
  })
  if (edit.topics !== undefined) await syncTopicDocs(sdk, auth, repo, edit.topics)
  return result
}


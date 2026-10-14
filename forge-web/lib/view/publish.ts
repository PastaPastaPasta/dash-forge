/**
 * Publishing a members-only branch's work onto a public branch from the web (mixed-visibility
 * DESIGN §4.3 "Merging a members branch into a public one", §10 "The publish dialog"): what the
 * dialog lists, the secret scan of what becomes public, and the copy it shows.
 *
 * Two methods (D10), never a merge commit with members-only parents: **Squash and publish**
 * (default) writes one new commit on the base with the merged tree; **Publish with history**
 * publishes the branch's commits as they are, its final head then linkable to the branch's
 * members-only activity (§2.3). What is listed and scanned is what the public gains: the squash's
 * files (the comparison's changes), or every file each published commit changed.
 */

import { AllowList, ALLOW_FILE, MAX_SCAN_BYTES, decide, describeRule, findingLocation, scanFile, scanUnread, type Rule } from '../secrets'
import { ObjectTooLargeError } from '../browse'
import { diffTrees, type DiffSides, type FileChange } from './commit-log'
import { parseCommit } from './git-objects'
import { readBlob, readCommit, readTree, type ObjectReader } from './tree-nav'

/** How a members-only branch's work is published. */
export type PublishMethod = 'squash' | 'history'

/** One likely secret in what would be published. */
export interface PublishFinding {
  readonly path: string
  readonly line: number | null
  readonly rule: Rule
  /** `refuse`: the push helper would refuse it (E807); the dialog asks "Publish anyway?". */
  readonly severity: 'refuse' | 'warn'
}

/** The scan of what a publish makes public. */
export interface PublishScan {
  readonly findings: readonly PublishFinding[]
  /** Files read for it. */
  readonly scanned: number
  /** More files changed than were scanned ({@link SCAN_FILES_MAX}). */
  readonly partial: boolean
}

/** Files one publish scan reads at most. */
export const SCAN_FILES_MAX = 500

/** Published commits whose changes the history scan walks at most. */
export const SCAN_COMMITS_MAX = 250

/** Git file modes whose blob is a file's content (a symlink's target and a gitlink are not scanned). */
function isFile(mode: number | null): boolean {
  return mode === 0o100644 || mode === 0o100755
}

/** The allow list (`.forge/secret-scan-allow`) of the tree `treeOid` would publish, else none. */
export async function readAllowList(reader: ObjectReader, treeOid: string): Promise<AllowList> {
  try {
    // `.forge/secret-scan-allow`: one directory down
    const [dirName, fileName] = ALLOW_FILE.split('/')
    const dir = (await readTree(reader, treeOid)).find((e) => e.name === dirName && e.mode === 0o040000)
    const entry = dir === undefined ? undefined : (await readTree(reader, dir.oid)).find((e) => e.name === fileName)
    if (entry === undefined || !isFile(entry.mode)) return AllowList.parse('')
    return AllowList.parse(new TextDecoder().decode(await readBlob(reader, entry.oid, 64 * 1024)))
  } catch {
    return AllowList.parse('')
  }
}

/**
 * Scan the files `changes` add or modify (the head side) as the push helper scans a public push
 * (`forge-secrets`, here `lib/secrets`): each blob read whole up to {@link MAX_SCAN_BYTES}, a
 * larger one by name only; findings the allow list silences dropped. Deleted files publish
 * nothing new.
 */
export async function scanChanges(reader: ObjectReader, changes: readonly FileChange[], allow: AllowList): Promise<PublishScan> {
  const files = changes.filter((c) => c.status !== 'deleted' && c.headOid !== null && isFile(c.headMode))
  const shown = files.slice(0, SCAN_FILES_MAX)
  const findings: PublishFinding[] = []
  for (const c of shown) {
    const oid = c.headOid as string
    let found
    try {
      found = scanFile(c.path, await readBlob(reader, oid, MAX_SCAN_BYTES))
    } catch (e) {
      if (!(e instanceof ObjectTooLargeError)) throw e
      found = scanUnread(c.path, oid)
    }
    for (const f of found) {
      const v = decide(f, false, allow)
      if (v !== null) findings.push({ path: f.path, line: f.line, rule: f.rule, severity: v.severity })
    }
  }
  return { findings, scanned: shown.length, partial: files.length > shown.length }
}

/**
 * Every file change the commits `commits` make against their first parents: what Publish with
 * history makes public, every intermediate version included. One entry per (path, blob).
 */
export async function historyChanges(sides: DiffSides, commits: readonly string[]): Promise<{ readonly changes: FileChange[]; readonly partial: boolean }> {
  const seen = new Set<string>()
  const changes: FileChange[] = []
  const walked = commits.slice(0, SCAN_COMMITS_MAX)
  for (const oid of walked) {
    const commit = await readCommit(sides.head, oid)
    const parent = commit.parents[0]
    const base = parent === undefined ? null : parseCommit((await sides.head.readObject(parent)).bytes).tree
    const diff = await diffTrees(sides, base, commit.tree)
    for (const c of diff.changes) {
      const key = `${c.path}\0${c.headOid ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      changes.push(c)
    }
  }
  return { changes, partial: commits.length > walked.length }
}

/** "alice", "alice and bob", "alice, bob and carol", "alice, bob and 3 others". */
export function peopleText(names: readonly string[]): string {
  const unique = [...new Set(names)]
  if (unique.length <= 1) return unique[0] ?? ''
  if (unique.length <= 3) return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`
  return `${unique.slice(0, 2).join(', ')} and ${unique.length - 2} others`
}

/** "3 commits by alice and bob · 14 files" (the dialog's exact list). Null parts are left out while unread. */
export function publishListText(commits: number | null, authors: readonly string[], files: number | null, filesPartial = false): string {
  const parts: string[] = []
  if (commits !== null) parts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'}${authors.length > 0 ? ` by ${peopleText(authors)}` : ''}`)
  if (files !== null) parts.push(`${filesPartial ? 'at least ' : ''}${files} ${files === 1 ? 'file' : 'files'}`)
  return parts.join(' · ')
}

/** The dialog's scan line: "No secrets found.", or the first finding and how many more. */
export function scanLine(scan: PublishScan): string {
  const first = scan.findings.find((f) => f.severity === 'refuse') ?? scan.findings[0]
  if (first === undefined) return scan.partial ? `No secrets found in the first ${scan.scanned} files.` : 'No secrets found.'
  const more = scan.findings.length - 1
  return `Possible secret in ${findingLocation({ ...first, fingerprint: '' })} (${describeRule(first.rule)})${more > 0 ? `, and ${more} more` : ''}. Publish anyway?`
}

/** A commit author's display name from a `Name <email>` line. */
export function authorName(ident: string): string {
  const at = ident.indexOf(' <')
  return (at >= 0 ? ident.slice(0, at) : ident).trim()
}

/** Whether a commit message names the members-only branch `branch` (its short name, or its full ref name). */
export function namesBranch(message: string, branch: string): boolean {
  const short = branch.replace(/^refs\/heads\//, '')
  if (short === '') return false
  // a whole-word match: `fix` names `fix`, not `prefix`
  const escaped = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_./-])${escaped}($|[^A-Za-z0-9_/-])`).test(message) || message.includes(branch)
}

/**
 * The squash message with `Co-authored-by` trailers for `coAuthors` (`Name <email>`), or without
 * any: a members-only PR's default lists none until the publisher opts in (their emails become
 * public, DESIGN §2.3), and an opt-out drops ones already there.
 */
export function withCoAuthors(message: string, coAuthors: readonly string[]): string {
  const stripped = message.replace(/(\n\n)?(Co-authored-by: [^\n]*\n?)+$/, '').replace(/\s+$/, '')
  return coAuthors.length === 0 ? stripped : `${stripped}\n\n${coAuthors.map((a) => `Co-authored-by: ${a}`).join('\n')}`
}

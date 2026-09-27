/**
 * Commits the browser makes to a PR's source branch (review-parity R5 §4.5, M6): applied review
 * suggestions, and "Update branch" (a merge of the base into the branch). Pure over an
 * {@link ObjectReader}: the page reads objects through the repos' browse readers and pushes
 * what these return with the merge runner's pack writer.
 *
 * - {@link planSuggestions} turns review comments into edits, refusing what `dg pr suggestion
 *   apply` refuses (E107): a comment not on a line of the new side, on another head, with no
 *   ```suggestion block or with several, or overlapping another one.
 * - {@link applySuggestionCommit} applies them bottom-up to each file of the head, rebuilds the
 *   trees on each changed path, and writes a commit with parent = head and the message
 *   `Apply suggestions from code review` + `Co-authored-by:` per reviewer + `Forge-Suggestion:`
 *   per comment — byte-for-byte the message `dg` writes (parity: `branch::suggestion_message`).
 * - {@link updateBranchCommit} merges the base tip into the head (disjoint changes only, as the
 *   browser merge), message `Merge branch '<base>' into <branch>`.
 */

import { gitOidHex, MODE_TREE, type GitObject } from '../browse'
import { anchorOf, applySuggestion, parseSuggestions, type AnchorFields } from '../rules/v2'
import { checkCommit, checkTree, parseCommit, parseTree, serializeTree, type TreeEntry } from '../view/git-objects'
import type { ObjectReader } from '../view/tree-nav'
import { mergeTrees, planMerge, type MergeIdentity } from './engine'
import { newCommits, objectsToPack } from './objects'
import { writePack, type BuiltPack } from './pack-writer'

/** A review comment, as the suggestion planner reads it. */
export interface SuggestionComment {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly anchor: AnchorFields
}

/** One suggestion to apply. */
export interface PlannedSuggestion {
  readonly commentId: string
  readonly reviewer: string
  readonly path: string
  /** 1-based, inclusive, on the new side. */
  readonly start: number
  readonly end: number
  readonly text: string
}

/** Why a suggestion cannot be applied (the E107 cases of `dg pr suggestion apply`). */
export class SuggestionRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SuggestionRefused'
  }
}

const short = (id: string): string => id.slice(0, 8)

/** The plan of one comment's suggestion on `head`, or why it cannot be applied. Parity: `dg`'s `plan_suggestion`. */
export function planSuggestion(c: SuggestionComment, head: string): PlannedSuggestion {
  const a = anchorOf(c.anchor)
  if (a === null) throw new SuggestionRefused(`comment ${short(c.id)} is not on a line of the diff`)
  if (a.line === null || a.side === null) throw new SuggestionRefused(`comment ${short(c.id)} is on a whole file, not on lines`)
  if (a.side !== 1) throw new SuggestionRefused(`comment ${short(c.id)} is on the old side of the diff; a suggestion replaces new lines`)
  if (a.commitOid.toLowerCase() !== head.toLowerCase()) {
    throw new SuggestionRefused(`comment ${short(c.id)} was made on ${a.commitOid.slice(0, 7)}, not on the PR head ${head.slice(0, 7)}`)
  }
  const s = parseSuggestions(c.body)
  if (s.length === 0) throw new SuggestionRefused(`comment ${short(c.id)} has no \`\`\`suggestion block`)
  if (s.length > 1) throw new SuggestionRefused(`comment ${short(c.id)} has ${s.length} suggestion blocks; apply it by hand`)
  return { commentId: c.id, reviewer: c.author, path: a.path, start: a.startLine ?? a.line, end: a.line, text: (s[0] as { text: string }).text }
}

/** Whether a comment's suggestion can be applied on `head` (for "Apply" buttons). */
export function applicable(c: SuggestionComment, head: string): boolean {
  try {
    planSuggestion(c, head)
    return true
  } catch {
    return false
  }
}

/** Apply `plans` to `files` (path → text): per file bottom-up, refusing overlaps. Parity: `dg`'s `apply_all`. */
export function applyAll(plans: readonly PlannedSuggestion[], files: ReadonlyMap<string, string>): Map<string, string> {
  const byFile = new Map<string, PlannedSuggestion[]>()
  for (const p of plans) byFile.set(p.path, [...(byFile.get(p.path) ?? []), p])
  const out = new Map<string, string>()
  for (const [path, ps] of byFile) {
    ps.sort((a, b) => a.start - b.start || a.end - b.end)
    for (let i = 1; i < ps.length; i++) {
      const [x, y] = [ps[i - 1] as PlannedSuggestion, ps[i] as PlannedSuggestion]
      if (y.start <= x.end) {
        throw new SuggestionRefused(`the suggestions ${short(x.commentId)} and ${short(y.commentId)} overlap in ${path} (lines ${x.start}-${x.end} and ${y.start}-${y.end}); apply one, then ask for the other again`)
      }
    }
    let text = files.get(path)
    if (text === undefined) throw new SuggestionRefused(`${path} is not a text file in the PR head`)
    for (const p of [...ps].reverse()) {
      const r = applySuggestion(text, p.start, p.end, p.text)
      if ('error' in r) {
        throw new SuggestionRefused(
          r.error === 'badRange'
            ? `comment ${short(p.commentId)} names an empty line range`
            : `comment ${short(p.commentId)} names lines ${p.start}-${p.end} but ${path} has fewer lines at the head`,
        )
      }
      text = r.ok
    }
    out.set(path, text)
  }
  return out
}

/** The commit message of applied suggestions. Parity: `dg`'s `suggestion_message` (`names`: DPNS names by identity). */
export function suggestionMessage(plans: readonly PlannedSuggestion[], names: ReadonlyMap<string, string>): string {
  const lines = ['Apply suggestions from code review', '']
  for (const r of [...new Set(plans.map((p) => p.reviewer))].sort()) lines.push(`Co-authored-by: ${names.get(r) ?? r} <${r}@users.forge.invalid>`)
  for (const p of plans) lines.push(`Forge-Suggestion: ${p.commentId}`)
  return lines.join('\n')
}

/** `Name <email> <seconds> <±hhmm>`. */
function ident(who: MergeIdentity): string {
  const when = who.timestamp ?? Math.floor(Date.now() / 1000)
  const offset = who.timezoneOffset ?? new Date(when * 1000).getTimezoneOffset()
  const east = -offset
  const abs = Math.abs(east)
  const tz = `${east < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
  // One line: a name or email with a newline or angle bracket would forge headers.
  const clean = (s: string): string => s.replace(/[\r\n<>\0]/g, '').trim()
  return `${clean(who.name)} <${clean(who.email)}> ${when} ${tz}`
}

/** A commit's bytes. */
export function commitBytes(tree: string, parents: readonly string[], who: MergeIdentity, message: string): Uint8Array {
  const id = ident(who)
  const text = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${id}\ncommitter ${id}\n\n${message.endsWith('\n') ? message : `${message}\n`}`
  return new TextEncoder().encode(text)
}

/** The text of the regular file at `path` in the tree `root`, or null (absent, not a regular file, binary). */
export async function readTextFile(reader: ObjectReader, root: string, path: string): Promise<string | null> {
  const parts = path.split('/')
  let tree = root
  for (let i = 0; i < parts.length; i++) {
    const entries = parseTree((await reader.readObject(tree)).bytes)
    const e = entries.find((x) => x.name === parts[i])
    if (e === undefined) return null
    if (i < parts.length - 1) {
      if (e.mode !== MODE_TREE) return null
      tree = e.oid
    } else {
      if (e.mode !== 0o100644 && e.mode !== 0o100755) return null
      const blob = await reader.readObject(e.oid)
      if (blob.type !== 'blob') return null
      const bytes = blob.bytes
      for (let j = 0; j < Math.min(bytes.length, 8192); j++) if (bytes[j] === 0) return null
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    }
  }
  return null
}

/**
 * The tree `root` with each path's file replaced by new text (existing regular files only; the
 * mode is kept). Returns the new root and every tree and blob it wrote.
 */
export async function replaceFiles(reader: ObjectReader, root: string, files: ReadonlyMap<string, string>): Promise<{ root: string; written: GitObject[] }> {
  const written: GitObject[] = []
  const put = (type: GitObject['type'], bytes: Uint8Array): string => {
    written.push({ type, bytes })
    return gitOidHex(type, bytes)
  }
  // Group the changes by their first path segment and recurse.
  const rewrite = async (tree: string, changes: ReadonlyMap<string, string>, prefix: string): Promise<string> => {
    const entries = parseTree((await reader.readObject(tree)).bytes)
    const here = new Map<string, Map<string, string>>()
    for (const [path, text] of changes) {
      const slash = path.indexOf('/')
      const head = slash === -1 ? path : path.slice(0, slash)
      const rest = slash === -1 ? '' : path.slice(slash + 1)
      here.set(head, (here.get(head) ?? new Map()).set(rest, text))
    }
    const out: TreeEntry[] = []
    for (const e of entries) {
      const sub = here.get(e.name)
      if (sub === undefined) {
        out.push(e)
        continue
      }
      if (sub.has('')) {
        if (e.mode !== 0o100644 && e.mode !== 0o100755) throw new SuggestionRefused(`${prefix}${e.name} is not a regular file`)
        out.push({ ...e, oid: put('blob', new TextEncoder().encode(sub.get('') as string)) })
      } else {
        if (e.mode !== MODE_TREE) throw new SuggestionRefused(`${prefix}${e.name} is not a directory`)
        out.push({ ...e, oid: await rewrite(e.oid, sub, `${prefix}${e.name}/`) })
      }
      here.delete(e.name)
    }
    const missing = [...here.keys()]
    if (missing.length > 0) throw new SuggestionRefused(`${prefix}${missing[0] as string} is not in the PR head`)
    const bytes = serializeTree(out)
    const oid = gitOidHex('tree', bytes)
    checkTree(oid, bytes)
    written.push({ type: 'tree', bytes })
    return oid
  }
  return { root: await rewrite(root, files, ''), written }
}

/** A commit to push to a branch: the new tip and its self-contained pack (objects not in `have`). */
export interface BranchCommit {
  readonly commit: string
  readonly pack: BuiltPack
  /** The files it changed (a suggestion commit), for the step list. */
  readonly files: readonly string[]
}

/** `reader` plus in-memory objects. */
function withObjects(reader: ObjectReader, objects: readonly GitObject[]): ObjectReader {
  const extra = new Map(objects.map((o) => [gitOidHex(o.type, o.bytes), o]))
  return { readObject: async (oid) => extra.get(oid) ?? reader.readObject(oid) }
}

/** The pack of `tip`'s objects that `have` (the branch's current tip) does not hold. */
async function packFor(reader: ObjectReader, tip: string, have: readonly string[]): Promise<BuiltPack> {
  const commits = await newCommits(reader, tip, have)
  return writePack(await objectsToPack(reader, commits))
}

/** Build the commit applying `plans` on `head` (the branch's tip): parent = head. */
export async function applySuggestionCommit(
  reader: ObjectReader,
  head: string,
  plans: readonly PlannedSuggestion[],
  who: MergeIdentity,
  names: ReadonlyMap<string, string>,
): Promise<BranchCommit> {
  if (plans.length === 0) throw new SuggestionRefused('no suggestions to apply')
  const root = parseCommit((await reader.readObject(head)).bytes).tree
  const current = new Map<string, string>()
  for (const path of new Set(plans.map((p) => p.path))) {
    const text = await readTextFile(reader, root, path)
    if (text === null) throw new SuggestionRefused(`${path} is not a regular text file in the PR head`)
    current.set(path, text)
  }
  const edited = applyAll(plans, current)
  const { root: tree, written } = await replaceFiles(reader, root, edited)
  const bytes = commitBytes(tree, [head], who, suggestionMessage(plans, names))
  const commit = gitOidHex('commit', bytes)
  checkCommit(commit, bytes)
  const pack = await packFor(withObjects(reader, [...written, { type: 'commit', bytes }]), commit, [head])
  return { commit, pack, files: [...edited.keys()] }
}

/** Why the branch cannot be updated in the browser. */
export type UpdateBranchPlan =
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'merge'; readonly mergeBase: string }
  | { readonly kind: 'fast-forward' }
  | { readonly kind: 'conflict'; readonly paths: readonly string[] }
  | { readonly kind: 'unrelated' }

/**
 * Merge the base tip into the head (M6), as `dg pr update-branch`: nothing when the head already
 * contains the base; a merge commit (parents head, base) when both changed disjoint paths;
 * conflicts otherwise (the browser never merges file contents). A head behind the base (it
 * contains nothing new) is not fast-forwarded: that would drop the PR's changes.
 */
export async function updateBranchCommit(
  reader: ObjectReader,
  head: string,
  baseTip: string,
  baseName: string,
  branchName: string,
  who: MergeIdentity,
): Promise<{ plan: UpdateBranchPlan; commit?: BranchCommit }> {
  const plan = await planMerge(reader, { baseTip: head, headOid: baseTip })
  if (plan.kind === 'up-to-date') return { plan: { kind: 'up-to-date' } }
  if (plan.kind === 'unrelated') return { plan: { kind: 'unrelated' } }
  if (plan.kind === 'conflict') return { plan: { kind: 'conflict', paths: plan.paths } }
  if (plan.kind === 'fast-forward') return { plan: { kind: 'fast-forward' } }
  const tree = async (c: string): Promise<string> => parseCommit((await reader.readObject(c)).bytes).tree
  const [b, o, t] = await Promise.all([tree(plan.mergeBase), tree(head), tree(baseTip)])
  const merged = await mergeTrees(reader, b, o, t)
  if (merged.kind === 'conflict') return { plan: { kind: 'conflict', paths: merged.paths } }
  const short = (r: string): string => r.replace(/^refs\/heads\//, '')
  const bytes = commitBytes(merged.oid, [head, baseTip], who, `Merge branch '${short(baseName)}' into ${short(branchName)}`)
  const commit = gitOidHex('commit', bytes)
  checkCommit(commit, bytes)
  const pack = await packFor(withObjects(reader, [...merged.written, { type: 'commit', bytes }]), commit, [head])
  return { plan: { kind: 'merge', mergeBase: plan.mergeBase }, commit: { commit, pack, files: [] } }
}

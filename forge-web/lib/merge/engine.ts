/**
 * The browser merge engine (`ux-dx-spec.md` §5.7): given the base branch's tip and a PR head,
 * decide how the PR merges and build the pack that makes it so. The browser never merges file
 * contents:
 *
 *  - **Fast-forward** when the head descends from the base tip: the new tip is the head.
 *  - A **merge commit** only when the two sides changed disjoint sets of paths since their one
 *    merge base ({@link mergeTrees}): each path takes the side that changed it. Anything else —
 *    a path, or an ancestor or descendant of it, touched by both sides; a criss-cross history
 *    with more than one merge base — is refused as "overlapping", and `dg pr merge` does it.
 *    The merge commit is authored and committed by the merger, message
 *    `Merge pull request #<n> from <source>`.
 *  - The **pack**: every object reachable from the new tip that the base repo does not hold,
 *    as a non-thin pack (see `objects.ts`, `pack-writer.ts`).
 *
 * Every commit and tree read is checked as `git fsck --strict` would ({@link strictReader}),
 * and the pack walk runs for fast-forwards and merges alike, so {@link checkMerge} and
 * {@link runMerge} always agree. Pure apart from its object reads, so it runs the same in a
 * Web Worker and in tests.
 */

import { gitOidHex, MODE_TREE, type GitObject } from '../browse'
import { checkCommit, checkTree, MalformedObjectError, MAX_TREE_DEPTH, parseCommit, parseTree, serializeTree, treeTooDeep, type TreeEntry } from '../view/git-objects'
import { findMergeBases, MergeBaseSearchLimitError } from '../view/pull-diff'
import type { ObjectReader } from '../view/tree-nav'
import { newCommits, objectsToPack, UnsupportedChangeError, WalkLimitError } from './objects'
import { writePack } from './pack-writer'

/** Who the merge commit is by (the merger's Settings name and email). */
export interface MergeIdentity {
  readonly name: string
  readonly email: string
  /** Seconds since the epoch; defaults to now. */
  readonly timestamp?: number
  /** Minutes, as `Date.getTimezoneOffset()` (positive west of UTC); defaults to local. */
  readonly timezoneOffset?: number
}

export interface MergeInput {
  /** The base branch's current tip, hex. */
  readonly baseTip: string
  /** The PR head, hex. */
  readonly headOid: string
  readonly prNumber: number
  /** How the PR's source is named in the subject: its source branch (else the head oid). */
  readonly sourceLabel: string
  /** The PR title, the message body. */
  readonly title?: string
  readonly author: MergeIdentity
  /**
   * Whether the head's objects are already in the base repo's packs (a same-repo PR): then
   * the head, like the base tip, is something the base repo "has".
   */
  readonly headInBase: boolean
  /**
   * Squash (review-parity M1): one commit on the base tip whose tree is the merged tree (the
   * head's own when the base is behind it), message {@link squashMessage} — parity with
   * `dg pr merge --squash`. Absent: fast-forward when possible, else a merge commit.
   */
  readonly squash?: { readonly message: string }
}

/** A merge the engine can make, before its pack is built. */
export type MergePlan =
  | { readonly kind: 'fast-forward'; readonly newTip: string }
  | { readonly kind: 'merge'; readonly mergeBase: string }
  /** Both sides touched the same paths (or the history has several merge bases): `paths` says where, when known. */
  | { readonly kind: 'conflict'; readonly paths: readonly string[] }
  /** A commit or tree fsck would refuse, or a change only the CLI merges: nothing is merged in the browser. */
  | { readonly kind: 'malformed'; readonly reason: string }
  /** Past a walk or read limit: too large to merge in a tab. */
  | { readonly kind: 'too-large'; readonly reason: string }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'unrelated' }

/** A merge ready to push. */
export interface MergeOutcome {
  readonly kind: 'fast-forward' | 'merge' | 'squash'
  readonly newTip: string
  readonly pack: Uint8Array
  readonly packHash: string
  readonly objectCount: number
}

export type MergeProgress = (phase: 'analyse' | 'merge' | 'pack', detail?: string) => void

/**
 * The merge commit message, as `dg pr merge` writes it: the subject names the PR and its
 * source branch (else the head), the body is the PR title.
 */
export function mergeMessage(prNumber: number, sourceLabel: string, rawTitle = ''): string {
  // The PR author wrote the title: one line, bounded, so it cannot forge trailers or headers.
  const title = rawTitle.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 200)
  return title === '' ? `Merge pull request #${prNumber} from ${sourceLabel}\n` : `Merge pull request #${prNumber} from ${sourceLabel}\n\n${title}\n`
}

/**
 * Classify the merge (no objects written). `reader` must read both sides (the base repo's
 * objects, and the head's source repo's). A criss-cross history (several merge bases) is a
 * `conflict`: which base a three-way merge starts from changes the answer, so only the CLI
 * merges it.
 */
export async function planMerge(reader: ObjectReader, input: Pick<MergeInput, 'baseTip' | 'headOid'>): Promise<Exclude<MergePlan, { kind: 'malformed' | 'too-large' }>> {
  const { baseTip, headOid } = input
  if (baseTip === '') return { kind: 'fast-forward', newTip: headOid }
  const bases = await findMergeBases(reader, baseTip, headOid)
  const base = bases[0]
  if (base === undefined) return { kind: 'unrelated' }
  if (bases.length > 1) return { kind: 'conflict', paths: [] }
  if (base === headOid) return { kind: 'up-to-date' }
  if (base === baseTip) return { kind: 'fast-forward', newTip: headOid }
  return { kind: 'merge', mergeBase: base }
}

type Entry = Pick<TreeEntry, 'mode' | 'oid'>

const same = (a: Entry | undefined, b: Entry | undefined): boolean => a?.mode === b?.mode && a?.oid === b?.oid

/** A merged directory with nothing left in it. */
const EMPTY = Symbol('empty tree')

/**
 * The tree a merge of two disjoint sides makes, over `reader`: `ours` and `theirs` as changed
 * from `base` (root tree oids). Walked name by name:
 *
 *  - unchanged on a side → the other side's entry (a deletion included);
 *  - changed on both → both must be directories (or new on both as directories), merged the
 *    same way one level down; anything else — the same file changed twice, even identically;
 *    a file on one side where the other changed the directory it replaced, or anything under
 *    a directory the other side removed entirely — is a conflict at that path.
 *
 * A merged directory left with no entries (each side deleted different files of it) is dropped
 * from its parent, as git does; an empty root is written as the empty tree. Returns the merged
 * root oid and the trees it wrote (bytes as git writes them), or the conflicting paths.
 */
export async function mergeTrees(
  reader: ObjectReader,
  base: string,
  ours: string,
  theirs: string,
): Promise<{ kind: 'merged'; oid: string; written: GitObject[] } | { kind: 'conflict'; paths: string[] }> {
  const conflicts: string[] = []
  const written: GitObject[] = []
  const entries = async (oid: string | undefined): Promise<Map<string, Entry>> => {
    if (oid === undefined) return new Map()
    const obj = await reader.readObject(oid)
    if (obj.type !== 'tree') throw new MalformedObjectError(oid, `a ${obj.type} where a tree was expected`)
    return new Map(parseTree(obj.bytes).map((e) => [e.name, { mode: e.mode, oid: e.oid }]))
  }
  const isTree = (e: Entry | undefined): e is Entry => e !== undefined && e.mode === MODE_TREE
  const conflict = (prefix: string): null => {
    conflicts.push(prefix === '' ? '/' : prefix.slice(0, -1))
    return null
  }
  // Returns the merged tree's oid, EMPTY when the merge leaves it with no entries, or null
  // once a conflict was recorded at or below `prefix`.
  const walk = async (b: string | undefined, o: string, t: string, prefix: string, depth: number): Promise<string | typeof EMPTY | null> => {
    if (b === o) return t
    if (b === t) return o
    // The same change on both sides is still a path both touched.
    if (o === t) return conflict(prefix)
    if (depth > MAX_TREE_DEPTH) throw treeTooDeep(o)
    const [be, oe, te] = await Promise.all([entries(b), entries(o), entries(t)])
    // A side that emptied this directory removed every entry of it: whatever the other side
    // changed here overlaps (git would call it a directory rename or a delete/modify).
    if (oe.size === 0 || te.size === 0) return conflict(prefix)
    const out: TreeEntry[] = []
    let clean = true
    for (const name of new Set([...be.keys(), ...oe.keys(), ...te.keys()])) {
      const [bb, oo, tt] = [be.get(name), oe.get(name), te.get(name)]
      const path = `${prefix}${name}`
      let pick: Entry | undefined
      if (same(oo, bb)) pick = tt
      else if (same(tt, bb)) pick = oo
      else if (isTree(oo) && isTree(tt) && (bb === undefined || isTree(bb))) {
        const sub = await walk(bb?.oid, oo.oid, tt.oid, `${path}/`, depth + 1)
        if (sub === null) {
          clean = false
          continue
        }
        // Emptied by the two sides' deletions together: the directory goes, as in git.
        if (sub === EMPTY) continue
        pick = { mode: MODE_TREE, oid: sub }
      } else {
        conflicts.push(path)
        clean = false
        continue
      }
      if (pick !== undefined) out.push({ name, ...pick })
    }
    if (!clean) return null
    if (out.length === 0) return EMPTY
    const bytes = serializeTree(out)
    const oid = gitOidHex('tree', bytes)
    // What this client writes is held to the same checks as what it reads.
    checkTree(oid, bytes)
    written.push({ type: 'tree', bytes })
    return oid
  }
  const root = await walk(base, ours, theirs, '', 0)
  if (root === null) return { kind: 'conflict', paths: conflicts }
  if (root === EMPTY) {
    const bytes = new Uint8Array(0)
    return { kind: 'merged', oid: gitOidHex('tree', bytes), written: [{ type: 'tree', bytes }] }
  }
  return { kind: 'merged', oid: root, written }
}

/** `Name <email> <seconds> <±hhmm>` for a git commit header. */
function identLine(who: MergeIdentity): string {
  const when = who.timestamp ?? Math.floor(Date.now() / 1000)
  // The offset in force at that moment (daylight saving differs across the year).
  const offset = who.timezoneOffset ?? new Date(when * 1000).getTimezoneOffset()
  const east = -offset
  const abs = Math.abs(east)
  const tz = `${east < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
  return `${who.name} <${who.email}> ${when} ${tz}`
}

/**
 * A squash commit's message (review-parity M1), as `dg pr merge --squash` writes it: the PR title
 * with its number, the body, and a `Co-authored-by` trailer for each commit author other than the
 * committer (`authors`: `Name <email>` of the PR's commits, oldest first, each once).
 */
export function squashMessage(title: string, body: string, number: number, authors: readonly string[], committer: string): string {
  // One line of title: the PR author wrote it (it cannot forge trailers or headers). dg uses the
  // raw title; a title holding a newline is the only case where the two differ, deliberately.
  let m = `${title.replace(/[\r\n\0]+/g, ' ').trim()} (#${number})`
  if (body.trim() !== '') m += `\n\n${body.replace(/\s+$/, '')}`
  const co = authors.filter((a) => a !== committer)
  if (co.length > 0) m += `\n\n${co.map((a) => `Co-authored-by: ${a}`).join('\n')}`
  return m
}

/** The PR's commit authors for a squash: loading (null), read (`complete` false: the list was capped), or unreadable. */
export type SquashAuthors = { readonly authors: readonly string[]; readonly complete: boolean } | { readonly error: string } | null

/**
 * The squash message box's state. The default waits for the authors (a squash made before would
 * drop their credit); a commit list that cannot be read gives a default without them, with a
 * warning, instead of waiting forever. `edited` (the merger's text) wins once typed. `problem`
 * says why "Squash and merge" is disabled, or null.
 */
export function squashDraft(
  pr: { readonly title: string; readonly body: string; readonly number: number },
  authors: SquashAuthors,
  committer: string,
  edited: string | null,
): { message: string; ready: boolean; warning: string | null; problem: string | null } {
  const fallback = authors === null ? null : squashMessage(pr.title, pr.body, pr.number, 'error' in authors ? [] : authors.authors, committer)
  const ready = edited !== null || fallback !== null
  const message = edited ?? fallback ?? ''
  const warning =
    authors !== null && 'error' in authors
      ? `The PR's commits could not be read (${authors.error}), so the message has no Co-authored-by lines: add them by hand if you want the authors credited.`
      : authors !== null && !authors.complete
        ? 'This PR has more commits than the page lists: add any missing Co-authored-by lines (or squash with `dg pr merge --squash`).'
        : null
  const problem = !ready ? "Reading the PR's commits for the Co-authored-by lines…" : message.trim() === '' ? 'Write a commit message to squash and merge.' : null
  return { message, ready, warning, problem }
}

/** The squash commit's bytes: the tree, the base tip as its only parent, the merger as author and committer. */
export function squashCommitBytes(tree: string, input: MergeInput): Uint8Array {
  const ident = identLine(input.author)
  const parents = input.baseTip === '' ? '' : `parent ${input.baseTip}\n`
  const message = (input.squash?.message ?? '').replace(/\0/g, '')
  return new TextEncoder().encode(`tree ${tree}\n${parents}author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`)
}

/** The merge commit's bytes: the merged tree, parents base tip then head, the merger as author and committer. */
export function mergeCommitBytes(tree: string, input: MergeInput): Uint8Array {
  const ident = identLine(input.author)
  const text = `tree ${tree}\nparent ${input.baseTip}\nparent ${input.headOid}\nauthor ${ident}\ncommitter ${ident}\n\n${mergeMessage(input.prNumber, input.sourceLabel, input.title)}`
  return new TextEncoder().encode(text)
}

/** `reader` with some objects added in memory (what the merge wrote). */
function withObjects(reader: ObjectReader, objects: readonly GitObject[]): ObjectReader {
  const extra = new Map(objects.map((o) => [gitOidHex(o.type, o.bytes), o]))
  return { readObject: async (oid) => extra.get(oid) ?? reader.readObject(oid) }
}

/** The merge commit over `reader`, with every object it created, or the conflicting paths. */
export async function disjointMerge(
  reader: ObjectReader,
  input: MergeInput,
  mergeBase: string,
): Promise<{ kind: 'merge'; oid: string; reader: ObjectReader } | { kind: 'conflict'; paths: readonly string[] }> {
  const tree = async (commit: string): Promise<string> => parseCommit((await reader.readObject(commit)).bytes).tree
  const [b, o, t] = await Promise.all([tree(mergeBase), tree(input.baseTip), tree(input.headOid)])
  const merged = await mergeTrees(reader, b, o, t)
  if (merged.kind === 'conflict') return merged
  const bytes = mergeCommitBytes(merged.oid, input)
  const oid = gitOidHex('commit', bytes)
  checkCommit(oid, bytes)
  return { kind: 'merge', oid, reader: withObjects(reader, [...merged.written, { type: 'commit', bytes }]) }
}

/** Object reads one merge (or check) may make before it is refused as too large. */
export const MERGE_READ_BUDGET = 100_000

/** The merge would read more objects than {@link MERGE_READ_BUDGET}. */
export class ReadBudgetError extends Error {
  constructor(readonly budget: number) {
    super(`this merge reads more than ${budget} objects; merge it with \`dg pr merge\``)
    this.name = 'ReadBudgetError'
  }
}

/**
 * `reader` refusing (with {@link MalformedObjectError}) any commit or tree fsck would refuse:
 * everything the merge reads — the history walks, the tree merge, the pack walk — sees only
 * objects git and this client read the same way.
 */
export function strictReader(reader: ObjectReader, budget = MERGE_READ_BUDGET): ObjectReader {
  // Distinct objects, so a run that walks again (a same-repo PR's second pack walk) counts
  // exactly what its check did. The walks' own caps bound repeated visits.
  const seen = new Set<string>()
  return {
    readObject: async (oid) => {
      seen.add(oid)
      if (seen.size > budget) throw new ReadBudgetError(budget)
      const obj = await reader.readObject(oid)
      if (obj.type === 'commit') checkCommit(oid, obj.bytes)
      else if (obj.type === 'tree') checkTree(oid, obj.bytes)
      return obj
    },
    ...(reader.locate ? { locate: (oid: string) => reader.locate?.(oid) ?? null } : {}),
  }
}

/** What the merge button can offer. */
export type MergeCheck = MergePlan['kind']

/** What a check found: the plan's kind, and the conflicting paths when it is a conflict. */
export interface MergeCheckResult {
  readonly check: MergeCheck
  readonly conflictPaths: readonly string[]
}

/** {@link checkMerge} with the conflicting paths (the merge box lists them, review-parity F7). */
export async function checkMergeDetailed(raw: ObjectReader, input: MergeInput, budget = MERGE_READ_BUDGET): Promise<MergeCheckResult> {
  const out = await refusing(() => build(strictReader(raw, budget), input, false))
  if (out.kind === 'checked') return { check: out.check, conflictPaths: [] }
  if (out.kind === 'squash' || out.kind === 'fast-forward' || out.kind === 'merge') return { check: out.kind === 'squash' ? 'merge' : out.kind, conflictPaths: [] }
  return { check: out.kind, conflictPaths: out.kind === 'conflict' ? out.paths : [] }
}

/**
 * Whether (and how) the PR merges: the whole merge and pack walk, without building the pack,
 * so a check that says "merge" is one {@link runMerge} completes.
 */
export async function checkMerge(raw: ObjectReader, input: MergeInput, budget = MERGE_READ_BUDGET): Promise<MergeCheck> {
  return (await checkMergeDetailed(raw, input, budget)).check
}

/** Run the whole merge: classify, merge when needed, and build the pack. */
export async function runMerge(raw: ObjectReader, input: MergeInput, onProgress?: MergeProgress): Promise<MergeOutcome | Exclude<MergePlan, { kind: 'fast-forward' | 'merge' }>> {
  const out = await refusing(() => build(strictReader(raw), input, true, onProgress))
  if (out.kind === 'checked') throw new Error('the merge built no pack')
  return out
}

/** A refusal as a result: history git would reject, or a change the browser does not merge. */
async function refusing<T>(work: () => Promise<T>): Promise<T | { kind: 'malformed' | 'too-large'; reason: string }> {
  try {
    return await work()
  } catch (e) {
    if (e instanceof MalformedObjectError || e instanceof UnsupportedChangeError) return { kind: 'malformed', reason: e.message }
    if (e instanceof ReadBudgetError || e instanceof WalkLimitError || e instanceof MergeBaseSearchLimitError) return { kind: 'too-large', reason: e.message }
    throw e
  }
}

async function build(
  reader: ObjectReader,
  input: MergeInput,
  pack: boolean,
  onProgress?: MergeProgress,
): Promise<MergeOutcome | { kind: 'checked'; check: 'fast-forward' | 'merge' } | Exclude<MergePlan, { kind: 'fast-forward' | 'merge' | 'malformed' | 'too-large' }>> {
  onProgress?.('analyse')
  const plan = await planMerge(reader, input)
  if (plan.kind === 'up-to-date' || plan.kind === 'unrelated' || plan.kind === 'conflict') return plan
  let tip: string
  let source = reader
  if (input.squash !== undefined) {
    // One commit on the base tip with the merged tree (the head's own when it descends).
    onProgress?.('merge')
    let tree: string
    let extra: GitObject[] = []
    if (plan.kind === 'fast-forward') tree = parseCommit((await reader.readObject(input.headOid)).bytes).tree
    else {
      const t = async (c: string): Promise<string> => parseCommit((await reader.readObject(c)).bytes).tree
      const [b, o, h] = await Promise.all([t(plan.mergeBase), t(input.baseTip), t(input.headOid)])
      const merged = await mergeTrees(reader, b, o, h)
      if (merged.kind === 'conflict') return merged
      tree = merged.oid
      extra = merged.written
    }
    const bytes = squashCommitBytes(tree, input)
    tip = gitOidHex('commit', bytes)
    checkCommit(tip, bytes)
    source = withObjects(reader, [...extra, { type: 'commit', bytes }])
  } else if (plan.kind === 'fast-forward') {
    tip = plan.newTip
  } else {
    onProgress?.('merge')
    const merged = await disjointMerge(reader, input, plan.mergeBase)
    if (merged.kind === 'conflict') return merged
    tip = merged.oid
    source = merged.reader
  }
  onProgress?.('pack')
  // Every commit the base branch gains is walked — for the check too — against the base tip
  // alone: the walk is where fsck parity and the unsupported-change rules apply, and a
  // same-repo head's commits are new to the branch even though the repo's packs hold them.
  const baseHave = input.baseTip === '' ? [] : [input.baseTip]
  let objects = await objectsToPack(source, await newCommits(source, tip, baseHave))
  if (!pack) return { kind: 'checked', check: plan.kind }
  // A squash commit's only parent is the base tip: nothing of the head's history is pushed.
  // What the base repo's packs already hold is not packed again: for a same-repo PR the head's
  // history (a fast-forward to it packs nothing).
  if (input.headInBase && input.squash === undefined) objects = await objectsToPack(source, await newCommits(source, tip, [...baseHave, input.headOid]))
  const built = writePack(objects)
  onProgress?.('pack', `${built.objectCount} objects`)
  return { kind: input.squash !== undefined ? 'squash' : plan.kind, newTip: tip, pack: built.bytes, packHash: built.packHash, objectCount: built.objectCount }
}

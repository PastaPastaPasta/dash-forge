/**
 * The browser merge engine (`ux-dx-spec.md` §5.7): given the base branch's tip and a PR head,
 * decide how the PR merges and build the pack that makes it so:
 *
 *  - **Fast-forward** when the head descends from the base tip: the new tip is the head.
 *  - A **merge commit** when the two sides merge cleanly from their one merge base
 *    ({@link mergeTrees}): each path takes the side that changed it, and a text file both sides
 *    changed is merged line by line as git does (`merge3.ts`, QW3-016), byte for byte git's
 *    result. Whatever git would conflict on — and the few things only git merges (renames, a
 *    directory one side removed, a criss-cross history with more than one merge base) — is
 *    refused as a conflict, and `dg pr merge` does it. The merge commit is authored and
 *    committed by the merger, message `Merge pull request #<n> from <source>` (or the
 *    merger's own, review-parity M2).
 *  - A **rebase** (`rebase.ts`): the PR's commits replayed on the base tip as `git rebase`
 *    replays them, each authored as before and committed by the merger.
 *  - The **pack**: every object reachable from the new tip that the base repo does not hold,
 *    as a non-thin pack (see `objects.ts`, `pack-writer.ts`).
 *
 * Every commit and tree read is checked as `git fsck --strict` would ({@link strictReader}),
 * and the pack walk runs for fast-forwards and merges alike, so {@link checkMerge} and
 * {@link runMerge} always agree. Pure apart from its object reads, so it runs the same in a
 * Web Worker and in tests.
 */

import { gitOidHex, MODE_TREE, ObjectTooLargeError, type GitObject } from '../browse'
import { checkCommit, checkTree, MalformedObjectError, MAX_TREE_DEPTH, parseCommit, parseTree, serializeTree, specialFileName, treeTooDeep, type TreeEntry } from '../view/git-objects'
import { branchName, plural } from '../view/format'
import { findMergeBases, MergeBaseSearchLimitError } from '../view/pull-diff'
import type { ObjectReader } from '../view/tree-nav'
import { isLegalRefName } from '../rules'
import { newCommits, objectsToPack, UnsupportedChangeError, WalkLimitError } from './objects'
import { merge3, MERGE3_MAX_BYTES } from './merge3'
import { rebaseCommits } from './rebase'
import { writePack } from './pack-writer'
import type { PackEstimate } from '../storage/merge-choice'

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
  /** How the PR's source is named in the subject: {@link mergeSourceLabel}. */
  readonly sourceLabel: string
  /** The PR title, the message body. */
  readonly title?: string
  /**
   * The merge commit's message as the merger edited it (review-parity M2, `dg pr merge --message`);
   * absent: {@link mergeMessage}. Written as `git commit-tree -m` writes it ({@link commitMessage}).
   */
  readonly message?: string
  readonly author: MergeIdentity
  /**
   * Whether the head's objects are already in the base repo's packs (a same-repo PR): then
   * the head, like the base tip, is something the base repo "has".
   */
  readonly headInBase: boolean
  /**
   * Squash (review-parity M1): one commit on the base tip whose tree is the merged tree (the
   * head's own when the base is behind it), message {@link squashMessage} — parity with
   * `dg pr merge --squash`. Absent: fast-forward when possible, else a merge commit. `author`:
   * the squash commit's author ({@link squashAuthor}: the PR's author by its oldest commit, as
   * GitHub credits a squash; QW4-008), the merger ({@link MergeInput.author}) committing it;
   * absent: the merger is both.
   */
  readonly squash?: { readonly message: string; readonly author?: { readonly name: string; readonly email: string } }
  /**
   * Always a merge commit (`git merge --no-ff`, GitHub's "Create a merge commit"; QW-069): when
   * the head descends from the base tip, a commit with the head's tree and parents base tip then
   * head, instead of a fast-forward. Ignored with {@link squash}, and on an empty base.
   */
  readonly noFastForward?: true
  /**
   * Rebase and merge (review-parity M1, `dg pr merge --rebase`): the PR's commits replayed on the
   * base tip ({@link rebaseCommits}), authors kept, the merger ({@link MergeInput.author})
   * committing each. A head on the base tip with a linear history fast-forwards, as git leaves
   * it. Ignored with {@link squash}.
   */
  readonly rebase?: true
}

/** A merge the engine can make, before its pack is built. */
export type MergePlan =
  | { readonly kind: 'fast-forward'; readonly newTip: string }
  | { readonly kind: 'merge'; readonly mergeBase: string }
  /**
   * git would conflict, or only git merges it (renames, a moved directory, binary or very large
   * files; or the history has several merge bases): `paths` says where, when known.
   */
  | { readonly kind: 'conflict'; readonly paths: readonly string[]; readonly reason?: string }
  /** A commit or tree fsck would refuse, or a change only the CLI merges: nothing is merged in the browser. */
  | { readonly kind: 'malformed'; readonly reason: string }
  /** Past a walk or read limit: too large to merge in a tab. */
  | { readonly kind: 'too-large'; readonly reason: string }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'unrelated' }

/** A merge ready to push. */
export interface MergeOutcome {
  readonly kind: 'fast-forward' | 'merge' | 'squash' | 'rebase'
  readonly newTip: string
  readonly pack: Uint8Array
  readonly packHash: string
  readonly objectCount: number
}

export type MergeProgress = (phase: 'analyse' | 'merge' | 'pack', detail?: string) => void

/**
 * The merge commit subject's source label, as `dg pr merge` names it: the source ref's short
 * branch name (`feature/x`, not `refs/heads/feature/x`) — closer to GitHub's `owner/branch`
 * (Forge has no login to put before the branch) — when the PR author wrote a legal ref name,
 * else the head oid.
 */
export function mergeSourceLabel(sourceRefName: string | null, headOid: string): string {
  return sourceRefName !== null && isLegalRefName(sourceRefName) ? branchName(sourceRefName) : headOid
}

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

/** A regular file's mode (`100644` or `100755`): the only entries whose contents merge. */
const isRegular = (e: Entry | undefined): e is Entry => e !== undefined && (e.mode === 0o100644 || e.mode === 0o100755)

/**
 * The tree a three-way merge makes, over `reader`: `ours` and `theirs` as changed from `base`
 * (root tree oids), as `merge-ort` merges them where it needs no rename detection. Walked name
 * by name:
 *
 *  - unchanged on a side → the other side's entry (a deletion included);
 *  - changed on both → directories on both sides (or new on both as directories) merge the same
 *    way one level down; a file (any non-directory) in all three that both sides changed the same
 *    way is taken (ort's "sides match"); a regular file in all three that both changed is merged:
 *    its mode as ort merges modes (a side that kept the base's mode takes the other's), its
 *    contents line by line ({@link merge3}) unless a side kept the base's blob. Anything else —
 *    a file added on both sides, a symlink or submodule changed differently, a file on one side
 *    where the other changed the directory it replaced, anything under a directory one side
 *    removed entirely (a directory rename, to git), a delete on one side and a change on the
 *    other (perhaps a rename), two changed directories that came out identical, lines that
 *    conflict, a binary or very large file — is a conflict at that path.
 *  - Contents are merged only where no `.gitattributes` sits in the path's directory or above it
 *    in any of the three trees: a merge driver (`merge=union`, `binary`, `-merge`) would change
 *    git's answer.
 *
 * Whatever this merges, `git merge-tree --write-tree` merges cleanly to the identical tree (the
 * git-parity suite); whatever git conflicts on, this refuses. A merged directory left with no
 * entries (each side deleted different files of it) is dropped from its parent, as git does; an
 * empty root is written as the empty tree. Returns the merged root oid and the trees and blobs
 * it wrote (bytes as git writes them), or the conflicting paths.
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
  // A blob over merge3's limit is refused on its first bytes, not downloaded whole (null).
  const blob = async (oid: string): Promise<Uint8Array | null> => {
    const obj = await reader.readObject(oid, { maxBytes: MERGE3_MAX_BYTES }).catch((e: unknown) => {
      if (e instanceof ObjectTooLargeError) return null
      throw e
    })
    if (obj === null) return null
    if (obj.type !== 'blob') throw new MalformedObjectError(oid, `a ${obj.type} where a file was expected`)
    return obj.bytes.length > MERGE3_MAX_BYTES ? null : obj.bytes
  }
  /** A text merge's three sides when all three changed, read together. */
  const contentSides = (bb: Entry | undefined, oo: Entry | undefined, tt: Entry | undefined): [string, string, string] | null =>
    isRegular(bb) && isRegular(oo) && isRegular(tt) && oo.oid !== tt.oid && oo.oid !== bb.oid && tt.oid !== bb.oid ? [bb.oid, oo.oid, tt.oid] : null
  const isTree = (e: Entry | undefined): e is Entry => e !== undefined && e.mode === MODE_TREE
  const conflict = (prefix: string): null => {
    conflicts.push(prefix === '' ? '/' : prefix.slice(0, -1))
    return null
  }
  /** A file in all three that both sides changed: the merged entry, or null for a conflict. */
  const mergeFile = async (bb: Entry, oo: Entry, tt: Entry, attributes: boolean, blobs: Map<string, Promise<Uint8Array | null>>): Promise<Entry | null> => {
    // ort's "sides match": the same change on both sides.
    if (same(oo, tt)) return oo
    if (!isRegular(bb) || !isRegular(oo) || !isRegular(tt)) return null
    // `handle_content_merge`'s mode merge (with only the two regular modes it is always clean).
    const mode = oo.mode === tt.mode || oo.mode === bb.mode ? tt.mode : oo.mode
    if (oo.oid === tt.oid || oo.oid === bb.oid) return { mode, oid: tt.oid }
    if (tt.oid === bb.oid) return { mode, oid: oo.oid }
    if (attributes) return null
    const [b, o, t] = await Promise.all([bb.oid, oo.oid, tt.oid].map((oid) => blobs.get(oid) ?? blob(oid)))
    if (b == null || o == null || t == null) return null
    const merged = merge3(b, o, t)
    if (merged.kind !== 'clean') return null
    written.push({ type: 'blob', bytes: merged.bytes })
    return { mode, oid: gitOidHex('blob', merged.bytes) }
  }
  // Returns the merged tree's oid, EMPTY when the merge leaves it with no entries, or null
  // once a conflict was recorded at or below `prefix`. `attributesAbove`: a `.gitattributes`
  // in a directory above this one (in any of the three trees).
  const walk = async (b: string | undefined, o: string, t: string, prefix: string, depth: number, attributesAbove: boolean): Promise<string | typeof EMPTY | null> => {
    if (b === o) return t
    if (b === t) return o
    // Two directories changed into the same tree: ort may still detect renames under them.
    if (o === t) return conflict(prefix)
    if (depth > MAX_TREE_DEPTH) throw treeTooDeep(o)
    const [be, oe, te] = await Promise.all([entries(b), entries(o), entries(t)])
    // A side that emptied this directory removed every entry of it: whatever the other side
    // changed here overlaps (git would call it a directory rename or a delete/modify).
    if (oe.size === 0 || te.size === 0) return conflict(prefix)
    const attributes = attributesAbove || [be, oe, te].some((m) => [...m.keys()].some((n) => specialFileName(n) === 'gitattributes'))
    // Every file here both sides changed is read at once, not one round trip after another.
    const blobs = new Map<string, Promise<Uint8Array | null>>()
    if (!attributes) {
      for (const name of oe.keys()) {
        for (const oid of contentSides(be.get(name), oe.get(name), te.get(name)) ?? []) if (!blobs.has(oid)) blobs.set(oid, blob(oid))
      }
      // A refused read surfaces where the merge reads it, not as an unhandled rejection.
      for (const p of blobs.values()) p.catch(() => undefined)
    }
    const out: TreeEntry[] = []
    let clean = true
    for (const name of new Set([...be.keys(), ...oe.keys(), ...te.keys()])) {
      const [bb, oo, tt] = [be.get(name), oe.get(name), te.get(name)]
      const path = `${prefix}${name}`
      let pick: Entry | undefined
      if (same(oo, bb)) pick = tt
      else if (same(tt, bb)) pick = oo
      else if (isTree(oo) && isTree(tt) && (bb === undefined || isTree(bb))) {
        const sub = await walk(bb?.oid, oo.oid, tt.oid, `${path}/`, depth + 1, attributes)
        if (sub === null) {
          clean = false
          continue
        }
        // Emptied by the two sides' deletions together: the directory goes, as in git.
        if (sub === EMPTY) continue
        pick = { mode: MODE_TREE, oid: sub }
      } else {
        const file = bb !== undefined && oo !== undefined && tt !== undefined && !isTree(bb) && !isTree(oo) && !isTree(tt) ? await mergeFile(bb, oo, tt, attributes, blobs) : null
        if (file === null) {
          conflicts.push(path)
          clean = false
          continue
        }
        pick = file
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
  const root = await walk(base, ours, theirs, '', 0, false)
  if (root === null) return { kind: 'conflict', paths: conflicts }
  if (root === EMPTY) {
    const bytes = new Uint8Array(0)
    return { kind: 'merged', oid: gitOidHex('tree', bytes), written: [{ type: 'tree', bytes }] }
  }
  return { kind: 'merged', oid: root, written }
}

/**
 * An ident line git's checks accept with none relaxed (`fsck_ident`): no stray `<`/`>`, one
 * space before the email and the date, a date without leading zeros, a `±hhmm` zone. History
 * the merge reads may break these (they are warnings, as for `git clone`); what it writes may not.
 */
const STRICT_IDENT = /^[^<>\n]* <[^<>\n]*> (0|[1-9]\d{0,17}) [+-]\d{4}$/

/** `Name <email> <seconds> <±hhmm>` for a git commit header. */
export function identLine(who: MergeIdentity): string {
  const when = who.timestamp ?? Math.floor(Date.now() / 1000)
  // The offset in force at that moment (daylight saving differs across the year).
  const offset = who.timezoneOffset ?? new Date(when * 1000).getTimezoneOffset()
  const east = -offset
  const abs = Math.abs(east)
  const tz = `${east < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
  const line = `${who.name} <${who.email}> ${when} ${tz}`
  if (!STRICT_IDENT.test(line)) {
    throw new MalformedObjectError('0'.repeat(40), `the merge identity ${JSON.stringify(line)} is not one git accepts`)
  }
  return line
}

/**
 * A squash commit's message (review-parity M1), as `dg pr merge --squash` writes it: the PR title
 * with its number, the body, and a `Co-authored-by` trailer for each commit author other than the
 * squash commit's own author (`authors`: `Name <email>` of the PR's commits, oldest first, each
 * once; `author`: {@link squashAuthor}'s, else the merger's).
 */
export function squashMessage(title: string, body: string, number: number, authors: readonly string[], author: string): string {
  // One line of title: the PR author wrote it (it cannot forge trailers or headers). dg uses the
  // raw title; a title holding a newline is the only case where the two differ, deliberately.
  let m = `${title.replace(/[\r\n\0]+/g, ' ').trim()} (#${number})`
  if (body.trim() !== '') m += `\n\n${body.replace(/\s+$/, '')}`
  // Compared as git writes them (an author line with stray spaces is still the same person).
  const own = canonicalIdent(author)
  const co = authors.filter((a) => canonicalIdent(a) !== own)
  if (co.length > 0) m += `\n\n${co.map((a) => `Co-authored-by: ${a}`).join('\n')}`
  return m
}

/** The PR's commit authors for a squash: loading (null), read (`complete` false: the list was capped), or unreadable. */
export type SquashAuthors = { readonly authors: readonly string[]; readonly complete: boolean } | { readonly error: string } | null

/** `Name <email>` split, when it makes an ident line git accepts (no stray `<`, `>` or newline). */
/** git's `crud()` (ident.c; `.` is not one): what it strips from both ends of an ident's name and email. */
const CRUD = /^[\0-\x20,:;<>"\\']+|[\0-\x20,:;<>"\\']+$/g

/**
 * `Name <email>` as git writes it into a commit (`strbuf_addstr_without_crud` on each part), or
 * null when git would refuse it (an empty part after that, or a stray `<`, `>` or newline). dg's
 * `squash_identity` applies the same rule, so both write the same bytes.
 */
export function parseIdent(line: string): { name: string; email: string } | null {
  const m = /^([^<>\n]*) <([^<>\n]*)>$/.exec(line)
  if (m === null) return null
  const name = (m[1] ?? '').replace(CRUD, '')
  const email = (m[2] ?? '').replace(CRUD, '')
  return name === '' || email === '' ? null : { name, email }
}

/** An author line in the form git writes it, for comparing two of them (the raw line when unparsable). */
function canonicalIdent(line: string): string {
  const who = parseIdent(line)
  return who === null ? line : `${who.name} <${who.email}>`
}

/**
 * Who a squash commit is authored by (QW4-008): the PR's author, as GitHub credits a squash, by the
 * author of its oldest commit (the first of `authors`) — the merger only commits it. Null (the
 * merger authors it) while the commits are unread or unreadable, when the list was capped (its
 * first entry is then not the oldest commit), or for an ident git would refuse.
 */
export function squashAuthor(authors: SquashAuthors): { name: string; email: string } | null {
  if (authors === null || 'error' in authors || !authors.complete) return null
  const first = authors.authors[0]
  return first === undefined ? null : parseIdent(first)
}

/**
 * The squash message box's state. The default waits for the authors (a squash made before would
 * drop their credit); a commit list that cannot be read gives a default without them, with a
 * warning, instead of waiting forever. `edited` (the merger's text) wins once typed. `problem`
 * says why "Squash and merge" is disabled, or null. `author` is the squash commit's author
 * ({@link squashAuthor}; null: the merger, `merger` as `Name <email>`), whom the default does
 * not list again as a co-author.
 */
export function squashDraft(
  pr: { readonly title: string; readonly body: string; readonly number: number },
  authors: SquashAuthors,
  merger: string,
  edited: string | null,
): { message: string; ready: boolean; warning: string | null; problem: string | null; author: { name: string; email: string } | null } {
  const author = squashAuthor(authors)
  const authorLine = author === null ? merger : `${author.name} <${author.email}>`
  const fallback = authors === null ? null : squashMessage(pr.title, pr.body, pr.number, 'error' in authors ? [] : authors.authors, authorLine)
  const ready = edited !== null || fallback !== null
  const message = edited ?? fallback ?? ''
  const warning =
    authors !== null && 'error' in authors
      ? `The PR's commits could not be read (${authors.error}), so you are the commit's author and the message has no Co-authored-by lines: add them by hand, or squash with \`dg pr merge --squash\` to credit the PR's author.`
      : authors !== null && !authors.complete
        ? "This PR has more commits than the page lists, so its first commit's author is not known here: you are the commit's author. Add any missing Co-authored-by lines, or squash with `dg pr merge --squash` to credit the PR's author."
        : null
  const problem = !ready ? "Reading the PR's commits for the Co-authored-by lines…" : message.trim() === '' ? 'Write a commit message to squash and merge.' : null
  return { message, ready, warning, problem, author }
}

/**
 * The squash commit's bytes: the tree, the base tip as its only parent, the PR's author
 * (`squash.author`, at the merge's time) as author and the merger as committer — the merger as
 * both when no author was given.
 */
export function squashCommitBytes(tree: string, input: MergeInput): Uint8Array {
  // One moment for both lines (the clock is read once).
  const at = { ...input.author, timestamp: input.author.timestamp ?? Math.floor(Date.now() / 1000) }
  const committer = identLine(at)
  const by = input.squash?.author
  const author = by === undefined ? committer : identLine({ ...at, name: by.name, email: by.email })
  const parents = input.baseTip === '' ? '' : `parent ${input.baseTip}\n`
  return new TextEncoder().encode(`tree ${tree}\n${parents}author ${author}\ncommitter ${committer}\n\n${commitMessage(input.squash?.message ?? '')}`)
}

/** The merge commit's bytes: the merged tree, parents base tip then head, the merger as author and committer. */
export function mergeCommitBytes(tree: string, input: MergeInput): Uint8Array {
  const ident = identLine(input.author)
  const message = input.message !== undefined ? commitMessage(input.message) : mergeMessage(input.prNumber, input.sourceLabel, input.title)
  const text = `tree ${tree}\nparent ${input.baseTip}\nparent ${input.headOid}\nauthor ${ident}\ncommitter ${ident}\n\n${message}`
  return new TextEncoder().encode(text)
}

/**
 * A message the merger typed, as `git commit-tree -m` (what `dg pr merge --message` runs) writes
 * it: NULs dropped (git refuses them), a final newline added when missing.
 */
export function commitMessage(raw: string): string {
  const message = raw.replace(/\0/g, '')
  return message.endsWith('\n') ? message : `${message}\n`
}

/** `reader` with some objects added in memory (what the merge wrote). */
function withObjects(reader: ObjectReader, objects: readonly GitObject[]): ObjectReader {
  const extra = new Map(objects.map((o) => [gitOidHex(o.type, o.bytes), o]))
  return { readObject: async (oid) => extra.get(oid) ?? reader.readObject(oid) }
}

/** The merge commit over `reader`, with every object it created, or the conflicting paths. */
export async function threeWayMerge(
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
    readObject: async (oid, options) => {
      seen.add(oid)
      if (seen.size > budget) throw new ReadBudgetError(budget)
      const obj = await reader.readObject(oid, options)
      if (obj.type === 'commit') checkCommit(oid, obj.bytes)
      else if (obj.type === 'tree') checkTree(oid, obj.bytes)
      return obj
    },
    ...(reader.locate ? { locate: async (oid: string) => (await reader.locate?.(oid)) ?? null } : {}),
  }
}

/** What the merge button can offer. */
export type MergeCheck = MergePlan['kind']

/** What a check found: the plan's kind, and the conflicting paths when it is a conflict. */
export interface MergeCheckResult {
  readonly check: MergeCheck
  readonly conflictPaths: readonly string[]
  /** Why it conflicts, when the paths do not say it (a rebase's refusals); else null. */
  readonly conflictReason: string | null
  /**
   * An upper bound on the pack the merge will store: its objects' raw bytes (a pack is zlib-
   * compressed, so never larger in practice) plus the pack framing, and its object count. The
   * check walks exactly these objects; null when it did not reach the pack step. Priced before
   * the merge starts, so its storage question is asked up front.
   */
  readonly packEstimate: PackEstimate | null
}

/** zlib's `deflateBound`: the most a zlib stream (with its 6-byte wrapper) can be for `n` input bytes. */
function zlibBound(n: number): number {
  return n + (n >>> 12) + (n >>> 14) + (n >>> 25) + 13 + 6
}

/**
 * A pack's size, bounded: the 12-byte header and 20-byte trailer, and per object up to 10 bytes
 * of entry header plus its zlib stream at its worst (incompressible blobs included).
 */
export function packSizeBound(objects: readonly { readonly bytes: Uint8Array }[]): number {
  return 32 + objects.reduce((n, o) => n + 10 + zlibBound(o.bytes.length), 0)
}

/** {@link checkMerge} with the conflicting paths (the merge box lists them, review-parity F7). */
export async function checkMergeDetailed(raw: ObjectReader, input: MergeInput, budget = MERGE_READ_BUDGET): Promise<MergeCheckResult> {
  const out = await refusing(() => build(strictReader(raw, budget), input, false))
  if (out.kind === 'checked') return { check: out.check, conflictPaths: [], conflictReason: null, packEstimate: out.packEstimate }
  if (out.kind === 'squash' || out.kind === 'rebase' || out.kind === 'fast-forward' || out.kind === 'merge') {
    return { check: out.kind === 'fast-forward' ? 'fast-forward' : 'merge', conflictPaths: [], conflictReason: null, packEstimate: { bytes: out.pack.length, objectCount: out.objectCount } }
  }
  return { check: out.kind, conflictPaths: out.kind === 'conflict' ? out.paths : [], conflictReason: out.kind === 'conflict' ? (out.reason ?? null) : null, packEstimate: null }
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
): Promise<
  | MergeOutcome
  | { kind: 'checked'; check: 'fast-forward' | 'merge'; packEstimate: PackEstimate }
  | Exclude<MergePlan, { kind: 'fast-forward' | 'merge' | 'malformed' | 'too-large' }>
> {
  onProgress?.('analyse')
  const plan = await planMerge(reader, input)
  if (plan.kind === 'up-to-date' || plan.kind === 'unrelated' || plan.kind === 'conflict') return plan
  let tip: string
  let source = reader
  // What the base gains: a fast-forward, unless --no-ff makes it a merge commit (or a rebase
  // rewrites the PR's commits).
  let kind: 'fast-forward' | 'merge' | 'rebase' = plan.kind
  if (input.rebase === true && input.squash === undefined && input.baseTip !== '') {
    onProgress?.('merge')
    const rebased = await rebaseCommits(reader, input.baseTip, input.headOid, plan.kind === 'merge' ? plan.mergeBase : null, identLine(input.author), mergeTrees)
    if (rebased.kind === 'conflict') return rebased
    if (rebased.kind === 'fast-forward') tip = input.headOid
    else {
      tip = rebased.tip
      source = rebased.reader
      kind = 'rebase'
    }
  } else if (input.squash !== undefined) {
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
  } else if (plan.kind === 'fast-forward' && (input.noFastForward !== true || input.baseTip === '')) {
    tip = plan.newTip
  } else if (plan.kind === 'fast-forward') {
    // --no-ff onto a base the head descends from: nothing to merge, the head's tree is the result.
    onProgress?.('merge')
    const bytes = mergeCommitBytes(parseCommit((await reader.readObject(input.headOid)).bytes).tree, input)
    tip = gitOidHex('commit', bytes)
    checkCommit(tip, bytes)
    source = withObjects(reader, [{ type: 'commit', bytes }])
    kind = 'merge'
  } else {
    onProgress?.('merge')
    const merged = await threeWayMerge(reader, input, plan.mergeBase)
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
  // The check sizes what it walked: at least what the merge packs (a same-repo head's history is
  // then left out of the pack), so an upper bound.
  if (!pack) return { kind: 'checked', check: kind === 'fast-forward' ? 'fast-forward' : 'merge', packEstimate: { bytes: packSizeBound(objects), objectCount: objects.length } }
  // A squash commit's only parent is the base tip, and a rebase's commits are new: nothing of the
  // head's history is pushed. What the base repo's packs already hold is not packed again: for a
  // same-repo PR the head's history (a fast-forward to it packs nothing).
  if (input.headInBase && input.squash === undefined && kind !== 'rebase') objects = await objectsToPack(source, await newCommits(source, tip, [...baseHave, input.headOid]))
  const built = writePack(objects)
  onProgress?.('pack', plural(built.objectCount, 'object'))
  return { kind: input.squash !== undefined ? 'squash' : kind, newTip: tip, pack: built.bytes, packHash: built.packHash, objectCount: built.objectCount }
}

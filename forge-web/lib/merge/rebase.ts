/**
 * The browser's rebase merge (review-parity M1, P1-2): the PR's commits replayed one by one on
 * the base tip, as `git rebase --merge <base tip>` replays them (what `dg pr merge --rebase`
 * runs), so the browser writes the same commits git writes, byte for byte, for a given committer
 * and time (the git-parity suite, `rebase.parity.test.ts`):
 *
 *  - a head on top of the base tip with a linear history is left as it is (git: "Current branch
 *    is up to date"): the base fast-forwards to it;
 *  - otherwise each commit of `merge base..head`, oldest first, is cherry-picked onto the last:
 *    a three-way merge ({@link mergeTrees}) of its parent's tree, the tip so far and its own tree.
 *    The author line and the message are the commit's own (the message from its first non-blank
 *    line, as the sequencer copies it); the merger commits. Signatures and other extra headers
 *    are dropped, as git drops them. A commit that started empty is kept; one that becomes
 *    empty (the base already holds its change) is dropped, as `--empty=drop` does.
 *
 * Refused, so `dg pr merge --rebase` (real git) does it instead: a merge commit in the PR's
 * history (git linearises it), a conflict or anything {@link mergeTrees} leaves to git, a commit
 * with an `encoding` header (git re-encodes its message), more than {@link REBASE_MAX_COMMITS}
 * commits, and a PR commit whose change may already be on the base: git skips a commit whose
 * patch-id matches one of the base's, and the browser does not compute patch-ids, so any base
 * commit that changes the same files with the same lines (whitespace aside) is a refusal.
 */

import { gitOidHex, MODE_TREE, ObjectTooLargeError, type GitObject } from '../browse'
import { concat } from '../private/bytes'
import { checkCommit, MalformedObjectError, MAX_TREE_DEPTH, parseCommit, parseTree, treeTooDeep, type TreeEntry } from '../view/git-objects'
import type { ObjectReader } from '../view/tree-nav'
import { MERGE3_MAX_BYTES } from './merge3'
import { newCommits, WalkLimitError } from './objects'

/** The most commits a browser rebase replays; past it, `dg pr merge --rebase`. */
export const REBASE_MAX_COMMITS = 250

/** Where a rebase stops, and why, for the merge box (`paths`: where it conflicts, when known). */
export interface RebaseRefusal {
  readonly kind: 'conflict'
  readonly paths: readonly string[]
  readonly reason: string
}

export type RebaseResult =
  /** The head is on top of the base tip with a linear history: git leaves it, the base fast-forwards. */
  | { readonly kind: 'fast-forward' }
  /** The replayed commits: the new tip, and a reader that also reads what the replay wrote. */
  | { readonly kind: 'rebased'; readonly tip: string; readonly reader: ObjectReader }
  | RebaseRefusal

/** The engine's `mergeTrees`, passed in (the engine imports this file). */
export type MergeTreesFn = (
  reader: ObjectReader,
  base: string,
  ours: string,
  theirs: string,
) => Promise<{ kind: 'merged'; oid: string; written: GitObject[] } | { kind: 'conflict'; paths: string[] }>

const short = (oid: string): string => oid.slice(0, 7)
const latin1 = new TextDecoder('latin1')

type Entry = Pick<TreeEntry, 'mode' | 'oid'>

/** A commit split as the sequencer reads it. */
interface PickedCommit {
  readonly oid: string
  readonly tree: string
  readonly parent: string
  /** The `author` line's value, raw bytes (copied verbatim). */
  readonly author: Uint8Array
  /** The message from its first non-blank line (`skip_blank_lines`), raw bytes. */
  readonly message: Uint8Array
  readonly encoding: boolean
}

/** git's `isspace` (`sane_ctype`): tab, LF, CR and space only. */
const isGitSpace = (b: number): boolean => b === 0x09 || b === 0x0a || b === 0x0d || b === 0x20

/** `skip_blank_lines` (pretty.c): drop leading lines made only of git whitespace. */
function skipBlankLines(msg: Uint8Array): Uint8Array {
  let at = 0
  while (at < msg.length) {
    const nl = msg.indexOf(0x0a, at)
    const end = nl === -1 ? msg.length : nl + 1
    for (let i = at; i < end; i++) if (!isGitSpace(msg[i] as number)) return msg.subarray(at)
    at = end
  }
  return msg.subarray(at)
}

/** Split a (checked) commit: its parents, author line, extra headers and message. */
function splitCommit(oid: string, bytes: Uint8Array): PickedCommit & { readonly parents: readonly string[] } {
  let sep = -1
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      sep = i
      break
    }
  }
  if (sep === -1) throw new MalformedObjectError(oid, 'no blank line after the header')
  // latin1 is one char per byte: an index in the text is the same index in the bytes.
  const header = latin1.decode(bytes.subarray(0, sep))
  const c = parseCommit(bytes)
  let author: Uint8Array | null = null
  let encoding = false
  let at = 0
  for (const line of header.split('\n')) {
    if (line.startsWith('author ') && author === null) author = bytes.subarray(at + 7, at + line.length)
    else if (line.startsWith('encoding ')) encoding = true
    at += line.length + 1
  }
  if (author === null) throw new MalformedObjectError(oid, 'no author line')
  return { oid, tree: c.tree, parent: c.parents[0] ?? '', parents: c.parents, author, message: skipBlankLines(bytes.subarray(sep + 2)), encoding }
}

/** A path trie: children by name; the `''` key marks a path in the set. */
type Trie = Map<string, Trie>

function trieOf(paths: Iterable<string>): Trie {
  const root: Trie = new Map()
  for (const p of paths) {
    let node = root
    for (const name of p.split('/')) {
      let next = node.get(name)
      if (next === undefined) node.set(name, (next = new Map()))
      node = next
    }
    node.set('', new Map())
  }
  return root
}

/** A file-level change: the entry before and after (absent: added or deleted). */
type Changes = Map<string, { readonly from: Entry | undefined; readonly to: Entry | undefined }>

/**
 * The file-level changes from tree `a` to tree `b` (either absent: empty), as a diff without
 * rename detection lists them. With `within`, null as soon as a change falls outside its paths.
 */
async function treeChanges(reader: ObjectReader, a: string | undefined, b: string | undefined, within: Trie | null): Promise<Changes | null> {
  const out: Changes = new Map()
  const entries = async (oid: string | undefined): Promise<Map<string, Entry>> => {
    if (oid === undefined) return new Map()
    const obj = await reader.readObject(oid)
    if (obj.type !== 'tree') throw new MalformedObjectError(oid, `a ${obj.type} where a tree was expected`)
    return new Map(parseTree(obj.bytes).map((e) => [e.name, { mode: e.mode, oid: e.oid }]))
  }
  const walk = async (x: string | undefined, y: string | undefined, prefix: string, node: Trie | null, depth: number): Promise<boolean> => {
    if (x === y) return true
    if (depth > MAX_TREE_DEPTH) throw treeTooDeep(x ?? y ?? '')
    const [ex, ey] = await Promise.all([entries(x), entries(y)])
    for (const name of new Set([...ex.keys(), ...ey.keys()])) {
      const [from, to] = [ex.get(name), ey.get(name)]
      if (from?.mode === to?.mode && from?.oid === to?.oid) continue
      const child = node?.get(name) ?? null
      if (node !== null && child === null) return false
      const path = `${prefix}${name}`
      const fromTree = from?.mode === MODE_TREE ? from.oid : undefined
      const toTree = to?.mode === MODE_TREE ? to.oid : undefined
      if ((fromTree !== undefined || toTree !== undefined) && !(await walk(fromTree, toTree, `${path}/`, child, depth + 1))) return false
      const fileFrom = from?.mode === MODE_TREE ? undefined : from
      const fileTo = to?.mode === MODE_TREE ? undefined : to
      if (fileFrom === undefined && fileTo === undefined) continue
      if (child !== null && !child.has('')) return false
      out.set(path, { from: fileFrom, to: fileTo })
    }
    return true
  }
  return (await walk(a, b, '', within, 0)) ? out : null
}

/** The changed paths and their mode transitions: equal for two commits git could call the same patch. */
function shapeOf(changes: Changes): string {
  return [...changes]
    .map(([p, c]) => `${p}\0${c.from?.mode ?? 0}\0${c.to?.mode ?? 0}`)
    .sort()
    .join('\n')
}

/**
 * A fingerprint every two patches with the same patch-id share (not the reverse): per path, the
 * lines it gains minus the lines it loses, each with all whitespace removed (patch-id hashes the
 * diff's lines so; the lines a diff adds minus those it removes are the new file's lines minus
 * the old's, whichever diff git drew). Null when a file is too large to read: then it matches.
 */
async function lineFingerprint(reader: ObjectReader, changes: Changes): Promise<string | null> {
  const lines = async (e: Entry | undefined): Promise<string[] | null> => {
    if (e === undefined) return []
    // A gitlink's "content" is the commit it names.
    if (e.mode === 0o160000) return [e.oid]
    const obj = await reader.readObject(e.oid, { maxBytes: MERGE3_MAX_BYTES }).catch((err: unknown) => {
      if (err instanceof ObjectTooLargeError) return null
      throw err
    })
    if (obj === null || obj.bytes.length > MERGE3_MAX_BYTES) return null
    return latin1.decode(obj.bytes).split('\n')
  }
  const parts: string[] = []
  for (const [path, c] of [...changes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [from, to] = await Promise.all([lines(c.from), lines(c.to)])
    if (from === null || to === null) return null
    const count = new Map<string, number>()
    for (const l of to) count.set(l.replace(/\s+/g, ''), (count.get(l.replace(/\s+/g, '')) ?? 0) + 1)
    for (const l of from) count.set(l.replace(/\s+/g, ''), (count.get(l.replace(/\s+/g, '')) ?? 0) - 1)
    const net = [...count].filter(([, n]) => n !== 0).map(([l, n]) => `${n}:${l}`).sort()
    parts.push(`${path}\0${net.join('\0')}`)
  }
  return parts.join('\n')
}

/**
 * The first PR commit (of `picks`) whose change may already be on the base (`upstream`, the
 * base's commits since the merge base): git's rebase would skip it, so the browser refuses. Each
 * PR commit is compared only with base commits that change exactly its paths, with the same modes.
 */
async function alreadyUpstream(reader: ObjectReader, picks: readonly { oid: string; changes: Changes }[], upstream: readonly string[]): Promise<{ pick: string; base: string } | null> {
  const byShape = new Map<string, { oid: string; changes: Changes }[]>()
  for (const p of picks) {
    const k = shapeOf(p.changes)
    byShape.set(k, [...(byShape.get(k) ?? []), p])
  }
  if (byShape.size === 0) return null
  const within = trieOf(picks.flatMap((p) => [...p.changes.keys()]))
  const prints = new Map<string, Promise<string | null>>()
  const print = (oid: string, changes: Changes): Promise<string | null> => {
    let p = prints.get(oid)
    if (p === undefined) prints.set(oid, (p = lineFingerprint(reader, changes)))
    return p
  }
  for (const u of upstream) {
    const c = parseCommit((await reader.readObject(u)).bytes)
    // The sequencer's walk skips merges (`max_parents = 1`) on both sides.
    if (c.parents.length > 1) continue
    const parentTree = c.parents[0] === undefined ? undefined : parseCommit((await reader.readObject(c.parents[0])).bytes).tree
    const changes = await treeChanges(reader, parentTree, c.tree, within)
    if (changes === null || changes.size === 0) continue
    const same = byShape.get(shapeOf(changes))
    if (same === undefined) continue
    const theirs = await print(u, changes)
    for (const p of same) {
      const ours = await print(p.oid, p.changes)
      if (ours === null || theirs === null || ours === theirs) return { pick: p.oid, base: u }
    }
  }
  return null
}

/**
 * Replay `headOid`'s commits since `mergeBase` onto `baseTip` (null `mergeBase`: the head
 * descends from the base tip). `committer`: the merger's `Name <email> <time> <zone>` line.
 */
export async function rebaseCommits(
  reader: ObjectReader,
  baseTip: string,
  headOid: string,
  mergeBase: string | null,
  committer: string,
  mergeTrees: MergeTreesFn,
): Promise<RebaseResult> {
  const stop = mergeBase ?? baseTip
  // The PR's commits, newest first: a linear run from the head down to `stop`.
  const chain: (PickedCommit & { readonly parents: readonly string[] })[] = []
  for (let at = headOid; at !== stop; ) {
    if (chain.length >= REBASE_MAX_COMMITS) throw new WalkLimitError(REBASE_MAX_COMMITS)
    const obj = await reader.readObject(at)
    if (obj.type !== 'commit') throw new MalformedObjectError(at, `a ${obj.type} where a commit was expected`)
    const c = splitCommit(at, obj.bytes)
    if (c.parents.length !== 1) {
      return {
        kind: 'conflict',
        paths: [],
        reason: c.parents.length > 1 ? `the PR's history holds a merge commit (${short(at)}), which only git's rebase flattens` : `the PR's history does not reach ${short(stop)}`,
      }
    }
    chain.push(c)
    at = c.parent
  }
  if (mergeBase === null) return { kind: 'fast-forward' }
  const picks = chain.reverse()
  const encoded = picks.find((p) => p.encoding)
  if (encoded !== undefined) return { kind: 'conflict', paths: [], reason: `commit ${short(encoded.oid)} names a message encoding, which git's rebase converts` }

  // Each commit's change, against its own parent (a commit that started empty has none).
  const treeOf = async (commit: string): Promise<string> => parseCommit((await reader.readObject(commit)).bytes).tree
  const changed: { oid: string; changes: Changes }[] = []
  for (const p of picks) {
    const parentTree = await treeOf(p.parent)
    if (parentTree === p.tree) continue
    changed.push({ oid: p.oid, changes: (await treeChanges(reader, parentTree, p.tree, null)) as Changes })
  }
  const upstream = await newCommits(reader, baseTip, [mergeBase])
  const dup = await alreadyUpstream(reader, changed, upstream)
  if (dup !== null) {
    return { kind: 'conflict', paths: [], reason: `commit ${short(dup.pick)} may already be on the base branch (as ${short(dup.base)}); git's rebase would skip it` }
  }

  // The replay: a reader over everything written so far, so the next pick reads the last tree.
  const extra = new Map<string, GitObject>()
  const over: ObjectReader = { readObject: async (oid, options) => extra.get(oid) ?? reader.readObject(oid, options) }
  const enc = new TextEncoder()
  let tip = baseTip
  let tipTree = await treeOf(baseTip)
  for (const p of picks) {
    const parentTree = await treeOf(p.parent)
    let tree = tipTree
    if (parentTree !== p.tree) {
      const merged = await mergeTrees(over, parentTree, tipTree, p.tree)
      if (merged.kind === 'conflict') return { kind: 'conflict', paths: merged.paths, reason: `commit ${short(p.oid)} does not apply cleanly on the base branch` }
      for (const o of merged.written) extra.set(gitOidHex(o.type, o.bytes), o)
      // Its change is already there: `--empty=drop` drops it.
      if (merged.oid === tipTree) continue
      tree = merged.oid
    }
    const bytes = concat(enc.encode(`tree ${tree}\nparent ${tip}\nauthor `), p.author, enc.encode(`\ncommitter ${committer}\n\n`), p.message)
    const oid = gitOidHex('commit', bytes)
    checkCommit(oid, bytes)
    extra.set(oid, { type: 'commit', bytes })
    tip = oid
    tipTree = tree
  }
  // Every commit was already on the base: nothing to merge.
  if (tip === baseTip) return { kind: 'conflict', paths: [], reason: "every commit's change is already on the base branch: there is nothing to rebase" }
  return { kind: 'rebased', tip, reader: over }
}

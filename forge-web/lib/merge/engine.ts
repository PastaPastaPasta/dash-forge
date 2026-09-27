/**
 * The browser merge engine (`ux-dx-spec.md` §5.7): given the base branch's tip and a PR head,
 * decide how the PR merges and build the pack that makes it so.
 *
 *  - **Fast-forward** when the head descends from the base tip: the new tip is the head.
 *  - Otherwise a **clean three-way merge** with isomorphic-git (merge base, tree merge, and a
 *    merge commit authored and committed by the merger, message
 *    `Merge pull request #<n> from <source>`). Conflicts are reported by path, and nothing is
 *    built.
 *  - The **pack**: every object reachable from the new tip that the base repo does not hold,
 *    as a non-thin pack (see `objects.ts`, `pack-writer.ts`).
 *
 * Pure apart from its object reads, so it runs the same in a Web Worker and in tests.
 */

import diff3Merge from 'diff3'

import { MODE_TREE } from '../browse'

import { checkCommit, checkTree, MalformedObjectError, parseCommit, parseTree } from '../view/git-objects'
import { findMergeBase } from '../view/pull-diff'
import type { ObjectReader } from '../view/tree-nav'
import { createMergeFs } from './git-fs'
import { newCommits, objectsToPack } from './objects'
import { writePack } from './pack-writer'

/** The largest file (in UTF-16 units, about bytes for text) merged line by line in the browser. */
export const TEXT_MERGE_MAX_CHARS = 1024 * 1024

/**
 * The line merge for files both sides changed: isomorphic-git's diff3, but refusing (as a
 * conflict) any file that is binary or not valid UTF-8 on any side. isomorphic-git hands the
 * driver the three versions decoded as UTF-8, so a NUL byte survives as U+0000 and an invalid
 * sequence becomes U+FFFD; merging those as text would commit a corrupted blob and call it
 * clean. Such files, and files over {@link TEXT_MERGE_MAX_CHARS}, are merged with the CLI.
 */
export function textOnlyMergeDriver({ branches, contents }: { branches: readonly string[]; contents: readonly string[] }): { cleanMerge: boolean; mergedText: string } {
  if (contents.some((c) => c.includes('\u0000') || c.includes('\ufffd'))) return { cleanMerge: false, mergedText: '' }
  // A file this large is merged with the CLI: a line merge in the browser could stall the tab.
  if (contents.some((c) => c.length > TEXT_MERGE_MAX_CHARS)) return { cleanMerge: false, mergedText: '' }
  const lines = (text: string): string[] => text.match(/^.*(\r?\n|$)/gm) ?? []
  const [base = '', ours = '', theirs = ''] = contents
  let mergedText = ''
  let cleanMerge = true
  for (const block of diff3Merge(lines(ours), lines(base), lines(theirs))) {
    if (block.ok) mergedText += block.ok.join('')
    else {
      cleanMerge = false
      mergedText += `<<<<<<< ${branches[1] ?? 'ours'}\n${block.conflict.a.join('')}=======\n${block.conflict.b.join('')}>>>>>>> ${branches[2] ?? 'theirs'}\n`
    }
  }
  return { cleanMerge, mergedText }
}

/** Who the merge commit is by (the merger's Settings name and email). */
export interface MergeIdentity {
  readonly name: string
  readonly email: string
  /** Seconds since the epoch; defaults to now. */
  readonly timestamp?: number
  /** Minutes, as `Date.getTimezoneOffset()` (isomorphic-git's convention); defaults to local. */
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
}

/** A merge the engine can make, before its pack is built. */
export type MergePlan =
  | { readonly kind: 'fast-forward'; readonly newTip: string }
  | { readonly kind: 'merge'; readonly mergeBase: string }
  | { readonly kind: 'conflict'; readonly paths: readonly string[] }
  /** A commit or tree fsck would refuse: nothing is merged in the browser. */
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'unrelated' }

/** A merge ready to push. */
export interface MergeOutcome {
  readonly kind: 'fast-forward' | 'merge'
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

interface ConflictData {
  readonly data?: { readonly filepaths?: readonly string[] }
  readonly code?: string
}

/**
 * Classify the merge (no objects written). `reader` must read both sides (the base repo's
 * objects, and the head's source repo's).
 */
export async function planMerge(reader: ObjectReader, input: Pick<MergeInput, 'baseTip' | 'headOid'>): Promise<Exclude<MergePlan, { kind: 'conflict' | 'malformed' }>> {
  const { baseTip, headOid } = input
  if (baseTip === '') return { kind: 'fast-forward', newTip: headOid }
  const base = await findMergeBase(reader, baseTip, headOid)
  if (base === null) return { kind: 'unrelated' }
  if (base === headOid) return { kind: 'up-to-date' }
  if (base === baseTip) return { kind: 'fast-forward', newTip: headOid }
  return { kind: 'merge', mergeBase: base }
}

/**
 * The merge commit (three-way, via isomorphic-git) over `reader`: its oid and every object it
 * created, or the conflicting paths.
 */
export async function threeWayMerge(
  reader: ObjectReader,
  input: MergeInput,
  mergeBase: string,
): Promise<{ kind: 'merge'; oid: string; reader: ObjectReader } | { kind: 'conflict'; paths: readonly string[] }> {
  const git = await import('isomorphic-git')
  const fs = createMergeFs(reader)
  const gitdir = '/.git'
  const p = fs.client.promises as unknown as {
    mkdir(path: string): Promise<void>
    writeFile(path: string, data: string): Promise<void>
  }
  await p.mkdir(gitdir)
  // A branch at the base tip for `ours`, and the head for `theirs`; nothing else is local.
  await p.writeFile(`${gitdir}/HEAD`, 'ref: refs/heads/base\n')
  await p.mkdir(`${gitdir}/refs`)
  await p.mkdir(`${gitdir}/refs/heads`)
  await p.mkdir(`${gitdir}/objects`)
  await p.mkdir(`${gitdir}/objects/pack`)
  await p.writeFile(`${gitdir}/refs/heads/base`, `${input.baseTip}\n`)
  await p.writeFile(`${gitdir}/refs/heads/head`, `${input.headOid}\n`)
  const who = {
    name: input.author.name,
    email: input.author.email,
    timestamp: input.author.timestamp ?? Math.floor(Date.now() / 1000),
    timezoneOffset: input.author.timezoneOffset ?? new Date().getTimezoneOffset(),
  }
  try {
    const r = await git.merge({
      fs: fs.client as unknown as Parameters<typeof git.merge>[0]['fs'],
      gitdir,
      ours: 'refs/heads/base',
      theirs: 'refs/heads/head',
      fastForward: false,
      noUpdateBranch: true,
      abortOnConflict: true,
      message: mergeMessage(input.prNumber, input.sourceLabel, input.title),
      author: who,
      committer: who,
      mergeDriver: textOnlyMergeDriver,
    })
    const underlying = fs.readError()
    if (underlying !== undefined) throw underlying
    if (r.oid === undefined) throw new Error('the merge produced no commit')
    const merged = parseCommit((await fs.reader.readObject(r.oid)).bytes).tree
    const trees = await Promise.all([input.baseTip, input.headOid, mergeBase].map(async (c) => parseCommit((await fs.reader.readObject(c)).bytes).tree))
    const refused = await auditMergedTree(fs.reader, merged, trees[0] as string, trees[1] as string, trees[2] as string)
    if (refused.length > 0) return { kind: 'conflict', paths: refused }
    return { kind: 'merge', oid: r.oid, reader: fs.reader }
  } catch (e) {
    // A read that failed underneath isomorphic-git surfaces as its own error, not "not found".
    const underlying = fs.readError()
    if (underlying !== undefined) throw underlying
    const err = e as ConflictData
    if (err.code === 'MergeConflictError') return { kind: 'conflict', paths: [...(err.data?.filepaths ?? [])] }
    // Conflicts isomorphic-git cannot express (add/add, file vs directory) come as this.
    if (err.code === 'MergeNotSupportedError') return { kind: 'conflict', paths: [] }
    throw e
  }
}

const MODE_LINK = 0o120000
const MODE_SUBMODULE = 0o160000

/** What an entry is, as git's merge compares them: a directory, a file (either file mode), a symlink, a submodule. */
function entryKind(mode: number): 'tree' | 'file' | 'link' | 'gitlink' {
  if (mode === MODE_TREE) return 'tree'
  if (mode === MODE_LINK) return 'link'
  if (mode === MODE_SUBMODULE) return 'gitlink'
  return 'file'
}

/**
 * Audit a tree isomorphic-git merged, against the merge base and both sides, before anything
 * is built from it. Returns the paths git would call conflicts that isomorphic-git merged:
 *
 *  - a path whose kind changed on one side (a file became a symlink, say) while the other side
 *    changed it too — git reports "CONFLICT (distinct types)", isomorphic-git merges the text;
 *  - a symlink or submodule entry that is neither side's (their targets are never merged).
 *
 * Every tree the merge wrote is also checked as fsck would ({@link checkTree}): isomorphic-git
 * orders entries by UTF-16, not git's bytes, so a merge the check offered never fails later.
 */
export async function auditMergedTree(reader: ObjectReader, merged: string, ours: string, theirs: string, base: string): Promise<string[]> {
  const conflicts: string[] = []
  const entries = async (oid: string | undefined): Promise<Map<string, { mode: number; oid: string }>> => {
    if (oid === undefined) return new Map()
    const obj = await reader.readObject(oid)
    if (obj.type !== 'tree') return new Map()
    return new Map(parseTree(obj.bytes).map((e) => [e.name, { mode: e.mode, oid: e.oid }]))
  }
  const walk = async (m: string, o: string | undefined, t: string | undefined, b: string | undefined, prefix: string): Promise<void> => {
    if (m === o || m === t) return // one side's tree unchanged: nothing merged below
    checkTree(m, (await reader.readObject(m)).bytes)
    const [me, oe, te, be] = await Promise.all([entries(m), entries(o), entries(t), entries(b)])
    const names = new Set([...me.keys(), ...oe.keys(), ...te.keys()])
    for (const name of names) {
      const path = `${prefix}${name}`
      const [mm, oo, tt, bb] = [me.get(name), oe.get(name), te.get(name), be.get(name)]
      const kinds = (x: { mode: number } | undefined): string => (x === undefined ? 'none' : entryKind(x.mode))
      const oursChanged = oo?.oid !== bb?.oid || oo?.mode !== bb?.mode
      const theirsChanged = tt?.oid !== bb?.oid || tt?.mode !== bb?.mode
      if (oursChanged && theirsChanged && oo !== undefined && tt !== undefined && kinds(oo) !== kinds(tt)) {
        conflicts.push(path)
        continue
      }
      if (mm === undefined) continue
      const special = mm.mode === MODE_LINK || mm.mode === MODE_SUBMODULE
      const isSide = (x: { mode: number; oid: string } | undefined): boolean => x !== undefined && x.mode === mm.mode && x.oid === mm.oid
      if (special && !isSide(oo) && !isSide(tt)) {
        conflicts.push(path)
        continue
      }
      if (mm.mode === MODE_TREE) {
        const sub = (x: { mode: number; oid: string } | undefined): string | undefined => (x !== undefined && x.mode === MODE_TREE ? x.oid : undefined)
        await walk(mm.oid, sub(oo), sub(tt), sub(bb), `${path}/`)
      }
    }
  }
  await walk(merged, ours, theirs, base, '')
  return conflicts
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
 * everything the merge reads — the history walks, isomorphic-git's tree merge, the pack
 * walk — sees only objects git and this client read the same way.
 */
export function strictReader(reader: ObjectReader, budget = MERGE_READ_BUDGET): ObjectReader {
  let reads = 0
  return {
    readObject: async (oid) => {
      // A small history can still name a huge number of paths (a tree DAG): cap the work.
      if (++reads > budget) throw new ReadBudgetError(budget)
      const obj = await reader.readObject(oid)
      if (obj.type === 'commit') checkCommit(oid, obj.bytes)
      else if (obj.type === 'tree') checkTree(oid, obj.bytes)
      return obj
    },
    ...(reader.locate ? { locate: (oid: string) => reader.locate?.(oid) ?? null } : {}),
  }
}

/** What the merge button can offer: the plan, with a three-way merge tried for conflicts. */
export type MergeCheck = 'fast-forward' | 'merge' | 'conflict' | 'malformed' | 'up-to-date' | 'unrelated'

export async function checkMerge(raw: ObjectReader, input: MergeInput, budget = MERGE_READ_BUDGET): Promise<MergeCheck> {
  const reader = strictReader(raw, budget)
  try {
    const plan = await planMerge(reader, input)
    if (plan.kind !== 'merge') return plan.kind
    return (await threeWayMerge(reader, input, plan.mergeBase)).kind
  } catch (e) {
    if (e instanceof MalformedObjectError) return 'malformed'
    throw e
  }
}

/** Run the whole merge: classify, merge when needed, and build the pack. */
export async function runMerge(raw: ObjectReader, input: MergeInput, onProgress?: MergeProgress): Promise<MergeOutcome | Extract<MergePlan, { kind: 'conflict' | 'malformed' | 'up-to-date' | 'unrelated' }>> {
  try {
    return await runStrict(strictReader(raw), input, onProgress)
  } catch (e) {
    if (e instanceof MalformedObjectError) return { kind: 'malformed', reason: e.message }
    throw e
  }
}

async function runStrict(reader: ObjectReader, input: MergeInput, onProgress?: MergeProgress): Promise<MergeOutcome | Extract<MergePlan, { kind: 'conflict' | 'up-to-date' | 'unrelated' }>> {
  onProgress?.('analyse')
  const plan = await planMerge(reader, input)
  if (plan.kind === 'up-to-date' || plan.kind === 'unrelated') return plan
  let tip: string
  let source = reader
  if (plan.kind === 'fast-forward') {
    tip = plan.newTip
  } else {
    onProgress?.('merge')
    const merged = await threeWayMerge(reader, input, plan.mergeBase)
    if (merged.kind === 'conflict') return merged
    tip = merged.oid
    source = merged.reader
  }
  onProgress?.('pack')
  // A fast-forward to a head the base repo already holds packs nothing (the tip is "had").
  const have = [input.baseTip, ...(input.headInBase ? [input.headOid] : [])].filter((o) => o !== '')
  const commits = await newCommits(source, tip, have)
  const objects = await objectsToPack(source, commits)
  const built = writePack(objects)
  onProgress?.('pack', `${built.objectCount} objects`)
  return { kind: plan.kind, newTip: tip, pack: built.bytes, packHash: built.packHash, objectCount: built.objectCount }
}

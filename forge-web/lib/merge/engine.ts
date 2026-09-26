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

import { hexToBytes } from '@noble/hashes/utils.js'

import type { GitObject } from '../browse'
import { findMergeBase } from '../view/pull-diff'
import type { ObjectReader } from '../view/tree-nav'
import { createMergeFs } from './git-fs'
import { newCommits, objectsToPack } from './objects'
import { writePack } from './pack-writer'

/** Who the merge commit is by (the merger's Settings name and email). */
export interface MergeIdentity {
  readonly name: string
  readonly email: string
  /** Seconds since the epoch; defaults to now. */
  readonly timestamp?: number
  /** Minutes, git's sign convention (`new Date().getTimezoneOffset()`); defaults to 0. */
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
export function mergeMessage(prNumber: number, sourceLabel: string, title = ''): string {
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
export async function planMerge(reader: ObjectReader, input: Pick<MergeInput, 'baseTip' | 'headOid'>): Promise<Exclude<MergePlan, { kind: 'conflict' }>> {
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
): Promise<{ kind: 'merge'; oid: string; written: ReadonlyMap<string, GitObject>; reader: ObjectReader } | { kind: 'conflict'; paths: readonly string[] }> {
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
    timezoneOffset: input.author.timezoneOffset ?? 0,
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
    })
    if (r.oid === undefined) throw new Error('the merge produced no commit')
    return { kind: 'merge', oid: r.oid, written: fs.written, reader: fs.reader }
  } catch (e) {
    const err = e as ConflictData
    if (err.code === 'MergeConflictError') return { kind: 'conflict', paths: [...(err.data?.filepaths ?? [])] }
    // Conflicts isomorphic-git cannot express (add/add, file vs directory) come as this.
    if (err.code === 'MergeNotSupportedError') return { kind: 'conflict', paths: [] }
    throw e
  }
}

/** What the merge button can offer: the plan, with a three-way merge tried for conflicts. */
export type MergeCheck = 'fast-forward' | 'merge' | 'conflict' | 'up-to-date' | 'unrelated'

export async function checkMerge(reader: ObjectReader, input: MergeInput): Promise<MergeCheck> {
  const plan = await planMerge(reader, input)
  if (plan.kind !== 'merge') return plan.kind
  return (await threeWayMerge(reader, input)).kind
}

/** Run the whole merge: classify, merge when needed, and build the pack. */
export async function runMerge(reader: ObjectReader, input: MergeInput, onProgress?: MergeProgress): Promise<MergeOutcome | Extract<MergePlan, { kind: 'conflict' | 'up-to-date' | 'unrelated' }>> {
  onProgress?.('analyse')
  const plan = await planMerge(reader, input)
  if (plan.kind === 'up-to-date' || plan.kind === 'unrelated') return plan
  let tip: string
  let source = reader
  if (plan.kind === 'fast-forward') {
    tip = plan.newTip
  } else {
    onProgress?.('merge')
    const merged = await threeWayMerge(reader, input)
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

/** An oid as the 20 bytes a ref update carries (validation helper for callers). */
export function oidBytes(hex: string): Uint8Array {
  const b = hexToBytes(hex)
  if (b.length !== 20) throw new Error('expected a 20-byte oid')
  return b
}

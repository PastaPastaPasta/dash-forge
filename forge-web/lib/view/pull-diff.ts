/** Reconstruct a pull request comparison from its base and source repository objects. */

import type { BrowseReader } from '../browse'
import { diffTrees, type FileChange } from './commit-log'
import { decodeTextBlob, parseCommit } from './git-objects'
import { compactDiffLines, diffTextLines, type CompactDiffLine } from './text-diff'

const INLINE_FILE_CAP = 50
const INLINE_BLOB_MAX_BYTES = 256 * 1024
const MERGE_BASE_COMMIT_CAP = 5000

export type ObjectReader = Pick<BrowseReader, 'readObject'>

export interface FilePatch {
  readonly change: FileChange
  readonly lines: readonly CompactDiffLine[] | null
  readonly note: string | null
}

export interface PullComparison {
  readonly changes: readonly FileChange[]
  readonly patches: readonly FilePatch[]
  readonly comparedBaseOid: string
  readonly comparisonNote: string | null
}

function combineReaders(primary: ObjectReader, fallback: ObjectReader): ObjectReader {
  return {
    async readObject(oid: string) {
      try {
        return await primary.readObject(oid)
      } catch (primaryError) {
        try {
          return await fallback.readObject(oid)
        } catch {
          throw primaryError
        }
      }
    },
  }
}

async function readCommit(reader: ObjectReader, oid: string) {
  const object = await reader.readObject(oid)
  if (object.type !== 'commit') throw new Error(`${oid.slice(0, 9)} is not a commit`)
  return parseCommit(object.bytes)
}

async function readPatchText(reader: ObjectReader, oid: string | null): Promise<string | null> {
  if (oid === null) return ''
  const object = await reader.readObject(oid)
  if (object.type !== 'blob' || object.bytes.length > INLINE_BLOB_MAX_BYTES) return null
  return decodeTextBlob(object.bytes)
}

async function loadFilePatch(reader: ObjectReader, change: FileChange): Promise<FilePatch> {
  try {
    const [before, after] = await Promise.all([
      readPatchText(reader, change.baseOid),
      readPatchText(reader, change.headOid),
    ])
    if (before === null || after === null) {
      return { change, lines: null, note: 'Binary, non-blob, or larger than 256 KiB' }
    }
    const lines = diffTextLines(before, after)
    if (lines === null) return { change, lines: null, note: 'Text diff is too large to render safely' }
    return { change, lines: compactDiffLines(lines), note: null }
  } catch (error) {
    return {
      change,
      lines: null,
      note: error instanceof Error ? error.message : 'Could not reconstruct this file',
    }
  }
}

const IMPORTED_BASE_ERROR = 'the imported record did not preserve its original target commit'

/**
 * Load the exact merge-base comparison when possible. Native PRs may fall back to the head
 * commit's first parent when target history is unavailable. Imported PRs must not: their
 * first parent can omit earlier commits from the original PR, so an inexact diff is worse
 * than linking to the archived upstream comparison.
 */
export async function loadPullComparison(
  sourceReader: ObjectReader,
  baseReader: ObjectReader,
  baseOid: string,
  headOid: string,
  imported: boolean,
): Promise<PullComparison> {
  const reader = combineReaders(sourceReader, baseReader)
  const head = await readCommit(reader, headOid)
  let comparedBaseOid = head.parents[0] || ''
  let comparisonNote: string | null = null

  if (baseOid === '') {
    if (imported) throw new Error(IMPORTED_BASE_ERROR)
    comparisonNote = 'The target ref has no current tip. Showing the proposed head against its first parent.'
  } else {
    let mergeBase: string | null
    try {
      mergeBase = await findMergeBase(reader, baseOid, headOid)
    } catch {
      if (imported) throw new Error(IMPORTED_BASE_ERROR)
      comparisonNote = 'The current target history is not available. Showing the head commit against its first parent.'
      mergeBase = null
    }

    if (mergeBase === null) {
      if (imported) throw new Error(IMPORTED_BASE_ERROR)
      if (comparisonNote === null) {
        comparisonNote = 'No common ancestor was found within the review limit. Showing the head commit against its first parent.'
      }
    } else {
      if (imported && mergeBase === headOid) throw new Error(IMPORTED_BASE_ERROR)
      comparedBaseOid = mergeBase
      if (mergeBase !== baseOid) {
        comparisonNote = `Showing changes since merge base ${mergeBase.slice(0, 7)}; the target ref is now ${baseOid.slice(0, 7)}.`
      }
    }
  }

  if (comparedBaseOid === '') throw new Error('the proposed head has no parent to compare')
  const baseTree = (await readCommit(reader, comparedBaseOid)).tree
  const changes = await diffTrees(reader, baseTree, head.tree)
  const patches = await Promise.all(
    changes.slice(0, INLINE_FILE_CAP).map((change) => loadFilePatch(reader, change)),
  )
  return { changes, patches, comparedBaseOid, comparisonNote }
}

/** Find the nearest head-side common ancestor, bounded so corrupt history cannot run away. */
export async function findMergeBase(
  reader: ObjectReader,
  baseOid: string,
  headOid: string,
): Promise<string | null> {
  const parents = new Map<string, readonly string[]>()
  const parentsOf = async (oid: string): Promise<readonly string[]> => {
    const cached = parents.get(oid)
    if (cached !== undefined) return cached
    const value = (await readCommit(reader, oid)).parents
    parents.set(oid, value)
    return value
  }

  const baseAncestors = new Set<string>()
  const baseQueue = [baseOid]
  for (let i = 0; i < baseQueue.length && baseAncestors.size < MERGE_BASE_COMMIT_CAP; i++) {
    const oid = baseQueue[i] as string
    if (baseAncestors.has(oid)) continue
    baseAncestors.add(oid)
    baseQueue.push(...(await parentsOf(oid)))
  }

  const seen = new Set<string>()
  const headQueue = [headOid]
  for (let i = 0; i < headQueue.length && seen.size < MERGE_BASE_COMMIT_CAP; i++) {
    const oid = headQueue[i] as string
    if (seen.has(oid)) continue
    if (baseAncestors.has(oid)) return oid
    seen.add(oid)
    headQueue.push(...(await parentsOf(oid)))
  }
  return null
}

export const PULL_DIFF_INLINE_FILE_CAP = INLINE_FILE_CAP

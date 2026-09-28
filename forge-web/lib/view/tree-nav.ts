/**
 * Tree navigation (view glue) — walk a repo's browse plane to list a directory or read a blob
 * without materializing the repo. Composes {@link BrowseReader} object reads with the git
 * tree/commit parsers.
 *
 * A commit → its root tree → nested trees along a path → the blob at a leaf. Every object is
 * hash-verified by the reader before it is returned, so a tampered pack byte fails the read.
 */

import type { BrowseReader, GitObject, LocatorEntry, ReadObjectOptions } from '../browse'
import { MODE_TREE, ObjectTooLargeError } from '../browse'
import { commitSubject, parseCommit, parseTree, type CommitObject, type TreeEntry } from './git-objects'

/**
 * The slice of {@link BrowseReader} object reads need. `locate` is optional so a test double
 * or a combined reader can omit it; when present it lets a diff skip downloading a blob whose
 * stored size alone rules out showing it inline.
 */
export interface ObjectReader {
  readObject(oidHex: string, options?: ReadObjectOptions): Promise<GitObject>
  locate?(oidHex: string): LocatorEntry | null
  /**
   * A new reader of the same objects with block read-ahead, for one walk over many commits
   * ({@link BrowseReader.forHistoryWalk}); `flush` passes on its batched hash-check verdicts.
   */
  forHistoryWalk?(): ObjectReader & { flush(): void }
}

/** Read a commit object, failing clearly when the oid names something else. */
export async function readCommit(reader: ObjectReader, commitOid: string): Promise<CommitObject> {
  const obj = await reader.readObject(commitOid)
  if (obj.type !== 'commit') throw new Error(`${commitOid.slice(0, 8)} is not a commit`)
  return parseCommit(obj.bytes)
}

/** Resolve a commit's root tree oid. */
export async function commitRootTree(reader: ObjectReader, commitOid: string): Promise<{ commit: CommitObject; tree: string }> {
  const commit = await readCommit(reader, commitOid)
  return { commit, tree: commit.tree }
}

/** Read a tree object's entries by tree oid. */
export async function readTree(reader: ObjectReader, treeOid: string): Promise<TreeEntry[]> {
  const obj = await reader.readObject(treeOid)
  if (obj.type !== 'tree') throw new Error(`${treeOid.slice(0, 8)} is not a tree`)
  return parseTree(obj.bytes)
}

/** Walk a `/`-separated path from a root tree to the tree oid for that directory. */
export async function treeAtPath(
  reader: BrowseReader,
  rootTreeOid: string,
  path: string,
): Promise<TreeEntry[]> {
  const segments = path.split('/').filter((s) => s.length > 0)
  let treeOid = rootTreeOid
  for (const seg of segments) {
    const entries = await readTree(reader, treeOid)
    const next = entries.find((e) => e.name === seg && e.mode === MODE_TREE)
    if (!next) throw new Error(`path not found: ${path}`)
    treeOid = next.oid
  }
  return readTree(reader, treeOid)
}

/** Find a directory entry (blob) by its leaf name within a tree, returning its oid. */
export function findEntry(entries: readonly TreeEntry[], name: string): TreeEntry | undefined {
  return entries.find((e) => e.name === name)
}

/**
 * A lower bound on a stored object's size, when the locator can tell without a fetch. Only an
 * undeltified entry qualifies (a delta's stored length says nothing about its result); zlib
 * never expands input by more than a fraction of a percent, so the stored length minus that
 * slack and the object header is a safe bound — IF the locator is honest. Nothing verifies a
 * locator's lengths, so this only ever skips work early: a read must still check the real size.
 */
export function knownMinSize(reader: ObjectReader, oid: string): number | null {
  const entry = reader.locate?.(oid)
  if (!entry || entry.deltaDepth !== 0) return null
  return Math.floor((entry.length - 64) / 1.01)
}

/**
 * Read a blob's raw bytes by oid, refusing one over `maxBytes` ({@link ObjectTooLargeError}):
 * a {@link BrowseReader} refuses it before inflating, and the result is checked here too, for
 * readers that ignore the option.
 */
export async function readBlob(reader: ObjectReader, blobOid: string, maxBytes = Infinity): Promise<Uint8Array> {
  const obj = await reader.readObject(blobOid, { maxBytes })
  if (obj.type !== 'blob') throw new Error(`${blobOid.slice(0, 8)} is not a blob`)
  if (obj.bytes.length > maxBytes) throw new ObjectTooLargeError(obj.bytes.length, maxBytes)
  return obj.bytes
}

/** Pick a README entry (case-insensitive, prefers .md) from a directory listing. */
export function pickReadme(entries: readonly TreeEntry[]): TreeEntry | undefined {
  const readmes = entries.filter((e) => /^readme(\.|$)/i.test(e.name))
  return readmes.find((e) => /\.md$/i.test(e.name)) ?? readmes[0]
}

export { commitSubject }

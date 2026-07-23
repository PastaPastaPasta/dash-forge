/**
 * Tree navigation (view glue) — walk a repo's browse plane to list a directory or read a blob
 * without materializing the repo. Composes {@link BrowseReader} object reads with the git
 * tree/commit parsers.
 *
 * A commit → its root tree → nested trees along a path → the blob at a leaf. Every object is
 * hash-verified by the reader before it is returned, so a tampered pack byte fails the read.
 */

import type { BrowseReader } from '../browse'
import { MODE_TREE } from '../browse'
import { commitSubject, parseCommit, parseTree, type CommitObject, type TreeEntry } from './git-objects'

/** Resolve a commit's root tree oid. */
export async function commitRootTree(reader: BrowseReader, commitOid: string): Promise<{ commit: CommitObject; tree: string }> {
  const obj = await reader.readObject(commitOid)
  if (obj.type !== 'commit') throw new Error(`${commitOid.slice(0, 8)} is not a commit`)
  const commit = parseCommit(obj.bytes)
  return { commit, tree: commit.tree }
}

/** Read a tree object's entries by tree oid. */
export async function readTree(reader: BrowseReader, treeOid: string): Promise<TreeEntry[]> {
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

/** Read a blob's raw bytes by oid. */
export async function readBlob(reader: BrowseReader, blobOid: string): Promise<Uint8Array> {
  const obj = await reader.readObject(blobOid)
  if (obj.type !== 'blob') throw new Error(`${blobOid.slice(0, 8)} is not a blob`)
  return obj.bytes
}

/** Pick a README entry (case-insensitive, prefers .md) from a directory listing. */
export function pickReadme(entries: readonly TreeEntry[]): TreeEntry | undefined {
  const readmes = entries.filter((e) => /^readme(\.|$)/i.test(e.name))
  return readmes.find((e) => /\.md$/i.test(e.name)) ?? readmes[0]
}

export { commitSubject }

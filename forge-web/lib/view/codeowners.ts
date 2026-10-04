/**
 * Code owners (view glue, P1-6): read a commit's code owners file through the browse reader and
 * say who owns a PR's changed paths. The rules (where the file is, how it parses and matches,
 * whom a PR asks) are `lib/rules/codeowners`, shared with `dg` by conformance vectors.
 */

import { MODE_TREE, ObjectTooLargeError } from '../browse'
import { CODEOWNERS_PATHS, MAX_CODEOWNERS_BYTES, parseCodeOwners, type CodeOwners } from '../rules/codeowners'
import { decodeTextBlob, type TreeEntry } from './git-objects'
import type { FileChange } from './commit-log'
import { commitRootTree, readBlob, readTree, type ObjectReader } from './tree-nav'

/** A commit's code owners file, parsed. */
export interface CodeOwnersFile {
  /** Where it was found ({@link CODEOWNERS_PATHS}). */
  readonly path: string
  readonly owners: CodeOwners
}

/** Parsed files by commit oid: a commit's content never changes, whichever repo holds it. */
const byCommit = new Map<string, Promise<CodeOwnersFile | null>>()
const CACHE_MAX = 32

/**
 * The code owners file at `commitOid`: the first of {@link CODEOWNERS_PATHS} that is a regular
 * text file of at most {@link MAX_CODEOWNERS_BYTES}, or null when there is none. A larger or
 * binary file counts as none, as on GitHub. Read failures reject (and are not cached).
 */
export function readCodeOwners(reader: ObjectReader, commitOid: string): Promise<CodeOwnersFile | null> {
  const cached = byCommit.get(commitOid)
  if (cached !== undefined) return cached
  const read = (async (): Promise<CodeOwnersFile | null> => {
    const { tree } = await commitRootTree(reader, commitOid)
    // Every candidate is at the root or one directory down: the root is read once, and each
    // directory at most once.
    const root = await readTree(reader, tree)
    const dirs = new Map<string, TreeEntry[] | null>([['', root]])
    for (const path of CODEOWNERS_PATHS) {
      const slash = path.lastIndexOf('/')
      const dir = slash < 0 ? '' : path.slice(0, slash)
      if (!dirs.has(dir)) {
        const sub = root.find((e) => e.name === dir && e.mode === MODE_TREE)
        dirs.set(dir, sub === undefined ? null : await readTree(reader, sub.oid))
      }
      const entry = dirs.get(dir)?.find((e) => e.name === path.slice(slash + 1))
      // A regular file (`100644`, `100755`, …): not a tree, a symlink or a submodule.
      if (entry === undefined || (entry.mode & 0o170000) !== 0o100000) continue
      let bytes: Uint8Array
      try {
        bytes = await readBlob(reader, entry.oid, MAX_CODEOWNERS_BYTES)
      } catch (e) {
        if (e instanceof ObjectTooLargeError) return null
        throw e
      }
      const text = decodeTextBlob(bytes)
      return text === null ? null : { path, owners: parseCodeOwners(text) }
    }
    return null
  })()
  byCommit.set(commitOid, read)
  if (byCommit.size > CACHE_MAX) byCommit.delete(byCommit.keys().next().value as string)
  read.catch(() => {
    if (byCommit.get(commitOid) === read) byCommit.delete(commitOid)
  })
  return read
}

/**
 * The paths a change set touches, as the code owners rule reads them: every added, deleted or
 * modified path, a rename as both its old and its new path (so the set is `git diff --name-only
 * --no-renames`, whatever rename detection a client ran).
 */
export function changedPaths(changes: readonly FileChange[]): string[] {
  const out = new Set<string>()
  for (const c of changes) {
    out.add(c.path)
    if (c.oldPath !== undefined) out.add(c.oldPath)
  }
  return [...out]
}

/** Forget every cached file (tests). */
export function clearCodeOwnersCache(): void {
  byCommit.clear()
}

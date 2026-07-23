/**
 * Staleness overlay — flatIndex freshness.
 *
 * Ports `overlay_tree` from `crates/forge-core/src/rules.rs`. Applies the tree diffs of
 * the ≤ 20 commits since a flatIndex's indexed tip on top of it, yielding the current
 * tree without re-downloading a fresh flatIndex (the S0.5 cold-load correction).
 */

import type { FlatIndex, FlatIndexEntry, TreeDiff } from './types'

/**
 * Overlay `laterCommitTreeDiffs` (in commit order, oldest first) onto `base`. Each
 * `upsert` adds/replaces a path; each `delete` removes one. The result is re-sorted by
 * path and its `tip` is the last diff's commit (unchanged if the slice is empty).
 */
export function overlayTree(base: FlatIndex, laterCommitTreeDiffs: readonly TreeDiff[]): FlatIndex {
  const tree = new Map<string, FlatIndexEntry>()
  for (const e of base.entries) {
    tree.set(e.path, { path: e.path, oid: e.oid, mode: e.mode, size: e.size ?? 0 })
  }

  let tip = base.tip
  for (const diff of laterCommitTreeDiffs) {
    for (const change of diff.changes ?? []) {
      if (change.op === 'upsert') {
        tree.set(change.path, {
          path: change.path,
          oid: change.oid,
          mode: change.mode,
          size: change.size ?? 0,
        })
      } else {
        tree.delete(change.path)
      }
    }
    tip = diff.commit
  }

  const entries = [...tree.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { tip, entries }
}

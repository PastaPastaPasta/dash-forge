/**
 * Ref-name collisions: a new ref git clients could not hold next to an existing one. Parity with
 * forge-core `rules::ref_collision` (vectors `ref_collision__*`).
 *
 * Consensus admits both `refs/heads/feature` and `refs/heads/feature/x`, and case variants. git
 * cannot: a ref is a file, so `feature` cannot also be a folder, and on macOS and Windows `Foo`
 * and `foo` are the same file. Clients refuse to create such a ref; readers still show any that
 * exist.
 */

import { compareStrings } from './oid'

/** ASCII-only case fold, as Rust's `eq_ignore_ascii_case`. */
const foldAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** `parent` is a folder of `child`, ignoring ASCII case. */
const isPathPrefix = (parent: string, child: string): boolean =>
  child.length > parent.length && foldAscii(child.slice(0, parent.length)) === foldAscii(parent) && child[parent.length] === '/'


/**
 * The existing ref `name` would collide with, or null: its parent or child path, or a ref that
 * differs from it only in ASCII case (the two combine: `Feature` and `feature/x` share a folder). `name` itself is an update, not a collision. The first
 * collision in byte order is returned, so every client names the same one.
 */
export function refCollision(existing: Iterable<string>, name: string): string | null {
  let first: string | null = null
  for (const e of existing) {
    if (e === name || !(isPathPrefix(e, name) || isPathPrefix(name, e) || foldAscii(e) === foldAscii(name))) continue
    if (first === null || compareStrings(e, first) < 0) first = e
  }
  return first
}

/** Why `name` cannot be created next to `existing` (what {@link refCollision} returned). */
export function collisionReason(name: string, existing: string): string {
  if (foldAscii(existing) === foldAscii(name)) return `${existing} exists and differs only in letter case`
  if (isPathPrefix(existing, name)) return `${existing} exists, so ${name} cannot be created under it`
  return `${existing} exists under it`
}

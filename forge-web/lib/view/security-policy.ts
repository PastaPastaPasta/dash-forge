/**
 * A repo's security policy (DESIGN mixed-visibility §4.7, D37): the `SECURITY.md` on the default
 * branch, which the repo header links ("Security policy"), `/<owner>/<repo>/security` shows, and the
 * new-issue form points to. There is no report form: intake is the email address and key the file
 * gives. Only the default branch's public files are read.
 *
 * Where it is looked for is GitHub's order of precedence for a file that can live in more than one
 * place (docs.github.com, "Creating a default community health file"): the `.github` folder, then
 * the root, then `docs/`. The first that is a regular file wins. `forge_core::rules::security_policy`
 * holds the same list for `dg repo view`; both have a test on its order.
 */

import type { BrowseReader } from '../browse'
import { MODE_TREE, ObjectTooLargeError } from '../browse'
import { decodeTextBlob, type TreeEntry } from './git-objects'
import { commitRootTree, readBlob, readTree } from './tree-nav'

/** Where the policy is looked for, in order. */
export const SECURITY_POLICY_PATHS = ['.github/SECURITY.md', 'SECURITY.md', 'docs/SECURITY.md'] as const

/** The largest policy shown here (a policy is a page of contact details): a larger one links to the file. */
export const SECURITY_POLICY_MAX_BYTES = 512 * 1024

/** The policy file at a tip. */
export interface SecurityPolicyFile {
  /** Which of {@link SECURITY_POLICY_PATHS} it is at. */
  readonly path: (typeof SECURITY_POLICY_PATHS)[number]
  /** The blob. */
  readonly oid: string
}

/** git's file-type bits (`S_IFMT`) and regular-file value: a symlink, directory or submodule named SECURITY.md is no policy. */
const S_IFMT = 0o170_000
const S_IFREG = 0o100_000
const isRegularFile = (e: TreeEntry): boolean => (e.mode & S_IFMT) === S_IFREG

/**
 * The first of {@link SECURITY_POLICY_PATHS} that is a regular file, given the root tree's entries
 * and a way to list a directory of it (called only for a directory that is looked in, in order, so
 * a repo with `.github/SECURITY.md` never reads `docs/`).
 */
export async function pickSecurityPolicy(
  root: readonly TreeEntry[],
  readDir: (oid: string) => Promise<readonly TreeEntry[]>,
): Promise<SecurityPolicyFile | null> {
  for (const path of SECURITY_POLICY_PATHS) {
    const slash = path.lastIndexOf('/')
    const dir = slash < 0 ? null : path.slice(0, slash)
    const name = path.slice(slash + 1)
    let entries: readonly TreeEntry[] | null = root
    if (dir !== null) {
      const sub = root.find((e) => e.name === dir && e.mode === MODE_TREE)
      entries = sub === undefined ? null : await readDir(sub.oid)
    }
    const file = entries?.find((e) => e.name === name && isRegularFile(e))
    if (file !== undefined) return { path, oid: file.oid }
  }
  return null
}

/** The security policy at `tipOid` (the default branch's tip), or null when it has none. */
export async function findSecurityPolicy(reader: BrowseReader, tipOid: string): Promise<SecurityPolicyFile | null> {
  const { tree } = await commitRootTree(reader, tipOid)
  return pickSecurityPolicy(await readTree(reader, tree), (oid) => readTree(reader, oid))
}

/** A policy's text: `tooLarge` when it is over {@link SECURITY_POLICY_MAX_BYTES}, `binary` when it is not text. */
export type SecurityPolicyText = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'tooLarge' } | { readonly kind: 'binary' }

/** Read a policy's file. */
export async function readSecurityPolicy(reader: BrowseReader, file: SecurityPolicyFile): Promise<SecurityPolicyText> {
  let bytes: Uint8Array
  try {
    bytes = await readBlob(reader, file.oid, SECURITY_POLICY_MAX_BYTES)
  } catch (e) {
    if (e instanceof ObjectTooLargeError) return { kind: 'tooLarge' }
    throw e
  }
  const text = decodeTextBlob(bytes)
  return text === null ? { kind: 'binary' } : { kind: 'text', text }
}

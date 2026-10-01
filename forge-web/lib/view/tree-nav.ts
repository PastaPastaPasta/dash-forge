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
import { commitSubject, MalformedObjectError, parseCommit, parseTag, parseTree, type CommitObject, type TagObject, type TreeEntry } from './git-objects'

/**
 * The slice of {@link BrowseReader} object reads need. `locate` is optional so a test double
 * or a combined reader can omit it; when present it lets a diff skip downloading a blob whose
 * stored size alone rules out showing it inline.
 */
export interface ObjectReader {
  readObject(oidHex: string, options?: ReadObjectOptions): Promise<GitObject>
  locate?(oidHex: string): LocatorEntry | null
  /** An object's type from entry headers alone, or null when not indexed ({@link BrowseReader.objectType}). */
  objectType?(oidHex: string): Promise<GitObject['type'] | null>
  /** A whole-stored blob's first bytes, unverified, to classify it ({@link BrowseReader.blobPrefix}). */
  blobPrefix?(oidHex: string, bytes: number): Promise<Uint8Array | null>

  /**
   * A new reader of the same objects with block read-ahead, for one walk over many commits
   * ({@link BrowseReader.forHistoryWalk}); `flush` passes on its batched hash-check verdicts.
   */
  forHistoryWalk?(): ObjectReader & { flush(): void }
  /** Shared by readers of the same objects and memos ({@link BrowseReader.memoScope}). */
  readonly memoScope?: object
}

/**
 * An object of the wrong type where a commit, tree or blob was expected: permanent (the object
 * is hash-checked, so reading it again gives the same answer), never worth a "Try again".
 */
export class ObjectTypeError extends Error {
  readonly oid: string
  readonly actual: GitObject['type']

  constructor(oid: string, actual: GitObject['type'], expected: GitObject['type']) {
    super(`${oid.slice(0, 8)} is a ${actual}, not a ${expected}`)
    this.name = 'ObjectTypeError'
    this.oid = oid
    this.actual = actual
  }
}

/** Read a commit object, failing clearly when the oid names something else. */
export async function readCommit(reader: ObjectReader, commitOid: string): Promise<CommitObject> {
  const obj = await reader.readObject(commitOid)
  if (obj.type !== 'commit') throw new ObjectTypeError(commitOid, obj.type, 'commit')
  return parseCommit(obj.bytes)
}

/**
 * Tags followed before giving up. git sets no limit (a cycle is impossible: each tag's id hashes
 * the id it names), but a hostile push can chain many; real repos nest one or two at most.
 */
export const TAG_PEEL_MAX = 16

/** What an object peels to (`git rev-parse <oid>^{}`). */
export interface Peeled {
  /** The first object that is not a tag, following annotated tags from the one named. */
  readonly oid: string
  /** Its type: a commit, almost always; a tree or a blob for a tag of one. */
  readonly type: Exclude<GitObject['type'], 'tag'>
  /** The annotated tags followed to reach it, outermost first (empty when none were). */
  readonly tags: readonly TagObject[]
}

/**
 * The most {@link peel} reads of one object. Tags and commits are far smaller; an object over it
 * is only asked its type (a tag of a large tree or blob costs a few header bytes, not the object).
 */
const PEEL_READ_MAX = 256 * 1024

/**
 * An object for {@link peel}: its bytes when it is small enough to be a tag (the read of a commit
 * is the one its view makes next, then answered from the reader's memo), else only its type.
 */
async function readForPeel(reader: ObjectReader, oid: string): Promise<GitObject | { readonly type: GitObject['type']; readonly bytes: null }> {
  try {
    return await reader.readObject(oid, { maxBytes: PEEL_READ_MAX })
  } catch (e) {
    if (!(e instanceof ObjectTooLargeError)) throw e
    // Too large to be a tag: its type, from entry headers (a delta's is its chain's base's).
    const type = (await reader.objectType?.(oid)) ?? (await reader.readObject(oid)).type
    return { type, bytes: null }
  }
}

/**
 * Peel `oid`: a commit, tree or blob is itself, and an annotated tag is followed to what it names
 * (a tag of a tag too). Costs one object read per tag followed. The read of the object it ends on
 * is the one its caller makes next anyway, which the reader then answers from its memo; an object
 * too large to be a tag is only asked its type ({@link PEEL_READ_MAX}).
 *
 * `verify: false` is for listings of many tags: it stops at a tag that declares its target a
 * commit and trusts that, instead of reading the commit (the commit page it links to checks it).
 */
export async function peel(reader: ObjectReader, oid: string, { verify = true }: { readonly verify?: boolean } = {}): Promise<Peeled> {
  const tags: TagObject[] = []
  let at = oid.toLowerCase()
  for (let depth = 0; depth <= TAG_PEEL_MAX; depth++) {
    const obj = await readForPeel(reader, at)
    if (obj.type !== 'tag') return { oid: at, type: obj.type, tags }
    if (obj.bytes === null) throw new MalformedObjectError(at, `a tag over ${PEEL_READ_MAX} bytes`)
    const tag = parseTag(obj.bytes)
    if (tag === null) throw new MalformedObjectError(at, 'a tag without an object and type header')
    tags.push(tag)
    if (!verify && tag.type === 'commit') return { oid: tag.object, type: 'commit', tags }
    at = tag.object
  }
  throw new MalformedObjectError(oid, `more than ${TAG_PEEL_MAX} nested tags`)
}

/**
 * {@link peel} to a commit (`git rev-parse <oid>^{commit}`). A tree or a blob, named directly or
 * by a tag, fails with {@link ObjectTypeError}, which carries its type.
 */
export async function peelToCommit(reader: ObjectReader, oid: string): Promise<Peeled> {
  const peeled = await peel(reader, oid)
  if (peeled.type !== 'commit') throw new ObjectTypeError(peeled.oid, peeled.type, 'commit')
  return peeled
}

/** Resolve a commit's root tree oid. */
export async function commitRootTree(reader: ObjectReader, commitOid: string): Promise<{ commit: CommitObject; tree: string }> {
  const commit = await readCommit(reader, commitOid)
  return { commit, tree: commit.tree }
}

/** Read a tree object's entries by tree oid. */
export async function readTree(reader: ObjectReader, treeOid: string): Promise<TreeEntry[]> {
  const obj = await reader.readObject(treeOid)
  if (obj.type !== 'tree') throw new ObjectTypeError(treeOid, obj.type, 'tree')
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
  if (obj.type !== 'blob') throw new ObjectTypeError(blobOid, obj.type, 'blob')
  if (obj.bytes.length > maxBytes) throw new ObjectTooLargeError(obj.bytes.length, maxBytes)
  return obj.bytes
}

/** Pick a README entry (case-insensitive, prefers .md) from a directory listing. */
export function pickReadme(entries: readonly TreeEntry[]): TreeEntry | undefined {
  const readmes = entries.filter((e) => /^readme(\.|$)/i.test(e.name))
  return readmes.find((e) => /\.md$/i.test(e.name)) ?? readmes[0]
}

export { commitSubject }

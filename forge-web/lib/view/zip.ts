/**
 * Download .zip of a ref (`ux-dx-spec.md` §5.4). The browse reader lives on the main thread,
 * so the tree walk and blob reads happen here (every object hash-checked by the reader, as on
 * any page), and the bytes go to a Web Worker that compresses them with fflate so the UI
 * stays responsive. Refs above {@link ZIP_MAX_BYTES} are refused before any blob is read:
 * sizes come from the locator (stored sizes) when it has them, else from what was read.
 */

import { MODE_GITLINK, MODE_TREE } from '../browse'
import type { ObjectReader } from './tree-nav'
import { ObjectTypeError, peel, readBlob, readTree } from './tree-nav'
import { decodeTextBlob, type TreeEntry } from './git-objects'
import { historyWalker } from './commit-log'
import {
  autoAbbrevLength,
  describeCommit,
  DescribeError,
  describeNames,
  expandExportSubst,
  exportAttributes,
  parseArchiveCommit,
  parseDescribeOptions,
  peelTags,
  uniqueAbbrev,
  type ArchiveCommit,
  type DescribeTag,
  type FormatContext,
} from './archive'
import type { ZipMessage } from './zip-entries'
import { mapPooled } from './pool'

/** The largest ref the browser zips (uncompressed bytes). Above it: clone instead. */
export const ZIP_MAX_BYTES = 100 * 1024 * 1024

/** A file under a tree: its path, blob, mode and stored size (the locator's; 0 when it cannot tell). */
export interface ZipFile {
  readonly path: string
  readonly oid: string
  readonly mode: number
  readonly size: number
}

/**
 * The file walk's bounds for Go to file and the language bar (tree reads only; no blob is read):
 * files, and a safety cap on trees (a push of many empty directories).
 */
export const FILE_WALK_FILES = 5000
export const FILE_WALK_TREES = 5000

/** The files a walk found, and whether a bound stopped it before it saw every file. */
export interface FileWalk {
  readonly files: ZipFile[]
  readonly truncated: boolean
}

export interface ZipProgress {
  readonly phase: 'listing' | 'reading' | 'describing' | 'compressing'
  readonly files: number
  readonly filesTotal: number
  readonly bytes: number
}

/** The zip would exceed {@link ZIP_MAX_BYTES}. */
export class ZipTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super('too large for a browser zip; clone instead')
    this.name = 'ZipTooLargeError'
  }
}

/** A tree entry name that is safe as one path segment. */
export function isSafeName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name)
}

/**
 * Tree reads a walk keeps in flight (QW-028): a level of dashpay/dash's tree is dozens of
 * directories, and one read at a time made Go to file and the language bar wait ~14 s for ~100
 * round trips. Reads of the same pack's neighbouring trees share their queries (the read-ahead
 * walker's blocks, the chunk queries gathered per turn).
 */
export const WALK_POOL = 16

/**
 * Every blob (and symlink) under a tree, gitlinks and unsafe names skipped, breadth first with up
 * to `pool` trees read at once, sorted by path, each with its stored size from the locator (tree
 * reads only). Stops after `maxTrees` trees or `maxFiles` files (`truncated`, also when one tree
 * alone holds more than the bound), so Go to file and the language bar can list a large repo
 * without walking all of it.
 */
export async function walkFiles(
  reader: ObjectReader,
  treeOid: string,
  { maxTrees = Infinity, maxFiles = Infinity, pool = WALK_POOL }: { readonly maxTrees?: number; readonly maxFiles?: number; readonly pool?: number } = {},
): Promise<FileWalk> {
  const files: ZipFile[] = []
  const queue: [string, string][] = [[treeOid, '']]
  let trees = 0
  let dropped = false
  const take = (entries: readonly TreeEntry[], prefix: string): void => {
    for (const e of entries) {
      // A tree is hash-checked, not sane: a hostile pusher can name an entry `..` (zip-slip).
      if (!isSafeName(e.name)) continue
      const path = prefix ? `${prefix}/${e.name}` : e.name
      if (e.mode === MODE_TREE) queue.push([e.oid, path])
      else if (e.mode === MODE_GITLINK) continue
      else if (files.length < maxFiles) files.push({ path, oid: e.oid, mode: e.mode, size: reader.locate?.(e.oid)?.length ?? 0 })
      else dropped = true
    }
  }
  await new Promise<void>((resolve, reject) => {
    let active = 0
    let failed = false
    const pump = (): void => {
      while (!failed && active < pool && queue.length > 0 && trees < maxTrees && files.length < maxFiles) {
        const [oid, prefix] = queue.shift() as [string, string]
        trees += 1
        active += 1
        readTree(reader, oid).then(
          (entries) => {
            active -= 1
            if (failed) return
            take(entries, prefix)
            pump()
          },
          (e: unknown) => {
            failed = true
            reject(e)
          },
        )
      }
      if (active === 0 && !failed) resolve()
    }
    pump()
  })
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  return { files, truncated: dropped || queue.length > 0 }
}

/**
 * Every file of a ref's tip (for the zip): a commit, or what an annotated tag names, through any
 * nested tags (L-01): the commit's tree, or a tagged tree itself. A tagged blob has no tree.
 */
export async function listFiles(reader: ObjectReader, tipOid: string): Promise<ZipFile[]> {
  return (await planArchive(reader, tipOid)).files
}

/** What `git archive` writes for a ref (QW-026): the files, and what it does to them. */
export interface ArchivePlan {
  /** The files, those `export-ignore` leaves out already left out. */
  readonly files: ZipFile[]
  /** The files whose `$Format:…$` are expanded (`export-subst`). */
  readonly subst: ReadonlySet<string>
  /** The commit archived, or null for a tag of a tree (git archive then has no commit to describe). */
  readonly commit: ArchiveCommit | null
  /** Every entry's time (ms): the committer time, as git archive stamps it; now for a tree. */
  readonly mtime: number
}

/**
 * The files of a ref's tip, as `git archive` takes them: the tree's own `.gitattributes` decide
 * which are left out (`export-ignore`) and which are expanded (`export-subst`), and the commit's
 * time is every entry's.
 */
export async function planArchive(reader: ObjectReader, tipOid: string): Promise<ArchivePlan> {
  const tip = await peel(reader, tipOid)
  let commit: ArchiveCommit | null = null
  let tree: string | null = tip.type === 'tree' ? tip.oid : null
  if (tip.type === 'commit') {
    const obj = await reader.readObject(tip.oid)
    if (obj.type !== 'commit') throw new ObjectTypeError(tip.oid, obj.type, 'commit')
    commit = parseArchiveCommit(tip.oid, obj.bytes)
    tree = commit.tree
  }
  if (tree === null) throw new ObjectTypeError(tip.oid, tip.type, 'tree')
  const all = (await walkFiles(reader, tree)).files
  // The tree's attributes, never the viewer's: every `.gitattributes` it holds (a few KiB).
  const attrFiles = new Map<string, string>()
  await mapPooled(
    all.filter((f) => f.path === '.gitattributes' || f.path.endsWith('/.gitattributes')),
    6,
    async (f) => {
      const text = decodeTextBlob(await readBlob(reader, f.oid, ATTRIBUTES_MAX_BYTES).catch(() => new Uint8Array()))
      if (text !== null) attrFiles.set(f.path, text)
    },
  )
  const attrs = exportAttributes(attrFiles)
  const files: ZipFile[] = []
  const subst = new Set<string>()
  for (const f of all) {
    const a = attrs(f.path)
    if (a.ignore) continue
    files.push(f)
    // A symlink's target is not a file's text: git expands regular files only.
    if (a.subst && commit !== null && (f.mode & 0o170000) === 0o100000) subst.add(f.path)
  }
  return { files, subst, commit, mtime: commit === null ? Date.now() : commit.committer.time * 1000 }
}

/** A `.gitattributes` larger than this is not read (git's own limit is 100 MB; real ones are a few KiB). */
const ATTRIBUTES_MAX_BYTES = 1024 * 1024

/** The refs `%(describe)` and `%d` read. */
export interface ArchiveRefs {
  readonly tags: readonly DescribeTag[]
  /** Branch short names and tips. */
  readonly heads: readonly { readonly name: string; readonly oid: string }[]
}

/**
 * Expand the `export-subst` files of `entries` in place (`$Format:…$`, gitattributes(5)), for the
 * plan's commit, as git archive does: files in archive order, and one `%(describe)` per archive
 * (the first; it is empty when no tag describes the commit, and the ones after it stay as
 * written), worked out as `git describe` does; `%d`/`%D` name the branches and tags at the
 * commit. A file that is not UTF-8 is left as it is. `signal` stops the describe walk.
 */
export async function substituteFiles(
  reader: ObjectReader & { findByPrefix?(prefix: string, limit?: number): string[]; readonly objectCount?: number },
  plan: ArchivePlan,
  entries: Record<string, Uint8Array>,
  refs: ArchiveRefs,
  { signal, onProgress }: { readonly signal?: AbortSignal; readonly onProgress?: (p: ZipProgress) => void } = {},
): Promise<void> {
  const commit = plan.commit
  if (commit === null || plan.subst.size === 0) return
  const texts = new Map<string, string>()
  for (const path of [...plan.subst].sort()) {
    const bytes = entries[path]
    if (bytes === undefined) continue
    try {
      texts.set(path, new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      // Not UTF-8: left as stored.
    }
  }
  const formats = [...texts.values()].flatMap((t) => [...t.matchAll(/\$Format:([^$]*)\$/g)].map((m) => m[1] as string))
  if (formats.length === 0) return
  const findByPrefix = reader.findByPrefix?.bind(reader)
  const auto = autoAbbrevLength(reader.objectCount ?? 0)
  const abbrev = (oid: string, min: number = auto): string => uniqueAbbrev(oid, min, findByPrefix)

  // The one `%(describe…)` git archive expands: the first, worked out before the (synchronous) expansion.
  const first = formats.map((f) => /%\(describe(?::([^)]*))?\)/.exec(f)).find((m) => m !== null)
  const firstSpec = first == null ? null : (first[1] ?? '')
  const firstOptions = firstSpec === null ? null : parseDescribeOptions(firstSpec)
  const needTags = firstOptions !== null || formats.some((f) => /%[dD]/.test(f))
  const peeled = needTags ? await peelTags(reader, refs.tags, signal) : []
  let described = ''
  if (firstOptions !== null) {
    onProgress?.({ phase: 'describing', files: 0, filesTotal: 0, bytes: 0 })
    const walker = historyWalker(reader)
    try {
      described = (await describeCommit(walker, commit.oid, describeNames(peeled, firstOptions), firstOptions, abbrev, { ...(signal ? { signal } : {}) })) ?? ''
    } catch (e) {
      // Past its bound: empty, as git's describe would fail.
      if (!(e instanceof DescribeError)) throw e
    } finally {
      walker.flush?.()
    }
  }
  let invoked = false
  const ctx: FormatContext = {
    commit,
    abbrev,
    // `%d` / `%D`: the branches, then every tag, at the commit.
    decorations: [...refs.heads.filter((h) => h.oid === commit.oid).map((h) => h.name), ...peeled.filter((t) => t.commit === commit.oid).map((t) => `tag: ${t.ref}`)],
    describe: (spec) => {
      if (invoked) return null
      invoked = true
      return parseDescribeOptions(spec) === null ? null : spec === firstSpec ? described : null
    },
  }
  for (const [path, text] of texts) entries[path] = new TextEncoder().encode(expandExportSubst(text, ctx))
}

/** Stored (compressed-on-disk) sizes from the locator: a lower bound, cheap to sum. */
export function storedSize(files: readonly ZipFile[]): number {
  return files.reduce((total, f) => total + f.size, 0)
}

/** Read every file's bytes (hash-checked by the reader), refusing past the size cap. */
export async function readZipFiles(
  reader: ObjectReader,
  files: readonly ZipFile[],
  onProgress: (p: ZipProgress) => void,
  signal?: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  const entries: Record<string, Uint8Array> = {}
  let bytes = 0
  let done = 0
  await mapPooled(files, 6, async (f) => {
    if (signal?.aborted) throw new Error('cancelled')
    const obj = await reader.readObject(f.oid)
    bytes += obj.bytes.length
    if (bytes > ZIP_MAX_BYTES) throw new ZipTooLargeError(bytes)
    // A copy: the reader caches `obj.bytes`, and the worker transfer detaches what it sends.
    entries[f.path] = obj.bytes.slice()
    done += 1
    onProgress({ phase: 'reading', files: done, filesTotal: files.length, bytes })
  })
  return entries
}

/**
 * How each entry is recorded, as `git archive --format=zip` records it (archive-zip.c): a file's
 * git mode (`0100755` for an executable, `0120000` for a symlink; a regular file carries no Unix
 * mode, as git writes it), every entry at `mtime` (DOS time and the `UT` extended timestamp), and
 * the commit id as the archive comment.
 */
export type ZipMeta = NonNullable<ZipMessage['meta']>

/** Compress in a worker (fflate); resolves with the zip bytes. */
export function compressInWorker(
  entries: Record<string, Uint8Array>,
  onProgress?: (p: ZipProgress) => void,
  signal?: AbortSignal,
  meta?: ZipMeta,
): Promise<Uint8Array> {
  const count = Object.keys(entries).length
  const bytes = Object.values(entries).reduce((n, b) => n + b.length, 0)
  onProgress?.({ phase: 'compressing', files: count, filesTotal: count, bytes })
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./zip.worker.ts', import.meta.url))
    worker.onmessage = (ev: MessageEvent<{ ok: true; zip: Uint8Array } | { ok: false; error: string }>) => {
      worker.terminate()
      if (ev.data.ok) resolve(ev.data.zip)
      else reject(new Error(ev.data.error))
    }
    worker.onerror = (ev) => {
      worker.terminate()
      reject(new Error(ev.message || 'the zip worker failed'))
    }
    signal?.addEventListener('abort', () => {
      worker.terminate()
      reject(new Error('cancelled'))
    })
    worker.postMessage({ entries, meta: meta ?? null }, Object.values(entries).map((b) => b.buffer as ArrayBuffer))
  })
}

/** `<name>-<ref>.zip`, with anything a filename should not hold replaced. */
export function zipFileName(repoName: string, ref: string): string {
  return `${repoName}-${ref}`.replace(/[^A-Za-z0-9._-]+/g, '-') + '.zip'
}

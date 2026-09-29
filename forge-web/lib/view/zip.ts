/**
 * Download .zip of a ref (`ux-dx-spec.md` §5.4). The browse reader lives on the main thread,
 * so the tree walk and blob reads happen here (every object hash-checked by the reader, as on
 * any page), and the bytes go to a Web Worker that compresses them with fflate so the UI
 * stays responsive. Refs above {@link ZIP_MAX_BYTES} are refused before any blob is read:
 * sizes come from the locator (stored sizes) when it has them, else from what was read.
 */

import { MODE_GITLINK, MODE_TREE } from '../browse'
import type { ObjectReader } from './tree-nav'
import { ObjectTypeError, peel, readCommit, readTree } from './tree-nav'
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
  readonly phase: 'listing' | 'reading' | 'compressing'
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
 * Every blob (and symlink) under a tree, gitlinks and unsafe names skipped, breadth first, sorted
 * by path, each with its stored size from the locator (tree reads only). Stops after `maxTrees`
 * trees or `maxFiles` files (`truncated`, also when one tree alone holds more than the bound), so
 * Go to file and the language bar can list a large repo without walking all of it.
 */
export async function walkFiles(
  reader: ObjectReader,
  treeOid: string,
  { maxTrees = Infinity, maxFiles = Infinity }: { readonly maxTrees?: number; readonly maxFiles?: number } = {},
): Promise<FileWalk> {
  const files: ZipFile[] = []
  const queue: [string, string][] = [[treeOid, '']]
  let trees = 0
  let dropped = false
  while (queue.length > 0 && trees < maxTrees && files.length < maxFiles) {
    const [oid, prefix] = queue.shift() as [string, string]
    trees += 1
    for (const e of await readTree(reader, oid)) {
      // A tree is hash-checked, not sane: a hostile pusher can name an entry `..` (zip-slip).
      if (!isSafeName(e.name)) continue
      const path = prefix ? `${prefix}/${e.name}` : e.name
      if (e.mode === MODE_TREE) queue.push([e.oid, path])
      else if (e.mode === MODE_GITLINK) continue
      else if (files.length < maxFiles) files.push({ path, oid: e.oid, mode: e.mode, size: reader.locate?.(e.oid)?.length ?? 0 })
      else dropped = true
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  return { files, truncated: dropped || queue.length > 0 }
}

/**
 * Every file of a ref's tip (for the zip): a commit, or what an annotated tag names, through any
 * nested tags (L-01): the commit's tree, or a tagged tree itself. A tagged blob has no tree.
 */
export async function listFiles(reader: ObjectReader, tipOid: string): Promise<ZipFile[]> {
  const tip = await peel(reader, tipOid)
  const tree = tip.type === 'commit' ? (await readCommit(reader, tip.oid)).tree : tip.type === 'tree' ? tip.oid : null
  if (tree === null) throw new ObjectTypeError(tip.oid, tip.type, 'tree')
  return (await walkFiles(reader, tree)).files
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

/** Compress in a worker (fflate); resolves with the zip bytes. */
export function compressInWorker(
  entries: Record<string, Uint8Array>,
  onProgress?: (p: ZipProgress) => void,
  signal?: AbortSignal,
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
    worker.postMessage(entries, Object.values(entries).map((b) => b.buffer as ArrayBuffer))
  })
}

/** `<name>-<ref>.zip`, with anything a filename should not hold replaced. */
export function zipFileName(repoName: string, ref: string): string {
  return `${repoName}-${ref}`.replace(/[^A-Za-z0-9._-]+/g, '-') + '.zip'
}

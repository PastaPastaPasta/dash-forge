/**
 * Download .zip of a ref (`ux-dx-spec.md` §5.4). The browse reader lives on the main thread,
 * so the tree walk and blob reads happen here (every object hash-checked by the reader, as on
 * any page), and the bytes go to a Web Worker that compresses them with fflate so the UI
 * stays responsive. Refs above {@link ZIP_MAX_BYTES} are refused before any blob is read:
 * sizes come from the locator (stored sizes) when it has them, else from what was read.
 */

import { MODE_GITLINK, MODE_TREE } from '../browse'
import type { ObjectReader } from './tree-nav'
import { readCommit, readTree } from './tree-nav'
import { mapPooled } from './pool'

/** The largest ref the browser zips (uncompressed bytes). Above it: clone instead. */
export const ZIP_MAX_BYTES = 100 * 1024 * 1024

/** A file to put in the zip. */
export interface ZipFile {
  readonly path: string
  readonly oid: string
  readonly mode: number
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

/** Every blob (and symlink) under a commit's tree, depth first. Gitlinks are skipped. */
export async function listFiles(reader: ObjectReader, commitOid: string): Promise<ZipFile[]> {
  const out: ZipFile[] = []
  const walk = async (treeOid: string, prefix: string): Promise<void> => {
    for (const e of await readTree(reader, treeOid)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name
      if (e.mode === MODE_TREE) await walk(e.oid, path)
      else if (e.mode !== MODE_GITLINK) out.push({ path, oid: e.oid, mode: e.mode })
    }
  }
  await walk((await readCommit(reader, commitOid)).tree, '')
  return out
}

/** Stored (compressed-on-disk) sizes from the locator: a lower bound, cheap to sum. */
export function storedSize(reader: ObjectReader, files: readonly ZipFile[]): number {
  let total = 0
  for (const f of files) total += reader.locate?.(f.oid)?.length ?? 0
  return total
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
    entries[f.path] = obj.bytes
    done += 1
    onProgress({ phase: 'reading', files: done, filesTotal: files.length, bytes })
  })
  return entries
}

/** Compress in a worker (fflate); resolves with the zip bytes. */
export function compressInWorker(
  entries: Record<string, Uint8Array>,
  onProgress?: (p: ZipProgress) => void,
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
    worker.postMessage(entries, Object.values(entries).map((b) => b.buffer as ArrayBuffer))
  })
}

/** `<name>-<ref>.zip`, with anything a filename should not hold replaced. */
export function zipFileName(repoName: string, ref: string): string {
  return `${repoName}-${ref}`.replace(/[^A-Za-z0-9._-]+/g, '-') + '.zip'
}

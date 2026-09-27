/**
 * A virtual file system for isomorphic-git that holds nothing of a repository but what the
 * merge writes. A loose-object read (`.git/objects/ab/cdef…`) is answered from an
 * {@link ObjectReader} — the repos' browse readers, which hash-verify every object — and
 * handed to isomorphic-git deflated, as a loose object would be (isomorphic-git re-checks the
 * sha1). Everything else (the merged trees and blobs, the merge commit, the empty index) lives
 * in memory. No repository is ever materialized: a merge reads the commits and trees on the
 * paths it compares, and the blobs of files both sides changed.
 */

import { unzlibSync, zlibSync } from 'fflate'

import type { GitObject } from '../browse'
import type { ObjectReader } from '../view/tree-nav'

const LOOSE = /\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/

class FsError extends Error {
  constructor(
    readonly code: 'ENOENT' | 'ENOTDIR',
    path: string,
  ) {
    super(`${code}: ${path}`)
  }
}

interface Stat {
  readonly type: 'file' | 'dir'
  readonly size: number
}

function statOf(type: 'file' | 'dir', size: number) {
  const s: Stat = { type, size }
  return {
    ...s,
    mode: type === 'dir' ? 0o40000 : 0o100644,
    ino: 0,
    uid: 0,
    gid: 0,
    dev: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => false,
  }
}

function wrap(obj: GitObject): Uint8Array {
  const head = new TextEncoder().encode(`${obj.type} ${obj.bytes.length}\0`)
  const out = new Uint8Array(head.length + obj.bytes.length)
  out.set(head, 0)
  out.set(obj.bytes, head.length)
  return out
}

function unwrap(raw: Uint8Array): GitObject {
  const nul = raw.indexOf(0)
  const [type] = new TextDecoder().decode(raw.subarray(0, nul)).split(' ')
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') throw new Error(`bad object type ${type}`)
  return { type, bytes: raw.slice(nul + 1) }
}

/** The file system, and a reader over what the merge wrote and `source`. */
export interface MergeFs {
  /** Pass as isomorphic-git's `fs`. */
  readonly client: { readonly promises: Record<string, (...args: never[]) => Promise<unknown>> }
  /** The first error an object read hit (reported to isomorphic-git as a missing file), if any. */
  readError(): unknown
  /** Reads objects the merge wrote first, then `source`. */
  readonly reader: ObjectReader
}

export function createMergeFs(source: ObjectReader): MergeFs {
  const files = new Map<string, Uint8Array>()
  let readError: unknown = undefined
  const written = new Map<string, GitObject>()
  const dirs = new Set<string>(['/'])

  const loose = (path: string): string | null => {
    const m = LOOSE.exec(path)
    return m === null ? null : `${m[1]}${m[2]}`
  }

  const readFile = async (path?: string, options?: unknown): Promise<Uint8Array | string> => {
    if (typeof path !== 'string') throw new FsError('ENOENT', String(path))
    const text = options === 'utf8' || (typeof options === 'object' && options !== null && (options as { encoding?: string }).encoding === 'utf8')
    const file = files.get(path)
    if (file !== undefined) return text ? new TextDecoder().decode(file) : file
    const oid = loose(path)
    if (oid === null) throw new FsError('ENOENT', path)
    let obj: GitObject
    try {
      obj = await source.readObject(oid)
    } catch (e) {
      // isomorphic-git only understands "no such file"; the real reason (a malformed object,
      // the read budget, a network failure) is kept for the caller to rethrow.
      readError ??= e
      throw new FsError('ENOENT', path)
    }
    return zlibSync(wrap(obj))
  }

  const writeFile = async (path: string, data: Uint8Array | string): Promise<void> => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
    files.set(path, bytes)
    const oid = loose(path)
    if (oid !== null) written.set(oid, unwrap(unzlibSync(bytes)))
  }

  const stat = async (path: string) => {
    if (dirs.has(path)) return statOf('dir', 0)
    const file = files.get(path)
    if (file !== undefined) return statOf('file', file.length)
    throw new FsError('ENOENT', path)
  }

  const promises = {
    readFile,
    writeFile,
    unlink: async (path: string) => {
      if (!files.delete(path)) throw new FsError('ENOENT', path)
    },
    readdir: async (path: string) => {
      const prefix = path.endsWith('/') ? path : `${path}/`
      if (!dirs.has(path)) throw new FsError('ENOENT', path)
      const names = new Set<string>()
      for (const p of [...files.keys(), ...dirs]) {
        if (p.startsWith(prefix) && p !== prefix) names.add(p.slice(prefix.length).split('/')[0] as string)
      }
      return [...names]
    },
    mkdir: async (path: string) => {
      dirs.add(path)
    },
    rmdir: async (path: string) => {
      dirs.delete(path)
    },
    stat,
    lstat: stat,
    readlink: async (path: string) => {
      throw new FsError('ENOENT', path)
    },
    symlink: async (_target: string, path: string) => {
      throw new FsError('ENOENT', path)
    },
  }

  const reader: ObjectReader = {
    readObject: (oid) => {
      const w = written.get(oid)
      return w ? Promise.resolve(w) : source.readObject(oid)
    },
  }
  return { client: { promises } as unknown as MergeFs['client'], reader, readError: () => readError }
}

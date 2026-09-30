/** The zip's tree walk, size cap and file naming (compression itself is fflate's). */

import { unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { MODE_GITLINK } from '../browse'
import { Store } from './diff-fixtures'
import { isSafeName, listFiles, readZipFiles, walkFiles, ZIP_MAX_BYTES, zipFileName, ZipTooLargeError } from './zip'

describe('zip of a ref', () => {
  it('lists every file under the commit and skips submodules', async () => {
    const s = new Store()
    const root = s.tree([
      { name: 'README.md', oid: s.blob('hi\n') },
      { name: 'src', oid: s.files({ 'main.rs': 'fn main() {}\n', 'lib/x.rs': 'x' }), mode: 0o40000 },
      { name: 'vendor', oid: 'ab'.repeat(20), mode: MODE_GITLINK },
    ])
    const tip = s.commit(root)
    const files = await listFiles(s.reader(), tip)
    expect(files.map((f) => f.path)).toEqual(['README.md', 'src/lib/x.rs', 'src/main.rs'])

    const entries = await readZipFiles(s.reader(), files, () => undefined)
    const round = unzipSync(zipSync(entries))
    expect(new TextDecoder().decode(round['src/main.rs'])).toBe('fn main() {}\n')
  })

  it('copies bytes so the worker transfer cannot empty the reader cache', async () => {
    const s = new Store()
    const same = s.blob('same\n')
    const tip = s.commit(s.tree([{ name: 'a', oid: same }, { name: 'b', oid: same }]))
    // A caching reader: every read of an oid returns the one cached object.
    const cached = new Map<string, Awaited<ReturnType<ReturnType<Store['reader']>['readObject']>>>()
    const inner = s.reader()
    const reader = {
      readObject: async (oid: string) => cached.get(oid) ?? cached.set(oid, await inner.readObject(oid)).get(oid)!,
    }
    const entries = await readZipFiles(reader, await listFiles(reader, tip), () => undefined)
    expect(entries['a']?.buffer).not.toBe(entries['b']?.buffer)
    expect(entries['a']?.buffer).not.toBe(cached.get(same)?.bytes.buffer)
    // Two identical files are two distinct transferables.
    expect(new Set(Object.values(entries).map((b) => b.buffer)).size).toBe(2)
  })

  it('a truncated parallel walk keeps the same files whatever order its reads land in', async () => {
    const s = new Store()
    // 12 top-level directories, each with 3 files and a subdirectory of 2: 60 files in 25 trees.
    const layout: Record<string, string> = {}
    for (let d = 0; d < 12; d++) {
      for (let f = 0; f < 3; f++) layout[`d${d}/f${f}.txt`] = `${d}.${f}`
      for (let f = 0; f < 2; f++) layout[`d${d}/sub/g${f}.txt`] = `${d}.sub.${f}`
    }
    const root = s.files(layout)
    const inner = s.reader()
    /** A reader whose reads land after `delay(n)` ms, `n` counting reads as they are asked. */
    const timed = (delay: (n: number) => number) => {
      let n = 0
      return {
        readObject: async (oid: string) => {
          const wait = delay(n++)
          await new Promise((r) => setTimeout(r, wait))
          return inner.readObject(oid)
        },
      }
    }
    const walk = async (delay: (n: number) => number, pool?: number) =>
      (await walkFiles(timed(delay), root, { maxFiles: 25, ...(pool === undefined ? {} : { pool }) })).files.map((f) => f.path)
    const serial = await walk(() => 0, 1)
    expect(serial).toHaveLength(25)
    // Later-asked reads landing first, first-asked landing first, and a scramble: one set.
    expect(await walk((n) => 30 - n)).toEqual(serial)
    expect(await walk((n) => n)).toEqual(serial)
    expect(await walk((n) => (n * 7) % 11)).toEqual(serial)
  })

  it('skips tree entries that would escape the zip root', () => {
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'a\0b']) expect(isSafeName(bad)).toBe(false)
    expect(isSafeName('..a')).toBe(true)
  })

  it('refuses past the size cap', async () => {
    const big = { readObject: () => Promise.resolve({ type: 'blob' as const, bytes: new Uint8Array(ZIP_MAX_BYTES / 2 + 1) }) }
    const files = [0, 1].map((i) => ({ path: `f${i}`, oid: String(i), mode: 0o100644, size: 0 }))
    await expect(readZipFiles(big, files, () => undefined)).rejects.toBeInstanceOf(ZipTooLargeError)
  })

  it('names the file after the repo and ref', () => {
    expect(zipFileName('forge-v2-demo', 'main')).toBe('forge-v2-demo-main.zip')
    expect(zipFileName('proj', 'feature/x y')).toBe('proj-feature-x-y.zip')
  })
})

/** The zip's tree walk, size cap and file naming (compression itself is fflate's). */

import { unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { MODE_GITLINK } from '../browse'
import { Store } from './diff-fixtures'
import { listFiles, readZipFiles, ZIP_MAX_BYTES, zipFileName, ZipTooLargeError } from './zip'

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

  it('refuses past the size cap', async () => {
    const big = { readObject: () => Promise.resolve({ type: 'blob' as const, bytes: new Uint8Array(ZIP_MAX_BYTES / 2 + 1) }) }
    const files = [0, 1].map((i) => ({ path: `f${i}`, oid: String(i), mode: 0o100644 }))
    await expect(readZipFiles(big, files, () => undefined)).rejects.toBeInstanceOf(ZipTooLargeError)
  })

  it('names the file after the repo and ref', () => {
    expect(zipFileName('forge-v2-demo', 'main')).toBe('forge-v2-demo-main.zip')
    expect(zipFileName('proj', 'feature/x y')).toBe('proj-feature-x-y.zip')
  })
})

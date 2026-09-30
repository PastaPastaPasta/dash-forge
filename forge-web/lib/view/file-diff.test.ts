import { describe, expect, it } from 'vitest'

import type { FileChange } from './commit-log'
import { MODE_GITLINK, Store } from './diff-fixtures'
import { COUNT_BLOB_MAX_BYTES, INLINE_BLOB_MAX_BYTES, diffTotals, loadFilePatch, uncountedReasons, type FilePatch } from './file-diff'
import { imageRepo } from './image-repo-fixture'
import { ObjectTooLargeError } from '../browse'

function change(partial: Partial<FileChange> & Pick<FileChange, 'baseOid' | 'headOid'>): FileChange {
  return {
    path: 'f',
    status: partial.baseOid === null ? 'added' : partial.headOid === null ? 'deleted' : 'modified',
    baseMode: partial.baseOid === null ? null : 0o100644,
    headMode: partial.headOid === null ? null : 0o100644,
    oid: (partial.headOid ?? partial.baseOid) as string,
    ...partial,
  }
}

describe('loadFilePatch', () => {
  it('renders a text change with +/- counts', async () => {
    const s = new Store()
    const r = s.reader()
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: s.blob('a\nb\n'), headOid: s.blob('a\nc\nd\n') }))
    expect(patch.kind).toBe('text')
    if (patch.kind !== 'text') return
    expect([patch.added, patch.deleted]).toEqual([2, 1])
  })

  it('reads each side through its own reader', async () => {
    const s = new Store()
    const before = s.blob('old\n')
    const baseOnly = s.snapshot()
    const after = s.blob('new\n')
    const headOnly = new Set([after])
    const patch = await loadFilePatch({ base: s.reader(baseOnly), head: s.reader(headOnly) }, change({ baseOid: before, headOid: after }))
    expect(patch.kind).toBe('text')
  })

  it('does not diff binary content', async () => {
    const s = new Store()
    const r = s.reader()
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: null, headOid: s.blob(new Uint8Array([0x89, 0x50, 0, 1])) }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'binary' })
  })

  it('does not diff a blob over the inline limit', async () => {
    const s = new Store()
    const r = s.reader()
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: null, headOid: s.blob('x'.repeat(INLINE_BLOB_MAX_BYTES + 1)) }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'large' })
  })

  it('skips the download when the locator already shows the blob is too large', async () => {
    const s = new Store()
    const big = s.blob('small in the store')
    const r = s.reader(undefined, () => ({ packRef: 0, offset: 0, length: 10 * INLINE_BLOB_MAX_BYTES, deltaChainSpan: 0, deltaDepth: 0 }))
    s.reads.length = 0
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: null, headOid: big }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'large', unverifiedSize: true })
    expect(s.reads).toEqual([])
  })

  it('says a locator-based skip is unverified, and can be overridden to measure the real blob', async () => {
    const s = new Store()
    // A locator that lies: a two-line file listed as megabytes, which would hide the change.
    const before = s.blob('ok\n')
    const after = s.blob('ok\nmalicious\n')
    const r = s.reader(undefined, () => ({ packRef: 0, offset: 0, length: 10 * INLINE_BLOB_MAX_BYTES, deltaChainSpan: 0, deltaDepth: 0 }))
    const skipped = await loadFilePatch({ base: r, head: r }, change({ baseOid: before, headOid: after }))
    expect(skipped).toMatchObject({ kind: 'placeholder', reason: 'large', unverifiedSize: true })
    if (skipped.kind === 'placeholder') expect(skipped.note).toMatch(/has not been checked/)

    const forced = await loadFilePatch({ base: r, head: r }, change({ baseOid: before, headOid: after }), { ignoreSizeHint: true })
    expect(forced).toMatchObject({ kind: 'text', added: 1, deleted: 0 })
  })

  it('does not offer an override when the measured blob is too large', async () => {
    const s = new Store()
    const r = s.reader()
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: null, headOid: s.blob('x'.repeat(INLINE_BLOB_MAX_BYTES + 1)) }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'large' })
    expect(patch).not.toHaveProperty('unverifiedSize')
  })

  it('labels a submodule pointer change without reading it', async () => {
    const s = new Store()
    const r = s.reader()
    const patch = await loadFilePatch(
      { base: r, head: r },
      change({ baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40), baseMode: MODE_GITLINK, headMode: MODE_GITLINK }),
    )
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'submodule' })
  })

  it('labels a mode-only change', async () => {
    const s = new Store()
    const r = s.reader()
    const blob = s.blob('x\n')
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: blob, headOid: blob, headMode: 0o100755 }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'mode-only' })
  })

  it('turns a failed read into a placeholder instead of rejecting', async () => {
    const s = new Store()
    const r = s.reader(new Set())
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: null, headOid: 'c'.repeat(40) }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'unreadable' })
  })
})

/**
 * The live path: blobs in a real pack read through a {@link BrowseReader}, which refuses an object
 * over `maxBytes` with its own `ObjectTooLargeError` before building it. The {@link Store} reader
 * above ignores the limit (as `git cat-file` does), which is how dashpay/dash's 300 KiB
 * `src/validation.cpp` and `src/net_processing.cpp` were counted offline but "not counted" live.
 */
describe('loadFilePatch over a pack (the live read path)', () => {
  const enc = new TextEncoder()
  const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag} line ${i} of the file`).join('\n') + '\n'
  /** The same change counted through a reader that ignores `maxBytes` (the offline harness). */
  async function offline(before: Uint8Array, after: Uint8Array): Promise<FilePatch> {
    const s = new Store()
    const r = s.reader()
    return loadFilePatch({ base: r, head: r }, change({ baseOid: s.blob(before), headOid: s.blob(after) }))
  }

  it('counts a change to a blob over 256 KiB, with one read per blob', async () => {
    const old = lines(12_000, 'x') // ~310 KiB
    const edited = old.replace('x line 5000 of the file\n', 'x line 5000 edited\nx line 5000 added\n')
    expect(old.length).toBeGreaterThan(INLINE_BLOB_MAX_BYTES)
    const { reader, oids, fetched } = imageRepo([
      { name: 'a.cpp', bytes: enc.encode(old) },
      { name: 'b.cpp', bytes: enc.encode(edited) },
    ])
    fetched.length = 0
    const patch = await loadFilePatch({ base: reader, head: reader }, change({ baseOid: oids['a.cpp']!, headOid: oids['b.cpp']! }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'large', added: 2, deleted: 1 })
    // Each blob is read once: not refused at the inline limit and read again to count it.
    expect(fetched).toHaveLength(2)
    expect(diffTotals([patch.change], () => patch)).toMatchObject({ added: 2, deleted: 1, uncounted: 0 })
  })

  it('counts a delta-compressed blob over 256 KiB as the offline reader does', async () => {
    // As on the dash mirror: the new side is an OFS delta (depth ≥ 1) whose result is ~300 KiB.
    const chunk = lines(1_500, 'y') // ~37 KiB, stored whole; the delta repeats it to 300 KiB
    const size = 300 * 1024
    const after = chunk.repeat(Math.ceil(size / chunk.length)).slice(0, size)
    const before = after.replace('y line 700 of the file\n', 'y line 700 was different\n')
    const { reader, oids } = imageRepo([
      { name: 'old.cpp', bytes: enc.encode(before) },
      { name: 'new.cpp', delta: { base: enc.encode(chunk), size } },
    ])
    expect(reader.locate(oids['new.cpp']!)?.deltaDepth).toBeGreaterThan(0)
    const live = await loadFilePatch({ base: reader, head: reader }, change({ baseOid: oids['old.cpp']!, headOid: oids['new.cpp']! }))
    const want = await offline(enc.encode(before), enc.encode(after))
    expect(want).toMatchObject({ kind: 'placeholder', reason: 'large', added: 1, deleted: 1 })
    expect(live).toMatchObject({ kind: 'placeholder', reason: 'large', added: 1, deleted: 1 })
  })

  it('says why a blob over the count limit is not counted, and marks the totals partial', async () => {
    const huge = lines(45_000, 'z') // ~1.1 MiB
    expect(huge.length).toBeGreaterThan(COUNT_BLOB_MAX_BYTES)
    const { reader, oids } = imageRepo([{ name: 'huge.cpp', bytes: enc.encode(huge) }])
    const patch = await loadFilePatch({ base: reader, head: reader }, change({ baseOid: null, headOid: oids['huge.cpp']! }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'large' })
    expect(patch).not.toHaveProperty('added')
    if (patch.kind === 'placeholder') expect(patch.note).toMatch(/^File too large to diff in the browser \(over 1\.0 MB\)\. .*not in the totals/)
    expect(diffTotals([patch.change], () => patch)).toMatchObject({ uncounted: 1 })
    expect(uncountedReasons([patch.change], () => patch)).toBe('1 too large to diff in the browser')
  })

  it('names a measured size over the count limit (a reader that ignores the limit)', async () => {
    const s = new Store()
    const r = s.reader()
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: null, headOid: s.blob(lines(45_000, 'z')) }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'large' })
    if (patch.kind === 'placeholder') expect(patch.note).toMatch(/^File too large to diff in the browser \(1\.\d MB\)/)
  })

  it('keeps the unverified wording when the reader refuses an entry on the length the index claims', async () => {
    // A locator that lies about a two-line file's stored length: the reader will not fetch it.
    const s = new Store()
    const small = s.blob('ok\n')
    const length = 20 * COUNT_BLOB_MAX_BYTES
    const lying = {
      locate: () => ({ packRef: 0, offset: 0, length, deltaChainSpan: 0, deltaDepth: 1 }),
      readObject: () => Promise.reject(new ObjectTooLargeError(length, COUNT_BLOB_MAX_BYTES)),
    }
    const patch = await loadFilePatch({ base: s.reader(), head: lying }, change({ baseOid: null, headOid: small }), { ignoreSizeHint: true })
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'large' })
    expect(patch).not.toHaveProperty('unverifiedSize') // downloading again would be refused the same way
    if (patch.kind === 'placeholder') expect(patch.note).toMatch(/stored size as 20 MB.*has not been checked/)
  })

  it('calls an over-256 KiB file with too many changes too complex, not too large, and still counts it (QW-027)', async () => {
    const s = new Store()
    const r = s.reader()
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: s.blob(lines(12_000, 'p')), headOid: s.blob(lines(12_000, 'q')) }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'too-complex', added: 12_000, deleted: 12_000 })
    if (patch.kind === 'placeholder') expect(patch.note).toMatch(/^Large file \(\d+ KB\) not shown.*its lines are counted/)
    // The change set's totals stay whole: nothing is left uncounted.
    expect(diffTotals([patch.change], () => patch)).toMatchObject({ added: 12_000, deleted: 12_000, uncounted: 0 })
    expect(uncountedReasons([patch.change], () => patch)).toBe('')
  })

  it('counts a change past the shown diff\'s edit bound (QW-027: dash v22…v23 left 16 files out)', async () => {
    const s = new Store()
    const r = s.reader()
    // 3,000 changed lines in a small file: over the 2,000 a diff shows, well within what is counted.
    const before = Array.from({ length: 3_000 }, (_, i) => `old ${i}\n`).join('')
    const after = Array.from({ length: 3_000 }, (_, i) => (i % 2 === 0 ? `old ${i}\n` : `new ${i}\n`)).join('')
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: s.blob(before), headOid: s.blob(after) }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'too-complex', added: 1_500, deleted: 1_500 })
  })

  it('calls a file binary when one side is, whichever side fails first', async () => {
    const s = new Store()
    const r = s.reader()
    const patch = await loadFilePatch({ base: r, head: r }, change({ baseOid: s.blob(new Uint8Array([0x89, 0x50, 0, 1])), headOid: s.blob(lines(45_000, 'z')) }))
    expect(patch).toMatchObject({ kind: 'placeholder', reason: 'binary' })
    expect(diffTotals([patch.change], () => patch)).toMatchObject({ added: 0, deleted: 0, uncounted: 0 })
  })

  it('lists every uncounted reason', () => {
    const at = (reason: 'large' | 'unreadable'): FilePatch => ({ kind: 'placeholder', change: change({ baseOid: null, headOid: 'a'.repeat(40) }), reason, note: '' })
    const patches = [at('large'), at('unreadable'), at('large')]
    expect(uncountedReasons(patches.map((p) => p.change), (c) => patches.find((p) => p.change === c))).toBe('2 too large to diff in the browser, 1 could not be read')
  })
})

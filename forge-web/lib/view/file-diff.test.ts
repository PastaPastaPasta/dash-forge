import { describe, expect, it } from 'vitest'

import type { FileChange } from './commit-log'
import { MODE_GITLINK, Store } from './diff-fixtures'
import { INLINE_BLOB_MAX_BYTES, loadFilePatch } from './file-diff'

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

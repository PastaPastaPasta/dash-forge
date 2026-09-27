import { describe, expect, it } from 'vitest'

import { Store } from '../view/diff-fixtures'
import { runMerge } from './engine'
import { writePack } from './pack-writer'
import { missingFromClosure } from './verify'

const ME = { name: 'M', email: 'm@x', timestamp: 1_700_000_000, timezoneOffset: 0 }

describe('closure check before any ref moves', () => {
  it('passes a complete merge pack against the base repo', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'b\n' }))
    const base = s.commit(s.files({ 'a.txt': 'A\n', 'b.txt': 'b\n' }), [root])
    const baseRepo = s.reader(s.snapshot())
    const head = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'B\n', 'c/d.txt': 'd\n' }), [root])
    const out = await runMerge(s.reader(), { baseTip: base, headOid: head, prNumber: 1, sourceLabel: 'x', author: ME, headInBase: false })
    if (out.kind !== 'merge') throw new Error(out.kind)
    expect(await missingFromClosure(out.pack, out.newTip, baseRepo)).toEqual([])
  })

  it('names what a pack is missing', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const baseRepo = s.reader(s.snapshot())
    const blob = s.blob('lost\n')
    const tree = s.tree([
      { name: 'a.txt', oid: s.blob('a\n') },
      { name: 'lost.txt', oid: blob },
    ])
    const tip = s.commit(tree, [base])
    // The commit and its tree, but not the new blob.
    const pack = writePack([s.objects.get(tip)!, s.objects.get(tree)!])
    expect(await missingFromClosure(pack.bytes, tip, baseRepo)).toEqual([blob])
    // An empty pack for a tip the base lacks: the tip itself is missing.
    expect(await missingFromClosure(writePack([]).bytes, tip, baseRepo)).toEqual([tip])
  })
})

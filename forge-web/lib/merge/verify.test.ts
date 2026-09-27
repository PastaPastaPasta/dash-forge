import { describe, expect, it } from 'vitest'

import type { LocatorEntry } from '../browse'
import { Store } from '../view/diff-fixtures'
import { runMerge } from './engine'
import { writePack } from './pack-writer'
import { mergeReaders, missingFromClosure } from './verify'

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
    expect(await missingFromClosure(out.pack, out.newTip, base, baseRepo)).toEqual([])
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
    const pack = writePack([s.objects.get(tip)!, s.objects.get(tree)!])
    expect(await missingFromClosure(pack.bytes, tip, base, baseRepo)).toEqual([blob])
    expect(await missingFromClosure(writePack([]).bytes, tip, base, baseRepo)).toEqual([tip])
  })

  it('M1: a same-repo head the base index lists but cannot serve is missing, not trusted', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const hidden = s.blob('claimed by the index, never stored\n')
    const head = s.commit(s.tree([{ name: 'a.txt', oid: s.blob('a\n') }, { name: 'h.txt', oid: hidden }]), [base])
    // A same-repo PR: the head's commit and tree are in the base repo, its new blob is not,
    // though a writer's index row claims it is.
    const inBase = new Set([...s.objects.keys()].filter((k) => k !== hidden))
    const lying = (_oid: string): LocatorEntry => ({ packRef: 0, offset: 0, length: 1, deltaChainSpan: 0, deltaDepth: 0 })
    const baseRepo = s.reader(inBase, lying)
    const out = await runMerge(s.reader(), { baseTip: base, headOid: head, prNumber: 1, sourceLabel: 'x', author: ME, headInBase: true })
    if (out.kind !== 'fast-forward') throw new Error(out.kind)
    expect(out.objectCount).toBe(0)
    expect(await missingFromClosure(out.pack, out.newTip, base, baseRepo)).toEqual([hidden])
  })

  it('H1: no merge readers until the base repo itself is loaded; the base side is never the fork', () => {
    const s = new Store()
    const fork = s.reader()
    const base = s.reader(new Set())
    expect(mergeReaders(null, fork)).toBeNull()
    expect(mergeReaders(base, fork)?.base).toBe(base)
    expect(mergeReaders(base, null)?.merge).toBe(base)
  })

  it('H1: the fork holding an object does not make it present in the base', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const baseRepo = s.reader(s.snapshot())
    const blob = s.blob('only in the fork\n')
    const tree = s.tree([{ name: 'a.txt', oid: s.blob('a\n') }, { name: 'f.txt', oid: blob }])
    const tip = s.commit(tree, [base])
    const pack = writePack([s.objects.get(tip)!, s.objects.get(tree)!])
    // The fork's reader has everything; the base's does not. Only the base's may be asked.
    expect(await missingFromClosure(pack.bytes, tip, base, s.reader())).toEqual([])
    expect(await missingFromClosure(pack.bytes, tip, base, baseRepo)).toEqual([blob])
  })
})

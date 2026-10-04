/**
 * Rebase and merge in the browser (review-parity M1, P1-2): what it replays, and what it leaves
 * to `dg pr merge --rebase`. `rebase.parity.test.ts` holds it to real git commit for commit.
 */

import { describe, expect, it } from 'vitest'

import { gitOidHex, type GitObject } from '../browse'
import { BrowseReader, ObjectLocator } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { Store } from '../view/diff-fixtures'
import { parseCommit } from '../view/git-objects'
import { checkMergeDetailed, runMerge, type MergeInput } from './engine'
import { newRun, runFor } from './runner'

const ME = { name: 'Merger', email: 'm@example.com', timestamp: 1_700_000_000, timezoneOffset: 0 }
const input = (baseTip: string, headOid: string, extra: Partial<MergeInput> = {}): MergeInput => ({ baseTip, headOid, prNumber: 4, sourceLabel: 'feature', author: ME, headInBase: false, rebase: true, ...extra })

async function packed(pack: Uint8Array): Promise<Map<string, GitObject>> {
  const rows = await indexPacks([pack])
  const r = new BrowseReader(ObjectLocator.parse(serializeLocator(rows)), memoryPackSource([pack]))
  return new Map(await Promise.all(rows.map(async (row) => [row.oidHex, await r.readObject(row.oidHex)] as const)))
}

function raw(s: Store, text: string): string {
  const bytes = new TextEncoder().encode(text)
  const oid = gitOidHex('commit', bytes)
  s.objects.set(oid, { type: 'commit', bytes })
  return oid
}

describe('rebase and merge', () => {
  it('replays each commit on the base tip: authors and messages kept, the merger commits', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'b\n' }))
    const base = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'B\n' }), [root])
    const one = raw(s, `tree ${s.files({ 'a.txt': 'a1\n', 'b.txt': 'b\n' })}\nparent ${root}\nauthor Ann <ann@x> 1500000000 +0200\ncommitter Ann <ann@x> 1500000000 +0200\n\nfirst\n`)
    const two = raw(s, `tree ${s.files({ 'a.txt': 'a2\n', 'b.txt': 'b\n', 'c.txt': 'c\n' })}\nparent ${one}\nauthor Bob <bob@x> 1500000100 -0500\ncommitter Bob <bob@x> 1500000100 -0500\n\n\nsecond\n\nbody`)
    const out = await runMerge(s.reader(), input(base, two))
    if (out.kind !== 'rebase') throw new Error(out.kind)
    const objects = await packed(out.pack)
    const tip = parseCommit((objects.get(out.newTip) as GitObject).bytes)
    const first = parseCommit((objects.get(tip.parents[0] as string) as GitObject).bytes)
    expect(first.parents).toEqual([base])
    expect([first.author.name, first.message, first.committer.name]).toEqual(['Ann', 'first\n', 'Merger'])
    // The leading blank line goes, as the sequencer drops it; no newline is added.
    expect([tip.author.name, tip.message]).toEqual(['Bob', 'second\n\nbody'])
    expect(objects.has(one) || objects.has(two)).toBe(false)
  })

  it('a linear head on the base tip fast-forwards; a merge commit in it is left to git', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const head = s.commit(s.files({ 'a.txt': 'b\n' }), [base])
    expect((await runMerge(s.reader(), input(base, head))).kind).toBe('fast-forward')
    const side = s.commit(s.files({ 'a.txt': 'a\n', 's.txt': 's\n' }), [base])
    const merged = s.commit(s.files({ 'a.txt': 'b\n', 's.txt': 's\n' }), [head, side])
    const check = await checkMergeDetailed(s.reader(), input(base, merged))
    expect(check).toMatchObject({ check: 'conflict', conflictPaths: [], reason: expect.stringMatching(/merge commit/) })
    // Without --rebase the same history fast-forwards.
    expect((await checkMergeDetailed(s.reader(), input(base, merged, { rebase: undefined }))).check).toBe('fast-forward')
  })

  it('a conflicting commit names its paths; an encoding header and a change the base already has are refused', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'b\n' }))
    const base = s.commit(s.files({ 'a.txt': 'A\n', 'b.txt': 'b\n' }), [root])
    const clash = s.commit(s.files({ 'a.txt': 'x\n', 'b.txt': 'b\n' }), [root])
    expect(await checkMergeDetailed(s.reader(), input(base, clash))).toMatchObject({ check: 'conflict', conflictPaths: ['a.txt'], reason: expect.stringMatching(/does not apply/) })
    const encoded = raw(s, `tree ${s.files({ 'a.txt': 'a\n', 'b.txt': 'B\n' })}\nparent ${root}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\nencoding ISO-8859-1\n\nmsg\n`)
    expect((await checkMergeDetailed(s.reader(), input(base, encoded))).reason).toMatch(/encoding/)
    // The same change as the base's own commit, with other lines around it: git skips it by patch-id.
    const root2 = s.commit(s.files({ 'f.txt': '1\n2\n3\n4\n5\n6\n7\n8\n9\n' }))
    const base2 = s.commit(s.files({ 'f.txt': '1\nTWO\n3\n4\n5\n6\n7\n8\n9\n' }), [root2])
    const base3 = s.commit(s.files({ 'f.txt': '1\nTWO\n3\n4\n5\n6\n7\n8\nnine\n' }), [base2])
    const dup = s.commit(s.files({ 'f.txt': '1\nTWO\n3\n4\n5\n6\n7\n8\n9\n' }), [root2])
    const later = s.commit(s.files({ 'f.txt': '1\nTWO\n3\n4\nfive\n6\n7\n8\n9\n' }), [dup])
    expect((await checkMergeDetailed(s.reader(), input(base3, later))).reason).toMatch(/already be on the base/)
  })

  it('refuses what git would re-encode, and a change git calls the same patch across a final newline', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n' }))
    const base = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'b\n' }), [root])
    // A raw Latin-1 byte (no encoding header): git's verify_utf8 rewrites it as UTF-8.
    const tree = s.files({ 'a.txt': 'A\n' })
    const bytes = new Uint8Array([...new TextEncoder().encode(`tree ${tree}\nparent ${root}\nauthor Ren`), 0xe9, ...new TextEncoder().encode(` <r@x> 1 +0000\ncommitter R <r@x> 1 +0000\n\nmsg\n`)])
    const latin = gitOidHex('commit', bytes)
    s.objects.set(latin, { type: 'commit', bytes })
    expect((await checkMergeDetailed(s.reader(), input(base, latin))).reason).toMatch(/not UTF-8/)
    const nonchar = raw(s, `tree ${tree}\nparent ${root}\nauthor R <r@x> 1 +0000\ncommitter R <r@x> 1 +0000\n\nmsg \uFFFE\n`)
    expect((await checkMergeDetailed(s.reader(), input(base, nonchar))).reason).toMatch(/not UTF-8/)
    // The base drops the final newline then restores it; the PR drops it. patch-id ignores
    // "\ No newline at end of file", so git skips the PR's commit: the browser must refuse.
    const f0 = s.commit(s.files({ 'f.txt': '1\n2\n3\n4\na\n' }))
    const u0 = s.commit(s.files({ 'f.txt': 'Z\n2\n3\n4\na' }), [f0])
    const u1 = s.commit(s.files({ 'f.txt': 'Z\n2\n3\n4\na\n' }), [u0])
    const p = s.commit(s.files({ 'f.txt': '1\n2\n3\n4\na' }), [f0])
    expect((await checkMergeDetailed(s.reader(), input(u1, p))).reason).toMatch(/already be on the base/)
  })

  it('fast-forwards a long linear head: only a replay is capped', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    let head = base
    for (let i = 0; i < 300; i++) head = s.commit(s.files({ 'a.txt': `${i}\n` }), [head])
    expect((await checkMergeDetailed(s.reader(), input(base, head))).check).toBe('fast-forward')
  })

  it('the run is keyed on the method', () => {
    const base = { baseTip: 'a'.repeat(40), headOid: 'b'.repeat(40) }
    const rebasing = newRun({ ...base, rebase: true })
    expect(rebasing.rebase).toBe(true)
    expect(runFor(rebasing, { ...base, rebase: true })).toBe(rebasing)
    expect(runFor(rebasing, base)).not.toBe(rebasing)
    expect(runFor(newRun(base), { ...base, rebase: true }).rebase).toBe(true)
  })
})

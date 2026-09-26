import { describe, expect, it } from 'vitest'

import { gitOidHex, ObjectLocator, BrowseReader } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { Store } from '../view/diff-fixtures'
import { parseCommit, parseTree } from '../view/git-objects'
import { mergeMessage, planMerge, runMerge, type MergeInput } from './engine'
import { newCommits } from './objects'
import { writePack } from './pack-writer'

const ME = { name: 'Merger', email: 'merger@example.com', timestamp: 1_700_000_000, timezoneOffset: 0 }

function input(baseTip: string, headOid: string, extra: Partial<MergeInput> = {}): MergeInput {
  return { baseTip, headOid, prNumber: 7, sourceLabel: 'refs/heads/fix', title: 'Fix it', author: ME, headInBase: false, ...extra }
}

/** Read every object of `pack` back through the same path the browse plane uses. */
async function readBack(pack: Uint8Array) {
  const indexed = await indexPacks([pack])
  const reader = new BrowseReader(ObjectLocator.parse(serializeLocator(indexed)), memoryPackSource([pack]))
  return { indexed, reader }
}

describe('pack writer', () => {
  it('writes a non-thin pack that indexPacks parses and verifies', async () => {
    const s = new Store()
    const tree = s.files({ 'a.txt': 'hello\n', 'dir/b.txt': 'world\n' })
    const c = s.commit(tree)
    const objects = [...s.objects.values()]
    const built = writePack(objects)
    expect(built.objectCount).toBe(objects.length)
    const { indexed, reader } = await readBack(built.bytes)
    expect(new Set(indexed.map((o) => o.oidHex))).toEqual(new Set(s.objects.keys()))
    const commit = await reader.readObject(c)
    expect(commit.type).toBe('commit')
    expect(gitOidHex(commit.type, commit.bytes)).toBe(c)
  })
})

describe('merge engine', () => {
  it('fast-forwards when the head descends from the base tip, packing only the new objects', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'README.md': 'v1\n', 'src/a.ts': 'a\n' }))
    const had = s.snapshot()
    const head = s.commit(s.files({ 'README.md': 'v2\n', 'src/a.ts': 'a\n' }), [base])
    const reader = s.reader()
    expect(await planMerge(reader, { baseTip: base, headOid: head })).toEqual({ kind: 'fast-forward', newTip: head })
    const out = await runMerge(reader, input(base, head))
    if (out.kind !== 'fast-forward') throw new Error(`expected a fast-forward, got ${out.kind}`)
    expect(out.newTip).toBe(head)
    const { indexed } = await readBack(out.pack)
    const oids = new Set(indexed.map((o) => o.oidHex))
    // The new commit, its root tree and the changed README; nothing the base already had.
    expect(oids.has(head)).toBe(true)
    for (const o of oids) expect(had.has(o)).toBe(false)
    expect(oids.size).toBe(3)
  })

  it('merges clean divergent histories into the expected tree, authored by the merger', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n' }))
    const base = s.commit(s.files({ 'a.txt': 'ONE\ntwo\nthree\n', 'b.txt': 'b\n' }), [root])
    const baseHad = s.snapshot()
    const head = s.commit(s.files({ 'a.txt': 'one\ntwo\nTHREE\n', 'b.txt': 'b\n', 'new/c.txt': 'c\n' }), [root])
    const out = await runMerge(s.reader(), input(base, head))
    if (out.kind !== 'merge') throw new Error(`expected a merge, got ${out.kind}`)

    const { indexed, reader } = await readBack(out.pack)
    const commit = parseCommit((await reader.readObject(out.newTip)).bytes)
    expect(commit.parents).toEqual([base, head])
    expect(commit.message).toBe(mergeMessage(7, 'refs/heads/fix', 'Fix it'))
    expect(commit.message).toBe('Merge pull request #7 from refs/heads/fix\n\nFix it\n')
    expect(commit.author).toMatchObject({ name: 'Merger', email: 'merger@example.com' })
    expect(commit.committer).toMatchObject({ name: 'Merger', email: 'merger@example.com' })

    // The merged tree is both sides' edits, byte for byte.
    const expected = new Store().files({ 'a.txt': 'ONE\ntwo\nTHREE\n', 'b.txt': 'b\n', 'new/c.txt': 'c\n' })
    expect(commit.tree).toBe(expected)
    const entries = parseTree((await reader.readObject(commit.tree)).bytes).map((e) => e.name)
    expect(entries).toEqual(['a.txt', 'b.txt', 'new'])

    // Non-thin and minimal: the head commit and its new objects travel, the base's do not.
    const oids = new Set(indexed.map((o) => o.oidHex))
    expect(oids.has(head)).toBe(true)
    expect(oids.has(base)).toBe(false)
    expect(oids.has(root)).toBe(false)
    for (const o of oids) expect(baseHad.has(o)).toBe(false)
  })

  it('packs no head objects for a same-repo PR (they are in the base repo already)', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'b\n' }))
    const base = s.commit(s.files({ 'a.txt': 'A\n', 'b.txt': 'b\n' }), [root])
    const head = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'B\n' }), [root])
    const out = await runMerge(s.reader(), input(base, head, { headInBase: true }))
    if (out.kind !== 'merge') throw new Error(`expected a merge, got ${out.kind}`)
    const { indexed } = await readBack(out.pack)
    // The merge commit and its new root tree: both blobs already exist on one side.
    const expectedTree = new Store().files({ 'a.txt': 'A\n', 'b.txt': 'B\n' })
    expect(indexed.map((o) => o.oidHex).sort()).toEqual([out.newTip, expectedTree].sort())
    expect(indexed.some((o) => o.oidHex === head)).toBe(false)
  })

  it('packs nothing for a fast-forward to a head the base repo already holds', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const head = s.commit(s.files({ 'a.txt': 'b\n' }), [base])
    const out = await runMerge(s.reader(), input(base, head, { headInBase: true }))
    if (out.kind !== 'fast-forward') throw new Error(`expected a fast-forward, got ${out.kind}`)
    expect(out.objectCount).toBe(0)
    expect(out.newTip).toBe(head)
  })

  it('reports conflicting paths and builds nothing', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'line\n', 'ok.txt': 'x\n' }))
    const base = s.commit(s.files({ 'a.txt': 'base side\n', 'ok.txt': 'x\n' }), [root])
    const head = s.commit(s.files({ 'a.txt': 'head side\n', 'ok.txt': 'x\n' }), [root])
    const out = await runMerge(s.reader(), input(base, head))
    expect(out).toEqual({ kind: 'conflict', paths: ['a.txt'] })
  })

  it('says a head already on the base is up to date, and unrelated histories are refused', async () => {
    const s = new Store()
    const c1 = s.commit(s.files({ 'a.txt': 'a\n' }))
    const c2 = s.commit(s.files({ 'a.txt': 'b\n' }), [c1])
    expect(await planMerge(s.reader(), { baseTip: c2, headOid: c1 })).toEqual({ kind: 'up-to-date' })
    const other = s.commit(s.files({ 'z.txt': 'z\n' }))
    expect(await planMerge(s.reader(), { baseTip: c2, headOid: other })).toEqual({ kind: 'unrelated' })
  })

  it('reads the head from a second repo when the base repo does not have it', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const baseRepo = s.snapshot()
    const head = s.commit(s.files({ 'a.txt': 'a\n', 'fork.txt': 'from the fork\n' }), [base])
    const baseOnly = s.reader(baseRepo)
    await expect(runMerge(baseOnly, input(base, head))).rejects.toThrow()
    const out = await runMerge(s.reader(), input(base, head))
    expect(out.kind).toBe('fast-forward')
  })
})

describe('new-commit walk', () => {
  it('stops at commits the base repo has, including across a merge', async () => {
    const s = new Store()
    const a = s.commit(s.files({ f: '1\n' }))
    const b = s.commit(s.files({ f: '2\n' }), [a])
    const side = s.commit(s.files({ f: '1\n', g: 'g\n' }), [a])
    const m = s.commit(s.files({ f: '2\n', g: 'g\n' }), [b, side])
    const tip = s.commit(s.files({ f: '3\n', g: 'g\n' }), [m])
    expect(await newCommits(s.reader(), tip, [b])).toEqual([tip, m, side])
    expect(await newCommits(s.reader(), tip, [m])).toEqual([tip])
    expect(await newCommits(s.reader(), tip, [])).toEqual([tip, m, side, b, a])
  })
})

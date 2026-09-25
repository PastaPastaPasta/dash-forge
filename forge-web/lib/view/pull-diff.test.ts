import { describe, expect, it } from 'vitest'

import { diffTrees, loadCommitChanges } from './commit-log'
import { MODE_TREE, Store } from './diff-fixtures'
import {
  findMergeBase,
  IMPORTED_BASE_ERROR,
  loadPullComparison,
  MergeBaseSearchLimitError,
  preferring,
} from './pull-diff'

const summary = (changes: readonly { path: string; status: string }[]): string[] =>
  changes.map((c) => `${c.status[0]?.toUpperCase()} ${c.path}`)

describe('diffTrees', () => {
  it('recurses into changed subtrees and reports adds, edits and deletes', async () => {
    const s = new Store()
    const base = s.files({ 'a.txt': 'a', 'src/x.ts': 'x', 'src/y.ts': 'y', 'gone.md': 'g' })
    const head = s.files({ 'a.txt': 'a', 'src/x.ts': 'x2', 'src/z.ts': 'z', 'new.md': 'n' })
    const r = s.reader()
    const { changes, truncated } = await diffTrees({ base: r, head: r }, base, head)
    expect(truncated).toBe(false)
    expect(summary(changes)).toEqual(['D gone.md', 'A new.md', 'M src/x.ts', 'D src/y.ts', 'A src/z.ts'])
  })

  it('reports a mode-only change', async () => {
    const s = new Store()
    const blob = s.blob('#!/bin/sh\n')
    const base = s.tree([{ name: 'run.sh', oid: blob }])
    const head = s.tree([{ name: 'run.sh', oid: blob, mode: 0o100755 }])
    const r = s.reader()
    const { changes } = await diffTrees({ base: r, head: r }, base, head)
    expect(changes).toEqual([
      { path: 'run.sh', status: 'modified', baseOid: blob, headOid: blob, baseMode: 0o100644, headMode: 0o100755, oid: blob },
    ])
  })

  it('keeps the file side of a path that became a directory', async () => {
    const s = new Store()
    const base = s.files({ docs: 'a file called docs' })
    const head = s.files({ 'docs/index.md': 'now a directory' })
    const r = s.reader()
    const { changes } = await diffTrees({ base: r, head: r }, base, head)
    expect(summary(changes)).toEqual(['D docs', 'A docs/index.md'])
  })

  it('fails rather than reporting a phantom change when a tree cannot be read', async () => {
    const s = new Store()
    const sub = s.files({ 'f.txt': 'f' })
    const base = s.tree([{ name: 'dir', oid: sub, mode: MODE_TREE }])
    const head = s.files({ 'dir/f.txt': 'g' })
    const onlyHead = s.reader(new Set([base, head, ...s.snapshot()].filter((o) => o !== sub)))
    await expect(diffTrees({ base: onlyHead, head: onlyHead }, base, head)).rejects.toThrow('object not in locator')
  })

  it('reads the base side and the head side through their own readers', async () => {
    const s = new Store()
    const base = s.files({ 'f.txt': 'old' })
    const baseRepo = s.snapshot()
    const head = s.files({ 'f.txt': 'new' })
    const headRepo = new Set([...s.snapshot()].filter((o) => !baseRepo.has(o)))
    const { changes } = await diffTrees({ base: s.reader(baseRepo), head: s.reader(headRepo) }, base, head)
    expect(summary(changes)).toEqual(['M f.txt'])
  })

  it('stops at the node cap and says so', async () => {
    const s = new Store()
    const files: Record<string, string> = {}
    for (let i = 0; i < 2100; i++) files[`f${i}`] = `${i}`
    const head = s.files(files)
    const r = s.reader()
    const { changes, truncated } = await diffTrees({ base: r, head: r }, null, head)
    expect(truncated).toBe(true)
    expect(changes.length).toBe(2000)
  })
})

describe('loadCommitChanges', () => {
  it('diffs a commit against its first parent, and a root commit against nothing', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a' }))
    const child = s.commit(s.files({ 'a.txt': 'a', 'b.txt': 'b' }), [root])
    const r = s.reader()
    expect(summary((await loadCommitChanges(r, root)).changes)).toEqual(['A a.txt'])
    expect(summary((await loadCommitChanges(r, child)).changes)).toEqual(['A b.txt'])
  })
})

describe('findMergeBase', () => {
  it('finds the fork point of two branches', async () => {
    const s = new Store()
    const t = s.files({ f: '1' })
    const root = s.commit(t)
    const common = s.commit(t, [root])
    const headParent = s.commit(t, [common])
    const base = s.commit(t, [common])
    const head = s.commit(t, [headParent])
    await expect(findMergeBase(s.reader(), base, head)).resolves.toBe(common)
  })

  it('returns the head itself once the base contains it', async () => {
    const s = new Store()
    const t = s.files({ f: '1' })
    const head = s.commit(t)
    const merged = s.commit(t, [head])
    await expect(findMergeBase(s.reader(), merged, head)).resolves.toBe(head)
  })

  it('finds a base that is an ancestor of the head', async () => {
    const s = new Store()
    const t = s.files({ f: '1' })
    const base = s.commit(t)
    const head = s.commit(t, [s.commit(t, [base])])
    await expect(findMergeBase(s.reader(), base, head)).resolves.toBe(base)
  })

  it('follows a merge commit into its second parent', async () => {
    const s = new Store()
    const t = s.files({ f: '1' })
    const root = s.commit(t)
    const side = s.commit(t, [root])
    const main = s.commit(t, [root])
    const merge = s.commit(t, [main, side])
    const head = s.commit(t, [side])
    await expect(findMergeBase(s.reader(), merge, head)).resolves.toBe(side)
  })

  it('is not fooled by a skewed committer clock into an older common ancestor', async () => {
    const s = new Store()
    const t = s.files({ f: '1' })
    const root = s.commitAt(t, [], 1)
    const fork = s.commitAt(t, [root], 2)
    const base = s.commitAt(t, [fork], 3)
    // The head merges `root` directly and, through a commit with a skewed (too old) clock,
    // the real fork point. A walk that stops at the first shared commit returns `root`.
    const skewed = s.commitAt(t, [fork], 0)
    const head = s.commitAt(t, [skewed, root], 10)
    await expect(findMergeBase(s.reader(), base, head)).resolves.toBe(fork)
  })

  it('returns null for unrelated histories, and rejects rather than answering when the cap is reached', async () => {
    const s = new Store()
    const t = s.files({ f: '1' })
    const a = s.commit(t, [], 'a')
    const b = s.commit(t, [], 'b')
    await expect(findMergeBase(s.reader(), a, b)).resolves.toBeNull()

    let tip = s.commit(t, [], 'root')
    const root = tip
    for (let i = 0; i < 20; i++) tip = s.commit(t, [tip], `c${i}`)
    // Stopping early is not evidence of unrelated histories — it must not read as "none".
    await expect(findMergeBase(s.reader(), tip, root, 5)).rejects.toBeInstanceOf(MergeBaseSearchLimitError)
    await expect(findMergeBase(s.reader(), tip, root)).resolves.toBe(root)
  })

  it('does not settle for an early candidate when the cap stops the walk', async () => {
    const s = new Store()
    const t = s.files({ f: '1' })
    // The same skewed-clock shape as above: `root` is met first, the true base `fork` later.
    const root = s.commitAt(t, [], 1)
    const fork = s.commitAt(t, [root], 2)
    const base = s.commitAt(t, [fork], 3)
    const skewed = s.commitAt(t, [fork], 0)
    const head = s.commitAt(t, [skewed, root], 10)
    await expect(findMergeBase(s.reader(), base, head)).resolves.toBe(fork)
    for (let cap = 1; cap < 6; cap++) {
      const got = await findMergeBase(s.reader(), base, head, cap).catch((e: unknown) => e)
      // Either the right answer or an explicit "stopped" — never `root` and never "unrelated".
      if (got !== fork) expect(got).toBeInstanceOf(MergeBaseSearchLimitError)
    }
  })
})

describe('loadPullComparison', () => {
  /** A base repo with `main`, and a fork holding a two-commit PR branched from it. */
  function forkedPull() {
    const s = new Store()
    const c0 = s.commit(s.files({ 'readme.md': 'hello\n', 'lib.ts': 'one\ntwo\n' }))
    const c1 = s.commit(s.files({ 'readme.md': 'hello world\n', 'lib.ts': 'one\ntwo\n' }), [c0])
    const baseRepo = s.snapshot()
    const p1 = s.commit(s.files({ 'readme.md': 'hello\n', 'lib.ts': 'one\nsecond\n' }), [c0])
    const p2 = s.commit(s.files({ 'readme.md': 'hello\n', 'lib.ts': 'one\nsecond\n', 'new.ts': 'n\n' }), [p1])
    // The fork holds its own copy of the shared history plus the PR commits.
    const sourceRepo = new Set([...s.snapshot()].filter((o) => !baseRepo.has(o) || o !== c1))
    return { s, c0, c1, p1, p2, baseRepo, sourceRepo }
  }

  it('compares a fork head against its merge base, reading each side from its repo', async () => {
    const { s, c0, c1, p2, baseRepo, sourceRepo } = forkedPull()
    const result = await loadPullComparison(
      { base: s.reader(baseRepo), head: s.reader(sourceRepo) },
      { baseTipOid: c1, baseOidAtOpen: c1, headOid: p2, merged: false, imported: false },
    )
    expect(result.comparedBaseOid).toBe(c0)
    expect(result.comparisonNote).toBeNull()
    // The base branch's own readme edit is not part of the PR.
    expect(summary(result.changes)).toEqual(['M lib.ts', 'A new.ts'])
  })

  it('fails with a clear message when the head is in neither repo', async () => {
    const { s, c1, p2, baseRepo } = forkedPull()
    const r = s.reader(baseRepo)
    await expect(
      loadPullComparison({ base: r, head: r }, { baseTipOid: c1, baseOidAtOpen: c1, headOid: p2, merged: false, imported: false }),
    ).rejects.toThrow(/PR head .* could not be read from the source repo/)
  })

  it('shows a merged PR against the base tip recorded when it was opened', async () => {
    const { s, c0, c1, p2 } = forkedPull()
    const mergeCommit = s.commit(s.files({ 'readme.md': 'hello world\n', 'lib.ts': 'one\nsecond\n', 'new.ts': 'n\n' }), [c1, p2])
    const r = s.reader()
    const result = await loadPullComparison(
      { base: r, head: r },
      { baseTipOid: mergeCommit, baseOidAtOpen: c1, headOid: p2, merged: true, imported: false },
    )
    expect(result.comparedBaseOid).toBe(c0)
    expect(result.comparisonNote).toMatch(/when this PR was opened.*because the PR is merged/)
    expect(summary(result.changes)).toEqual(['M lib.ts', 'A new.ts'])
  })

  it('does not walk the merged tip first for a merged PR', async () => {
    const { s, c1, p2 } = forkedPull()
    let tip = s.commit(s.files({ x: '1' }), [c1, p2])
    for (let i = 0; i < 30; i++) tip = s.commit(s.files({ x: `${i}` }), [tip])
    const r = s.reader()
    s.reads.length = 0
    await loadPullComparison({ base: r, head: r }, { baseTipOid: tip, baseOidAtOpen: c1, headOid: p2, merged: true, imported: false })
    expect(s.reads).not.toContain(tip)
  })

  it('says why when it falls back from the current tip to the tip at open', async () => {
    const { s, c0, c1, p2 } = forkedPull()
    const unrelated = s.commit(s.files({ other: 'x' }))
    const r = s.reader()
    const result = await loadPullComparison(
      { base: r, head: r },
      { baseTipOid: unrelated, baseOidAtOpen: c1, headOid: p2, merged: false, imported: false },
    )
    expect(result.comparedBaseOid).toBe(c0)
    expect(result.comparisonNote).toMatch(/current tip: no common ancestor/)
    expect(result.comparisonNote).not.toMatch(/merged/)
  })

  it('hands back fallback readers so a patch can read a blob held only by the other repo', async () => {
    const { s, c1, p2, baseRepo } = forkedPull()
    const sourceOnlyHead = new Set([...s.snapshot()].filter((o) => !baseRepo.has(o)))
    const result = await loadPullComparison(
      { base: s.reader(baseRepo), head: s.reader(sourceOnlyHead) },
      { baseTipOid: c1, baseOidAtOpen: c1, headOid: p2, merged: false, imported: false },
    )
    // The PR's history reaches the shared base commit, which only the base repo holds.
    for (const c of result.changes) {
      if (c.headOid) await expect(result.sides.head.readObject(c.headOid)).resolves.toBeDefined()
      if (c.baseOid) await expect(result.sides.base.readObject(c.baseOid)).resolves.toBeDefined()
    }
  })

  it('falls back to the first parent, with a note, when base history is unreadable', async () => {
    const { s, p1, p2, sourceRepo } = forkedPull()
    const head = s.reader(sourceRepo)
    const result = await loadPullComparison(
      { base: head, head },
      { baseTipOid: 'f'.repeat(40), baseOidAtOpen: 'f'.repeat(40), headOid: p2, merged: false, imported: false },
    )
    expect(result.comparedBaseOid).toBe(p1)
    expect(result.comparisonNote).toMatch(/could not be read.*first parent/s)
    expect(summary(result.changes)).toEqual(['A new.ts'])
  })

  it('shows a root head commit in full when the base has no tip', async () => {
    const s = new Store()
    const head = s.commit(s.files({ 'a.txt': 'a' }))
    const r = s.reader()
    const result = await loadPullComparison({ base: r, head: r }, { baseTipOid: '', baseOidAtOpen: '', headOid: head, merged: false, imported: false })
    expect(result.comparedBaseOid).toBe('')
    expect(result.comparisonNote).toMatch(/no recorded tip.*root head commit/)
    expect(summary(result.changes)).toEqual(['A a.txt'])
  })

  it('refuses an inexact comparison for an imported PR', async () => {
    const { s, p2, sourceRepo } = forkedPull()
    const r = s.reader(sourceRepo)
    await expect(
      loadPullComparison({ base: r, head: r }, { baseTipOid: '9'.repeat(40), baseOidAtOpen: '9'.repeat(40), headOid: p2, merged: false, imported: true }),
    ).rejects.toThrow(IMPORTED_BASE_ERROR)
  })

  it('refuses an imported comparison whose every recorded target already contains the head', async () => {
    const s = new Store()
    const t = s.files({ f: '1' })
    const head = s.commit(t, [s.commit(t)])
    const target = s.commit(t, [head])
    const r = s.reader()
    await expect(
      loadPullComparison({ base: r, head: r }, { baseTipOid: target, baseOidAtOpen: target, headOid: head, merged: false, imported: true }),
    ).rejects.toThrow(IMPORTED_BASE_ERROR)
  })
})

describe('preferring', () => {
  it('reads from the preferred reader first and falls back on a miss', async () => {
    const s = new Store()
    const a = s.blob('a')
    const aOnly = s.snapshot()
    const b = s.blob('b')
    const primary = s.reader(aOnly)
    const both = preferring(primary, s.reader())
    s.reads.length = 0
    await both.readObject(a)
    expect(s.reads).toEqual([a])
    s.reads.length = 0
    await both.readObject(b)
    expect(s.reads).toEqual([b, b])
    await expect(both.readObject('0'.repeat(40))).rejects.toThrow('object not in locator')
  })
})

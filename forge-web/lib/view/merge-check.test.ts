import { describe, expect, it } from 'vitest'

import { Store } from './diff-fixtures'
import { checkMerge, unrecordedMergeLikely } from './merge-check'

/**
 * A base with two commits and a PR branched off the first: the same shapes as `dg`'s
 * `facts_from_git_label_real_squashed_and_fake_merges`, read through the browser's readers.
 */
function repo() {
  const s = new Store()
  const root = s.commit(s.files({ 'a.txt': 'a' }))
  const base1 = s.commit(s.files({ 'a.txt': 'a', 'b.txt': 'b' }), [root])
  const head = s.commit(s.files({ 'a.txt': 'a', 'c.txt': 'c' }), [root])
  const both = s.files({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' })
  const merged = s.commit(both, [base1, head])
  const squashed = s.commit(both, [base1])
  const other = s.commit(s.files({ 'a.txt': 'a', 'b.txt': 'b', 'z.txt': 'z' }), [base1])
  const r = s.reader()
  return { s, sides: { base: r, head: r }, root, base1, head, merged, squashed, other }
}

describe('checkMerge — does a recorded merge contain its PR', () => {
  it('labels a merge commit, a squash, an unrelated commit and an old tip', async () => {
    const { sides, root, base1, head, merged, squashed, other } = repo()
    expect((await checkMerge(sides, { headOid: head, mergeOid: merged, tipBefore: base1 })).verdict).toBe('contains')
    expect(await checkMerge(sides, { headOid: head, mergeOid: squashed, tipBefore: base1 })).toEqual({ verdict: 'squash', combined: [] })
    expect((await checkMerge(sides, { headOid: head, mergeOid: other, tipBefore: base1 })).verdict).toBe('missing')
    expect((await checkMerge(sides, { headOid: head, mergeOid: base1, tipBefore: root })).verdict).toBe('missing')
  })

  it('a fast-forward to the head contains it without reading anything else', async () => {
    const { sides, root, head } = repo()
    expect((await checkMerge(sides, { headOid: head, mergeOid: head, tipBefore: root })).verdict).toBe('contains')
  })

  it('says unknown, never missing, when the commits cannot be read', async () => {
    const { s, base1, head, squashed } = repo()
    const without = s.reader(new Set([...s.snapshot()].filter((o) => o !== head)))
    const c = await checkMerge({ base: without, head: without }, { headOid: head, mergeOid: squashed, tipBefore: base1 })
    expect(c.verdict).toBe('unknown')
  })
})

describe('unrecordedMergeLikely — the cheap look before the full check', () => {
  it('is likely for a merge commit with the head as a parent, or a tip changing only PR paths', async () => {
    const { sides, base1, head, merged, squashed, other } = repo()
    const prPaths = new Set(['c.txt'])
    expect(await unrecordedMergeLikely(sides, { tip: merged, prev: base1, head, prPaths })).toBe(true)
    expect(await unrecordedMergeLikely(sides, { tip: squashed, prev: base1, head, prPaths })).toBe(true)
    // An ordinary new commit on the base, touching a path the PR doesn't: no full check.
    expect(await unrecordedMergeLikely(sides, { tip: other, prev: base1, head, prPaths })).toBe(false)
    // The PR's own path list is incomplete: the full check decides.
    expect(await unrecordedMergeLikely(sides, { tip: other, prev: base1, head, prPaths: null })).toBe(true)
  })

  it('is not likely when the tip is not built on the tip before it', async () => {
    const { sides, head, merged, other } = repo()
    expect(await unrecordedMergeLikely(sides, { tip: other, prev: head, head: merged, prPaths: new Set(['z.txt']) })).toBe(false)
  })
})

describe('unrecordedMergeLikely — merges the tip no longer is', () => {
  it('finds a merge commit followed by another push, and one of several merges in a row', async () => {
    const { s, base1, head, merged } = repo()
    const later = s.commit(s.files({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'd.txt': 'd' }), [merged])
    const r = s.reader()
    const sides = { base: r, head: r }
    // Two pushes: the merge, then another commit; the tip before the current one is the merge.
    expect(await unrecordedMergeLikely(sides, { tip: later, prev: merged, head, prPaths: new Set(['c.txt']) })).toBe(true)
    // Several merges in one push: the PR's merge is behind another merge on the first-parent line.
    const other = s.commit(s.files({ 'e.txt': 'e' }), [])
    const second = s.commit(s.files({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'e.txt': 'e' }), [merged, other])
    const r2 = s.reader()
    expect(await unrecordedMergeLikely({ base: r2, head: r2 }, { tip: second, prev: base1, head, prPaths: new Set(['c.txt']) })).toBe(true)
  })

  it('takes the comparison\'s own finding that the tip contains the head', async () => {
    const { sides, base1, head, other } = repo()
    expect(await unrecordedMergeLikely(sides, { tip: other, prev: base1, head, prPaths: new Set(['zz']), tipContainsHead: true })).toBe(true)
  })
})

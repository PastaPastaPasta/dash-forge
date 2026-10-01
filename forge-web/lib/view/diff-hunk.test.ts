import { describe, expect, it } from 'vitest'

import { commentedSpan, parseDiffHunk, shownHunk } from './diff-hunk'
import { toCommentView } from './issues-view'

const HUNK = '@@ -10,4 +10,5 @@ fn main() {\n a\n-b\n+B\n+C\n d\n\\ No newline at end of file'

describe('parseDiffHunk (QW2-010)', () => {
  it('numbers each line on the side it belongs to', () => {
    const h = parseDiffHunk(HUNK)!
    expect(h.header).toBe('@@ -10,4 +10,5 @@ fn main() {')
    expect(h.lines.map((l) => [l.kind, l.old, l.new, l.text])).toEqual([
      ['context', 10, 10, 'a'],
      ['del', 11, null, 'b'],
      ['add', null, 11, 'B'],
      ['add', null, 12, 'C'],
      ['context', 12, 13, 'd'],
      ['note', null, null, '\\ No newline at end of file'],
    ])
  })

  it('marks the commented lines, the hunk\'s tail, on their side only', () => {
    const h = '@@ -10,4 +10,4 @@\n a\n-b\n+B\n+C\n-c'
    // a two-line comment on the new side: the last two new-side lines (the removed line between is not one)
    const right = parseDiffHunk(h, { side: 1, span: commentedSpan(12, 11) })!
    expect(right.lines.filter((l) => l.marked).map((l) => l.text)).toEqual(['B', 'C'])
    const left = parseDiffHunk(h, { side: 0, span: 1 })!
    expect(left.lines.filter((l) => l.marked).map((l) => l.text)).toEqual(['c'])
    // a context line counts on either side
    const ctx = parseDiffHunk('@@ -1,2 +1,2 @@\n-x\n a', { side: 1, span: 1 })!
    expect(ctx.lines.filter((l) => l.marked).map((l) => l.text)).toEqual(['a'])
    // a file-level comment marks nothing
    expect(parseDiffHunk(h, { side: null, span: 1 })!.lines.some((l) => l.marked)).toBe(false)
    expect(commentedSpan(5, null)).toBe(1)
    expect(commentedSpan(5, 9)).toBe(1)
  })

  it('refuses what is not a hunk, so it shows as plain text', () => {
    expect(parseDiffHunk('not a hunk\n+a')).toBeNull()
    expect(parseDiffHunk('@@ -1 +1 @@\n*weird')).toBeNull()
    expect(parseDiffHunk('')).toBeNull()
    // an empty line is context that lost its space
    expect(parseDiffHunk('@@ -1,2 +1,2 @@\n a\n\n')!.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ['context', 1, 1],
      ['context', 2, 2],
    ])
  })

  it('reads a header without counts', () => {
    expect(parseDiffHunk('@@ -3 +3 @@\n-x\n+y')!.lines.map((l) => [l.old, l.new])).toEqual([
      [3, null],
      [null, 3],
    ])
  })
})

describe('shownHunk (QW2-010)', () => {
  const MIRROR = 'MirrorMirrorMirrorMirrorMirrorMirrorMirror1'
  const anchor = { path: 'a.rs', line: 3, startLine: null, side: 1 as const, commitOid: '' }
  const origin = { author: 'octocat', createdAt: 1, url: 'https://github.com/o/r/pull/1#discussion_r1', host: 'github.com' }
  const c = { diffHunk: '@@ -1 +1 @@\n+a', anchor, origin, author: MIRROR }
  it('shows a mirrored comment\'s hunk only when its signer may mirror', () => {
    expect(shownHunk(c, new Set([MIRROR]))).toBe('@@ -1 +1 @@\n+a')
    expect(shownHunk(c, new Set())).toBeNull()
    expect(shownHunk(c, null)).toBeNull()
    expect(shownHunk({ ...c, origin: null }, new Set([MIRROR])), 'a native comment').toBeNull()
    expect(shownHunk({ ...c, anchor: null }, new Set([MIRROR])), 'not on a file').toBeNull()
  })
})

describe('toCommentView diffHunk', () => {
  const doc = (extra: Record<string, unknown>) => ({ $id: 'c', $ownerId: 'o', $createdAt: 1, targetId: 't', body: 'b', diffHunk: '@@ -1 +1 @@\n+a', ...extra })
  it('keeps a hunk only on an imported comment on a file', () => {
    expect(toCommentView(doc({ path: 'a.rs', imported: { author: 'x', createdAt: 1, url: 'u' } })).diffHunk).toBe('@@ -1 +1 @@\n+a')
    expect(toCommentView(doc({ path: 'a.rs' })).diffHunk).toBeNull()
    expect(toCommentView(doc({ imported: { author: 'x', createdAt: 1, url: 'u' } })).diffHunk).toBeNull()
  })
})

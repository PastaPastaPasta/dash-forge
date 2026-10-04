import { describe, expect, it } from 'vitest'

import { DIFF_HIGHLIGHT_MAX, diffSides, highlightDiff, lineHtml, wordsOnly } from './diff-highlight'
import { diffTextLines, type TextDiffLine } from './text-diff'

const OLD = ['const a = 1', '/* a comment', 'still comment */', 'return a + b', 'gone()'].join('\n')
const NEW = ['const a = 1', '/* a comment', 'still comment */', 'return a - b', 'added()'].join('\n')
const lines = (): readonly TextDiffLine[] => diffTextLines(OLD, NEW)!
const find = (all: readonly TextDiffLine[], kind: TextDiffLine['kind'], text: string): TextDiffLine => all.find((l) => l.kind === kind && l.text === text)!

describe('diffSides', () => {
  it('rebuilds the old and new files and indexes each line in them', () => {
    const all = lines()
    const s = diffSides(all)
    expect(s.oldText).toBe(OLD)
    expect(s.newText).toBe(NEW)
    expect(s.oldIndex.get(find(all, 'deleted', 'return a + b'))).toBe(3)
    expect(s.newIndex.get(find(all, 'added', 'return a - b'))).toBe(3)
    expect(s.newIndex.has(find(all, 'deleted', 'gone()'))).toBe(false)
  })
})

describe('lineHtml', () => {
  it('marks the changed word of a paired line before any syntax colours load, and escapes', () => {
    const all = diffTextLines('if (a < b) x()', 'if (a > b) x()')!
    const h = wordsOnly(all)
    expect(lineHtml(h, find(all, 'deleted', 'if (a < b) x()'), 'old')).toBe('if (a <mark class="diff-del-word">&lt;</mark> b) x()')
    expect(lineHtml(h, find(all, 'added', 'if (a > b) x()'), 'new')).toBe('if (a <mark class="diff-add-word">&gt;</mark> b) x()')
  })

  it('leaves context and unpaired lines plain until highlighted', () => {
    const all = diffTextLines('a\nb', 'a\nb\nc')!
    const h = wordsOnly(all)
    expect(lineHtml(h, find(all, 'context', 'a'), 'new')).toBeNull()
    expect(lineHtml(h, find(all, 'added', 'c'), 'new')).toBeNull()
  })

  it('colours each side by the file name, carrying a multi-line comment across lines, with word marks inside', async () => {
    const all = lines()
    const h = await highlightDiff(wordsOnly(all), 'x.ts', 'x.ts')
    expect(lineHtml(h, find(all, 'context', 'still comment */'), 'new')).toContain('hljs-comment')
    const changed = lineHtml(h, find(all, 'added', 'return a - b'), 'new')!
    expect(changed).toContain('hljs-keyword')
    expect(changed).toContain('<mark class="diff-add-word">-</mark>')
  })

  it('does not guess a language for a name it does not know', async () => {
    const all = lines()
    const h = await highlightDiff(wordsOnly(all), 'NOTES', 'NOTES')
    expect(h.old).toBeNull()
    expect(h.new).toBeNull()
  })

  it('leaves both sides plain when one is too long to colour', async () => {
    const all: TextDiffLine[] = [
      { kind: 'deleted', text: 'let a = 1', oldLine: 1, newLine: null },
      { kind: 'added', text: 'let a = 2', oldLine: null, newLine: 1 },
      { kind: 'added', text: `const s = '${'x'.repeat(DIFF_HIGHLIGHT_MAX)}'`, oldLine: null, newLine: 2 },
    ]
    const h = await highlightDiff(wordsOnly(all), 'x.ts', 'x.ts')
    expect(h.old).toBeNull()
    expect(h.new).toBeNull()
    // The word marks are still there.
    expect(lineHtml(h, find(all, 'added', 'let a = 2'), 'new')).toContain('<mark class="diff-add-word">2</mark>')
  })

  it('highlights only the side an added file has', async () => {
    const all = diffTextLines('', 'fn main() {}\n')!
    const h = await highlightDiff(wordsOnly(all), 'main.rs', 'main.rs')
    expect(h.old).toBeNull()
    expect(h.new).not.toBeNull()
  })
})

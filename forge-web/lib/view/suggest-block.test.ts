import { describe, expect, it } from 'vitest'

import { parseSuggestions } from '@/lib/rules/suggestion'
import { insertSuggestion, linesAt, suggestionFence } from './suggest-block'

const HEAD = 'ab'.repeat(20)

describe('insertSuggestion', () => {
  it('writes a block pre-filled with the lines, which parses back to them', () => {
    const out = insertSuggestion('', 0, 0, ['    let x = 1;', '    let y = 2;'])
    expect(out.body).toBe('```suggestion\n    let x = 1;\n    let y = 2;\n```\n')
    expect(parseSuggestions(out.body)).toEqual([{ text: '    let x = 1;\n    let y = 2;' }])
    // The caret ends the suggested text, ready to edit it.
    expect(out.body.slice(0, out.caret).endsWith('let y = 2;')).toBe(true)
  })

  it('puts the block on lines of its own after text already typed, keeping what follows', () => {
    const out = insertSuggestion('Rename this:', 12, 12, ['a'])
    expect(out.body).toBe('Rename this:\n\n```suggestion\na\n```\n')
    const mid = insertSuggestion('before\nafter', 7, 7, ['x'])
    expect(mid.body).toBe('before\n\n```suggestion\nx\n```\nafter')
  })

  it('replaces the selection', () => {
    expect(insertSuggestion('keep DROP keep', 5, 9, ['z']).body).toBe('keep \n\n```suggestion\nz\n```\n keep')
  })

  it('fences longer than any backtick run in the lines, so none closes the block early', () => {
    expect(suggestionFence(['plain'])).toBe('```')
    const lines = ['```', 'code ```` here']
    const out = insertSuggestion('', 0, 0, lines)
    expect(out.body.startsWith('`````suggestion\n')).toBe(true)
    expect(parseSuggestions(out.body)).toEqual([{ text: lines.join('\n') }])
  })
})

describe('linesAt', () => {
  const text = 'one\ntwo\nthree\n'
  it('reads the anchored lines of the new side on the head', () => {
    expect(linesAt(text, { path: 'f', line: 2, side: 1, commitOid: HEAD }, HEAD)).toEqual(['two'])
    expect(linesAt(text, { path: 'f', line: 3, startLine: 1, side: 1, commitOid: HEAD.toUpperCase() }, HEAD)).toEqual(['one', 'two', 'three'])
  })

  it('refuses the old side, another head, a missing text and lines out of range', () => {
    expect(linesAt(text, { path: 'f', line: 2, side: 0, commitOid: HEAD }, HEAD)).toBeNull()
    expect(linesAt(text, { path: 'f', line: 2, side: 1, commitOid: 'cd'.repeat(20) }, HEAD)).toBeNull()
    expect(linesAt(null, { path: 'f', line: 2, side: 1, commitOid: HEAD }, HEAD)).toBeNull()
    expect(linesAt(text, { path: 'f', line: 9, side: 1, commitOid: HEAD }, HEAD)).toBeNull()
    expect(linesAt(text, { path: 'f', line: 1, startLine: 2, side: 1, commitOid: HEAD }, HEAD)).toBeNull()
    expect(linesAt(text, { path: 'f', side: 1, commitOid: HEAD }, HEAD)).toBeNull()
  })
})

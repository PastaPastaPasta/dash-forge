import { describe, expect, it } from 'vitest'
import { countLines, fileLines } from './blob-content'

describe('countLines', () => {
  it('agrees with fileLines', () => {
    for (const t of ['', '\n', 'a', 'a\n', 'a\nb', 'a\nb\n', 'a\n\n', '\n\n\n', 'a\r\nb\r\n']) expect(countLines(t)).toBe(fileLines(t).length)
  })
})

describe('fileLines', () => {
  it('drops the empty line after a final newline', () => {
    expect(fileLines('a\nb\n')).toEqual(['a', 'b'])
    expect(fileLines('a\r\nb\r\n')).toEqual(['a\r', 'b\r'])
  })
  it('keeps a last line with no newline', () => {
    expect(fileLines('a\nb')).toEqual(['a', 'b'])
  })
  it('keeps blank lines before the final newline', () => {
    expect(fileLines('a\n\n')).toEqual(['a', ''])
  })
  it('numbers an empty file, and a lone newline, as one empty line', () => {
    expect(fileLines('')).toEqual([''])
    expect(fileLines('\n')).toEqual([''])
  })
})

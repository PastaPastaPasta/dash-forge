import { describe, expect, it } from 'vitest'
import { applyFormat, formatForKey } from './markdown-format'

describe('applyFormat', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(applyFormat('a word here', 2, 6, 'bold')).toEqual({ value: 'a **word** here', start: 4, end: 8 })
    expect(applyFormat('a word here', 2, 6, 'italic')).toEqual({ value: 'a _word_ here', start: 3, end: 7 })
    expect(applyFormat('a word here', 2, 6, 'code')).toEqual({ value: 'a `word` here', start: 3, end: 7 })
  })

  it('unwraps a selection that is wrapped already', () => {
    expect(applyFormat('a **word** here', 4, 8, 'bold')).toEqual({ value: 'a word here', start: 2, end: 6 })
  })

  it('puts an empty mark pair at the caret', () => {
    expect(applyFormat('ab', 1, 1, 'bold')).toEqual({ value: 'a****b', start: 3, end: 3 })
  })

  it('makes a link, selecting the part left to type', () => {
    expect(applyFormat('see docs', 4, 8, 'link')).toEqual({ value: 'see [docs](url)', start: 11, end: 14 })
    const url = 'see https://example.org'
    expect(applyFormat(url, 4, url.length, 'link')).toEqual({ value: 'see [text](https://example.org)', start: 5, end: 9 })
  })

  it('maps keys to formats', () => {
    expect(formatForKey('b')).toBe('bold')
    expect(formatForKey('I')).toBe('italic')
    expect(formatForKey('e')).toBe('code')
    expect(formatForKey('k')).toBe('link')
    expect(formatForKey('x')).toBeNull()
  })
})

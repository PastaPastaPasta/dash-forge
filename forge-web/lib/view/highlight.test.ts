/**
 * Syntax-highlight line-splitting correctness.
 *
 * The blob view only swaps in highlighted lines when their count matches the plain line
 * count (else it stays plain). So the load-bearing property is: `highlightBlob` returns
 * exactly one HTML fragment per source line, and stripping the markup reproduces the source.
 */

import { describe, expect, it } from 'vitest'

import { highlightBlob } from './highlight'

/** Strip tags and unescape the entities highlight.js emits — recovering the source text. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
}

describe('highlightBlob', () => {
  it('returns one line per source line and preserves the text (typescript)', async () => {
    const src = [
      'export function add(a: number, b: number): number {',
      '  // sum two numbers',
      '  const total = a + b',
      '  return total',
      '}',
      '',
    ].join('\n')

    const result = await highlightBlob(src, 'math.ts')
    expect(result).not.toBeNull()
    expect(result?.language).toBe('typescript')
    expect(result?.lines.length).toBe(src.split('\n').length)
    expect(result?.lines.map(stripHtml).join('\n')).toBe(src)
  })

  it('reopens spans that straddle a line break without losing text', async () => {
    // A block comment spans several lines — the span must be closed/reopened per line.
    const src = ['/*', ' multi', ' line', '*/', 'const x = 1'].join('\n')
    const result = await highlightBlob(src, 'x.ts')
    expect(result?.lines.length).toBe(5)
    expect(result?.lines.map(stripHtml).join('\n')).toBe(src)
  })

  it('falls back to null for an unknown extension with low auto-relevance (prose)', async () => {
    const src = 'just some plain english prose with no code structure at all\n'
    expect(await highlightBlob(src, 'notes.unknownext')).toBeNull()
  })

  it('highlights by extension → language mapping (rust)', async () => {
    const src = 'fn main() {\n    println!("hi");\n}\n'
    const result = await highlightBlob(src, 'main.rs')
    expect(result?.language).toBe('rust')
    expect(result?.lines.map(stripHtml).join('\n')).toBe(src)
  })
})

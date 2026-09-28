import { describe, expect, it } from 'vitest'

import { parseMarkdown } from './markdown'

describe('a ```suggestion block', () => {
  it('parses as a code block with lang "suggestion" (the view renders it as a diff)', () => {
    const blocks = parseMarkdown('Use two.\n\n```suggestion\n    2\n```\n')
    expect(blocks.map((b) => b.t)).toEqual(['paragraph', 'code'])
    const code = blocks[1] as { t: 'code'; lang: string; v: string }
    expect(code.lang).toBe('suggestion')
    expect(code.v).toBe('    2')
  })
})

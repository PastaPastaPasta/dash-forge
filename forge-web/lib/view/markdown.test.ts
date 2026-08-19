import { describe, expect, it } from 'vitest'
import { parseMarkdown, type Inline } from './markdown'

function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      if (node.t === 'text' || node.t === 'code') return node.v
      if (node.t === 'image') return node.alt
      return inlineText(node.c)
    })
    .join('')
}

describe('parseMarkdown GFM tables', () => {
  it('parses the DIP summary table into headers and rows', () => {
    const source = [
      'Number | Layer | Title | Owner | Type | Status',
      '--- | --- | --- | --- | --- | ---',
      '[1](dip-0001.md) | Consensus | Initial Scaling | Darren Tapp | Standard | Final',
      '[2](dip-0002.md) | Consensus | Special Transactions | Samuel Westrich | Standard | Final',
    ].join('\n')

    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    const table = blocks[0]
    expect(table?.t).toBe('table')
    if (!table || table.t !== 'table') return

    expect(table.header.map(inlineText)).toEqual(['Number', 'Layer', 'Title', 'Owner', 'Type', 'Status'])
    expect(table.rows).toHaveLength(2)
    expect(table.rows[0]?.map(inlineText)).toEqual([
      '1',
      'Consensus',
      'Initial Scaling',
      'Darren Tapp',
      'Standard',
      'Final',
    ])
  })

  it('honors alignment and pipes escaped or enclosed in code spans', () => {
    const source = [
      '| Name | Score | Example |',
      '| :--- | ---: | :---: |',
      '| left \\| right | 42 | `a|b` |',
    ].join('\n')

    const table = parseMarkdown(source)[0]
    expect(table?.t).toBe('table')
    if (!table || table.t !== 'table') return

    expect(table.align).toEqual(['left', 'right', 'center'])
    expect(table.rows[0]?.map(inlineText)).toEqual(['left | right', '42', 'a|b'])
  })

  it('pads short rows and leaves ordinary pipe prose as a paragraph', () => {
    const source = [
      'A | B | C',
      '--- | --- | ---',
      'one | two',
      '',
      'This | is ordinary prose.',
      '',
      'This \\| is escaped prose.',
      '---',
    ].join('\n')
    const blocks = parseMarkdown(source)
    expect(blocks.map((block) => block.t)).toEqual(['table', 'paragraph', 'paragraph', 'hr'])
    const table = blocks[0]
    if (!table || table.t !== 'table') return
    expect(table.rows[0]?.map(inlineText)).toEqual(['one', 'two', ''])
  })
})

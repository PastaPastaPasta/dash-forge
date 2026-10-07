import { describe, expect, it } from 'vitest'
import { runWithDeadline } from './fuzz-fixtures'
import { MARKDOWN_MAX_NODES, parseMarkdown, splitRefs, type Block, type Inline } from './markdown'

describe('splitRefs (#n and @name autolinks)', () => {
  it('finds issue references and mentions at word boundaries', () => {
    expect(splitRefs('see #12 and @alice.')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'ref', n: 12 },
      { t: 'text', v: ' and ' },
      { t: 'mention', name: 'alice', label: 'alice' },
      { t: 'text', v: '.' },
    ])
    expect(splitRefs('#3 first')).toEqual([{ t: 'ref', n: 3 }, { t: 'text', v: ' first' }])
    expect(splitRefs('(@Bob.dash)')).toEqual([{ t: 'text', v: '(' }, { t: 'mention', name: 'bob', label: 'Bob' }, { t: 'text', v: ')' }])
  })

  it('leaves emails, fragments, hex and inner hashes alone', () => {
    for (const s of ['mail x@example.com now', 'a#1', 'color #1f883d', 'path/#2', 'issue#4', '#12abc', 'user@@x', 'foo@bar']) {
      expect(splitRefs(s).filter((p) => p.t !== 'text')).toEqual([])
    }
  })

  it('returns the text unchanged when there is nothing to link', () => {
    expect(splitRefs('plain text')).toEqual([{ t: 'text', v: 'plain text' }])
    expect(splitRefs('')).toEqual([])
  })
})

function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      if (node.t === 'text' || node.t === 'code') return node.v
      if (node.t === 'image') return node.alt
      if (node.t === 'br') return '\n'
      if (node.t === 'fnref') return `[${node.n}]`
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
      '',
      '---',
    ].join('\n')
    const blocks = parseMarkdown(source)
    expect(blocks.map((block) => block.t)).toEqual(['table', 'paragraph', 'paragraph', 'hr'])
    const table = blocks[0]
    if (!table || table.t !== 'table') return
    expect(table.rows[0]?.map(inlineText)).toEqual(['one', 'two', ''])
  })
})

describe('parseMarkdown line terminators (D-900)', () => {
  const markdownUrl = new URL('./markdown.ts', import.meta.url)

  /** Parse in a worker with a deadline, so a regression fails instead of hanging the run. */
  async function parseWithDeadline(source: string): Promise<Block[]> {
    const result = await runWithDeadline(markdownUrl, 'parseMarkdown', [[source]], 2_000, true)
    expect(result.timedOut, `parseMarkdown(${JSON.stringify(source)}) did not return`).toBe(false)
    return result.timedOut ? [] : (result.results[0] as Block[])
  }

  it.each([
    ['bare CR', '\r'],
    ['CRLF', '\r\n'],
  ])('treats %s as a line ending', async (_name, nl) => {
    const blocks = await parseWithDeadline(`# a${nl}## Feature${nl}${nl}- one${nl}- two${nl}${nl}text${nl}more`)
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'heading', 'list', 'paragraph'])
    const [h1, h2, list, para] = blocks
    if (h1?.t === 'heading') expect(inlineText(h1.c)).toBe('a')
    if (h2?.t === 'heading') expect([h2.level, inlineText(h2.c)]).toEqual([2, 'Feature'])
    if (list?.t === 'list') expect(list.items.map(inlineText)).toEqual(['one', 'two'])
    if (para?.t === 'paragraph') expect(inlineText(para.c)).toBe('text more')
  })

  // CommonMark (and GitHub) end lines only on LF, CR and CRLF; the rest are spaces there.
  it.each([
    ['LINE SEPARATOR', '\u2028'],
    ['PARAGRAPH SEPARATOR', '\u2029'],
    ['NEL', '\u0085'],
    ['form feed', '\f'],
    ['vertical tab', '\v'],
  ])('treats %s as a space, not a line ending', async (_name, sep) => {
    expect(await parseWithDeadline(`# a${sep}b`)).toEqual([{ t: 'heading', level: 1, c: [{ t: 'text', v: 'a b' }] }])
    expect(await parseWithDeadline(`one${sep}- two`)).toEqual([{ t: 'paragraph', c: [{ t: 'text', v: 'one - two' }] }])
  })

  it.each(['#', '-', '1.', '>', '***', '```'])('returns for a %s marker right before U+2028, U+2029 or a lone CR', async (marker) => {
    for (const sep of ['\u2028', '\u2029', '\r', '\u2028\r\n\u2029\r']) {
      expect((await parseWithDeadline(`${marker}${sep}x`)).length).toBeGreaterThan(0)
    }
  })

  it('returns for a heading ending in U+2028 (the preact 10.10.0 release notes)', async () => {
    expect(await parseWithDeadline('# a\u2028')).toEqual([{ t: 'heading', level: 1, c: [{ t: 'text', v: 'a' }] }])
    const notes = await parseWithDeadline('## Feature\u2028\r\n\r\n* Microtick')
    expect(notes).toEqual([
      { t: 'heading', level: 2, c: [{ t: 'text', v: 'Feature' }] },
      { t: 'list', ordered: false, items: [[{ t: 'text', v: 'Microtick' }]] },
    ])
  })

  it('caps blockquote nesting and renders the rest as text', async () => {
    const blocks = await parseWithDeadline('>'.repeat(40) + ' deep')
    let depth = 0
    let node: Block | undefined = blocks[0]
    while (node?.t === 'quote') {
      depth += 1
      node = node.c[0]
    }
    expect(depth).toBe(16)
    expect(node?.t === 'paragraph' && inlineText(node.c)).toBe('>'.repeat(24) + ' deep')
  })
})

describe('parseInline grammar (the linear rewrite keeps the old regex semantics)', () => {
  const para = (source: string): Inline[] => {
    const block = parseMarkdown(source)[0]
    return block?.t === 'paragraph' ? [...block.c] : []
  }

  it('parses links, images, code, emphasis, strike and autolinks', () => {
    expect(para('see [the *docs*](https://x.io/a "title") now')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://x.io/a', c: [{ t: 'text', v: 'the ' }, { t: 'em', c: [{ t: 'text', v: 'docs' }] }] },
      { t: 'text', v: ' now' },
    ])
    expect(para('![logo](/a.png) `a*b` **b** __c__ ~~d~~ _e_')).toEqual([
      { t: 'image', src: '/a.png', alt: 'logo' },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'a*b' },
      { t: 'text', v: ' ' },
      { t: 'strong', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'strong', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'del', c: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'e' }] },
    ])
    expect(para('go https://x.io/p?q=1) end')).toEqual([
      { t: 'text', v: 'go ' },
      { t: 'link', href: 'https://x.io/p?q=1', c: [{ t: 'text', v: 'https://x.io/p?q=1' }] },
      { t: 'text', v: ') end' },
    ])
  })

  it('leaves unclosed and empty delimiters as text', () => {
    // (A lone `*` is an empty list item, as on GitHub: `x *` keeps the unpaired delimiter in text.)
    for (const s of ['[a](b', '[](x)', '[a]( x)', '[a]()', '`', '``', 'a****', '~~a~', 'x *', 'http://', 'a ![b]']) {
      expect(inlineText(para(s)), s).toBe(s)
    }
  })

  it('refuses protocol-relative links and images (off-site tracking pixels)', () => {
    for (const href of ['//evil.example/p.gif', '/\\evil.example/p.gif']) {
      expect(para(`![x](${href})`)[0], href).toEqual({ t: 'image', src: '#', alt: 'x' })
      expect(para(`[x](${href})`)[0], href).toEqual({ t: 'link', href: '#', c: [{ t: 'text', v: 'x' }] })
    }
    expect(para('[x](/docs/a.md)')[0]).toEqual({ t: 'link', href: '/docs/a.md', c: [{ t: 'text', v: 'x' }] })
  })

  it('neutralizes unsafe link schemes', () => {
    expect(para('[x](javascript:alert(1))')[0]).toEqual({ t: 'link', href: '#', c: [{ t: 'text', v: 'x' }] })
    expect(para('![x](data:text/html,hi)')[0]).toEqual({ t: 'image', src: '#', alt: 'x' })
  })
})

describe('parseMarkdown node budget (SR-01)', () => {
  const countNodes = (blocks: readonly Block[]): number => {
    const inl = (xs: readonly Inline[]): number =>
      xs.reduce((n, x) => n + 1 + ('c' in x ? inl(x.c) : 0), 0)
    return blocks.reduce((n, b) => {
      if (b.t === 'heading' || b.t === 'paragraph') return n + 1 + inl(b.c)
      if (b.t === 'list') return n + 1 + b.items.reduce((m, it) => m + 1 + inl(it), 0)
      if (b.t === 'quote') return n + 1 + countNodes(b.c)
      if (b.t === 'table') return n + 1 + [...b.header, ...b.rows.flat()].reduce((m, c) => m + 1 + inl(c), 0)
      return n + 1
    }, 0)
  }

  it('stops emitting spans past the budget and keeps the rest as text', () => {
    const blocks = parseMarkdown('*x* '.repeat(MARKDOWN_MAX_NODES * 2))
    const para = blocks[0]
    expect(blocks).toHaveLength(1)
    if (para?.t !== 'paragraph') return
    const last = para.c[para.c.length - 1]
    expect(last?.t).toBe('text')
    expect(last?.t === 'text' && last.v.endsWith('*x* *x*')).toBe(true)
    expect(countNodes(blocks)).toBeLessThanOrEqual(MARKDOWN_MAX_NODES + 2)
    // The prefix before the cut keeps its emphasis.
    expect(para.c.filter((n) => n.t === 'em').length).toBeGreaterThan(MARKDOWN_MAX_NODES / 8)
  })

  it('charges runs that can never pair as text, not as nodes', () => {
    expect(countNodes(parseMarkdown('snake_case_name and my__var__name'))).toBe(2)
    // 30,000 snake_case words spend none of the budget, so emphasis after them still renders.
    const [p] = parseMarkdown('a_b '.repeat(30_000) + '*after*')
    expect(p?.t === 'paragraph' && p.c[p.c.length - 1]).toEqual({ t: 'em', c: [{ t: 'text', v: 'after' }] })
  })

  it('bounds the inline tree\'s depth, and keeps pairing after a too-deep nest', () => {
    const depth = (ns: readonly Inline[]): number => ns.reduce((d, n) => Math.max(d, 'c' in n ? 1 + depth(n.c) : 0), 0)
    const nested = parseMarkdown('*a **b '.repeat(300) + 'x' + '** c*'.repeat(300))[0]
    expect(nested?.t === 'paragraph' && depth(nested.c)).toBeLessThanOrEqual(33)
    const later = parseMarkdown('*a '.repeat(40) + 'x' + ' b*'.repeat(40) + ' then *later em*')[0]
    expect(later?.t === 'paragraph' && later.c[later.c.length - 1]).toEqual({ t: 'em', c: [{ t: 'text', v: 'later em' }] })
  })

  it('bounds blocks, list items and table rows the same way', () => {
    for (const src of ['a\n\n'.repeat(MARKDOWN_MAX_NODES * 2), '- a\n'.repeat(MARKDOWN_MAX_NODES * 2), 'h|i\n---|---\n' + 'c|d\n'.repeat(MARKDOWN_MAX_NODES * 2)]) {
      const blocks = parseMarkdown(src)
      expect(countNodes(blocks), src.slice(0, 12)).toBeLessThan(MARKDOWN_MAX_NODES * 2.5)
      const tail = blocks[blocks.length - 1]
      expect(tail?.t === 'paragraph' && tail.c[0]?.t === 'text', src.slice(0, 12)).toBe(true)
    }
  })

  it('leaves over-wide tables as text and charges the header row', () => {
    const wide = 'a|'.repeat(174_000)
    const blocks = parseMarkdown(`${wide}\n${'-|'.repeat(174_000)}\n${wide}`)
    expect(blocks.every((b) => b.t !== 'table')).toBe(true)
    expect(countNodes(blocks)).toBeLessThan(10)
    const cols = 128
    const header = 'h|'.repeat(cols)
    const table = parseMarkdown(`${header}\n${'---|'.repeat(cols)}\n` + `${'c|'.repeat(cols)}\n`.repeat(1_000))
    expect(table[0]?.t).toBe('table')
    expect(countNodes(table)).toBeLessThan(MARKDOWN_MAX_NODES + 2 * cols + 10)
  })

  it('resets the budget for every document', () => {
    parseMarkdown('*x* '.repeat(MARKDOWN_MAX_NODES * 2))
    expect(parseMarkdown('*a*')).toEqual([{ t: 'paragraph', c: [{ t: 'em', c: [{ t: 'text', v: 'a' }] }] }])
  })
})

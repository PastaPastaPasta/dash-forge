/**
 * FG-2 (dash showcase QA ledger L-03, L-41, L-40, L-51, L-67, L-38, L-75): the renderer against
 * GitHub-flavored Markdown. Each expectation is what github.com renders for the same input
 * (checked through GitHub's `POST /markdown`, modes `gfm` and `markdown`), cited by the GFM
 * spec example number where the spec has one; the dash cases are cut from dashpay/dash.
 */

import { describe, expect, it } from 'vitest'

import { parseMarkdown, splitRefs, splitUrls, type Block, type Inline } from './markdown'

function text(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      if (n.t === 'text' || n.t === 'code') return n.v
      if (n.t === 'image') return n.alt
      if (n.t === 'br') return '\n'
      if (n.t === 'fnref') return `[${n.n}]`
      return text(n.c)
    })
    .join('')
}

/** A compact shape of blocks, for comparing structure. */
function shape(blocks: readonly Block[]): unknown[] {
  return blocks.map((b) => {
    switch (b.t) {
      case 'heading':
        return `h${b.level}:${text(b.c)}`
      case 'paragraph':
        return `p:${text(b.c)}`
      case 'hr':
        return 'hr'
      case 'code':
        return `code(${b.lang}):${b.v}`
      case 'quote':
        return { quote: shape(b.c) }
      case 'alert':
        return { alert: b.kind, c: shape(b.c) }
      case 'list':
        return {
          [b.ordered ? 'ol' : 'ul']: b.items.map((it, i) => {
            const rest = b.blocks?.[i] ?? []
            return rest.length === 0 ? text(it) : [text(it), ...shape(rest)]
          }),
          ...(b.loose ? { loose: true } : {}),
          ...(b.start !== undefined ? { start: b.start } : {}),
        }
      case 'footnotes':
        return { footnotes: b.items.map((f) => [f.n, f.label, f.refs, ...shape(f.c)]) }
      default:
        return b.t
    }
  })
}

const md = (s: string, breaks = false): unknown[] => shape(parseMarkdown(s, { breaks }))

describe('setext headings (L-03)', () => {
  it('GFM 80: === is h1 and --- is h2', () => {
    expect(md('Foo *bar*\n=========\n\nFoo *bar*\n---------')).toEqual(['h1:Foo bar', 'h2:Foo bar'])
  })

  it('GFM 81: a multi-line paragraph becomes the heading', () => {
    expect(md('Foo *bar\nbaz*\n====')).toEqual(['h1:Foo bar baz'])
  })

  it('GFM 83: any underline length, indented up to 3', () => {
    expect(md('Foo\n-------------------------\n\nFoo\n=')).toEqual(['h2:Foo', 'h1:Foo'])
    expect(md('Foo\n   ----      ')).toEqual(['h2:Foo'])
  })

  it('GFM 97: needs a paragraph right before it (a blank line in between is not one)', () => {
    expect(md('a\n\n===')).toEqual(['p:a', 'p:==='])
    expect(md('\n====')).toEqual(['p:===='])
  })

  it('GFM 94: after a list, --- is a rule, not a heading', () => {
    expect(md('- a\n---')).toEqual([{ ul: ['a'] }, 'hr'])
  })

  it('the dash README: its title is an h1 and its sections h2s, with no stray rules', () => {
    const src = [
      'Dash Core staging tree',
      '===========================',
      '',
      '|CI|master|develop|',
      '|-|-|-|',
      '|Gitlab|x|y|',
      '',
      'https://www.dash.org',
      '',
      'What is Dash?',
      '-------------',
      '',
      'Dash is an open source cryptocurrency.',
      '',
      'License',
      '-------',
      '',
      'Dash Core is released under the terms of the MIT license.',
    ].join('\n')
    const blocks = md(src)
    expect(blocks).toEqual(['h1:Dash Core staging tree', 'table', 'p:https://www.dash.org', 'h2:What is Dash?', 'p:Dash is an open source cryptocurrency.', 'h2:License', 'p:Dash Core is released under the terms of the MIT license.'])
    expect(blocks).not.toContain('hr')
  })

  it('release notes: "About this release" is an h1 and "Credits" an h2 (dash v24.0.0-rc.1)', () => {
    expect(md('About this release\n=============\n\nNotes.\n\nCredits\n-------\n\nThanks', true)).toEqual(['h1:About this release', 'p:Notes.', 'h2:Credits', 'p:Thanks'])
  })

  it('a rule after a blank line is still a rule', () => {
    expect(md('text\n\n---\n\n***')).toEqual(['p:text', 'hr', 'hr'])
  })
})

describe('line breaks: comment mode vs document mode (L-41)', () => {
  it('document mode (README): a single newline is a space', () => {
    expect(md('Line one\nline two')).toEqual(['p:Line one line two'])
  })

  it('comment mode (issues, PRs, comments, release notes): a single newline is a <br>', () => {
    expect(md('Line one\nline two  \nthree', true)).toEqual(['p:Line one\nline two\nthree'])
  })

  it('the dash #6935 body: each line on its own line, bold labels on theirs', () => {
    const src = '<!-- template -->\nExporting of transactions freezes after clicking export\nBackup freezes after clicking backup.\nForce close needed.\n\n**Expected behavior**\nHave setting functions work'
    expect(md(src, true)).toEqual([
      'p:Exporting of transactions freezes after clicking export\nBackup freezes after clicking backup.\nForce close needed.',
      'p:Expected behavior\nHave setting functions work',
    ])
  })

  it('a heading and code keep no break (only paragraphs break)', () => {
    expect(md('# a\n```\nx\ny\n```', true)).toEqual(['h1:a', 'code():x\ny'])
  })
})

describe('lists: continuation, nesting, looseness (L-41)', () => {
  it('GFM 254-ish: an indented continuation line stays in its item', () => {
    expect(md('1. item\n   continuation\n2. two', true)).toEqual([{ ol: ['item\ncontinuation', 'two'] }])
    expect(md('1. item\n   continuation\n2. two')).toEqual([{ ol: ['item continuation', 'two'] }])
  })

  it('GFM 290: a lazy (unindented) continuation line stays in its item', () => {
    expect(md('- a\nlazy')).toEqual([{ ul: ['a lazy'] }])
    expect(md('1. item\n   continuation\n2. two\nlazy line', true)).toEqual([{ ol: ['item\ncontinuation', 'two\nlazy line'] }])
  })

  it('GFM 294: a nested list is a block of its item', () => {
    expect(md('- a\n  - b\n    - c\n- d')).toEqual([{ ul: [['a', { ul: [['b', { ul: ['c'] }]] }], 'd'] }])
  })

  it('GFM 306 / 307: a blank line between items makes the list loose', () => {
    expect(md('- a\n- b\n\n- c')).toEqual([{ ul: ['a', 'b', 'c'], loose: true }])
    expect(md('- a\n- b\n- c')).toEqual([{ ul: ['a', 'b', 'c'] }])
  })

  it('a blank line between two blocks of an item makes it loose; a blank after the list does not', () => {
    expect(md('- a\n\n  more\n- b')).toEqual([{ ul: [['a', 'p:more'], 'b'], loose: true }])
    expect(md('- a\n- b\n\nafter')).toEqual([{ ul: ['a', 'b'] }, 'p:after'])
  })

  it('GFM 301: a changed bullet starts a new list', () => {
    expect(md('- a\n* b')).toEqual([{ ul: ['a'] }, { ul: ['b'] }])
  })

  it('GFM 265 / 304: ordered lists keep their start, and 1) is an ordered marker', () => {
    expect(md('3. a\n4. b')).toEqual([{ ol: ['a', 'b'], start: 3 }])
    expect(md('1) a\n2) b')).toEqual([{ ol: ['a', 'b'] }])
  })

  it('GFM 304: only a list starting at 1 interrupts a paragraph', () => {
    expect(md('The number of windows in my house is\n14.  The number of doors is 6.')).toEqual(['p:The number of windows in my house is 14.  The number of doors is 6.'])
    expect(md('para\n1. a list')).toEqual(['p:para', { ol: ['a list'] }])
  })

  it('fenced code inside an item', () => {
    expect(md('- a\n  ```\n  code\n  ```\n- b')).toEqual([{ ul: [['a', 'code():code'], 'b'] }])
  })

  it('the dash #7549 "Possible fixes": each bullet keeps its wrapped lines', () => {
    const src = [
      '- Make the snapshot write in `AddToCache` conditional on being inside a committed',
      '  transaction — read paths compute-and-cache only.',
      '- Or wrap the out-of-dbTx `GetCreditPool` callers in a rolled-back',
      '  `BeginTransaction` (read-only semantics).',
      '',
      'The assert itself is correct (it prevents writing an inconsistent evodb); the bug',
      'is on the write side.',
    ].join('\n')
    expect(md(src, true)).toEqual([
      {
        ul: [
          'Make the snapshot write in AddToCache conditional on being inside a committed\ntransaction — read paths compute-and-cache only.',
          'Or wrap the out-of-dbTx GetCreditPool callers in a rolled-back\nBeginTransaction (read-only semantics).',
        ],
      },
      'p:The assert itself is correct (it prevents writing an inconsistent evodb); the bug\nis on the write side.',
    ])
  })

  it('the dash v18.2.0-beta.1 analyzepsbt entry stays one bullet under its h2', () => {
    const src = 'New RPCs\n--------\n\n- `analyzepsbt` examines a PSBT and provides information about what\n  the PSBT contains and the next steps that need to be taken in order\n  to complete the transaction.'
    expect(md(src, true)).toEqual(['h2:New RPCs', { ul: ['analyzepsbt examines a PSBT and provides information about what\nthe PSBT contains and the next steps that need to be taken in order\nto complete the transaction.'] }])
  })

  it('keeps task lists', () => {
    const [list] = parseMarkdown('- [x] done\n  more\n- [ ] todo')
    expect(list).toMatchObject({ t: 'list', tasks: [true, false] })
  })
})

describe('review findings: lazy lines and fences in containers', () => {
  it('a lazy line follows only a paragraph: not a closed fence, heading or rule in an item', () => {
    expect(md('- item\n  ```\n  code\n  ```\nNext paragraph')).toEqual([{ ul: [['item', 'code():code']] }, 'p:Next paragraph'])
    expect(md('- # h\nfoo')).toEqual([{ ul: [['', 'h1:h']] }, 'p:foo'])
    expect(md('> ```\n> code\n> ```\nfoo')).toEqual([{ quote: ['code():code'] }, 'p:foo'])
  })

  it('a fence opened on a list marker line does not hide later reference definitions', () => {
    const blocks = parseMarkdown('- ```sh\n  make\n  ```\n\nSee [docs].\n\n[docs]: https://example.com')
    const para = blocks[1] as Extract<Block, { t: 'paragraph' }>
    expect(para.c.find((n) => n.t === 'link')).toMatchObject({ t: 'link', href: 'https://example.com' })
    expect(blocks).toHaveLength(2)
  })
})

describe('blockquotes and GitHub alerts (L-75)', () => {
  it('GFM 233: a lazy line continues the quote\'s paragraph', () => {
    expect(md('> foo\nbar\n\nbaz')).toEqual([{ quote: ['p:foo bar'] }, 'p:baz'])
  })

  it('reads the five alert kinds, case-insensitively', () => {
    for (const kind of ['NOTE', 'tip', 'Important', 'WARNING', 'caution']) {
      expect(md(`> [!${kind}]\n> Useful info.`)).toEqual([{ alert: kind.toLowerCase(), c: ['p:Useful info.'] }])
    }
  })

  it('is a plain quote when the marker is not alone on its line, unknown, empty or nested', () => {
    expect(md('> [!TIP] inline\n> x')).toEqual([{ quote: ['p:[!TIP] inline x'] }])
    expect(md('> [!DANGER]\n> x')).toEqual([{ quote: ['p:[!DANGER] x'] }])
    expect(md('> [!NOTE]\n\nafter')).toEqual([{ quote: ['p:[!NOTE]'] }, 'p:after'])
    expect(md('> > [!NOTE]\n> > x')).toEqual([{ quote: [{ quote: ['p:[!NOTE] x'] }] }])
  })
})

describe('footnotes (L-75)', () => {
  it('numbers notes in reference order and lists only referenced ones', () => {
    const blocks = parseMarkdown('Text[^1] and [^x].\n\n[^1]: note one\n    continued\n[^x]: second\n\n[^unused]: nope')
    expect(shape(blocks)).toEqual(['p:Text[1] and [2].', { footnotes: [[1, '1', 1, 'p:note one continued'], [2, 'x', 1, 'p:second']] }])
  })

  it('a definition right after a paragraph line is a definition, not a broken reference link', () => {
    expect(md('Text[^1]\n[^1]: note')).toEqual(['p:Text[1]', { footnotes: [[1, '1', 1, 'p:note']] }])
  })

  it('counts repeated references (one back link each) and parses notes as Markdown', () => {
    const blocks = parseMarkdown('A[^n] B[^N]\n\n[^n]: The *note*.', { breaks: true })
    expect(shape(blocks)).toEqual(['p:A[1] B[1]', { footnotes: [[1, 'n', 2, 'p:The note.']] }])
    const para = blocks[0] as Extract<Block, { t: 'paragraph' }>
    expect(para.c.filter((n) => n.t === 'fnref')).toEqual([
      { t: 'fnref', label: 'n', n: 1, k: 1 },
      { t: 'fnref', label: 'n', n: 1, k: 2 },
    ])
  })

  it('leaves an undefined [^x] as text and a note without references out', () => {
    expect(md('see [^missing]')).toEqual(['p:see [^missing]'])
    expect(md('[^a]: alone')).toEqual([])
  })
})

describe('emoji shortcodes (L-75)', () => {
  it('converts known names, even inside a word, and leaves unknown ones and code alone', () => {
    expect(md(':+1: :tada: foo:smile:bar :not_an_emoji: `:tada:`')).toEqual(['p:👍 🎉 foo😄bar :not_an_emoji: :tada:'])
  })
})

describe('mermaid (L-75)', () => {
  it('stays a code block tagged mermaid (the renderer labels it, never runs it)', () => {
    expect(md('```mermaid\ngraph TD; A-->B\n```')).toEqual(['code(mermaid):graph TD; A-->B'])
  })
})

describe('splitRefs: cross-repo refs, commit ids and GitHub mentions (L-40, L-51, L-67, L-38)', () => {
  const refs = (s: string) => splitRefs(s).filter((p) => p.t !== 'text')

  it('reads owner/name#N, and #N inside a sentence or parentheses', () => {
    expect(refs('dashpay/dash#7511, dashpay/platform#4344 and (#5017)')).toEqual([
      { t: 'ref', n: 7511, repo: { owner: 'dashpay', name: 'dash' } },
      { t: 'ref', n: 4344, repo: { owner: 'dashpay', name: 'platform' } },
      { t: 'ref', n: 5017 },
    ])
  })

  it('leaves what GitHub leaves: bitcoin#N, #0, a/b#1 mid-path, x#1', () => {
    expect(refs('bitcoin#15454 #0 x#1 path/a/b#1 issue#4')).toEqual([])
  })

  it('reads commit ids of 7-40 hex with a digit and a letter, bare or owner/name@sha', () => {
    expect(refs('fixed in 1898d8f7ac7 and dashpay/dash@3ba0805c0e368b2bc69dafd39e353b992884c7bc')).toEqual([
      { t: 'commit', oid: '1898d8f7ac7' },
      { t: 'commit', oid: '3ba0805c0e368b2bc69dafd39e353b992884c7bc', repo: { owner: 'dashpay', name: 'dash' } },
    ])
  })

  it('does not read words, numbers or glued hex as commits', () => {
    expect(refs('deadbeef 1234567 abc123 x1898d8f7ac7 1898d8f7ac7x 1898d8f7ac7-2 #1898d8f')).toEqual([])
  })

  it('keeps a mention\'s case and GitHub\'s [bot] suffix', () => {
    expect(refs('@PastaPastaPasta and @coderabbitai[bot]')).toEqual([
      { t: 'mention', name: 'pastapastapasta', label: 'PastaPastaPasta' },
      { t: 'mention', name: 'coderabbitai', label: 'coderabbitai', bot: true },
    ])
  })

  it('merges the text around references it skips', () => {
    expect(splitRefs('a 1234567 b')).toEqual([{ t: 'text', v: 'a 1234567 b' }])
  })
})

describe('splitUrls (commit messages, L-67)', () => {
  it('splits bare URLs out of plain text with GFM\'s trailing punctuation rule', () => {
    expect(splitUrls('See https://github.com/dashpay/dash/pull/7760. Thanks')).toEqual([
      { t: 'text', v: 'See ' },
      { t: 'url', href: 'https://github.com/dashpay/dash/pull/7760' },
      { t: 'text', v: '. Thanks' },
    ])
    expect(splitUrls('no url here')).toEqual([{ t: 'text', v: 'no url here' }])
    expect(splitUrls('xhttps://a.b')).toEqual([{ t: 'text', v: 'xhttps://a.b' }])
  })
})

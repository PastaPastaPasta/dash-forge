/**
 * D-051 (README rendering) and D-052 (release notes): badges, relative links, escapes, task
 * lists, reference links, hard breaks, GFM autolinks and GitHub's sanitized HTML subset. The
 * inputs are cut from the showcase repos' READMEs and release notes.
 */

import { describe, expect, it } from 'vitest'

import { headingSlug, isRelativeHref, parseMarkdown, safeHref, type Block, type Inline } from './markdown'

const para = (source: string): Inline[] => {
  const block = parseMarkdown(source)[0]
  return block?.t === 'paragraph' ? [...block.c] : []
}

describe('badges and links (D-051)', () => {
  it('reads [![alt](img)](href) as an image inside a link', () => {
    expect(para('[![CICD](https://github.com/sharkdp/fd/actions/workflows/CICD.yml/badge.svg)](https://github.com/sharkdp/fd/actions)')).toEqual([
      {
        t: 'link',
        href: 'https://github.com/sharkdp/fd/actions',
        c: [{ t: 'image', src: 'https://github.com/sharkdp/fd/actions/workflows/CICD.yml/badge.svg', alt: 'CICD' }],
      },
    ])
  })

  it('keeps relative links and images for the renderer to resolve', () => {
    expect(para('![Demo](doc/screencast.svg)')).toEqual([{ t: 'image', src: 'doc/screencast.svg', alt: 'Demo' }])
    expect(para('[LICENSE-MIT](LICENSE-MIT)')[0]).toMatchObject({ t: 'link', href: 'LICENSE-MIT' })
    expect(para('[x](./a/../b.md#frag)')[0]).toMatchObject({ t: 'link', href: './a/../b.md#frag' })
    expect(isRelativeHref('doc/a.png')).toBe(true)
    for (const h of ['https://x', '#a', '/abs', 'mailto:a@b', 'dash://x']) expect(isRelativeHref(h), h).toBe(false)
  })

  it('still refuses unsafe schemes and off-site protocol-relative forms', () => {
    for (const h of ['javascript:alert(1)', 'JaVaScRiPt:x', 'data:text/html,x', 'vbscript:x', '//evil/p.gif', '\\\\evil', 'a\\b']) {
      expect(safeHref(h), h).toBe('#')
    }
  })

  it('resolves reference links and hides their definitions', () => {
    const blocks = parseMarkdown('Use [Glamour][glam] or [the docs][] or [glam].\n\n[glam]: https://github.com/charmbracelet/glamour\n[The Docs]: <docs/index.md> "title"')
    expect(blocks).toHaveLength(1)
    const links = (blocks[0] as Extract<Block, { t: 'paragraph' }>).c.filter((n) => n.t === 'link')
    expect(links.map((l) => (l.t === 'link' ? l.href : ''))).toEqual([
      'https://github.com/charmbracelet/glamour',
      'docs/index.md',
      'https://github.com/charmbracelet/glamour',
    ])
  })

  it('leaves an undefined reference as text', () => {
    expect(para('[nope][missing] and [x]')).toEqual([{ t: 'text', v: '[nope][missing] and [x]' }])
  })
})

describe('escapes, entities, breaks, task lists (D-051)', () => {
  it('treats backslash-escaped punctuation as literal', () => {
    expect(para('character[\\*](http://vimdoc.sourceforge.net/x) and \\_not em\\_ and 1\\. two')).toEqual([
      { t: 'text', v: 'character' },
      { t: 'link', href: 'http://vimdoc.sourceforge.net/x', c: [{ t: 'text', v: '*' }] },
      { t: 'text', v: ' and _not em_ and 1. two' },
    ])
  })

  it('decodes entity and numeric references', () => {
    expect(para('a &amp; b &lt;c&gt; &#169; &#x1F600; &bogus;')).toEqual([{ t: 'text', v: 'a & b <c> © 😀 &bogus;' }])
  })

  it('makes two trailing spaces or a backslash a hard break, and a plain line end a space', () => {
    expect(para('one  \ntwo\\\nthree\nfour')).toEqual([
      { t: 'text', v: 'one' },
      { t: 'br' },
      { t: 'text', v: 'two' },
      { t: 'br' },
      { t: 'text', v: 'three four' },
    ])
  })

  it('reads GitHub task lists', () => {
    const [list] = parseMarkdown('- [x] done\n- [ ] todo\n- plain')
    expect(list).toEqual({
      t: 'list',
      ordered: false,
      items: [[{ t: 'text', v: 'done' }], [{ t: 'text', v: 'todo' }], [{ t: 'text', v: 'plain' }]],
      tasks: [true, false, null],
    })
  })

  it('does not italicize snake_case words', () => {
    expect(para('call my_var_name now')).toEqual([{ t: 'text', v: 'call my_var_name now' }])
  })

  it('makes GitHub heading slugs', () => {
    expect(headingSlug('How to use')).toBe('how-to-use')
    expect(headingSlug('Command-line options: `fd -h`!')).toBe('command-line-options-fd--h')
    expect(headingSlug('💁 More information')).toBe('-more-information')
  })
})

describe('autolinks (D-052)', () => {
  it('does not swallow trailing punctuation or quotes', () => {
    const links = (s: string): string[] => para(s).flatMap((n) => (n.t === 'link' ? [n.href] : []))
    expect(links('see https://stuff.charm.sh/glow/glow-filter.gif".')).toEqual(['https://stuff.charm.sh/glow/glow-filter.gif'])
    expect(links('(https://x.io/a), https://x.io/b. https://x.io/c?')).toEqual(['https://x.io/a', 'https://x.io/b', 'https://x.io/c'])
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar) end')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
    expect(links('https://x.io/a&amp;')).toEqual(['https://x.io/a'])
  })

  it('reads <https://…> autolinks', () => {
    expect(para('<https://preactjs.com>')).toEqual([{ t: 'link', href: 'https://preactjs.com', c: [{ t: 'text', v: 'https://preactjs.com' }] }])
  })
})

describe('raw HTML, as GitHub sanitizes it (D-052)', () => {
  it('renders an inline <img> with its size instead of printing the tag', () => {
    const blocks = parseMarkdown('<img src="https://stuff.charm.sh/glow/glow-1.3-tabs.gif" width="600" alt="Glow Tabs Demo">')
    expect(blocks).toEqual([
      { t: 'inline', c: [{ t: 'image', src: 'https://stuff.charm.sh/glow/glow-1.3-tabs.gif', alt: 'Glow Tabs Demo', width: 600 }] },
    ])
  })

  it('keeps <kbd>, <sub>, <sup>, <b> and <br> inside Markdown text', () => {
    expect(para('press <kbd>tab</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <b>bold</b><br>next')).toEqual([
      { t: 'text', v: 'press ' },
      { t: 'tag', tag: 'kbd', c: [{ t: 'text', v: 'tab' }] },
      { t: 'text', v: ', H' },
      { t: 'tag', tag: 'sub', c: [{ t: 'text', v: '2' }] },
      { t: 'text', v: 'O, x' },
      { t: 'tag', tag: 'sup', c: [{ t: 'text', v: '2' }] },
      { t: 'text', v: ', ' },
      { t: 'strong', c: [{ t: 'text', v: 'bold' }] },
      { t: 'br' },
      { t: 'text', v: 'next' },
    ])
  })

  it('builds <details><summary> and aligned blocks around Markdown', () => {
    const blocks = parseMarkdown('<details>\n<summary>More</summary>\n\n- a\n- b\n\n</details>\n\n<p align="center">Fast <b>4kB</b></p>')
    expect(blocks).toEqual([
      {
        t: 'element',
        tag: 'details',
        align: null,
        c: [
          { t: 'element', tag: 'summary', align: null, c: [{ t: 'inline', c: [{ t: 'text', v: 'More' }] }] },
          { t: 'list', ordered: false, items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] },
        ],
      },
      {
        t: 'element',
        tag: 'p',
        align: 'center',
        c: [{ t: 'inline', c: [{ t: 'text', v: 'Fast ' }, { t: 'strong', c: [{ t: 'text', v: '4kB' }] }] }],
      },
    ])
  })

  it('renders the preact README header: a centered link around a Markdown image', () => {
    const blocks = parseMarkdown(
      '<p align="center">\n<a href="https://preactjs.com" target="_blank">\n\n![Preact](https://raw.githubusercontent.com/preactjs/preact/8b0bcc9/logo.svg?sanitize=true \'Preact\')\n\n</a>\n</p>',
    )
    expect(blocks).toEqual([
      {
        t: 'element',
        tag: 'p',
        align: 'center',
        c: [
          {
            t: 'element',
            tag: 'a',
            align: null,
            href: 'https://preactjs.com',
            c: [{ t: 'paragraph', c: [{ t: 'image', src: 'https://raw.githubusercontent.com/preactjs/preact/8b0bcc9/logo.svg?sanitize=true', alt: 'Preact' }] }],
          },
        ],
      },
    ])
  })

  it('drops script-like elements with their contents, and unknown tags but not their text', () => {
    expect(parseMarkdown('<script>alert(1)</script>\n\nok')).toEqual([{ t: 'paragraph', c: [{ t: 'text', v: 'ok' }] }])
    expect(para('a <span style="x">b</span> <iframe src="x">hidden</iframe> c <abbr title="t">VDOM</abbr>')).toEqual([
      { t: 'text', v: 'a b  c VDOM' },
    ])
  })

  it('never keeps an unsafe URL from HTML attributes', () => {
    expect(para('<img src="javascript:alert(1)"> <a href="data:text/html,x">x</a>')).toEqual([
      { t: 'image', src: '#', alt: '' },
      { t: 'text', v: ' ' },
      { t: 'link', href: '#', c: [{ t: 'text', v: 'x' }] },
    ])
  })

  it('keeps a <pre> block as code, and prints malformed tags as text', () => {
    expect(parseMarkdown('<pre>\na &lt; b\n</pre>')).toEqual([{ t: 'code', lang: '', v: 'a < b' }])
    expect(para('1 < 2 and <3 and <a href=>x')).toEqual([{ t: 'text', v: '1 < 2 and <3 and <a href=>x' }])
  })
})

describe('review regressions', () => {
  const links = (s: string): string[] => {
    const out: string[] = []
    const walk = (ns: readonly Inline[]): void => {
      for (const n of ns) {
        if (n.t === 'link') out.push(n.href)
        if ('c' in n) walk(n.c)
      }
    }
    walk(para(s))
    return out
  }

  it('finds a nested link destination after an outer bracket fails', () => {
    expect(links('[a [b](c) d]( x)')).toEqual(['c'])
    expect(links('[r]: https://r.io\n\n[a [b][r] c][]')).toEqual(['https://r.io'])
  })

  it('keeps a space at the end of a span', () => {
    expect(para('a <b>Note: </b>text')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'strong', c: [{ t: 'text', v: 'Note: ' }] },
      { t: 'text', v: 'text' },
    ])
  })

  it('treats a tag named like an Object.prototype member as an unknown tag', () => {
    expect(para('<constructor>kept</constructor> <toString>x</toString>')).toEqual([{ t: 'text', v: 'kept x' }])
    expect(parseMarkdown('<constructor>\nblock\n</constructor>').every((b) => b.t !== 'element')).toBe(true)
  })

  it('keeps closing-tag offsets right after characters whose lowercase is longer (İ)', () => {
    expect(para('İİİ<kbd>x</kbd> after')).toEqual([
      { t: 'text', v: 'İİİ' },
      { t: 'tag', tag: 'kbd', c: [{ t: 'text', v: 'x' }] },
      { t: 'text', v: ' after' },
    ])
    expect(para('İİİ<script>bad</script> after')).toEqual([{ t: 'text', v: 'İİİ after' }])
  })

  it('strips a heading\'s closing hashes, and is fast on long space runs', () => {
    expect(parseMarkdown('## Title ##')).toEqual([{ t: 'heading', level: 2, c: [{ t: 'text', v: 'Title' }] }])
    expect(parseMarkdown('# C#')).toEqual([{ t: 'heading', level: 1, c: [{ t: 'text', v: 'C#' }] }])
    const t = performance.now()
    parseMarkdown('# a' + ' '.repeat(200_000) + 'x')
    parseMarkdown('<pre>\na' + '\n'.repeat(200_000) + 'b\n</pre>')
    expect(performance.now() - t).toBeLessThan(1000)
  })
})

describe('post-merge review of #82', () => {
  /** Every link href in the document, in order. */
  const links = (s: string): string[] => {
    const out: string[] = []
    const walk = (ns: readonly (Inline | Block)[]): void => {
      for (const n of ns) {
        if (n.t === 'link') out.push(n.href)
        if (n.t === 'list') n.items.forEach(walk)
        else if ('c' in n) walk(n.c)
      }
    }
    walk(parseMarkdown(s))
    return out
  }

  it('links the inner span when an outer bracket is no link, whatever follows it', () => {
    expect(para('[x [a](b) y]( z)')).toEqual([
      { t: 'text', v: '[x ' },
      { t: 'link', href: 'b', c: [{ t: 'text', v: 'a' }] },
      { t: 'text', v: ' y]( z)' },
    ])
    expect(links('[a]: https://a.io\n\n[x [y][a] z][b]')).toEqual(['https://a.io'])
  })

  it('does not match a reference label longer than 999 characters', () => {
    const long = 'a'.repeat(1000)
    expect(links(`[a]: https://x.io\n\n[${long}] [${long}][] [t][${'b'.repeat(1000)}] [t][a]`)).toEqual(['https://x.io'])
  })

  it('keeps offsets after characters whose lowercase is longer (İ), inline and in HTML blocks', () => {
    expect(para('İİİİ<kbd>ab</kbd>cdef')).toEqual([
      { t: 'text', v: 'İİİİ' },
      { t: 'tag', tag: 'kbd', c: [{ t: 'text', v: 'ab' }] },
      { t: 'text', v: 'cdef' },
    ])
    expect(parseMarkdown('<div>\nİİİİİİİ<script>x</script>visible <b>bold</b>\n</div>')).toEqual([
      {
        t: 'element',
        tag: 'div',
        align: null,
        c: [
          { t: 'inline', c: [{ t: 'text', v: 'İİİİİİİ' }] },
          { t: 'inline', c: [{ t: 'text', v: 'visible ' }, { t: 'strong', c: [{ t: 'text', v: 'bold' }] }] },
        ],
      },
    ])
    expect(para('İİ<KBD>x</KBD>')).toEqual([{ t: 'text', v: 'İİ' }, { t: 'tag', tag: 'kbd', c: [{ t: 'text', v: 'x' }] }])
  })

  it('refuses hrefs hidden behind control characters, as the URL parser strips them', () => {
    for (const h of [
      '\u0001javascript:alert(1)',
      ' \u0000javascript:alert(1)',
      'javascript:alert(1)\u0001',
      '\u0001//evil.com',
      'java\u0001script:alert(1)',
      'https://x.io/\u007f',
    ]) {
      expect(safeHref(h), JSON.stringify(h)).toBe('#')
    }
    expect(links('[a](&#1;javascript:alert(1)) [b](&#x1f;//evil.com)')).toEqual(['#', '#'])
    expect(safeHref(' https://x.io/a ')).toBe('https://x.io/a')
  })

  it('drops HTML comments inline and as blocks, in READMEs and comment bodies alike', () => {
    expect(para('a <!-- hidden --> b <!--> c <!---> d')).toEqual([{ t: 'text', v: 'a  b  c  d' }])
    expect(parseMarkdown('<!-- backportsys v1 -->\n<!-- bps:hands_off -->\n\nText')).toEqual([{ t: 'paragraph', c: [{ t: 'text', v: 'Text' }] }])
    // A comment block interrupts a paragraph and runs to the line holding `-->`.
    expect(parseMarkdown('Intro\n<!--\n# not a heading\n- not a list\n--> tail\nafter')).toEqual([
      { t: 'paragraph', c: [{ t: 'text', v: 'Intro' }] },
      { t: 'inline', c: [{ t: 'text', v: 'tail' }] },
      { t: 'paragraph', c: [{ t: 'text', v: 'after' }] },
    ])
    // Unclosed: the rest of the document is the comment, as in CommonMark.
    expect(parseMarkdown('ok\n\n<!-- never closed\n\n# gone')).toEqual([{ t: 'paragraph', c: [{ t: 'text', v: 'ok' }] }])
    expect(parseMarkdown('<div>\na <!-- <b>x</b> --> b\n</div>')).toEqual([
      { t: 'element', tag: 'div', align: null, c: [{ t: 'inline', c: [{ t: 'text', v: 'a' }] }, { t: 'inline', c: [{ t: 'text', v: 'b' }] }] },
    ])
    // Inside code, a comment is text.
    expect(para('`<!-- x -->`')).toEqual([{ t: 'code', v: '<!-- x -->' }])
  })

  it('renders reference-style images and badges', () => {
    const src = [
      '![logo][logo] [![npm][npm-badge]][npm-url] ![CI] ![alt][]',
      '',
      '[logo]: docs/logo.png',
      '[npm-badge]: https://img.shields.io/npm/v/x.svg',
      '[npm-url]: https://npmjs.com/x',
      '[ci]: https://ci/badge.svg',
      '[alt]: https://a/b.png',
    ].join('\n')
    expect(para(src)).toEqual([
      { t: 'image', src: 'docs/logo.png', alt: 'logo' },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://npmjs.com/x', c: [{ t: 'image', src: 'https://img.shields.io/npm/v/x.svg', alt: 'npm' }] },
      { t: 'text', v: ' ' },
      { t: 'image', src: 'https://ci/badge.svg', alt: 'CI' },
      { t: 'text', v: ' ' },
      { t: 'image', src: 'https://a/b.png', alt: 'alt' },
    ])
    expect(para('![nope][missing]')).toEqual([{ t: 'text', v: '![nope][missing]' }])
  })

  it('decodes the entities README nav rows use', () => {
    expect(para('[A](#a) &middot; [B](#b) &bull; &copy; 2026 &mdash; x &ndash; y &hellip; &rarr; &larr; &times; &laquo;&raquo; &reg; &trade;')
      .filter((n) => n.t === 'text')
      .map((n) => (n.t === 'text' ? n.v : ''))
      .join('|')).toBe(' · | • © 2026 — x – y … → ← × «» ® ™')
    expect(para('&constructor; &toString;')).toEqual([{ t: 'text', v: '&constructor; &toString;' }])
  })

  it('reads a definition right after a heading, fence, rule or another definition, but not inside a paragraph', () => {
    // `docs/a.md` is not autolinked, so only a resolved reference links it.
    expect(links('# Title\n[a]: docs/a.md\n\n[a]')).toEqual(['docs/a.md'])
    expect(links('```\ncode\n```\n[a]: docs/a.md\n\n[a]')).toEqual(['docs/a.md'])
    expect(links('---\n[a]: docs/a.md\n\n[a]')).toEqual(['docs/a.md'])
    expect(links('[b]: docs/b.md\n[a]: docs/a.md\n\n[a] [b]')).toEqual(['docs/a.md', 'docs/b.md'])
    expect(parseMarkdown('# Title\n[a]: docs/a.md')).toEqual([{ t: 'heading', level: 1, c: [{ t: 'text', v: 'Title' }] }])
    // A paragraph line: `[a]: …` is paragraph text, and `[a]` is no link.
    expect(parseMarkdown('text\n[a]: docs/a.md\n\n[a]')[1]).toEqual({ t: 'paragraph', c: [{ t: 'text', v: '[a]' }] })
  })

  it('keeps <a name> targets without an empty paragraph, prefixed as GitHub does', () => {
    expect(parseMarkdown('<a name="install"></a>\n\n## Install')).toEqual([
      { t: 'inline', c: [{ t: 'anchor', id: 'install', c: [] }] },
      { t: 'heading', level: 2, c: [{ t: 'text', v: 'Install' }] },
    ])
    expect(para('see <a id="Usage">usage</a> here')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'anchor', id: 'usage', c: [{ t: 'text', v: 'usage' }] },
      { t: 'text', v: ' here' },
    ])
    expect(parseMarkdown('<div id="top" align="center">\nx\n</div>')[0]).toMatchObject({ t: 'element', tag: 'div', id: 'top' })
  })

  it('keeps an unclosed __ literal, and lets an em hold a strong', () => {
    expect(para('__a__b')).toEqual([{ t: 'text', v: '__a__b' }])
    expect(para('_a __b__ c_')).toEqual([
      { t: 'em', c: [{ t: 'text', v: 'a ' }, { t: 'strong', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' }] },
    ])
  })

  it('reads ___x___ and ***x*** as strong emphasis, and mismatched runs as GitHub does', () => {
    const strongEm = [{ t: 'em', c: [{ t: 'strong', c: [{ t: 'text', v: 'a' }] }] }]
    expect(para('___a___')).toEqual(strongEm)
    expect(para('***a***')).toEqual(strongEm)
    expect(para('see ___this___ now')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'em', c: [{ t: 'strong', c: [{ t: 'text', v: 'this' }] }] },
      { t: 'text', v: ' now' },
    ])
    expect(para('__a_')).toEqual([{ t: 'text', v: '_' }, { t: 'em', c: [{ t: 'text', v: 'a' }] }])
    expect(para('_a__')).toEqual([{ t: 'em', c: [{ t: 'text', v: 'a' }] }, { t: 'text', v: '_' }])
  })

  it('accepts an escaped [ in a reference label', () => {
    expect(para('[a\\[b]: docs/x.md\n\n[a\\[b]')).toEqual([{ t: 'link', href: 'docs/x.md', c: [{ t: 'text', v: 'a[b' }] }])
  })

  it('keeps both the link and the anchor of <a href name>', () => {
    expect(para('<a name="top" href="#x">up</a>')).toEqual([{ t: 'link', href: '#x', id: 'top', c: [{ t: 'text', v: 'up' }] }])
  })

  it('does not embolden intraword double underscores', () => {
    expect(para('my__var__name and __init__.py')).toEqual([
      { t: 'text', v: 'my__var__name and ' },
      { t: 'strong', c: [{ t: 'text', v: 'init' }] },
      { t: 'text', v: '.py' },
    ])
    expect(para('a __b__ c')).toEqual([{ t: 'text', v: 'a ' }, { t: 'strong', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' }])
  })
})

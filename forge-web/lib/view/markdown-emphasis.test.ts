/**
 * Emphasis against the spec GitHub renders with: every example of the "Emphasis and strong
 * emphasis" section of cmark-gfm's `test/spec.txt` (GFM 0.29), vendored unedited in
 * `fixtures/commonmark-emphasis.json` (CC-BY-SA 4.0). Each is parsed and printed back as the
 * spec's HTML.
 *
 * A few examples lean on syntax this renderer deliberately does not have (link titles, raw
 * HTML attributes kept verbatim, autolinks inside `<…>` spanning emphasis): those are listed
 * in {@link OUT_OF_SCOPE} with the reason, and only their emphasis is not what is checked.
 */

import { describe, expect, it } from 'vitest'

import spec from './fixtures/commonmark-emphasis.json'
import { parseMarkdown, type Block, type Inline } from './markdown'

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inlineHtml(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return escapeHtml(n.v)
        case 'em':
          return `<em>${inlineHtml(n.c)}</em>`
        case 'strong':
          return `<strong>${inlineHtml(n.c)}</strong>`
        case 'del':
          return `<del>${inlineHtml(n.c)}</del>`
        case 'code':
          return `<code>${escapeHtml(n.v)}</code>`
        case 'link':
          return `<a href="${escapeHtml(n.href)}">${inlineHtml(n.c)}</a>`
        case 'br':
          return '<br />\n'
        default:
          return `<${n.t}>`
      }
    })
    .join('')
}

function html(blocks: readonly Block[]): string {
  return blocks.map((b) => (b.t === 'paragraph' ? `<p>${inlineHtml(b.c)}</p>\n` : `<${b.t}>\n`)).join('')
}

/**
 * Examples whose expected HTML needs syntax outside this renderer's GitHub subset. Their
 * emphasis still parses; only the unrelated syntax differs.
 */
const OUT_OF_SCOPE: Readonly<Record<number, string>> = {
  // Raw inline HTML is never echoed: it becomes allowlisted nodes (so `<img title="*">` is an
  // image node and an unclosed `<a href>` is dropped). What these examples check is that the
  // `*` / `_` inside the tag do not pair, which the tests below cover.
  484: 'raw <img> echoed as HTML',
  485: 'raw unclosed <a href> echoed as HTML',
  486: 'raw unclosed <a href> echoed as HTML',
}

/** The spec's line ending inside a paragraph is `\n`; this renderer joins lines with a space. */
const normalize = (s: string): string => s.replace(/\n(?!$)/g, ' ').replace(/<br \/> /g, '<br />\n')

describe('CommonMark emphasis (cmark-gfm spec 0.29, §6.4)', () => {
  const examples = spec.examples as { example: number; markdown: string; html: string }[]
  it('has the section\'s examples', () => {
    expect(examples.length).toBeGreaterThan(120)
  })
  it('does not pair * or _ inside a tag (examples 484-486)', () => {
    expect(parseMarkdown('*<img src="foo" title="*"/>')[0]).toMatchObject({ t: 'paragraph', c: [{ t: 'text', v: '*' }, { t: 'image' }] })
    expect(JSON.stringify(parseMarkdown('**<a href="**">'))).not.toMatch(/strong/)
    expect(JSON.stringify(parseMarkdown('__<a href="__">'))).not.toMatch(/strong/)
  })

  for (const ex of examples) {
    const skip = OUT_OF_SCOPE[ex.example]
    it.skipIf(skip !== undefined)(`example ${ex.example}: ${JSON.stringify(ex.markdown.trimEnd()).slice(0, 60)}`, () => {
      expect(normalize(html(parseMarkdown(ex.markdown.trimEnd())))).toBe(normalize(ex.html))
    })
  }
})

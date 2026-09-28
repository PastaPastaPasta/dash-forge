/**
 * Raw HTML inside Markdown, the way GitHub treats it: a small allowlist of elements is kept,
 * every other tag is dropped (its text stays), and the contents of script-like elements are
 * dropped too. Nothing here ever produces HTML: tags become typed AST nodes, and attribute
 * values only reach the DOM through React props (escaped), with URLs through `safeHref`.
 *
 * Loaded by plain Node (type stripping) in `render-fuzz.test.ts`: keep imports relative and the
 * syntax erasable.
 */

/** A tag as it appeared in the source: `<kbd>`, `</kbd>`, `<img src=… />`. */
export interface TagToken {
  readonly name: string
  readonly close: boolean
  readonly attrs: Readonly<Record<string, string>>
}

/** Longest tag scanned; a longer `<…>` run is text (keeps the scan linear). */
export const MAX_TAG_CHARS = 1024

/**
 * Parse the tag in `src[start..end]` (from `<` to the `>` at `end`), or null when it is not a
 * well-formed tag. Hand-written, not a regex over attributes, so no input backtracks.
 */
export function parseTag(src: string, start: number, end: number): TagToken | null {
  let i = start + 1
  const close = src[i] === '/'
  if (close) i += 1
  const nameStart = i
  if (!/[A-Za-z]/.test(src[i] ?? '')) return null
  while (i < end && /[A-Za-z0-9-]/.test(src[i] as string)) i += 1
  const name = src.slice(nameStart, i).toLowerCase()
  const attrs: Record<string, string> = {}
  const space = (): boolean => {
    const before = i
    while (i < end && /\s/.test(src[i] as string)) i += 1
    return i > before
  }
  for (;;) {
    const spaced = space()
    if (i >= end) break
    if (src[i] === '/' && i === end - 1) {
      i += 1
      break
    }
    if (close || !spaced) return null
    const attrStart = i
    if (!/[A-Za-z_:]/.test(src[i] as string)) return null
    while (i < end && /[A-Za-z0-9_:.-]/.test(src[i] as string)) i += 1
    const attr = src.slice(attrStart, i).toLowerCase()
    space()
    let value = ''
    if (src[i] === '=') {
      i += 1
      space()
      const q = src[i]
      if (q === '"' || q === "'") {
        const endQuote = src.indexOf(q, i + 1)
        if (endQuote === -1 || endQuote >= end) return null
        value = src.slice(i + 1, endQuote)
        i = endQuote + 1
      } else {
        const valueStart = i
        while (i < end && !/[\s"'=<>`]/.test(src[i] as string)) i += 1
        if (i === valueStart) return null
        value = src.slice(valueStart, i)
      }
    }
    if (!(attr in attrs)) attrs[attr] = decodeEntities(value)
  }
  return { name, close, attrs }
}

/** The named references READMEs use (nav rows joined by `&middot;`, `&copy;` lines, arrows). */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  middot: '\u00b7', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', mdash: '\u2014', ndash: '\u2013',
  hellip: '\u2026', rarr: '\u2192', larr: '\u2190', times: '\u00d7', laquo: '\u00ab', raquo: '\u00bb',
  bull: '\u2022',
}

/** Decode the character references an attribute value commonly carries (`&amp;` in a URL). */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,6});/g, (whole, ref: string) => {
    if (ref[0] !== '#') return Object.hasOwn(NAMED_ENTITIES, ref) ? (NAMED_ENTITIES[ref] as string) : whole
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�'
  })
}

/** Inline elements kept as themselves. */
export const INLINE_TAGS = new Set(['kbd', 'sub', 'sup'])
/** Elements kept as the equivalent Markdown span. */
export const SPAN_ALIASES: Readonly<Record<string, 'strong' | 'em' | 'del'>> = {
  b: 'strong',
  strong: 'strong',
  i: 'em',
  em: 'em',
  s: 'del',
  del: 'del',
  strike: 'del',
}
/** Elements dropped with everything inside them (GitHub's sanitizer removes their contents). */
export const DROP_WITH_CONTENTS = new Set([
  'script', 'style', 'iframe', 'noscript', 'noembed', 'noframes', 'object', 'embed', 'svg', 'math',
  'template', 'textarea', 'title', 'xmp', 'plaintext', 'select', 'option', 'button', 'form',
])

/**
 * Element names that start an HTML block when a line opens with them (CommonMark §4.6, type 6).
 * Other tags start one only when the line holds nothing but a complete tag (type 7).
 */
export const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col',
  'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html',
  'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option',
  'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr',
  'track', 'ul',
])

/** A line that opens an HTML comment block (CommonMark §4.6, type 2): it runs to the line holding `-->`. */
export const COMMENT_START = /^ {0,3}<!--/

/** Whether `line` starts an HTML block, and whether that block may interrupt a paragraph. */
export function htmlBlockStart(line: string): 'strong' | 'weak' | null {
  if (COMMENT_START.test(line)) return 'strong'
  const m = /^ {0,3}<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(line)
  if (m === null) return null
  const name = (m[2] as string).toLowerCase()
  if (BLOCK_TAGS.has(name) || DROP_WITH_CONTENTS.has(name)) return 'strong'
  // Type 7: a complete open or close tag alone on its line (it cannot interrupt a paragraph).
  const trimmed = line.trim()
  if (trimmed.length > MAX_TAG_CHARS || !trimmed.endsWith('>') || trimmed.indexOf('>') !== trimmed.length - 1) return null
  return parseTag(trimmed, 0, trimmed.length - 1) === null ? null : 'weak'
}

/** A positive integer attribute (`width="600"`), capped, or undefined. */
export function sizeAttr(v: string | undefined): number | undefined {
  if (v === undefined || !/^\d{1,5}$/.test(v.trim())) return undefined
  const n = Number(v.trim())
  return n > 0 ? Math.min(n, 4096) : undefined
}

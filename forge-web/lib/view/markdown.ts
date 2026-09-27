/**
 * Minimal, safe Markdown → AST (view glue).
 *
 * Loaded by plain Node (type stripping) in `render-fuzz.test.ts`: keep imports relative and
 * the syntax erasable (no enums, namespaces or `@/` aliases).
 *
 * No external dependency (shiki/remark are not in the bundle): this parses a practical GFM
 * subset into a typed AST that {@link MarkdownView} renders as React elements. Because the
 * renderer only ever emits known elements with escaped text (never raw HTML), the pipeline
 * is XSS-safe by construction — untrusted README/issue bodies cannot inject markup. Links
 * are restricted to safe schemes.
 *
 * Supported: ATX headings, fenced + inline code, bold/italic/strikethrough, links (inline and
 * reference), images, badges (an image inside a link), backslash escapes, entity references,
 * hard line breaks, autolinks (GFM's trailing-punctuation rule, and `<url>`), task lists,
 * unordered/ordered lists, blockquotes, horizontal rules, GFM tables, and paragraphs.
 *
 * Raw HTML is handled as GitHub's sanitizer does (`markdown-html.ts`): an allowlist of
 * elements becomes typed nodes (`img`, `br`, `kbd`, `sub`, `sup`, `details`/`summary`,
 * `p`/`div` with `align`, `a`, tables…), other tags are dropped with their text kept, and
 * script-like elements are dropped with their contents.
 */

import {
  decodeEntities,
  DROP_WITH_CONTENTS,
  htmlBlockStart,
  INLINE_TAGS,
  MAX_TAG_CHARS,
  parseTag,
  sizeAttr,
  SPAN_ALIASES,
  type TagToken,
} from './markdown-html.ts'

export type Inline =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'strong'; readonly c: readonly Inline[] }
  | { readonly t: 'em'; readonly c: readonly Inline[] }
  | { readonly t: 'del'; readonly c: readonly Inline[] }
  | { readonly t: 'code'; readonly v: string }
  | { readonly t: 'link'; readonly href: string; readonly c: readonly Inline[] }
  | {
      readonly t: 'image'
      readonly src: string
      readonly alt: string
      readonly width?: number
      readonly height?: number
    }
  | { readonly t: 'br' }
  /** An allowlisted inline HTML element kept as itself. */
  | { readonly t: 'tag'; readonly tag: 'kbd' | 'sub' | 'sup'; readonly c: readonly Inline[] }

export type Block =
  | { readonly t: 'heading'; readonly level: number; readonly c: readonly Inline[] }
  | { readonly t: 'paragraph'; readonly c: readonly Inline[] }
  | { readonly t: 'code'; readonly lang: string; readonly v: string }
  | {
      readonly t: 'list'
      readonly ordered: boolean
      readonly items: readonly (readonly Inline[])[]
      /** Per item: `true`/`false` for a task (`- [x]` / `- [ ]`), null for a plain item. Absent when no item is a task. */
      readonly tasks?: readonly (boolean | null)[]
    }
  | { readonly t: 'quote'; readonly c: readonly Block[] }
  | {
      readonly t: 'table'
      readonly header: readonly (readonly Inline[])[]
      readonly align: readonly TableAlignment[]
      readonly rows: readonly (readonly (readonly Inline[])[])[]
    }
  | { readonly t: 'hr' }
  /** The inline content of a raw HTML block (text and inline elements, no Markdown). */
  | { readonly t: 'inline'; readonly c: readonly Inline[] }
  /** An allowlisted HTML container (`<details>`, `<p align=center>`, `<td>`…) and what it holds. */
  | {
      readonly t: 'element'
      readonly tag: ElementTag
      readonly align: 'left' | 'center' | 'right' | null
      /** `a` only: the (checked) link target. */
      readonly href?: string
      /** `details` only: starts expanded. */
      readonly open?: boolean
      readonly c: readonly Block[]
    }

/** HTML containers kept as themselves; other block tags GitHub allows render as `div`. */
export type ElementTag =
  | 'details' | 'summary' | 'p' | 'div' | 'a' | 'blockquote'
  | 'table' | 'thead' | 'tbody' | 'tfoot' | 'tr' | 'td' | 'th'
  | 'ul' | 'ol' | 'li' | 'dl' | 'dt' | 'dd'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

export type TableAlignment = 'left' | 'center' | 'right' | null

/**
 * Restrict link/image hrefs to safe schemes, same-site paths and relative paths. Protocol-
 * relative forms (`//host/x`, and `/\host/x` or `\\host`, which browsers read the same way)
 * are refused: they point off-site, so an image written that way is a tracking pixel that
 * logs every viewer's IP. ASCII tab/CR/LF are dropped first, as the URL parser drops them
 * (`/<TAB>/host` is `//host`). Any other scheme (`javascript:`, `data:`) is refused.
 *
 * A relative path (`docs/a.md`, `./logo.png`) is kept: the renderer resolves it against the
 * repo the Markdown came from ({@link isRelativeHref}), or drops it where there is none.
 */
export function safeHref(href: string): string {
  const h = href.replace(/[\t\n\r]/g, '').trim()
  if (h === '' || /^[/\\][/\\]/.test(h)) return '#'
  if (/^(https?:|mailto:|dash:|ipfs:|#|\/)/i.test(h)) return h
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.includes('\\')) return '#'
  return h
}

/** A path relative to the Markdown file (not a URL, fragment or site path). */
export function isRelativeHref(href: string): boolean {
  return href !== '' && !/^(https?:|mailto:|dash:|ipfs:|#|\/|[a-z][a-z0-9+.-]*:)/i.test(href)
}
/**
 * Sources longer than this (UTF-16 units, ≈ bytes for ASCII) are shown as plain text instead
 * of being parsed: parsing stays linear, but the element tree of a multi-megabyte document is
 * itself too slow to render.
 */
export const MARKDOWN_MAX_CHARS = 1 << 20

/**
 * Most AST nodes one document may produce. Parsing is linear, but every node becomes a React
 * element, and a hostile 1 MiB body can ask for hundreds of thousands (`*x* *x* …`). Past
 * the budget, the rest of the document is one plain-text paragraph (fail closed).
 */
export const MARKDOWN_MAX_NODES = 20_000

/** Nodes left in the current {@link parseMarkdown} call (parsing is synchronous). */
let nodesLeft = MARKDOWN_MAX_NODES

/**
 * `src.indexOf(ch, from)` for a scan whose `from` never decreases: the last answer is reused
 * until the scan passes it, so a whole scan costs O(n) in total rather than O(n) per query.
 * This is what keeps unclosed delimiters (`[[[[…`, `![![…`, `[a](b[a](b…`) linear.
 */
function forwardFinder(src: string, ch: string): (from: number) => number {
  let at = -2 // -2: not searched yet; -1: no `ch` at or after the last `from`
  return (from) => {
    if (at !== -1 && at < from) at = src.indexOf(ch, from)
    return at
  }
}

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)

/** ASCII punctuation a backslash escapes (CommonMark §2.4). */
const ESCAPABLE = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')

/** Reference definitions (`[label]: url`) of the document being parsed, keyed by normalized label. */
let references: ReadonlyMap<string, string> = new Map()

/** A reference label as CommonMark matches it: case-folded, inner whitespace collapsed. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Characters GFM trims from the end of a bare autolink (`https://x.io/a.` ends at `a`). */
const AUTOLINK_TRAILING_CHARS = new Set(['?', '!', '.', ',', ':', '*', '_', '~', "'", '"'])

/**
 * Where a bare `http(s)://` autolink starting at `start` ends, GitHub's way: at whitespace or
 * `<`, then trailing punctuation and quotes are dropped, and a `)` is kept only while the
 * link's parentheses balance (`https://en.wikipedia.org/wiki/Foo_(bar)`).
 */
function autolinkEnd(src: string, start: number, bodyStart: number): number {
  let end = bodyStart
  let open = 0
  let close = 0
  while (end < src.length && !isSpace(src[end]) && src[end] !== '<') {
    if (src[end] === '(') open += 1
    else if (src[end] === ')') close += 1
    end += 1
  }
  // Trim from the end, one character per step (linear): trailing punctuation and quotes, a
  // `)` that closes nothing, and a trailing `&name;` entity.
  while (end > bodyStart) {
    const c = src[end - 1] as string
    if (AUTOLINK_TRAILING_CHARS.has(c)) {
      end -= 1
    } else if (c === ')' && close > open) {
      close -= 1
      end -= 1
    } else if (c === ';') {
      let j = end - 2
      while (j > bodyStart && /[a-z]/i.test(src[j] as string) && end - j < 12) j -= 1
      if (src[j] === '&' && j < end - 2) end = j
      else break
    } else break
  }
  return end
}

/**
 * Inline spans, scanned left to right without backtracking regexes. Every step consumes at
 * least one character, and each delimiter lookup goes through a {@link forwardFinder}, so a
 * pass is linear in `src` (nested spans re-scan only the text they consumed).
 *
 * The span grammar is the original regex one: `![alt](src …)`, `[text](href …)`,
 * `` `code` ``, `**x**` / `__x__`, `~~x~~`, `*x*` / `_x_`. On top of it:
 * - `\*` and friends are literal characters, and `&amp;`-style references decode;
 * - a link's text is scanned for its closing `]` with nesting, so a badge
 *   `[![alt](img)](href)` is an image inside a link;
 * - `[text][ref]`, `[text][]` and `[ref]` use the document's reference definitions;
 * - bare `http(s)://` autolinks follow GFM (no trailing punctuation or quotes), and `<url>`;
 * - allowlisted inline HTML (`<img>`, `<br>`, `<kbd>`, `<sub>`, `<sup>`, `<b>`, `<a>`…) is
 *   kept, other tags are dropped with their text kept (`markdown-html.ts`);
 * - a line ending in two spaces or `\` is a hard break (lines are joined with `\n`).
 */
function parseInline(src: string, depth = 0, htmlOnly = false): Inline[] {
  const out: Inline[] = []
  // Text is collected as pieces and joined once per run: reading a `+=`-built string (as a
  // line-end check must) flattens it, which made a 1 MiB paragraph quadratic.
  let pieces: string[] = []
  let pendingSpaces = 0 // spaces right before the cursor, held back for the hard-break rule
  const add = (piece: string): void => {
    if (pendingSpaces > 0) {
      pieces.push(' '.repeat(pendingSpaces))
      pendingSpaces = 0
    }
    pieces.push(piece)
  }
  const flush = (): void => {
    if (pendingSpaces > 0) add('')
    if (pieces.length > 0) {
      const v = pieces.join('')
      pieces = []
      if (v !== '') {
        out.push({ t: 'text', v })
        nodesLeft -= 1
      }
    }
  }
  /** Emit a span node (after the text before it). */
  const push = (node: Inline): void => {
    flush()
    out.push(node)
    nodesLeft -= 1
  }
  // One finder per (delimiter, offset) so each one's `from` only moves forward.
  const imageBracket = forwardFinder(src, ']')
  const imageParen = forwardFinder(src, ')')
  // Link destinations and `][ref]` labels are looked up from each `]`, and nested link text
  // makes those positions go backwards, so they use exact next-occurrence tables (one pass).
  const linkParen = nextIndexOf(src, ')')
  const refClose = nextIndexOf(src, ']')
  const tick = forwardFinder(src, '`')
  const tagClose = forwardFinder(src, '>')
  const semicolon = forwardFinder(src, ';')
  const closingTag = closingTags(src)
  const pairClose = { '*': forwardFinder(src, '*'), _: forwardFinder(src, '_'), '~': forwardFinder(src, '~') }
  const singleClose = { '*': forwardFinder(src, '*'), _: forwardFinder(src, '_') }
  // Matching `]` for each `[`, found by one stack pass (escapes and code spans skipped): link
  // text may hold brackets, as a badge's `![alt](src)` does. Linear, and computed once.
  const closeOf = htmlOnly ? new Map<number, number>() : matchBrackets(src)

  /** `(href …)` right after `]` at `close`: the href and the index past `)`. */
  const destination = (close: number, paren: (from: number) => number): { href: string; end: number } | null => {
    if (src[close + 1] !== '(') return null
    const hrefStart = close + 2
    const end = paren(hrefStart)
    if (end === -1 || end === hrefStart || isSpace(src[hrefStart])) return null
    let hrefEnd = hrefStart
    while (hrefEnd < end && !isSpace(src[hrefEnd])) hrefEnd += 1
    let href = src.slice(hrefStart, hrefEnd)
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1)
    return { href: decodeEntities(unescape(href)), end: end + 1 }
  }

  /** A reference link `[text][ref]` / `[text][]` / `[ref]` whose text ends at `close`. */
  const reference = (open: number, close: number): { href: string; end: number } | null => {
    if (references.size === 0) return null
    if (src[close + 1] === '[') {
      const refEnd = refClose(close + 2)
      if (refEnd === -1) return null
      const label = refEnd === close + 2 ? src.slice(open + 1, close) : src.slice(close + 2, refEnd)
      const href = references.get(normalizeLabel(label))
      return href === undefined ? null : { href, end: refEnd + 1 }
    }
    const href = references.get(normalizeLabel(src.slice(open + 1, close)))
    return href === undefined ? null : { href, end: close + 1 }
  }

  let i = 0
  while (i < src.length) {
    if (nodesLeft <= 0) {
      add(src.slice(i)) // node budget spent: the rest is plain text
      break
    }
    const ch = src[i] as string
    const next = src[i + 1]

    // backslash escape: `\*` is a literal `*`; `\` at a line end is a hard break
    if (ch === '\\' && !htmlOnly) {
      if (next === '\n') {
        push({ t: 'br' })
        i += 2
        continue
      }
      if (next !== undefined && ESCAPABLE.has(next)) {
        add(next)
        i += 2
        continue
      }
    }
    // hard break: two or more spaces before a line end; a plain line end is a space
    if (ch === '\n') {
      const hard = !htmlOnly && pendingSpaces >= 2
      pendingSpaces = 0
      if (hard) push({ t: 'br' })
      else add(' ')
      i += 1
      continue
    }
    if (ch === ' ') {
      pendingSpaces += 1
      i += 1
      continue
    }
    // entity / character reference
    if (ch === '&') {
      const semi = semicolon(i + 1)
      if (semi !== -1 && semi - i <= 32) {
        const decoded = decodeEntities(src.slice(i, semi + 1))
        if (decoded !== src.slice(i, semi + 1)) {
          add(decoded)
          i = semi + 1
          continue
        }
      }
    }
    // Inside a raw HTML block only tags and entities mean anything (as on GitHub).
    if (htmlOnly && ch !== '<') {
      add(ch)
      i += 1
      continue
    }
    // image ![alt](src)
    if (ch === '!' && next === '[') {
      const close = imageBracket(i + 2)
      const m = close === -1 ? null : destination(close, imageParen)
      if (m) {
        push({ t: 'image', src: safeHref(m.href), alt: plain(src.slice(i + 2, close)) })
        i = m.end
        continue
      }
    }
    // link [text](href), [text][ref], [ref]
    if (ch === '[' && depth < MAX_INLINE_DEPTH) {
      const close = closeOf.get(i)
      if (close !== undefined && close > i + 1) {
        const m = destination(close, linkParen) ?? reference(i, close)
        if (m) {
          push({ t: 'link', href: safeHref(m.href), c: parseInline(src.slice(i + 1, close), depth + 1) })
          i = m.end
          continue
        }
      }
    }
    // inline code `code`
    if (ch === '`') {
      const close = tick(i + 1)
      if (close > i + 1) {
        push({ t: 'code', v: src.slice(i + 1, close).replace(/\n/g, ' ') })
        i = close + 1
        continue
      }
    }
    // inline HTML and `<url>` autolinks
    if (ch === '<') {
      const close = tagClose(i + 1)
      if (close !== -1 && close - i <= MAX_TAG_CHARS) {
        const inner = src.slice(i + 1, close)
        if (!htmlOnly && /^(https?|mailto):[^\s<>]*$/i.test(inner)) {
          push({ t: 'link', href: safeHref(inner), c: [{ t: 'text', v: inner.replace(/^mailto:/i, '') }] })
          i = close + 1
          continue
        }
        const tag = parseTag(src, i, close)
        if (tag !== null) {
          const consumed = inlineTag(tag, close + 1, depth, htmlOnly, closingTag, src)
          if (consumed !== null) {
            if (consumed.node !== null) push(consumed.node)
            i = consumed.end
            continue
          }
        }
      }
    }
    // strong **x** / __x__, strikethrough ~~x~~
    if ((ch === '*' || ch === '_' || ch === '~') && next === ch && depth < MAX_INLINE_DEPTH) {
      const close = pairClose[ch](i + 2)
      if (close > i + 2 && src[close + 1] === ch) {
        const c = parseInline(src.slice(i + 2, close), depth + 1)
        push(ch === '~' ? { t: 'del', c } : { t: 'strong', c })
        i = close + 2
        continue
      }
    }
    // em *x* / _x_ (an intraword `_` is literal: snake_case_names)
    if ((ch === '*' || (ch === '_' && !isWordChar(src[i - 1]))) && depth < MAX_INLINE_DEPTH) {
      const close = singleClose[ch](i + 1)
      if (close > i + 1 && (ch === '*' || !isWordChar(src[close + 1]))) {
        push({ t: 'em', c: parseInline(src.slice(i + 1, close), depth + 1) })
        i = close + 1
        continue
      }
    }
    // bare autolink (GFM: trailing punctuation and quotes are not part of it)
    if (ch === 'h' && !isWordChar(src[i - 1]) && (src.startsWith('http://', i) || src.startsWith('https://', i))) {
      const bodyStart = i + (src[i + 4] === 's' ? 8 : 7)
      const end = autolinkEnd(src, i, bodyStart)
      if (end > bodyStart) {
        const url = src.slice(i, end)
        push({ t: 'link', href: safeHref(url), c: [{ t: 'text', v: url }] })
        i = end
        continue
      }
    }
    add(ch)
    i += 1
  }
  if (depth === 0) pendingSpaces = 0 // a paragraph's trailing spaces go; a span's (`<b>Note: </b>x`) stay
  flush()
  return out
}

/**
 * `f(from)`: the index of the first `ch` at or after `from`, or -1, for any `from` in any order.
 * One right-to-left pass builds the table, so every lookup is O(1).
 */
function nextIndexOf(src: string, ch: string): (from: number) => number {
  let table: Int32Array | null = null
  return (from) => {
    if (table === null) {
      table = new Int32Array(src.length + 1)
      let next = -1
      table[src.length] = -1
      for (let k = src.length - 1; k >= 0; k--) {
        if (src[k] === ch) next = k
        table[k] = next
      }
    }
    return from >= src.length ? -1 : (table[Math.max(0, from)] as number)
  }
}

/**
 * Closing-tag lookups: `f(name, from)` finds `</name>` at or after `from` (ignoring ASCII
 * case), with one forward finder per name so a run of unclosed `<kbd>` costs one scan. Only
 * ASCII letters are lowercased: `toLowerCase` changes some strings' length (`İ` becomes two
 * units), which would shift every offset after it.
 */
function closingTags(src: string): (name: string, from: number) => number {
  const lower = src.includes('<') ? src.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : src
  const finders = new Map<string, (from: number) => number>()
  return (name, from) => {
    let f = finders.get(name)
    if (f === undefined) {
      f = forwardFinder(lower, `</${name}>`)
      finders.set(name, f)
    }
    return f(from)
  }
}

/** Nesting cap for spans inside spans (a hostile `[[[[…](x)](x)…` stays shallow). */
const MAX_INLINE_DEPTH = 32

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)

/** Drop backslash escapes: `\*` → `*`. */
function unescape(s: string): string {
  return s.includes('\\') ? s.replace(/\\([!-/:-@[-`{-~])/g, '$1') : s
}

/** An image's alt text: its label with Markdown punctuation left as written, escapes and entities resolved. */
function plain(label: string): string {
  return decodeEntities(unescape(label))
}

/**
 * The matching `]` of every `[` in `src`, skipping escaped brackets and code spans: one linear
 * stack pass. Unmatched brackets have no entry.
 */
function matchBrackets(src: string): Map<number, number> {
  const out = new Map<number, number>()
  if (!src.includes('[')) return out
  const stack: number[] = []
  const tick = forwardFinder(src, '`')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      i += 1
      continue
    }
    if (c === '`') {
      // A code span runs to the next backtick, as the span rule reads it. With none left,
      // no later backtick opens a span either.
      const end = tick(i + 1)
      if (end !== -1) i = end
      continue
    }
    if (c === '[') stack.push(i)
    else if (c === ']' && stack.length > 0) out.set(stack.pop() as number, i)
  }
  return out
}

/**
 * An inline HTML tag at `src[..end)`: the node it becomes (null: nothing, e.g. a dropped tag)
 * and where scanning resumes. Paired tags consume through their closing tag.
 */
function inlineTag(
  tag: TagToken,
  end: number,
  depth: number,
  htmlOnly: boolean,
  closingTag: (name: string, from: number) => number,
  src: string,
): { node: Inline | null; end: number } | null {
  if (tag.close) return { node: null, end } // a stray closing tag: dropped
  if (tag.name === 'br') return { node: { t: 'br' }, end }
  if (tag.name === 'img') {
    const width = sizeAttr(tag.attrs['width'])
    const height = sizeAttr(tag.attrs['height'])
    return {
      node: {
        t: 'image',
        src: safeHref(tag.attrs['src'] ?? ''),
        alt: tag.attrs['alt'] ?? '',
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      },
      end,
    }
  }
  const closing = closingTag(tag.name, end)
  if (DROP_WITH_CONTENTS.has(tag.name)) {
    return { node: null, end: closing === -1 ? src.length : closing + tag.name.length + 3 }
  }
  const alias = Object.hasOwn(SPAN_ALIASES, tag.name) ? SPAN_ALIASES[tag.name] : undefined
  const kept = INLINE_TAGS.has(tag.name) ? (tag.name as 'kbd' | 'sub' | 'sup') : undefined
  if ((alias !== undefined || kept !== undefined || tag.name === 'a') && closing !== -1 && depth < MAX_INLINE_DEPTH) {
    const c = parseInline(src.slice(end, closing), depth + 1, htmlOnly)
    const after = closing + tag.name.length + 3
    if (kept !== undefined) return { node: { t: 'tag', tag: kept, c }, end: after }
    if (alias !== undefined) return { node: { t: alias, c }, end: after }
    const href = tag.attrs['href']
    return { node: href === undefined ? null : { t: 'link', href: safeHref(href), c }, end: href === undefined ? end : after }
  }
  // Any other tag (`<span>`, `<font>`, `<abbr>`…): the tag goes, its text stays.
  return { node: null, end }
}

/** Split a GFM table row without treating escaped or inline-code pipes as delimiters. */
function splitTableRow(line: string): string[] {
  const cells: string[] = ['']
  let codeFence = 0

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? ''
    if (ch === '\\' && line[i + 1] === '|') {
      cells[cells.length - 1] += '|'
      i += 1
      continue
    }
    if (ch === '`') {
      let ticks = 1
      while (line[i + ticks] === '`') ticks += 1
      if (codeFence === 0) codeFence = ticks
      else if (codeFence === ticks) codeFence = 0
      cells[cells.length - 1] += '`'.repeat(ticks)
      i += ticks - 1
      continue
    }
    if (ch === '|' && codeFence === 0) {
      cells.push('')
      continue
    }
    cells[cells.length - 1] += ch
  }

  if (cells[0]?.trim() === '') cells.shift()
  if (cells[cells.length - 1]?.trim() === '') cells.pop()
  return cells.map((cell) => cell.trim())
}

function delimiterAlignment(cell: string): TableAlignment | undefined {
  const delimiter = cell.trim()
  if (!/^:?-{3,}:?$/.test(delimiter)) return undefined
  if (delimiter.startsWith(':') && delimiter.endsWith(':')) return 'center'
  if (delimiter.endsWith(':')) return 'right'
  if (delimiter.startsWith(':')) return 'left'
  return null
}

/** Wider tables are left as paragraphs: every cell of every row is its own node. */
const MAX_TABLE_COLUMNS = 128

/** The header cells and alignments when a GFM table starts at `lines[start]`, else null. */
function tableStart(
  lines: readonly string[],
  start: number,
): { readonly headerCells: string[]; readonly align: TableAlignment[] } | null {
  const headerLine = lines[start]
  const delimiterLine = lines[start + 1]
  if (
    headerLine === undefined ||
    delimiterLine === undefined ||
    !headerLine.includes('|') ||
    !delimiterLine.includes('|')
  ) {
    return null
  }

  const headerCells = splitTableRow(headerLine)
  const delimiterCells = splitTableRow(delimiterLine)
  if (
    headerCells.length === 0 ||
    headerCells.length > MAX_TABLE_COLUMNS ||
    headerCells.length !== delimiterCells.length
  ) {
    return null
  }

  const align: TableAlignment[] = []
  for (const cell of delimiterCells) {
    const alignment = delimiterAlignment(cell)
    if (alignment === undefined) return null
    align.push(alignment)
  }
  return { headerCells, align }
}

function parseTable(
  lines: readonly string[],
  start: number,
): { readonly block: Block; readonly next: number } | null {
  const head = tableStart(lines, start)
  if (head === null) return null
  const { headerCells, align } = head
  const columnCount = headerCells.length
  nodesLeft -= columnCount // the header row
  const rows: Inline[][][] = []
  let next = start + 2
  while (next < lines.length && nodesLeft >= columnCount) {
    const rowLine = lines[next] ?? ''
    if (rowLine.trim() === '' || !rowLine.includes('|')) break
    nodesLeft -= columnCount
    const row = splitTableRow(rowLine).slice(0, columnCount)
    while (row.length < columnCount) row.push('')
    rows.push(row.map((cell) => parseInline(cell)))
    next += 1
  }

  return {
    block: {
      t: 'table',
      header: headerCells.map((cell) => parseInline(cell)),
      align,
      rows,
    },
    next,
  }
}

/**
 * Only LF, CR and CRLF end a line (CommonMark §2.1, as GitHub renders it); CR and CRLF become
 * `\n` before any line logic runs.
 */
const LINE_ENDINGS = /\r\n?/g

/**
 * Characters JavaScript treats as line terminators or `\s` but Markdown does not end a line
 * on: VT, FF, NEL (U+0085) and the Unicode LINE / PARAGRAPH SEPARATORs (U+2028 / U+2029).
 * They become a plain space. Left in place, JS regexes disagreed about them (`\s` matches
 * U+2028 but `.` does not), so `isBlockStart` accepted `# a<U+2028>` while the heading regex
 * rejected it, and the paragraph collector then consumed nothing, forever (D-900).
 */
const SPACE_LIKE = /[\u000b\u000c\u0085\u2028\u2029]/g

/** Blockquotes nest by recursion; past this depth the rest of a quote is plain text. */
const MAX_QUOTE_DEPTH = 16

const HEADING = /^(#{1,6})\s+([\s\S]*)$/
const HR = /^(\s*[-*_]){3,}\s*$/
const UL_ITEM = /^\s*[-*+]\s+([\s\S]*)$/
const OL_ITEM = /^\s*\d+\.\s+([\s\S]*)$/

/** Parse a markdown document into a block AST. */
export function parseMarkdown(src: string): Block[] {
  nodesLeft = MARKDOWN_MAX_NODES
  const lines = src.replace(LINE_ENDINGS, '\n').replace(SPACE_LIKE, ' ').split('\n')
  references = collectReferences(lines)
  try {
    return parseBlocks(lines, 0)
  } finally {
    references = new Map()
  }
}

/** Most reference definitions one document may declare. */
const MAX_REFERENCES = 1000

/**
 * `[label]: url "title"`, on its own line. Linear: `[ \t]*` and the destination's `[^\s<>]`
 * cannot overlap, and the title is matched by a plain `.*`.
 */
const REFERENCE_DEF = /^ {0,3}\[([^\]\n]{1,999})\]:[ \t]*<?([^\s<>]+)>?(?:[ \t]+.*)?$/

/**
 * Collect reference definitions (first one wins, as in CommonMark) and blank their lines so
 * they render as nothing. A definition cannot interrupt a paragraph, and fenced code holds
 * none.
 */
function collectReferences(lines: string[]): Map<string, string> {
  const refs = new Map<string, string>()
  let fenced = false
  let prevBlank = true
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.startsWith('```')) fenced = !fenced
    const m = !fenced && prevBlank && line.length < 2048 ? REFERENCE_DEF.exec(line) : null
    if (m !== null && refs.size < MAX_REFERENCES) {
      const label = normalizeLabel(m[1] as string)
      if (label !== '' && !refs.has(label)) refs.set(label, decodeEntities(unescape(m[2] as string)))
      lines[i] = ''
      continue // the next line may be another definition
    }
    prevBlank = line.trim() === ''
  }
  return refs
}

/** A run of lines as one paragraph of plain text: the fail-closed rendering. */
const plainParagraph = (lines: readonly string[]): Block => ({
  t: 'paragraph',
  c: [{ t: 'text', v: lines.join(' ').trim() }],
})

/** An HTML container opening or closing inside a run of blocks, before the tree is built. */
type Item =
  | Block
  | { readonly t: 'open'; readonly tag: ElementTag; readonly name: string; readonly attrs: Readonly<Record<string, string>> }
  | { readonly t: 'close'; readonly name: string }

/** HTML elements kept as containers, by source name → the element rendered. */
const CONTAINERS: Readonly<Record<string, ElementTag>> = {
  details: 'details', summary: 'summary', p: 'p', div: 'div', a: 'a', blockquote: 'blockquote',
  table: 'table', thead: 'thead', tbody: 'tbody', tfoot: 'tfoot', tr: 'tr', td: 'td', th: 'th',
  ul: 'ul', ol: 'ol', li: 'li', dl: 'dl', dt: 'dt', dd: 'dd',
  h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
  center: 'div', section: 'div', article: 'div', header: 'div', footer: 'div', main: 'div',
  nav: 'div', aside: 'div', figure: 'div', figcaption: 'div', caption: 'div',
}

/** HTML containers nest at most this deep; deeper opening tags are ignored. */
const MAX_HTML_DEPTH = 32

/** Elements whose block runs to their closing tag, not a blank line (CommonMark type 1). */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'pre'])

/**
 * The items a raw HTML block produces: container tags as open/close items, `<hr>` as a rule,
 * and everything between them as inline content (text plus the allowlisted inline elements,
 * no Markdown). Dropped elements vanish with their contents. One forward pass.
 */
function htmlItems(src: string): Item[] {
  const items: Item[] = []
  const gt = forwardFinder(src, '>')
  const lt = forwardFinder(src, '<')
  const closing = closingTags(src)
  let textStart = 0
  const flushText = (end: number): void => {
    const text = src.slice(textStart, end)
    if (text.trim() !== '') items.push({ t: 'inline', c: parseInline(text.trim(), 0, true) })
  }
  let i = 0
  while (nodesLeft > 0) {
    const open = lt(i)
    if (open === -1) break
    const close = gt(open + 1)
    if (close === -1) break
    const tag = close - open <= MAX_TAG_CHARS ? parseTag(src, open, close) : null
    i = open + 1
    if (tag === null) continue
    const container = Object.hasOwn(CONTAINERS, tag.name) ? CONTAINERS[tag.name] : undefined
    if (container !== undefined || tag.name === 'hr') {
      flushText(open)
      if (tag.name === 'hr') items.push({ t: 'hr' })
      else if (tag.close) items.push({ t: 'close', name: tag.name })
      else items.push({ t: 'open', tag: container as ElementTag, name: tag.name, attrs: tag.attrs })
      nodesLeft -= 1
      i = textStart = close + 1
    } else if (DROP_WITH_CONTENTS.has(tag.name) && !tag.close) {
      flushText(open)
      const end = closing(tag.name, close + 1)
      i = textStart = end === -1 ? src.length : end + tag.name.length + 3
    } else {
      i = close + 1 // an inline element: it stays in the text for the inline parser
    }
  }
  flushText(src.length)
  return items
}

const ALIGN = new Set(['left', 'center', 'right'])

/** Build the element tree from open/close items, as a browser's tree builder would. */
function buildTree(items: readonly Item[]): Block[] {
  interface Frame {
    readonly tag: ElementTag
    readonly name: string
    readonly attrs: Readonly<Record<string, string>>
    readonly c: Block[]
  }
  const root: Block[] = []
  const stack: Frame[] = []
  const top = (): Block[] => (stack.length === 0 ? root : (stack[stack.length - 1] as Frame).c)
  const pop = (): void => {
    const f = stack.pop() as Frame
    const align = (f.attrs['align'] ?? '').toLowerCase()
    top().push({
      t: 'element',
      tag: f.tag,
      align: ALIGN.has(align) ? (align as 'left' | 'center' | 'right') : f.name === 'center' ? 'center' : null,
      ...(f.tag === 'a' && f.attrs['href'] !== undefined ? { href: safeHref(f.attrs['href']) } : {}),
      ...(f.tag === 'details' && 'open' in f.attrs ? { open: true } : {}),
      c: f.c,
    })
  }
  for (const item of items) {
    if (item.t === 'open') {
      if (stack.length < MAX_HTML_DEPTH) stack.push({ tag: item.tag, name: item.name, attrs: item.attrs, c: [] })
    } else if (item.t === 'close') {
      // Close the innermost open element of that name (and anything left open inside it); a
      // closing tag nothing matches is ignored.
      let at = stack.length - 1
      while (at >= 0 && (stack[at] as Frame).name !== item.name) at -= 1
      if (at >= 0) while (stack.length > at) pop()
    } else {
      top().push(item)
    }
  }
  while (stack.length > 0) pop()
  return root
}

/** GitHub's task-list marker at the start of a list item: `[ ] ` or `[x] `. */
const TASK = /^\[([ xX])\][ \t]/

function parseBlocks(lines: readonly string[], depth: number): Block[] {
  const blocks: Item[] = []
  let i = 0

  /** Parse one block at `lines[i]`, advancing `i` past it. */
  const step = (): void => {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i += 1
      return
    }
    // fenced code
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      const lang = fence[1] ?? ''
      i += 1
      const buf: string[] = []
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        buf.push(lines[i] ?? '')
        i += 1
      }
      i += 1 // closing fence
      blocks.push({ t: 'code', lang, v: buf.join('\n') })
      return
    }
    // raw HTML block (CommonMark §4.6)
    const html = htmlBlockStart(line)
    if (html !== null) {
      const name = (/^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(line)?.[1] ?? '').toLowerCase()
      const buf = [line]
      i += 1
      if (RAW_TEXT.has(name)) {
        // Runs to the line holding its closing tag (or the end).
        const end = `</${name}>`
        if (!line.toLowerCase().includes(end)) {
          while (i < lines.length && !(lines[i] ?? '').toLowerCase().includes(end)) buf.push(lines[i++] ?? '')
          if (i < lines.length) buf.push(lines[i++] ?? '')
        }
        if (name === 'pre') {
          const text = buf.join('\n').replace(/<[^<>]{0,1024}>/g, '')
          blocks.push({ t: 'code', lang: '', v: trimNewlines(decodeEntities(text)) })
        }
        return
      }
      while (i < lines.length && (lines[i] ?? '').trim() !== '') buf.push(lines[i++] ?? '')
      blocks.push(...htmlItems(buf.join('\n')))
      return
    }
    // heading
    const h = line.match(HEADING)
    if (h) {
      blocks.push({ t: 'heading', level: h[1]?.length ?? 1, c: parseInline(stripClosingHashes(h[2] ?? '').trim()) })
      i += 1
      return
    }
    // GFM table: header row followed by a delimiter/alignment row.
    const table = parseTable(lines, i)
    if (table) {
      blocks.push(table.block)
      i = table.next
      return
    }
    // hr
    if (HR.test(line)) {
      blocks.push({ t: 'hr' })
      i += 1
      return
    }
    // blockquote
    if (line.startsWith('>')) {
      const buf: string[] = []
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        buf.push((lines[i] ?? '').replace(/^>\s?/, ''))
        i += 1
      }
      const inner = depth + 1 < MAX_QUOTE_DEPTH ? parseBlocks(buf, depth + 1) : [plainParagraph(buf)]
      blocks.push({ t: 'quote', c: inner })
      return
    }
    // list (GitHub task-list items: `- [ ] todo`, `- [x] done`)
    const ordered = OL_ITEM.test(line)
    if (ordered || UL_ITEM.test(line)) {
      const item = ordered ? OL_ITEM : UL_ITEM
      const items: Inline[][] = []
      const tasks: (boolean | null)[] = []
      while (i < lines.length && nodesLeft > 0) {
        const mm = (lines[i] ?? '').match(item)
        if (!mm) break
        nodesLeft -= 1
        const body = mm[1] ?? ''
        const task = TASK.exec(body)
        tasks.push(task === null ? null : task[1] !== ' ')
        items.push(parseInline(task === null ? body : body.slice(task[0].length)))
        i += 1
      }
      blocks.push(tasks.some((t) => t !== null) ? { t: 'list', ordered, items, tasks } : { t: 'list', ordered, items })
      return
    }
    // paragraph: this line, plus following lines until a blank line or another block starts.
    // Lines are joined with `\n` so the inline parser can see hard breaks.
    const buf = [line]
    i += 1
    while (
      i < lines.length &&
      lines[i]?.trim() !== '' &&
      !isBlockStart(lines[i] ?? '') &&
      tableStart(lines, i) === null
    ) {
      buf.push(lines[i] ?? '')
      i += 1
    }
    blocks.push({ t: 'paragraph', c: parseInline(buf.map((l) => l.replace(/^[ \t]+/, '')).join('\n').trim()) })
  }

  while (i < lines.length) {
    if (nodesLeft <= 0) {
      blocks.push(plainParagraph(lines.slice(i))) // node budget spent: fail closed to text
      break
    }
    const start = i
    const before = blocks.length
    step()
    nodesLeft -= blocks.length - before
    // Every step must consume a line. If a future rule ever disagrees with another about
    // where a block starts, fail closed — render the rest as text — rather than spin forever.
    if (i <= start) {
      blocks.push(plainParagraph(lines.slice(start)))
      break
    }
  }
  return buildTree(blocks)
}

function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s/.test(line) ||
    line.startsWith('```') ||
    line.startsWith('>') ||
    UL_ITEM.test(line) ||
    OL_ITEM.test(line) ||
    HR.test(line) ||
    htmlBlockStart(line) === 'strong'
  )
}

/** An ATX heading's text without its optional closing `#`s (`## a ##`). A backward scan: the
 * regex form `/[ \t]+#+[ \t]*$/` is quadratic on a long run of spaces. */
function stripClosingHashes(s: string): string {
  let end = s.length
  while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) end -= 1
  let j = end
  while (j > 0 && s[j - 1] === '#') j -= 1
  if (j === end) return s
  if (j === 0) return ''
  return s[j - 1] === ' ' || s[j - 1] === '\t' ? s.slice(0, j) : s
}

/** `s` without leading and trailing newlines (index loops, not a quadratic regex). */
function trimNewlines(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && s[a] === '\n') a += 1
  while (b > a && s[b - 1] === '\n') b -= 1
  return s.slice(a, b)
}

/**
 * GitHub's heading anchor: lowercased, punctuation dropped, spaces to `-`. The renderer
 * prefixes `user-content-` (as GitHub does) and numbers repeats.
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

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
 * Supported: ATX headings, fenced + inline code, bold/italic/strikethrough, links, images,
 * unordered/ordered lists, blockquotes, horizontal rules, GFM tables, and paragraphs.
 */

export type Inline =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'strong'; readonly c: readonly Inline[] }
  | { readonly t: 'em'; readonly c: readonly Inline[] }
  | { readonly t: 'del'; readonly c: readonly Inline[] }
  | { readonly t: 'code'; readonly v: string }
  | { readonly t: 'link'; readonly href: string; readonly c: readonly Inline[] }
  | { readonly t: 'image'; readonly src: string; readonly alt: string }

export type Block =
  | { readonly t: 'heading'; readonly level: number; readonly c: readonly Inline[] }
  | { readonly t: 'paragraph'; readonly c: readonly Inline[] }
  | { readonly t: 'code'; readonly lang: string; readonly v: string }
  | { readonly t: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly t: 'quote'; readonly c: readonly Block[] }
  | {
      readonly t: 'table'
      readonly header: readonly (readonly Inline[])[]
      readonly align: readonly TableAlignment[]
      readonly rows: readonly (readonly (readonly Inline[])[])[]
    }
  | { readonly t: 'hr' }

export type TableAlignment = 'left' | 'center' | 'right' | null

/** A piece of plain text split by {@link splitRefs}. */
export type RefPiece =
  | { readonly t: 'text'; readonly v: string }
  /** `#12`: issue or PR 12 of the current repo. */
  | { readonly t: 'ref'; readonly n: number }
  /** `@alice` / `@alice.dash`: a DPNS name. */
  | { readonly t: 'mention'; readonly name: string }

/**
 * `#n` (1–10 digits) and `@name` (a DPNS label, optionally `.dash`) in plain text, the GitHub
 * way: only at a word boundary (not inside `a#1`, `x@y.com` or a URL fragment), and a `#n`
 * followed by a letter or digit is not a reference. Code spans and links are never split (the
 * caller applies this to text nodes only). Pure, so the parser stays render-agnostic.
 */
export function splitRefs(text: string): RefPiece[] {
  const out: RefPiece[] = []
  const re = /(^|[^\w/#@.&-])(?:#(\d{1,10})(?![\w-])|@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.dash)?(?![\w.@-]*[\w@]))/g
  let last = 0
  for (const m of text.matchAll(re)) {
    const lead = m[1] ?? ''
    const start = (m.index ?? 0) + lead.length
    if (start > last) out.push({ t: 'text', v: text.slice(last, start) })
    if (m[2] !== undefined) out.push({ t: 'ref', n: Number(m[2]) })
    else out.push({ t: 'mention', name: (m[3] ?? '').toLowerCase() })
    last = (m.index ?? 0) + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

/**
 * Restrict link/image hrefs to safe schemes and same-site paths. Protocol-relative forms
 * (`//host/x`, and `/\host/x`, which browsers read the same way) are refused: they point
 * off-site, so an image written that way is a tracking pixel that logs every viewer's IP.
 * ASCII tab/CR/LF are dropped first, as the URL parser drops them (`/<TAB>/host` is `//host`).
 */
function safeHref(href: string): string {
  const h = href.replace(/[\t\n\r]/g, '').trim()
  if (/^\/[/\\]/.test(h)) return '#'
  if (/^(https?:|mailto:|dash:|ipfs:|#|\/)/i.test(h)) return h
  return '#'
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

/**
 * Inline spans, scanned left to right without backtracking regexes. Every step consumes at
 * least one character, and each delimiter lookup goes through a {@link forwardFinder}, so a
 * pass is linear in `src` (nested spans re-scan only the text they consumed).
 *
 * The grammar is the original regex one: `![alt](src …)`, `[text](href …)`, `` `code` ``,
 * `**x**` / `__x__`, `~~x~~`, `*x*` / `_x_`, and bare `http(s)://` autolinks. A span's
 * content cannot contain its own closing delimiter, so a link or image ends at the first `]`
 * and the first `)` after it, which is exactly where the old regexes matched.
 */
function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = (): void => {
    if (text) {
      out.push({ t: 'text', v: text })
      nodesLeft -= 1
      text = ''
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
  const linkBracket = forwardFinder(src, ']')
  const linkParen = forwardFinder(src, ')')
  const tick = forwardFinder(src, '`')
  const pairClose = { '*': forwardFinder(src, '*'), _: forwardFinder(src, '_'), '~': forwardFinder(src, '~') }
  const singleClose = { '*': forwardFinder(src, '*'), _: forwardFinder(src, '_') }

  /** `[label](href …)` whose `[` is at `open`: the label, href and the index past `)`. */
  const bracketed = (
    open: number,
    bracket: (from: number) => number,
    paren: (from: number) => number,
    allowEmptyLabel: boolean,
  ): { label: string; href: string; end: number } | null => {
    const close = bracket(open + 1)
    if (close === -1 || (!allowEmptyLabel && close === open + 1) || src[close + 1] !== '(') return null
    const hrefStart = close + 2
    const end = paren(hrefStart)
    if (end === -1 || end === hrefStart || isSpace(src[hrefStart])) return null
    let hrefEnd = hrefStart
    while (hrefEnd < end && !isSpace(src[hrefEnd])) hrefEnd += 1
    return { label: src.slice(open + 1, close), href: src.slice(hrefStart, hrefEnd), end: end + 1 }
  }

  let i = 0
  while (i < src.length) {
    if (nodesLeft <= 0) {
      text += src.slice(i) // node budget spent: the rest is plain text
      break
    }
    const ch = src[i] as string
    const next = src[i + 1]

    // image ![alt](src)
    if (ch === '!' && next === '[') {
      const m = bracketed(i + 1, imageBracket, imageParen, true)
      if (m) {
        push({ t: 'image', src: safeHref(m.href), alt: m.label })
        i = m.end
        continue
      }
    }
    // link [text](href)
    if (ch === '[') {
      const m = bracketed(i, linkBracket, linkParen, false)
      if (m) {
        push({ t: 'link', href: safeHref(m.href), c: parseInline(m.label) })
        i = m.end
        continue
      }
    }
    // inline code `code`
    if (ch === '`') {
      const close = tick(i + 1)
      if (close > i + 1) {
        push({ t: 'code', v: src.slice(i + 1, close) })
        i = close + 1
        continue
      }
    }
    // strong **x** / __x__, strikethrough ~~x~~
    if ((ch === '*' || ch === '_' || ch === '~') && next === ch) {
      const close = pairClose[ch](i + 2)
      if (close > i + 2 && src[close + 1] === ch) {
        const c = parseInline(src.slice(i + 2, close))
        push(ch === '~' ? { t: 'del', c } : { t: 'strong', c })
        i = close + 2
        continue
      }
    }
    // em *x* / _x_
    if (ch === '*' || ch === '_') {
      const close = singleClose[ch](i + 1)
      if (close > i + 1) {
        push({ t: 'em', c: parseInline(src.slice(i + 1, close)) })
        i = close + 1
        continue
      }
    }
    // bare autolink
    if (ch === 'h' && (src.startsWith('http://', i) || src.startsWith('https://', i))) {
      const start = i + (src[i + 4] === 's' ? 8 : 7)
      let end = start
      while (end < src.length && src[end] !== ')' && !isSpace(src[end])) end += 1
      if (end > start) {
        const url = src.slice(i, end)
        push({ t: 'link', href: safeHref(url), c: [{ t: 'text', v: url }] })
        i = end
        continue
      }
    }
    text += ch
    i += 1
  }
  flush()
  return out
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
    rows.push(row.map(parseInline))
    next += 1
  }

  return {
    block: {
      t: 'table',
      header: headerCells.map(parseInline),
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
  return parseBlocks(src.replace(LINE_ENDINGS, '\n').replace(SPACE_LIKE, ' ').split('\n'), 0)
}

/** A run of lines as one paragraph of plain text: the fail-closed rendering. */
const plainParagraph = (lines: readonly string[]): Block => ({
  t: 'paragraph',
  c: [{ t: 'text', v: lines.join(' ').trim() }],
})

function parseBlocks(lines: readonly string[], depth: number): Block[] {
  const blocks: Block[] = []
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
    // heading
    const h = line.match(HEADING)
    if (h) {
      blocks.push({ t: 'heading', level: h[1]?.length ?? 1, c: parseInline((h[2] ?? '').trim()) })
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
    // list
    const ordered = OL_ITEM.test(line)
    if (ordered || UL_ITEM.test(line)) {
      const item = ordered ? OL_ITEM : UL_ITEM
      const items: Inline[][] = []
      while (i < lines.length && nodesLeft > 0) {
        const mm = (lines[i] ?? '').match(item)
        if (!mm) break
        nodesLeft -= 1
        items.push(parseInline(mm[1] ?? ''))
        i += 1
      }
      blocks.push({ t: 'list', ordered, items })
      return
    }
    // paragraph: this line, plus following lines until a blank line or another block starts.
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
    blocks.push({ t: 'paragraph', c: parseInline(buf.join(' ').trim()) })
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
  return blocks
}

function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s/.test(line) ||
    line.startsWith('```') ||
    line.startsWith('>') ||
    UL_ITEM.test(line) ||
    OL_ITEM.test(line) ||
    HR.test(line)
  )
}

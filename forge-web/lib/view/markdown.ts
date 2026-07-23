/**
 * Minimal, safe Markdown → AST (view glue).
 *
 * No external dependency (shiki/remark are not in the bundle): this parses a practical GFM
 * subset into a typed AST that {@link MarkdownView} renders as React elements. Because the
 * renderer only ever emits known elements with escaped text (never raw HTML), the pipeline
 * is XSS-safe by construction — untrusted README/issue bodies cannot inject markup. Links
 * are restricted to safe schemes.
 *
 * Supported: ATX headings, fenced + inline code, bold/italic/strikethrough, links, images,
 * unordered/ordered lists, blockquotes, horizontal rules, and paragraphs.
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
  | { readonly t: 'hr' }

/** Restrict link/image hrefs to safe schemes. */
function safeHref(href: string): string {
  const h = href.trim()
  if (/^(https?:|mailto:|dash:|ipfs:|#|\/)/i.test(h)) return h
  return '#'
}

function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let i = 0
  let text = ''
  const flush = (): void => {
    if (text) {
      out.push({ t: 'text', v: text })
      text = ''
    }
  }
  while (i < src.length) {
    const rest = src.slice(i)
    // image ![alt](src)
    let m = rest.match(/^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/)
    if (m) {
      flush()
      out.push({ t: 'image', src: safeHref(m[2] ?? ''), alt: m[1] ?? '' })
      i += m[0].length
      continue
    }
    // link [text](href)
    m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)[^)]*\)/)
    if (m) {
      flush()
      out.push({ t: 'link', href: safeHref(m[2] ?? ''), c: parseInline(m[1] ?? '') })
      i += m[0].length
      continue
    }
    // inline code `code`
    m = rest.match(/^`([^`]+)`/)
    if (m) {
      flush()
      out.push({ t: 'code', v: m[1] ?? '' })
      i += m[0].length
      continue
    }
    // strong **x** or __x__
    m = rest.match(/^\*\*([^*]+)\*\*/) || rest.match(/^__([^_]+)__/)
    if (m) {
      flush()
      out.push({ t: 'strong', c: parseInline(m[1] ?? '') })
      i += m[0].length
      continue
    }
    // strikethrough ~~x~~
    m = rest.match(/^~~([^~]+)~~/)
    if (m) {
      flush()
      out.push({ t: 'del', c: parseInline(m[1] ?? '') })
      i += m[0].length
      continue
    }
    // em *x* or _x_
    m = rest.match(/^\*([^*]+)\*/) || rest.match(/^_([^_]+)_/)
    if (m) {
      flush()
      out.push({ t: 'em', c: parseInline(m[1] ?? '') })
      i += m[0].length
      continue
    }
    // bare autolink
    m = rest.match(/^(https?:\/\/[^\s)]+)/)
    if (m) {
      flush()
      out.push({ t: 'link', href: safeHref(m[1] ?? ''), c: [{ t: 'text', v: m[1] ?? '' }] })
      i += m[0].length
      continue
    }
    text += src[i]
    i += 1
  }
  flush()
  return out
}

/** Parse a markdown document into a block AST. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  const collectParagraph = (): void => {
    const buf: string[] = []
    while (i < lines.length && lines[i]?.trim() !== '' && !isBlockStart(lines[i] ?? '')) {
      buf.push(lines[i] ?? '')
      i += 1
    }
    if (buf.length > 0) {
      blocks.push({ t: 'paragraph', c: parseInline(buf.join(' ').trim()) })
    }
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i += 1
      continue
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
      continue
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      blocks.push({ t: 'heading', level: h[1]?.length ?? 1, c: parseInline((h[2] ?? '').trim()) })
      i += 1
      continue
    }
    // hr
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      blocks.push({ t: 'hr' })
      i += 1
      continue
    }
    // blockquote
    if (line.startsWith('>')) {
      const buf: string[] = []
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        buf.push((lines[i] ?? '').replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ t: 'quote', c: parseMarkdown(buf.join('\n')) })
      continue
    }
    // list
    const ul = line.match(/^\s*[-*+]\s+/)
    const ol = line.match(/^\s*\d+\.\s+/)
    if (ul || ol) {
      const ordered = ol !== null
      const items: Inline[][] = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        const mm = ordered ? l.match(/^\s*\d+\.\s+(.*)$/) : l.match(/^\s*[-*+]\s+(.*)$/)
        if (!mm) break
        items.push(parseInline(mm[1] ?? ''))
        i += 1
      }
      blocks.push({ t: 'list', ordered, items })
      continue
    }
    collectParagraph()
  }
  return blocks
}

function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s/.test(line) ||
    line.startsWith('```') ||
    line.startsWith('>') ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^(\s*[-*_]){3,}\s*$/.test(line)
  )
}

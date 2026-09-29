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
 * Supported: ATX and setext headings, fenced + inline code, bold/italic/strikethrough, links
 * (inline and reference), images, badges (an image inside a link), backslash escapes, entity
 * references, hard line breaks, autolinks (GFM's trailing-punctuation rule, and `<url>`), task
 * lists, unordered/ordered lists (nested, with continuation and lazy lines, tight or loose),
 * blockquotes (with lazy lines), GitHub alerts (`> [!NOTE]`), footnotes, emoji shortcodes,
 * horizontal rules, GFM tables, and paragraphs.
 *
 * Two modes, as GitHub has: a document (README, `.md` file) keeps a single newline as a space;
 * a comment (issue, PR, comment, review, release notes: `{ breaks: true }`) makes it a `<br>`.
 *
 * Raw HTML is handled as GitHub's sanitizer does (`markdown-html.ts`): an allowlist of
 * elements becomes typed nodes (`img`, `br`, `kbd`, `sub`, `sup`, `details`/`summary`,
 * `p`/`div` with `align`, `a`, tables…), other tags are dropped with their text kept, and
 * script-like elements are dropped with their contents.
 */

import {
  COMMENT_START,
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
import { EMOJI } from './emoji.ts'

export type Inline =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'strong'; readonly c: readonly Inline[] }
  | { readonly t: 'em'; readonly c: readonly Inline[] }
  | { readonly t: 'del'; readonly c: readonly Inline[] }
  | { readonly t: 'code'; readonly v: string }
  | {
      readonly t: 'link'
      readonly href: string
      readonly c: readonly Inline[]
      /** `<a href name|id>`: the link is also an in-page anchor target. */
      readonly id?: string
    }
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
  /** `<a name="x">` / `<a id="x">`: an in-page anchor target (the renderer prefixes `user-content-`). */
  | { readonly t: 'anchor'; readonly id: string; readonly c: readonly Inline[] }
  /**
   * `[^label]`: a reference to footnote `n` (numbered in order of first reference). `k` counts
   * the references to that note so far (1 for the first), for the back links.
   */
  | { readonly t: 'fnref'; readonly label: string; readonly n: number; readonly k: number }

export type Block =
  | { readonly t: 'heading'; readonly level: number; readonly c: readonly Inline[] }
  | { readonly t: 'paragraph'; readonly c: readonly Inline[] }
  | { readonly t: 'code'; readonly lang: string; readonly v: string }
  | {
      readonly t: 'list'
      readonly ordered: boolean
      /** Per item: its first paragraph's text (empty when the item starts with another block). */
      readonly items: readonly (readonly Inline[])[]
      /** Per item: `true`/`false` for a task (`- [x]` / `- [ ]`), null for a plain item. Absent when no item is a task. */
      readonly tasks?: readonly (boolean | null)[]
      /** Per item: the blocks after its first paragraph (a nested list, code…). Absent when no item has any. */
      readonly blocks?: readonly (readonly Block[])[]
      /** A blank line separates items or their blocks: each item's text is a paragraph. */
      readonly loose?: true
      /** An ordered list's first number, when not 1. */
      readonly start?: number
    }
  | { readonly t: 'quote'; readonly c: readonly Block[] }
  /** A GitHub alert: a blockquote opening with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`. */
  | { readonly t: 'alert'; readonly kind: AlertKind; readonly c: readonly Block[] }
  /** The document's footnotes, in reference order (only notes that are referenced). */
  | { readonly t: 'footnotes'; readonly items: readonly Footnote[] }
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
      /** The element's `id` (or an `<a>`'s `name`): an in-page anchor target. */
      readonly id?: string
      readonly c: readonly Block[]
    }

/** HTML containers kept as themselves; other block tags GitHub allows render as `div`. */
export type ElementTag =
  | 'details' | 'summary' | 'p' | 'div' | 'a' | 'blockquote'
  | 'table' | 'thead' | 'tbody' | 'tfoot' | 'tr' | 'td' | 'th'
  | 'ul' | 'ol' | 'li' | 'dl' | 'dt' | 'dd'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

export type TableAlignment = 'left' | 'center' | 'right' | null

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

export interface Footnote {
  /** The normalized label (`[^Label]` → `label`). */
  readonly label: string
  /** Its number: the order of its first reference. */
  readonly n: number
  /** How many times it is referenced (one back link each). */
  readonly refs: number
  readonly c: readonly Block[]
}

/** Another repository a reference names (`owner/name#12`, `owner/name@sha`). */
export interface RefRepo {
  readonly owner: string
  readonly name: string
}

/** A piece of plain text split by {@link splitRefs}. */
export type RefPiece =
  | { readonly t: 'text'; readonly v: string }
  /** `#12` (this repo) or `owner/name#12`: issue or PR 12. */
  | { readonly t: 'ref'; readonly n: number; readonly repo?: RefRepo }
  /** A commit id (7–40 hex), bare or as `owner/name@sha`. */
  | { readonly t: 'commit'; readonly oid: string; readonly repo?: RefRepo }
  /**
   * `@alice`, `@alice.dash` or `@name[bot]`: `name` is lowercased (a DPNS label), `label` is as
   * written (a GitHub login keeps its case). `bot`: written with GitHub's `[bot]` suffix.
   */
  | { readonly t: 'mention'; readonly name: string; readonly label: string; readonly bot?: true }

/**
 * The references GitHub autolinks in plain text:
 * - `#n` (1–10 digits) and `owner/name#n`;
 * - a commit id, 7–40 lowercase hex holding a digit and a letter (so `1234567` and `deadbeef`
 *   are words, as GitHub leaves them), bare or as `owner/name@sha`;
 * - `@name` (optionally `.dash`, or GitHub's `[bot]`).
 * Only at a word boundary (not inside `a#1`, `x@y.com`, a path or a URL fragment), and a
 * reference followed by a letter or digit is not one. Code spans and links are never split (the
 * caller applies this to text nodes only). Pure, so the parser stays render-agnostic.
 */
export function splitRefs(text: string): RefPiece[] {
  const out: RefPiece[] = []
  const repoOf = (owner: string | undefined, name: string | undefined): { repo?: RefRepo } =>
    owner === undefined ? {} : { repo: { owner, name: name as string } }
  let last = 0
  for (const m of text.matchAll(REF_RE)) {
    const lead = m[1] ?? ''
    const start = (m.index ?? 0) + lead.length
    let piece: RefPiece | null
    if (m[4] !== undefined) {
      const n = Number(m[4])
      piece = n === 0 ? null : { t: 'ref', n, ...repoOf(m[2], m[3]) }
    } else if (m[7] !== undefined) {
      const oid = m[7]
      piece = /\d/.test(oid) && /[a-f]/.test(oid) ? { t: 'commit', oid, ...repoOf(m[5], m[6]) } : null
    } else {
      const label = m[8] as string
      piece = { t: 'mention', name: label.toLowerCase(), label, ...(m[9] === '[bot]' ? { bot: true as const } : {}) }
    }
    // A skipped match stays in the text around it (`last` does not move).
    if (piece === null) continue
    if (start > last) out.push({ t: 'text', v: text.slice(last, start) })
    out.push(piece)
    last = (m.index ?? 0) + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

/** `owner/name` as GitHub spells them: a login (alphanumerics and hyphens) and a repo name. */
const REPO_PREFIX = '([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})'
const REF_RE = new RegExp(
  '(^|[^\\w/#@.&-])(?:' +
    `(?:${REPO_PREFIX})?#(\\d{1,10})(?![\\w-])` +
    `|(?:${REPO_PREFIX}@)?([0-9a-f]{7,40})(?![\\w@-])` +
    '|@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\\.dash|\\[bot\\])?(?![\\w.@-]*[\\w@])' +
    ')',
  'g',
)

/** A piece of a commit message: plain text (split further by {@link splitRefs}) or a bare URL. */
export type PlainPiece = { readonly t: 'text'; readonly v: string } | { readonly t: 'url'; readonly href: string }

/**
 * Plain text (a commit message) with its bare `http(s)://` URLs split out, ending where GFM's
 * autolinks end (no trailing punctuation). Linear: one pass over the URL starts.
 */
export function splitUrls(text: string): PlainPiece[] {
  const out: PlainPiece[] = []
  let last = 0
  for (const m of text.matchAll(/https?:\/\//g)) {
    const at = m.index ?? 0
    if (at < last || isWordChar(text[at - 1])) continue
    const end = autolinkEnd(text, at + m[0].length, text.length)
    if (end === at + m[0].length) continue
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) })
    out.push({ t: 'url', href: safeHref(text.slice(at, end)) })
    last = end
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

/**
 * Restrict link/image hrefs to safe schemes, same-site paths and relative paths. Protocol-
 * relative forms (`//host/x`, and `/\host/x` or `\\host`, which browsers read the same way)
 * are refused: they point off-site, so an image written that way is a tracking pixel that
 * logs every viewer's IP. The URL parser's own clean-up runs first: ASCII tab/CR/LF are
 * dropped anywhere (`/<TAB>/host` is `//host`) and C0 controls and spaces are trimmed from
 * both ends (`\u0001javascript:` is `javascript:`); any other control character left makes the
 * href unsafe. Any other scheme (`javascript:`, `data:`) is refused.
 *
 * A relative path (`docs/a.md`, `./logo.png`) is kept: the renderer resolves it against the
 * repo the Markdown came from ({@link isRelativeHref}), or drops it where there is none.
 */
export function safeHref(href: string): string {
  const stripped = href.replace(/[\t\n\r]/g, '')
  // Index loops, not `/^[\0- ]+|[\0- ]+$/`: that trim is quadratic on a long inner space run.
  let a = 0
  let b = stripped.length
  while (a < b && stripped.charCodeAt(a) <= 0x20) a += 1
  while (b > a && stripped.charCodeAt(b - 1) <= 0x20) b -= 1
  const h = stripped.slice(a, b)
  if (h === '' || /[\u0000-\u001f\u007f]/.test(h) || /^[/\\][/\\]/.test(h)) return '#'
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
 * Only for one left-to-right pass (bracket matching, HTML block items); span lookups, whose
 * `from` can go backwards, use {@link InlineDoc.find}.
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
 * `s` with ASCII letters lowercased and nothing else: `toLowerCase` lengthens some strings
 * (`İ` becomes two units), which would shift every offset after it.
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase())
}

/** ASCII punctuation a backslash escapes (CommonMark §2.4). */
const ESCAPABLE = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')

/** Reference definitions (`[label]: url`) of the document being parsed, keyed by normalized label. */
let references: ReadonlyMap<string, string> = new Map()

/** Longest link label, as CommonMark bounds it (and {@link REFERENCE_DEF} matches). */
const MAX_LABEL = 999

/** A reference label as CommonMark matches it: case-folded, inner whitespace collapsed. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Characters GFM trims from the end of a bare autolink (`https://x.io/a.` ends at `a`). */
const AUTOLINK_TRAILING_CHARS = new Set(['?', '!', '.', ',', ':', '*', '_', '~', "'", '"'])

/**
 * Where a bare `http(s)://` autolink whose body starts at `bodyStart` ends, GitHub's way: at
 * whitespace, `<` or `limit`, then trailing punctuation and quotes are dropped, and a `)` is
 * kept only while the link's parentheses balance (`https://en.wikipedia.org/wiki/Foo_(bar)`).
 */
function autolinkEnd(src: string, bodyStart: number, limit: number): number {
  let end = bodyStart
  let open = 0
  let close = 0
  while (end < limit && !isSpace(src[end]) && src[end] !== '<') {
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
 * One inline source and the lookups every span inside it shares. Nested spans are parsed as
 * ranges of the same string (no slices), so the bracket matches, the lowercase copy and each
 * delimiter's position list are built at most once per top-level call, lazily, and each
 * lookup is exact whatever order the spans ask in.
 */
interface InlineDoc {
  readonly src: string
  /** The first `needle` starting at or after `from` and ending by `end`, or -1 (binary search). */
  find(needle: string, from: number, end: number): number
  /** The `]` matching a `[` at `open` (escapes and code spans skipped), or -1. */
  closeOf(open: number): number
}

function inlineDoc(src: string): InlineDoc {
  const lists = new Map<string, Int32Array>()
  let lower: string | null = null
  let brackets: Int32Array | null = null
  return {
    src,
    find(needle, from, end) {
      let list = lists.get(needle)
      if (list === undefined) {
        // Closing tags match without regard to ASCII case (`</KBD>`).
        const hay = needle.startsWith('</') ? (lower ??= asciiLower(src)) : src
        list = indexesOf(hay, needle)
        lists.set(needle, list)
      }
      let lo = 0
      let hi = list.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if ((list[mid] as number) < from) lo = mid + 1
        else hi = mid
      }
      if (lo === list.length) return -1
      const at = list[lo] as number
      return at + needle.length <= end ? at : -1
    },
    closeOf(open) {
      brackets ??= matchBrackets(src)
      return brackets[open] ?? -1
    },
  }
}

/** Every index of `needle` in `hay`, ascending. */
function indexesOf(hay: string, needle: string): Int32Array {
  const out: number[] = []
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) out.push(at)
  return Int32Array.from(out)
}

/**
 * The matching `]` of every `[` in `src` (-1 for none), skipping escaped brackets and code
 * spans: one linear stack pass.
 */
function matchBrackets(src: string): Int32Array {
  if (!src.includes('[')) return new Int32Array(0)
  const out = new Int32Array(src.length).fill(-1)
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
    else if (c === ']' && stack.length > 0) out[stack.pop() as number] = i
  }
  return out
}

/** Parse `src` as inline Markdown (or, with `htmlOnly`, the inline content of a raw HTML block). */
function parseInline(src: string, htmlOnly = false): Inline[] {
  return parseSpan(inlineDoc(src), 0, src.length, 0, htmlOnly)
}

/**
 * Inline spans of `doc.src[start..end)`, scanned left to right without backtracking regexes.
 * Every step consumes at least one character and every delimiter lookup is a binary search,
 * so a pass is linear in the range (nested spans re-scan only the text they consumed, at most
 * {@link MAX_INLINE_DEPTH} deep).
 *
 * Spans: `![alt](src …)`, `[text](href …)`, `` `code` ``, `~~x~~`, and emphasis, which is
 * CommonMark's (§6.4): `*` and `_` runs are classified by the flanking rules as they are
 * scanned, then paired by {@link processEmphasis} (so `***x***`, `_a **b** c_`, the rule of 3
 * and intraword `_` all behave as on GitHub). On top of it:
 * - `\*` and friends are literal characters, and `&amp;`-style references decode;
 * - a link's text is scanned for its closing `]` with nesting, so a badge
 *   `[![alt](img)](href)` is an image inside a link;
 * - `[text][ref]`, `[text][]` and `[ref]` (and `![alt][ref]`…) use the reference definitions;
 * - bare `http(s)://` autolinks follow GFM (no trailing punctuation or quotes), and `<url>`;
 * - allowlisted inline HTML (`<img>`, `<br>`, `<kbd>`, `<sub>`, `<sup>`, `<b>`, `<a>`…) is
 *   kept, other tags are dropped with their text kept (`markdown-html.ts`), and comments
 *   (`<!-- … -->`) are dropped;
 * - a line ending in two spaces or `\` is a hard break (lines are joined with `\n`).
 */
function parseSpan(doc: InlineDoc, start: number, end: number, depth: number, htmlOnly: boolean): Inline[] {
  const { src } = doc
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
  /** The character at `k`, or undefined outside this span (as if the span were its own string). */
  const at = (k: number): string | undefined => (k >= start && k < end ? src[k] : undefined)
  const find = (needle: string, from: number): number => doc.find(needle, from, end)
  /** `*` and `_` runs seen in this span, in order, paired by {@link processEmphasis} at the end. */
  const delims: Delim[] = []
  /** A `*` / `_` run at `src[from..to)`: a text node for now, classified as CommonMark says (§6.2). */
  const pushDelimiter = (ch: '*' | '_', from: number, to: number): void => {
    const before = at(from - 1)
    const after = at(to)
    const left = leftFlanking(before, after)
    const right = leftFlanking(after, before)
    // `_` also may not open or close inside a word (`snake_case_name`).
    const canOpen = ch === '*' ? left : left && (!right || isPunctuation(before))
    const canClose = ch === '*' ? right : right && (!left || isPunctuation(after))
    if (!canOpen && !canClose) {
      add(src.slice(from, to)) // can never pair: plain text, in the text around it
      return
    }
    flush()
    delims.push({ item: out.length, ch, orig: to - from, count: to - from, canOpen, canClose })
    out.push({ t: 'text', v: src.slice(from, to) })
    nodesLeft -= 1
  }
  /**
   * Whether `src[from..to)` holds a `[` that is not backslash-escaped. Each step is a binary
   * search, and escaped ones are skipped at most {@link MAX_LABEL} times (a label's length).
   */
  const hasUnescapedBracket = (from: number, to: number): boolean => {
    for (let b = doc.find('[', from, to); b !== -1; b = doc.find('[', b + 1, to)) {
      let slashes = 0
      while (src[b - 1 - slashes] === '\\' && b - 1 - slashes >= from) slashes += 1
      if (slashes % 2 === 0) return true
    }
    return false
  }
  /** The `]` matching a `[` at `open`, when it is inside this span; else -1. */
  const closeOf = (open: number): number => {
    const close = doc.closeOf(open)
    return close < end ? close : -1
  }

  /** `(href …)` right after `]` at `close`: the href and the index past `)`. */
  const destination = (close: number): { href: string; end: number } | null => {
    if (at(close + 1) !== '(') return null
    const hrefStart = close + 2
    const paren = find(')', hrefStart)
    if (paren === -1 || paren === hrefStart || isSpace(src[hrefStart])) return null
    let hrefEnd = hrefStart
    while (hrefEnd < paren && !isSpace(src[hrefEnd])) hrefEnd += 1
    let href = src.slice(hrefStart, hrefEnd)
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1)
    return { href: plain(href), end: paren + 1 }
  }

  /**
   * A reference `[text][ref]` / `[text][]` / `[ref]` whose text is `[open..close]`. A label is
   * at most {@link MAX_LABEL} characters and holds no `[` (as CommonMark says), so a failed `[`
   * costs O(log n) however long its text: normalizing every one made nested brackets quadratic.
   */
  const reference = (open: number, close: number): { href: string; end: number } | null => {
    if (references.size === 0) return null
    // `[text][ref]` names `ref`; `[text][]` and `[text]` name `text`.
    const refEnd = at(close + 1) === '[' ? closeOf(close + 1) : close
    if (refEnd === -1) return null
    const [from, to] = refEnd > close + 2 ? [close + 2, refEnd] : [open + 1, close]
    // A label holds no `[` (CommonMark): an outer bracket around links is never a reference,
    // and checking that first (a binary search) keeps nested brackets from each normalizing
    // up to 999 characters.
    if (to - from > MAX_LABEL || hasUnescapedBracket(from, to)) return null
    const href = references.get(normalizeLabel(src.slice(from, to)))
    return href === undefined ? null : { href, end: refEnd + 1 }
  }

  let i = start
  while (i < end) {
    if (nodesLeft <= 0) {
      add(src.slice(i, end)) // node budget spent: the rest is plain text
      break
    }
    const ch = src[i] as string
    const next = at(i + 1)

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
    // hard break: two or more spaces before a line end (or any line end in comment mode); a
    // plain line end is a space
    if (ch === '\n') {
      const hard = !htmlOnly && (pendingSpaces >= 2 || softBreaks)
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
      const semi = find(';', i + 1)
      if (semi !== -1 && semi - i <= 32) {
        const raw = src.slice(i, semi + 1)
        const decoded = decodeEntities(raw)
        if (decoded !== raw) {
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
    // image ![alt](src), ![alt][ref], ![alt]
    if (ch === '!' && next === '[') {
      const close = find(']', i + 2)
      const m = close === -1 ? null : destination(close)
      if (m) {
        push({ t: 'image', src: safeHref(m.href), alt: plain(src.slice(i + 2, close)) })
        i = m.end
        continue
      }
      const refClose = closeOf(i + 1)
      const r = refClose > i + 2 ? reference(i + 1, refClose) : null
      if (r) {
        push({ t: 'image', src: safeHref(r.href), alt: plain(src.slice(i + 2, refClose)) })
        i = r.end
        continue
      }
    }
    // footnote reference [^label], when the document defines that note
    if (ch === '[' && next === '^' && footnoteDefs.size > 0) {
      // Only a span no longer than the longest defined label, holding no `[` (a binary search),
      // is normalized: `[^[^[^…` never is, and the spans that are are disjoint, so the work is
      // linear in total. (Nested spans rescan, at most MAX_INLINE_DEPTH deep, as elsewhere.)
      const close = find(']', i + 2)
      const ok = close > i + 2 && close - (i + 2) <= footnoteLabelMax && doc.find('[', i + 2, close) === -1
      const label = ok ? normalizeLabel(src.slice(i + 2, close)) : ''
      if (footnoteDefs.has(label)) {
        let use = footnoteUse.get(label)
        if (use === undefined) {
          use = { n: footnoteUse.size + 1, refs: 0 }
          footnoteUse.set(label, use)
        }
        use.refs += 1
        push({ t: 'fnref', label, n: use.n, k: use.refs })
        i = close + 1
        continue
      }
    }
    // emoji shortcode :name: (GitHub converts one even inside a word: `foo:smile:bar`)
    if (ch === ':' && !htmlOnly) {
      let j = i + 1
      while (j < end && j - i <= MAX_EMOJI_NAME && isEmojiNameChar(src.charCodeAt(j))) j += 1
      const emoji = j > i + 1 && src[j] === ':' && j < end ? EMOJI.get(src.slice(i + 1, j)) : undefined
      if (emoji !== undefined) {
        add(emoji)
        i = j + 1
        continue
      }
    }
    // link [text](href), [text][ref], [ref]
    if (ch === '[' && depth < MAX_INLINE_DEPTH) {
      const close = closeOf(i)
      if (close > i + 1) {
        const m = destination(close) ?? reference(i, close)
        if (m) {
          push({ t: 'link', href: safeHref(m.href), c: parseSpan(doc, i + 1, close, depth + 1, false) })
          i = m.end
          continue
        }
      }
    }
    // inline code `code`
    if (ch === '`') {
      const close = find('`', i + 1)
      if (close > i + 1) {
        push({ t: 'code', v: src.slice(i + 1, close).replace(/\n/g, ' ') })
        i = close + 1
        continue
      }
    }
    // comments, inline HTML and `<url>` autolinks
    if (ch === '<') {
      if (src.startsWith('<!--', i) && i + 4 <= end) {
        // `<!-->` and `<!--->` are complete (empty) comments too.
        const close = find('-->', i + 2)
        if (close !== -1) {
          i = close + 3 // dropped, as GitHub's sanitizer drops it
          continue
        }
      }
      const close = find('>', i + 1)
      if (close !== -1 && close - i <= MAX_TAG_CHARS) {
        const inner = src.slice(i + 1, close)
        if (!htmlOnly && /^(https?|mailto):[^\s<>]*$/i.test(inner)) {
          push({ t: 'link', href: safeHref(inner), c: [{ t: 'text', v: inner.replace(/^mailto:/i, '') }] })
          i = close + 1
          continue
        }
        const tag = parseTag(src, i, close)
        if (tag !== null) {
          const consumed = inlineTag(doc, tag, close + 1, end, depth, htmlOnly)
          if (consumed !== null) {
            if (consumed.node !== null) push(consumed.node)
            i = consumed.end
            continue
          }
        }
      }
    }
    // `*` / `_` runs: emphasis delimiters, paired once the span is scanned
    if (ch === '*' || ch === '_') {
      let past = i + 1
      while (at(past) === ch) past += 1
      pushDelimiter(ch, i, past)
      i = past
      continue
    }
    // strikethrough ~~x~~
    if (ch === '~' && next === '~' && depth < MAX_INLINE_DEPTH) {
      const close = find('~~', i + 2)
      if (close > i + 2) {
        push({ t: 'del', c: parseSpan(doc, i + 2, close, depth + 1, false) })
        i = close + 2
        continue
      }
    }
    // bare autolink (GFM: trailing punctuation and quotes are not part of it)
    if (ch === 'h' && !isWordChar(at(i - 1)) && (src.startsWith('http://', i) || src.startsWith('https://', i))) {
      const bodyStart = i + (src[i + 4] === 's' ? 8 : 7)
      const linkEnd = autolinkEnd(src, bodyStart, end)
      if (linkEnd > bodyStart) {
        const url = src.slice(i, linkEnd)
        push({ t: 'link', href: safeHref(url), c: [{ t: 'text', v: url }] })
        i = linkEnd
        continue
      }
    }
    add(ch)
    i += 1
  }
  if (depth === 0) pendingSpaces = 0 // a paragraph's trailing spaces go; a span's (`<b>Note: </b>x`) stay
  flush()
  return delims.length === 0 ? out : processEmphasis(out, delims, MAX_INLINE_DEPTH - depth)
}

/** A `*` / `_` delimiter run, as CommonMark's emphasis algorithm tracks it. */
interface Delim {
  /** Its text node's index in the span's node list. */
  readonly item: number
  readonly ch: '*' | '_'
  /** The run's length as written (the rule of 3 looks at it). */
  readonly orig: number
  /** Characters not yet used by an emphasis. */
  count: number
  readonly canOpen: boolean
  readonly canClose: boolean
}

/** Unicode whitespace, as CommonMark reads it; outside the span (undefined) counts too. */
const isWhitespace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch)

/** ASCII or Unicode punctuation (CommonMark 0.29, which GitHub's cmark-gfm follows). */
const isPunctuation = (ch: string | undefined): boolean => ch !== undefined && (ESCAPABLE.has(ch) || /\p{P}/u.test(ch))

/**
 * Whether a run between `before` and `after` is left-flanking (CommonMark §6.2): not followed
 * by whitespace, and not followed by punctuation unless preceded by whitespace or punctuation.
 * Swapping the arguments asks whether it is right-flanking.
 */
function leftFlanking(before: string | undefined, after: string | undefined): boolean {
  return !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before))
}

/** Depth of an inline node's subtree (text 0, a leaf span 1), computed once per node. */
const inlineDepths = new WeakMap<Inline, number>()
function inlineDepth(n: Inline): number {
  if (n.t === 'text') return 0
  let d = inlineDepths.get(n)
  if (d === undefined) {
    d = 1
    if ('c' in n) for (const child of n.c) d = Math.max(d, 1 + inlineDepth(child))
    inlineDepths.set(n, d)
  }
  return d
}

/**
 * CommonMark's "process emphasis" (appendix A of the spec): pair `*` / `_` runs into em and
 * strong nodes, closers left to right, each looking back for the nearest opener it may pair
 * with (the rule of 3). `openers_bottom` remembers, per kind of closer, how far back a failed
 * search already looked, so the whole pass is linear. Nodes are kept in a linked list, and a
 * pairing moves what lies between into the new node once.
 *
 * The result is at most `maxNest` deep, counting every span: a pairing that would go deeper
 * (a hostile `****…x****…`) is skipped, and no later closer pairs with an opener before it
 * (`floor`), which keeps the pass linear. A pairing is charged to the node budget exactly: one
 * new node, less the delimiter runs it uses up; one that frees nodes is made even past it.
 */
function processEmphasis(items: Inline[], delims: readonly Delim[], maxNest: number): Inline[] {
  const nodes: Inline[] = items.slice()
  const next: number[] = items.map((_, k) => (k + 1 < items.length ? k + 1 : -1))
  const prev: number[] = items.map((_, k) => k - 1)
  let head = items.length > 0 ? 0 : -1
  const unlink = (k: number): void => {
    if (prev[k] === -1) head = next[k] as number
    else next[prev[k] as number] = next[k] as number
    if (next[k] !== -1) prev[next[k] as number] = prev[k] as number
  }
  const dNext: number[] = delims.map((_, k) => (k + 1 < delims.length ? k + 1 : -1))
  const dPrev: number[] = delims.map((_, k) => k - 1)
  const dropDelim = (d: number): void => {
    if (dPrev[d] !== -1) dNext[dPrev[d] as number] = dNext[d] as number
    if (dNext[d] !== -1) dPrev[dNext[d] as number] = dPrev[d] as number
  }
  /** openers_bottom: per closer kind, the delimiter index a search need not go below. */
  const bottoms = new Map<string, number>()

  /** Openers at or before this delimiter can no longer pair (a pairing there was too deep). */
  let floor = -1
  let closer = delims.length > 0 ? 0 : -1
  while (closer !== -1) {
    const c = delims[closer] as Delim
    if (!c.canClose) {
      closer = dNext[closer] as number
      continue
    }
    const kind = `${c.ch}${c.canOpen ? 1 : 0}${c.orig % 3}`
    const bottom = Math.max(bottoms.get(kind) ?? -1, floor)
    let opener = dPrev[closer] as number
    for (; opener > bottom; opener = dPrev[opener] as number) {
      const o = delims[opener] as Delim
      // The rule of 3: a run that can both open and close pairs only if the lengths' sum is
      // not a multiple of 3, unless both lengths are.
      const oddMatch = (c.canOpen || o.canClose) && c.orig % 3 !== 0 && (o.orig + c.orig) % 3 === 0
      if (o.ch === c.ch && o.canOpen && !oddMatch) break
    }
    if (opener <= bottom) {
      bottoms.set(kind, dPrev[closer] as number)
      const after = dNext[closer] as number
      if (!c.canOpen) dropDelim(closer)
      closer = after
      continue
    }
    const o = delims[opener] as Delim
    const use = c.count >= 2 && o.count >= 2 ? 2 : 1
    // `**` around a lone strong (`****x****`): cmark-gfm renders one strong, so the inner node
    // is kept as it is. No node is made and nothing is walked, so a run of these stays O(1).
    const inner = next[o.item] as number
    const reuse = use === 2 && inner !== c.item && next[inner] === c.item && (nodes[inner] as Inline).t === 'strong'
    // One new node (none when reusing), less the runs this uses up (their text nodes go).
    const cost = (reuse ? 0 : 1) - (o.count === use ? 1 : 0) - (c.count === use ? 1 : 0)
    // What lies between the two runs becomes the new node's children.
    const children: Inline[] = []
    let depthIn = 0
    if (!reuse) {
      for (let k = inner; k !== c.item; k = next[k] as number) {
        const node = nodes[k] as Inline
        children.push(node)
        depthIn = Math.max(depthIn, inlineDepth(node))
      }
    }
    if (depthIn + 1 > maxNest || (nodesLeft <= 0 && cost > 0)) {
      // Too deep, or no budget left: this closer stays text, and nothing before it pairs.
      floor = closer
      closer = dNext[closer] as number
      continue
    }
    o.count -= use
    c.count -= use
    nodes[o.item] = { t: 'text', v: o.ch.repeat(o.count) }
    nodes[c.item] = { t: 'text', v: c.ch.repeat(c.count) }
    nodesLeft -= cost
    if (!reuse) {
      // GitHub's cmark-gfm does not nest strong directly in strong (`**a **b** c**` is one strong).
      const flat = use === 2 ? children.flatMap((n) => (n.t === 'strong' ? n.c : [n])) : children
      const k = nodes.length
      nodes.push({ t: use === 2 ? 'strong' : 'em', c: mergeText(flat) })
      next.push(c.item)
      prev.push(o.item)
      next[o.item] = k
      prev[c.item] = k
    }
    // Runs between the two can no longer pair.
    dNext[opener] = closer
    dPrev[closer] = opener
    if (o.count === 0) {
      unlink(o.item)
      dropDelim(opener)
    }
    if (c.count === 0) {
      const after = dNext[closer] as number
      unlink(c.item)
      dropDelim(closer)
      closer = after
    }
  }
  const result: Inline[] = []
  for (let k = head; k !== -1; k = next[k] as number) result.push(nodes[k] as Inline)
  return mergeText(result)
}

/** `nodes` with adjacent text nodes joined and empty ones dropped. */
function mergeText(nodes: readonly Inline[]): Inline[] {
  const out: Inline[] = []
  let text: string[] = []
  const flushText = (): void => {
    const v = text.join('')
    if (v !== '') out.push({ t: 'text', v })
    text = []
  }
  for (const n of nodes) {
    if (n.t === 'text') text.push(n.v)
    else {
      flushText()
      out.push(n)
    }
  }
  flushText()
  return out
}

/** Nesting cap for spans inside spans (a hostile `[[[[…](x)](x)…` stays shallow). */
const MAX_INLINE_DEPTH = 32

/** Longest emoji shortcode name looked for (GitHub's longest in use is under 40). */
const MAX_EMOJI_NAME = 40

/** `[a-z0-9_+-]`: the characters of an emoji shortcode name. */
function isEmojiNameChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)

/** Drop backslash escapes: `\*` → `*`. */
function unescape(s: string): string {
  return s.includes('\\') ? s.replace(/\\([!-/:-@[-`{-~])/g, '$1') : s
}

/** Text with escapes and entities resolved (an image's alt, a link destination), Markdown punctuation left as written. */
function plain(label: string): string {
  return decodeEntities(unescape(label))
}

/**
 * The anchor an `<a name=…>` / `<a id=…>` sets, lowercased as in-page links are, or undefined.
 * The renderer prefixes `user-content-` (as GitHub does), so `[Install](#install)` reaches it.
 */
function anchorId(attrs: Readonly<Record<string, string>>): string | undefined {
  const id = (attrs['name'] ?? attrs['id'] ?? '').trim()
  return id !== '' && id.length <= 256 ? id.toLowerCase() : undefined
}

/**
 * An inline HTML tag ending just before `after` (inside a span ending at `end`): the node it
 * becomes (null: nothing, e.g. a dropped tag) and where scanning resumes. Paired tags consume
 * through their closing tag.
 */
function inlineTag(
  doc: InlineDoc,
  tag: TagToken,
  after: number,
  end: number,
  depth: number,
  htmlOnly: boolean,
): { node: Inline | null; end: number } | null {
  if (tag.close) return { node: null, end: after } // a stray closing tag: dropped
  if (tag.name === 'br') return { node: { t: 'br' }, end: after }
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
      end: after,
    }
  }
  const alias = Object.hasOwn(SPAN_ALIASES, tag.name) ? SPAN_ALIASES[tag.name] : undefined
  const kept = INLINE_TAGS.has(tag.name) ? (tag.name as 'kbd' | 'sub' | 'sup') : undefined
  const dropAll = DROP_WITH_CONTENTS.has(tag.name)
  // Only these names are looked for: any other tag (`<span>`, `<font>`, `<abbr>`…) goes and
  // its text stays, so an unbounded set of names never costs a scan each.
  if (!dropAll && alias === undefined && kept === undefined && tag.name !== 'a') return { node: null, end: after }
  const closing = doc.find(`</${tag.name}>`, after, end)
  const past = closing + tag.name.length + 3
  if (dropAll) return { node: null, end: closing === -1 ? end : past }
  if (closing === -1 || depth >= MAX_INLINE_DEPTH) return { node: null, end: after }
  const c = parseSpan(doc, after, closing, depth + 1, htmlOnly)
  if (kept !== undefined) return { node: { t: 'tag', tag: kept, c }, end: past }
  if (alias !== undefined) return { node: { t: alias, c }, end: past }
  const href = tag.attrs['href']
  const id = anchorId(tag.attrs)
  if (href !== undefined) return { node: { t: 'link', href: safeHref(href), c, ...(id !== undefined ? { id } : {}) }, end: past }
  return id === undefined ? { node: null, end: after } : { node: { t: 'anchor', id, c }, end: past }
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
  if (!/^:?-+:?$/.test(delimiter)) return undefined // GFM 198: one `-` is enough
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
  // The header first: footnotes are numbered in order of first reference.
  const header = headerCells.map((cell) => parseInline(cell))
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
      header,
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

/** Blockquotes and list items nest by recursion; past this depth the rest is plain text. */
const MAX_NEST_DEPTH = 16

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+([\s\S]*))?$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
/** A setext heading's underline (`===` for h1, `---` for h2), right after paragraph lines. */
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
/** A code fence (``` indented at most 3 spaces) and its info string's first word. */
const FENCE = /^ {0,3}```(\w*)/
/** A fence line in any container: after any indent, list markers and quote markers. */
const ANY_FENCE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|>)[ \t]*)*```/
const QUOTE = /^ {0,3}>/
/** A list item's marker: `-`, `*`, `+`, or `1.` / `1)`, then spaces and the item's text (or nothing). */
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)([\s\S]*))?$/
/** A GitHub alert's first line (`> [!NOTE]`). */
const ALERT = /^\[!(note|tip|important|warning|caution)\][ \t]*$/i

/** Comment mode (GitHub's issue/PR/comment rendering): every line end in a paragraph is a `<br>`. */
let softBreaks = false

/** Options of {@link parseMarkdown}. */
export interface MarkdownOptions {
  /**
   * GitHub's comment mode (issues, PRs, comments, reviews, release notes): a single newline
   * inside a paragraph is a line break. Off for documents (README, `.md` files), where it is a
   * space.
   */
  readonly breaks?: boolean
}

/** Parse a markdown document into a block AST. */
export function parseMarkdown(src: string, options: MarkdownOptions = {}): Block[] {
  nodesLeft = MARKDOWN_MAX_NODES
  softBreaks = options.breaks === true
  const lines = src.replace(LINE_ENDINGS, '\n').replace(SPACE_LIKE, ' ').split('\n')
  const defs = collectReferences(lines)
  references = defs.refs
  footnoteDefs = defs.footnotes
  try {
    const blocks = parseBlocks(lines, 0)
    const notes = parseFootnotes()
    if (notes.length > 0) blocks.push({ t: 'footnotes', items: notes })
    return blocks
  } finally {
    references = new Map()
    footnoteDefs = new Map()
    footnoteUse = new Map()
    footnoteLabelMax = 0
    softBreaks = false
  }
}

/** Footnote definitions of the document being parsed: label → the note's lines. */
let footnoteDefs: ReadonlyMap<string, readonly string[]> = new Map()
/** Footnotes referenced so far, in order of first reference, and how often. */
let footnoteUse = new Map<string, { n: number; refs: number }>()
/**
 * The longest footnote label defined (as written): a `[^…]` longer than it names no note, so
 * it is not normalized (a hostile `[^[^[^…` would otherwise normalize ~1,000 characters each).
 */
let footnoteLabelMax = 0

/**
 * The referenced footnotes, numbered in order of first reference (as GitHub numbers them).
 * A note referenced only from another note is parsed too: the map grows while it is walked,
 * and a JS map iteration visits entries added during it. Each note is parsed once.
 */
function parseFootnotes(): Footnote[] {
  // `use.refs` is read after the walk: a later note may reference an earlier one again.
  const parsed: { label: string; use: { n: number; refs: number }; c: Block[] }[] = []
  for (const [label, use] of footnoteUse) {
    if (nodesLeft <= 0) break
    parsed.push({ label, use, c: parseBlocks(footnoteDefs.get(label) ?? [], 1) })
  }
  return parsed.map(({ label, use, c }) => ({ label, n: use.n, refs: use.refs, c }))
}

/** Most reference (and footnote) definitions one document may declare. */
const MAX_REFERENCES = 1000

/**
 * `[label]: url "title"`, on its own line. Linear: `[ \t]*` and the destination's `[^\s<>]`
 * cannot overlap, and the title is matched by a plain `.*`. A `[^label]:` is a footnote.
 */
const REFERENCE_DEF = /^ {0,3}\[(?!\^)([^\]\n]{1,999})\]:[ \t]*<?([^\s<>]+)>?(?:[ \t]+.*)?$/

/** `[^label]: text`: a footnote definition (GitHub's; it may interrupt a paragraph). */
const FOOTNOTE_DEF = /^ {0,3}\[\^([^\]\s]{1,999})\]:[ \t]?([\s\S]*)$/

/** Columns of a line's leading whitespace (a tab to the next multiple of 4). */
function indentOf(line: string): number {
  let col = 0
  for (let k = 0; k < line.length; k++) {
    const c = line[k]
    if (c === ' ') col += 1
    else if (c === '\t') col += 4 - (col % 4)
    else break
  }
  return col
}

/** `line` without `cols` columns of leading whitespace (tabs expanded as {@link indentOf} counts them). */
function stripCols(line: string, cols: number): string {
  let col = 0
  let k = 0
  while (k < line.length && col < cols) {
    const c = line[k]
    if (c === ' ') col += 1
    else if (c === '\t') col += 4 - (col % 4)
    else break
    k += 1
  }
  // A tab that spans past `cols` leaves its remaining columns as spaces.
  return ' '.repeat(Math.max(0, col - cols)) + line.slice(k)
}

/**
 * Collect reference definitions (first one wins, as in CommonMark) and blank their lines so
 * they render as nothing. Only a paragraph's line keeps the next line from being one (a
 * definition cannot interrupt a paragraph): after a blank line, a heading, a fence, a rule or
 * another definition it may start. Fenced code holds none.
 *
 * Footnote definitions (`[^1]: note`) are collected the same way, with their continuation:
 * lines indented 4 or more (blank lines between them included) and lazy paragraph lines.
 */
function collectReferences(lines: string[]): { refs: Map<string, string>; footnotes: Map<string, string[]> } {
  const refs = new Map<string, string>()
  const footnotes = new Map<string, string[]>()
  let fenced = false
  let mayStart = true
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    // Any fence line, also one opened in a list item or quote (`- ```sh`) and its indented
    // close: fences pair up whatever container holds them.
    const fence = ANY_FENCE.test(line)
    if (fence) fenced = !fenced
    const note = !fenced && !fence && line.length < 2048 ? FOOTNOTE_DEF.exec(line) : null
    if (note !== null && footnotes.size < MAX_REFERENCES) {
      const body = [note[2] as string]
      lines[i] = ''
      let j = i + 1
      while (j < lines.length) {
        const l = lines[j] as string
        if (l.trim() === '') {
          // Blank lines belong to the note only when an indented line follows them.
          let k = j
          while (k < lines.length && (lines[k] as string).trim() === '') k += 1
          if (k === lines.length || indentOf(lines[k] as string) < 4) break
          for (; j < k; j++) body.push('')
          continue
        }
        if (indentOf(l) >= 4) body.push(stripCols(l, 4))
        else if ((body[body.length - 1] ?? '').trim() !== '' && !isBlockStart(l) && !FOOTNOTE_DEF.test(l)) body.push(l)
        else break
        lines[j] = ''
        j += 1
      }
      const label = normalizeLabel(note[1] as string)
      if (!footnotes.has(label)) footnotes.set(label, body)
      footnoteLabelMax = Math.max(footnoteLabelMax, (note[1] as string).length)
      i = j - 1
      mayStart = true
      continue
    }
    const m = !fenced && !fence && mayStart && line.length < 2048 ? REFERENCE_DEF.exec(line) : null
    if (m !== null && refs.size < MAX_REFERENCES) {
      const label = normalizeLabel(m[1] as string)
      if (label !== '' && !refs.has(label)) refs.set(label, plain(m[2] as string))
      lines[i] = ''
      continue // the next line may be another definition
    }
    mayStart = fence || line.trim() === '' || HEADING.test(line) || HR.test(line)
  }
  return { refs, footnotes }
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
  const commentEnd = forwardFinder(src, '-->')
  const doc = inlineDoc(src)
  let textStart = 0
  const flushText = (end: number): void => {
    const text = src.slice(textStart, end).trim()
    const c = text === '' ? [] : parseInline(text, true)
    if (c.length > 0) items.push({ t: 'inline', c })
  }
  let i = 0
  while (nodesLeft > 0) {
    const open = lt(i)
    if (open === -1) break
    if (src.startsWith('<!--', open)) {
      // A comment goes with everything in it; an unclosed one runs to the end of the block.
      flushText(open)
      const end = commentEnd(open + 2)
      i = textStart = end === -1 ? src.length : end + 3
      continue
    }
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
      const end = doc.find(`</${tag.name}>`, close + 1, src.length)
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
    const id = anchorId(f.attrs)
    top().push({
      t: 'element',
      tag: f.tag,
      align: ALIGN.has(align) ? (align as 'left' | 'center' | 'right') : f.name === 'center' ? 'center' : null,
      ...(f.tag === 'a' && f.attrs['href'] !== undefined ? { href: safeHref(f.attrs['href']) } : {}),
      ...(f.tag === 'details' && 'open' in f.attrs ? { open: true } : {}),
      ...(id !== undefined ? { id } : {}),
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
  return parseBlockRun(lines, depth).blocks
}

/** A list item's marker: its type (a bullet character, or an ordered list's `.` / `)`) and where its content starts. */
interface ListMarker {
  readonly ordered: boolean
  /** `-`, `*`, `+`, `.` or `)`: items of one list share it. */
  readonly kind: string
  readonly number: number
  /** The content's column: continuation lines indented this far belong to the item. */
  readonly width: number
  /** The first line's content. */
  readonly content: string
}

function listMarker(line: string): ListMarker | null {
  const m = LIST_ITEM.exec(line)
  if (m === null) return null
  const indent = indentOf(m[1] as string)
  const marker = m[2] as string
  const ordered = marker.length > 1 // a bullet is one character; `1.` at least two
  const markerEnd = indent + marker.length
  const spaces = m[3] === undefined ? 0 : indentOf(' '.repeat(markerEnd) + m[3]) - markerEnd
  const text = m[4] ?? ''
  // No content, or 5+ spaces after the marker (indented code there): content starts one past it.
  const width = text === '' || spaces > 4 ? markerEnd + 1 : markerEnd + spaces
  return {
    ordered,
    kind: ordered ? marker.slice(-1) : marker,
    number: ordered ? Number(marker.slice(0, -1)) : 0,
    width,
    content: spaces > 4 ? ' '.repeat(spaces - 1) + text : text,
  }
}

/**
 * Whether a list item may interrupt a paragraph (CommonMark §5.2): it has content, is indented
 * less than 4, and an ordered one starts at 1 (so `2012. A year` in a sentence stays text).
 */
function interruptsParagraph(line: string): boolean {
  const m = listMarker(line)
  return m !== null && m.content.trim() !== '' && indentOf(line) < 4 && (!m.ordered || m.number === 1)
}

/**
 * Lines of a container (a quote, a list item) that continue its paragraph without its marker
 * or indent: not blank, not the start of another block, not a setext underline, and only right
 * after a paragraph line outside fenced code.
 */
function isLazyLine(line: string, prev: string | undefined, inFence: boolean): boolean {
  return (
    !inFence &&
    prev !== undefined &&
    prev.trim() !== '' &&
    // Only a paragraph continues: not after a fence, heading or rule line.
    !FENCE.test(prev) &&
    !HEADING.test(prev) &&
    !HR.test(prev) &&
    line.trim() !== '' &&
    !isBlockStart(line) &&
    !SETEXT.test(line)
  )
}

/**
 * Blocks of `lines`, and whether a blank line separates two of them (a list item holding such
 * a gap makes its list loose).
 */
function parseBlockRun(lines: readonly string[], depth: number): { blocks: Block[]; gap: boolean } {
  const blocks: Item[] = []
  let i = 0
  let gap = false

  /**
   * A list whose first item's marker is `first` (at `lines[i]`), advancing `i` past it. An
   * item holds the lines indented to its content column, and lazy lines continuing its
   * paragraph; its content is parsed as blocks (nested lists, code, quotes…). The list is loose
   * (its items' text in paragraphs) when a blank line separates two items, or two blocks of
   * one item.
   */
  const parseList = (first: ListMarker): Block => {
    const items: (readonly Inline[])[] = []
    const tasks: (boolean | null)[] = []
    const rest: Block[][] = []
    let loose = false
    let marker: ListMarker | null = first
    while (marker !== null && nodesLeft > 0) {
      nodesLeft -= 1
      const task = TASK.exec(marker.content)
      tasks.push(task === null ? null : task[1] !== ' ')
      const body = [task === null ? marker.content : marker.content.slice(task[0].length)]
      // Inside fenced code, a line is never lazy (a lazy line cannot be a fence: isBlockStart).
      let fenced = FENCE.test(body[0] as string)
      let blanks = 0
      i += 1
      while (i < lines.length) {
        const l = lines[i] ?? ''
        if (l.trim() === '') {
          blanks += 1
          body.push('')
        } else if (indentOf(l) >= marker.width) {
          blanks = 0
          const stripped = stripCols(l, marker.width)
          body.push(stripped)
          if (FENCE.test(stripped)) fenced = !fenced
        } else if (blanks === 0 && listMarker(l) === null && isLazyLine(l, body[body.length - 1], fenced)) {
          body.push(l)
        } else break
        i += 1
      }
      // Trailing blank lines are between this item and whatever follows, not in it: they are
      // left for the next item or the enclosing block (whose looseness they decide).
      while (body.length > 1 && (body[body.length - 1] as string).trim() === '') {
        body.pop()
        i -= 1
      }
      const run = depth + 1 < MAX_NEST_DEPTH ? parseBlockRun(body, depth + 1) : { blocks: [plainParagraph(body)], gap: false }
      if (run.gap) loose = true
      const head = run.blocks[0]
      const text = head?.t === 'paragraph' ? head.c : null
      items.push(text ?? [])
      rest.push(text !== null ? run.blocks.slice(1) : run.blocks)
      // The next item: the same kind of marker, after any blank lines (which make the list loose).
      let k = i
      while (k < lines.length && (lines[k] ?? '').trim() === '') k += 1
      const next = k < lines.length && !HR.test(lines[k] ?? '') ? listMarker(lines[k] ?? '') : null
      marker = next !== null && next.ordered === first.ordered && next.kind === first.kind ? next : null
      if (marker !== null) {
        if (k > i) loose = true
        i = k
      }
    }
    return {
      t: 'list',
      ordered: first.ordered,
      items,
      ...(tasks.some((t) => t !== null) ? { tasks } : {}),
      ...(rest.some((r) => r.length > 0) ? { blocks: rest } : {}),
      ...(loose ? { loose: true as const } : {}),
      ...(first.ordered && first.number !== 1 ? { start: first.number } : {}),
    }
  }

  /** Append lines to `buf` through the first one that `holds` (or to the end), advancing `i`. */
  const takeThrough = (buf: string[], holds: (line: string) => boolean): void => {
    while (i < lines.length && !holds(lines[i] ?? '')) buf.push(lines[i++] ?? '')
    if (i < lines.length) buf.push(lines[i++] ?? '')
  }

  /** Parse one block at `lines[i]`, advancing `i` past it. */
  const step = (): void => {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i += 1
      return
    }
    // fenced code (its lines lose up to the opening fence's indent)
    const fence = FENCE.exec(line)
    if (fence) {
      const lang = fence[1] ?? ''
      const indent = indentOf(line)
      i += 1
      const buf: string[] = []
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        buf.push(stripCols(lines[i] ?? '', indent))
        i += 1
      }
      i += 1 // closing fence
      blocks.push({ t: 'code', lang, v: buf.join('\n') })
      return
    }
    // HTML comment block (CommonMark §4.6 type 2): runs to the line holding `-->`, and only
    // what follows the comment on that line (if anything) shows
    if (COMMENT_START.test(line)) {
      const buf = [line]
      i += 1
      if (!line.includes('-->', line.indexOf('<!--') + 2)) takeThrough(buf, (l) => l.includes('-->'))
      blocks.push(...htmlItems(buf.join('\n')))
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
        const holdsEnd = (l: string): boolean => asciiLower(l).includes(end)
        if (!holdsEnd(line)) takeThrough(buf, holdsEnd)
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
    const h = HEADING.exec(line)
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
    // blockquote: `>` lines, and lazy lines continuing its paragraph (GitHub alerts at the top level)
    if (QUOTE.test(line)) {
      const buf: string[] = []
      let fenced = false
      while (i < lines.length) {
        const l = lines[i] ?? ''
        if (QUOTE.test(l)) {
          const inner = l.replace(/^ {0,3}> ?/, '')
          buf.push(inner)
          if (FENCE.test(inner)) fenced = !fenced
        } else if (isLazyLine(l, buf[buf.length - 1], fenced)) buf.push(l)
        else break
        i += 1
      }
      if (depth + 1 >= MAX_NEST_DEPTH) {
        blocks.push({ t: 'quote', c: [plainParagraph(buf)] })
        return
      }
      const alert = depth === 0 ? ALERT.exec(buf[0] ?? '') : null
      if (alert !== null && buf.slice(1).some((l) => l.trim() !== '')) {
        blocks.push({ t: 'alert', kind: (alert[1] as string).toLowerCase() as AlertKind, c: parseBlocks(buf.slice(1), depth + 1) })
      } else {
        blocks.push({ t: 'quote', c: parseBlocks(buf, depth + 1) })
      }
      return
    }
    // list (GitHub task-list items: `- [ ] todo`, `- [x] done`)
    const first = listMarker(line)
    if (first !== null) {
      blocks.push(parseList(first))
      return
    }
    // paragraph: this line, plus following lines until a blank line or another block starts,
    // or a setext underline (`===`, `---`) that makes the lines a heading. Lines are joined
    // with `\n` so the inline parser can see hard breaks.
    const buf = [line]
    i += 1
    let setext = 0
    while (i < lines.length && lines[i]?.trim() !== '') {
      const underline = SETEXT.exec(lines[i] ?? '')
      if (underline !== null) {
        setext = underline[1]?.startsWith('=') ? 1 : 2
        i += 1
        break
      }
      if (isBlockStart(lines[i] ?? '') || tableStart(lines, i) !== null) break
      buf.push(lines[i] ?? '')
      i += 1
    }
    const c = parseInline(buf.map((l) => l.replace(/^[ \t]+/, '')).join('\n').trim())
    if (setext !== 0) {
      blocks.push({ t: 'heading', level: setext, c })
      return
    }
    // A paragraph of only comments shows nothing, and one of only `<a name>` targets is no
    // paragraph (GitHub's `<a name="install"></a>` lines): the anchors stay, the gap goes.
    if (c.every((n) => n.t === 'anchor' && n.c.length === 0)) {
      if (c.length > 0) blocks.push({ t: 'inline', c })
    } else {
      blocks.push({ t: 'paragraph', c })
    }
  }

  let blank = false // a blank line since the last block
  while (i < lines.length) {
    if (nodesLeft <= 0) {
      blocks.push(plainParagraph(lines.slice(i))) // node budget spent: fail closed to text
      break
    }
    const start = i
    const before = blocks.length
    if ((lines[i] ?? '').trim() === '') blank = true
    step()
    nodesLeft -= blocks.length - before
    if (blocks.length > before) {
      if (blank && before > 0) gap = true
      blank = false
    }
    // Every step must consume a line. If a future rule ever disagrees with another about
    // where a block starts, fail closed — render the rest as text — rather than spin forever.
    if (i <= start) {
      blocks.push(plainParagraph(lines.slice(start)))
      break
    }
  }
  return { blocks: buildTree(blocks), gap }
}

/** Whether `line` starts a block that interrupts a paragraph. */
function isBlockStart(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    QUOTE.test(line) ||
    interruptsParagraph(line) ||
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

/**
 * Word-level changes inside a diff's changed lines, as GitHub marks them: a deleted line is
 * paired with the added line at the same place in the run of additions that follows it (as the
 * side-by-side view lays them out), and the words that differ between the two are marked.
 *
 * Display only: nothing here decides what changed, only which part of a changed line to tint.
 * Bounded: a long line, or a pair that shares too little to be worth marking, gets no marks (the
 * whole row is tinted already).
 */

import type { TextDiffLine } from './text-diff'

/** A changed part of a line: `[start, end)` in UTF-16 code units of its text. */
export type Span = readonly [number, number]

/** Lines with more tokens than this are not marked: the comparison is quadratic. */
const MAX_TOKENS = 400
/**
 * A file's word marking stops after this many comparison cells (tokens × tokens, summed over its
 * pairs): a huge rewrite keeps its row tints and loses only the word marks past this point.
 */
export const WORD_DIFF_BUDGET = 4_000_000
/**
 * A pair is marked only when at least this share of the longer line's visible characters is
 * unchanged. Below it the line was rewritten, and marking nearly everything says nothing.
 */
const MIN_COMMON = 0.3

/**
 * Words (letters with their combining marks, digits, `_`), emoji (with their joiners and
 * modifiers), runs of whitespace, and single other characters: a mark never splits a character
 * from its accents.
 */
const TOKEN = /[\p{L}\p{M}\p{N}_]+|\p{Extended_Pictographic}(?:\p{M}|\u200d\p{Extended_Pictographic})*|\s+|[^\p{L}\p{M}\p{N}_\s]\p{M}*/gu

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

const visible = (t: string): number => (/^\s+$/.test(t) ? 0 : t.length)

/**
 * The spans of `a` and of `b` that differ, from a longest common subsequence of their tokens.
 * Null when either line is too long to compare or the two share too little to be worth marking.
 */
export function wordDiff(a: string, b: string, ta: readonly string[] = tokenize(a), tb: readonly string[] = tokenize(b)): { readonly a: Span[]; readonly b: Span[] } | null {
  if (a === b) return { a: [], b: [] }
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) return null
  const n = ta.length
  const m = tb.length
  // lcs[i][j]: the common length of ta[i..] and tb[j..], in tokens.
  const w = m + 1
  const lcs = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = ta[i] === tb[j] ? (lcs[(i + 1) * w + j + 1] as number) + 1 : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number)
    }
  }
  const sameA = new Uint8Array(n)
  const sameB = new Uint8Array(m)
  let common = 0
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ta[i] === tb[j]) {
      sameA[i] = 1
      sameB[j] = 1
      common += visible(ta[i] as string)
      i++
      j++
    } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) i++
    else j++
  }
  const longer = Math.max(ta.reduce((s, t) => s + visible(t), 0), tb.reduce((s, t) => s + visible(t), 0))
  if (longer > 0 && common / longer < MIN_COMMON) return null
  return { a: spansOf(ta, sameA), b: spansOf(tb, sameB) }
}

/**
 * The changed tokens as spans. Two changed runs with only whitespace between them are one span
 * (`foo bar` → `baz qux` marks the phrase, not two words and a gap).
 */
function spansOf(tokens: readonly string[], same: Uint8Array): Span[] {
  const text = tokens.join('')
  const spans: [number, number][] = []
  let pos = 0
  for (let i = 0; i < tokens.length; i++) {
    const end = pos + (tokens[i] as string).length
    const last = spans[spans.length - 1]
    if (same[i] === 0) {
      if (last !== undefined && /^\s*$/.test(text.slice(last[1], pos))) last[1] = end
      else spans.push([pos, end])
    }
    pos = end
  }
  return spans
}

/**
 * Word-level spans for a file's changed lines, keyed by the line: each run of deletions is paired
 * row by row with the run of additions right after it (`splitRows`' pairing). Lines without a
 * partner, and pairs {@link wordDiff} declines, are absent.
 */
export function pairWordDiffs(lines: readonly TextDiffLine[], budget = WORD_DIFF_BUDGET): Map<TextDiffLine, Span[]> {
  const out = new Map<TextDiffLine, Span[]>()
  let left = budget
  let i = 0
  while (i < lines.length && left > 0) {
    if (lines[i]?.kind !== 'deleted') {
      i++
      continue
    }
    const dels: TextDiffLine[] = []
    while (lines[i]?.kind === 'deleted') dels.push(lines[i++] as TextDiffLine)
    const adds: TextDiffLine[] = []
    while (lines[i]?.kind === 'added') adds.push(lines[i++] as TextDiffLine)
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const [del, add] = [dels[k] as TextDiffLine, adds[k] as TextDiffLine]
      const [ta, tb] = [tokenize(del.text), tokenize(add.text)]
      // A pair over the token cap is never compared, so it costs nothing.
      if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) continue
      left -= ta.length * tb.length
      if (left < 0) break
      const d = wordDiff(del.text, add.text, ta, tb)
      if (d === null) continue
      if (d.a.length > 0) out.set(del, d.a)
      if (d.b.length > 0) out.set(add, d.b)
    }
  }
  return out
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }

/** Text as HTML, escaped as highlight.js escapes it (so spans count characters the same way). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string)
}

/**
 * Wrap the `spans` of a line's text in `<mark class=…>`, inside the HTML highlight.js made of it
 * (or {@link escapeHtml}'s). Each mark stays inside one element, closed before a tag and reopened
 * after it, so the result nests. An entity counts as the one character it stands for.
 */
export function markSpans(html: string, spans: readonly Span[], className: string): string {
  if (spans.length === 0) return html
  let out = ''
  let pos = 0
  let si = 0
  let open = false
  for (const [piece] of html.matchAll(/<[^>]*>|&#?\w+;|[^<&]|&/g)) {
    if (piece.startsWith('<')) {
      // Close the mark before any tag; the next character reopens it if it is still inside.
      if (open) out += '</mark>'
      out += piece
      open = false
      continue
    }
    while (si < spans.length && pos >= (spans[si] as Span)[1]) si++
    const inside = si < spans.length && pos >= (spans[si] as Span)[0]
    if (inside && !open) out += `<mark class="${className}">`
    else if (!inside && open) out += '</mark>'
    open = inside
    out += piece
    pos += 1
  }
  if (open) out += '</mark>'
  return out
}

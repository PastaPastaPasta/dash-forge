/**
 * Review suggestions — ```` ```suggestion ```` blocks in a comment body and the text
 * replacement that applies one (review-parity §4.5, §5.6). The TypeScript port of
 * `parse_suggestions` / `apply_suggestion` in `crates/forge-core/src/rules/review.rs`, held in
 * parity by the `suggestion__*` vectors; re-exported from `./review`.
 *
 * Comment bodies are untrusted and permanent, so both run in linear time (`render-fuzz.test.ts`
 * checks it). Loaded by plain Node (type stripping) there: no imports, erasable syntax only.
 */

export interface Suggestion {
  readonly text: string
}

function leadingSpaces(line: string): number {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  return n
}

function runOf(s: string, ch: string): number {
  let n = 0
  while (n < s.length && s[n] === ch) n++
  return n
}

/** Fence whitespace: ASCII space, tab and CR only (the Rust `is_fence_space`). */
const isFenceSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\r'

/**
 * `s` without leading and trailing fence whitespace (the Rust `trim_matches(is_fence_space)`).
 * A scan, not a `/^…+|…+$/` regex: that alternation retries the trailing branch at every
 * position of a long whitespace run, quadratic in its length (180 ms for 20 KB of spaces).
 */
function trimFence(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && isFenceSpace(s[a])) a++
  while (b > a && isFenceSpace(s[b - 1])) b--
  return s.slice(a, b)
}

/** Whether `s` is only fence whitespace. */
function allFenceSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (!isFenceSpace(s[i])) return false
  return true
}

function fenceOpen(line: string): { indent: number; ch: string; run: number; word: string } | null {
  const indent = leadingSpaces(line)
  if (indent > 3) return null
  const rest = line.slice(indent)
  const ch = rest[0]
  if (ch !== '`' && ch !== '~') return null
  const run = runOf(rest, ch)
  if (run < 3) return null
  const info = trimFence(rest.slice(run))
  if (ch === '`' && info.includes('`')) return null
  // The first word: up to the first fence space (a scan; `split` would build every word).
  let end = 0
  while (end < info.length && !isFenceSpace(info[end])) end++
  return { indent, ch, run, word: info.slice(0, end) }
}

function fenceClose(line: string, ch: string, run: number): boolean {
  const indent = leadingSpaces(line)
  if (indent > 3) return false
  const rest = line.slice(indent)
  const n = runOf(rest, ch)
  return n >= run && allFenceSpace(rest.slice(n))
}

/** The ```` ```suggestion ```` blocks of a body, in order (the Rust `parse_suggestions`). */
export function parseSuggestions(body: string): Suggestion[] {
  const out: Suggestion[] = []
  let open: { indent: number; ch: string; run: number; isSuggestion: boolean; lines: string[] } | null = null
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (open !== null) {
      if (fenceClose(line, open.ch, open.run)) {
        if (open.isSuggestion) out.push({ text: open.lines.join('\n') })
        open = null
      } else {
        // Up to the opener's indentation is removed from content lines (CommonMark).
        open.lines.push(line.slice(Math.min(leadingSpaces(line), open.indent)))
      }
      continue
    }
    const f = fenceOpen(line)
    if (f !== null) open = { indent: f.indent, ch: f.ch, run: f.run, isSuggestion: f.word === 'suggestion', lines: [] }
  }
  if (open?.isSuggestion) out.push({ text: open.lines.join('\n') })
  return out
}

export type SuggestionError = 'badRange' | 'outOfRange'

/**
 * Replace lines `startLine..=endLine` (1-based) of `file` with `text`, keeping the file's
 * newline style and trailing-newline state (the Rust `apply_suggestion`).
 */
export function applySuggestion(
  file: string,
  startLine: number,
  endLine: number,
  text: string,
): { ok: string } | { error: SuggestionError } {
  if (startLine < 1 || startLine > endLine) return { error: 'badRange' }
  const firstNl = file.indexOf('\n')
  const nl = firstNl > 0 && file[firstNl - 1] === '\r' ? '\r\n' : '\n'
  const trailing = file.endsWith('\n')
  const normalized = file.replace(/\r\n/g, '\n')
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  const lines = normalized === '' ? [] : body.split('\n')
  if (endLine > lines.length) return { error: 'outOfRange' }
  const replacement = text.replace(/\r\n/g, '\n')
  // Concatenated, not `splice(…, ...lines)`: spreading a large suggestion into call
  // arguments overflows the stack (a 1 MiB suggestion of empty lines is 1M arguments).
  const result = lines
    .slice(0, startLine - 1)
    .concat(replacement === '' ? [] : replacement.split('\n'), lines.slice(endLine))
  let out = result.join(nl)
  if (trailing && result.length > 0) out += nl
  return { ok: out }
}

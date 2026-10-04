/**
 * Code search over a repo's files held in memory (P1-3): what the search worker runs for a
 * {@link CodeQuery}. A scan, not an inverted index: the text of every file the index holds is in
 * memory, and V8's regular expressions scan dashpay/dash's 4,398 text files (45 MiB) for a word in
 * 5 to 25 ms, which no prefilter would beat by enough to pay for its memory. A scan also answers
 * what a token index cannot: any substring, a phrase across punctuation, and regular expressions.
 *
 * Results are GitHub's: the matching files (every term in the content or the path, no negated term,
 * every filter passed), ranked with path matches first, then by how often the terms occur; for the
 * files shown, each matching line with a line of context either side and the matches marked.
 *
 * Pure (no DOM, no network): the worker runs it, and the tests run it directly.
 */

import { escapeRegex, globRegex, isEmptyQuery, type CodeQuery } from './code-query'
import { searchLanguageNamed } from './languages'

/** One file the index holds. */
export interface CorpusFile {
  readonly path: string
  readonly text: string
  /** Its language for `language:` ({@link searchLanguageOf}), or null. */
  readonly language: string | null
}

/** `[start, end)` of a match, in UTF-16 units of the line (or path) shown. */
export type MatchRange = readonly [number, number]

/** A line shown under a result: a matching line (with `ranges`) or a line of context (none). */
export interface ResultLine {
  /** 1-based line number. */
  readonly n: number
  readonly text: string
  readonly ranges: readonly MatchRange[]
  /** The line was cut to a window around its matches: text was left out before / after. */
  readonly clippedStart: boolean
  readonly clippedEnd: boolean
}

export interface FileResult {
  readonly path: string
  readonly language: string | null
  /** Matches in the path (bare terms and `path:` substrings). */
  readonly pathRanges: readonly MatchRange[]
  /** Lines with a match (counted up to {@link MAX_COUNTED_LINES}). */
  readonly matchLines: number
  /** The matching lines (up to {@link MAX_SHOWN_LINES}) with a line of context either side, in order. */
  readonly lines: readonly ResultLine[]
}

export interface SearchResult {
  /** The files asked for (`offset`, `limit`), ranked. */
  readonly files: readonly FileResult[]
  /** Every matching file (unless {@link stopped}). */
  readonly fileCount: number
  /** `language:` values that name no language this search knows. */
  readonly unknownLanguages: readonly string[]
  /** The scan ran out of its time budget: the counts cover the files scanned before then. */
  readonly stopped: boolean
  /** Files the index holds (searched or filtered out). */
  readonly searched: number
  readonly ms: number
}

/** Matching lines counted per file (a minified file's every line need not be). */
export const MAX_COUNTED_LINES = 1000
/** Matching lines returned per file shown (GitHub's "Show more matches" stops too). */
export const MAX_SHOWN_LINES = 100
/** A line longer than this is shown as a window around its first match. */
export const LINE_WINDOW = 240
/** Occurrences counted per file for ranking. */
const MAX_COUNTED_OCCURRENCES = 10_000

interface CompiledTerm {
  /** Test (no `g`: no `lastIndex` state). */
  readonly test: RegExp
  /** Every occurrence (`g`). */
  readonly all: RegExp
  readonly contentOnly: boolean
}

function compile(source: string, caseSensitive: boolean, contentOnly: boolean): CompiledTerm {
  // `m`: `^` and `$` are line anchors, as a code search reads them.
  const flags = `m${caseSensitive ? '' : 'i'}`
  return { test: new RegExp(source, flags), all: new RegExp(source, `g${flags}`), contentOnly }
}

/** Every non-empty match of `re` (global) in `text`, up to `max`. */
function ranges(re: RegExp, text: string, max: number): MatchRange[] {
  const out: MatchRange[] = []
  re.lastIndex = 0
  for (let m = re.exec(text); m !== null && out.length < max; m = re.exec(text)) {
    if (m[0].length === 0) {
      // An empty match (`/^/`, `/x*/`) marks nothing; step past it or the scan never ends.
      re.lastIndex += 1
      continue
    }
    out.push([m.index, m.index + m[0].length])
  }
  return out
}

/** How many non-empty matches of `re` (global) `text` holds, up to `max` (no array of them). */
function countMatches(re: RegExp, text: string, max: number): number {
  let n = 0
  re.lastIndex = 0
  for (let m = re.exec(text); m !== null && n < max; m = re.exec(text)) {
    if (m[0].length === 0) re.lastIndex += 1
    else n += 1
  }
  return n
}

/** Sorted, overlapping or touching ranges merged. */
function merge(list: MatchRange[]): MatchRange[] {
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: [number, number][] = []
  for (const [s, e] of list) {
    const last = out[out.length - 1]
    if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** The start offset of every line of `text`. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** The index of the line holding `offset` (binary search over {@link lineStarts}). */
function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] as number) <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Line `i` of `text` (without its newline, or a `\r` before it). */
function lineText(text: string, starts: readonly number[], i: number): string {
  const start = starts[i] as number
  const next = starts[i + 1]
  let end = next === undefined ? text.length : next - 1
  if (end > start && text.charCodeAt(end - 1) === 13) end -= 1
  return text.slice(start, end)
}

/** A line shown, cut to {@link LINE_WINDOW} around its first match when longer. */
function shownLine(n: number, line: string, marks: readonly MatchRange[]): ResultLine {
  if (line.length <= LINE_WINDOW) return { n, text: line, ranges: marks, clippedStart: false, clippedEnd: false }
  const first = marks[0]?.[0] ?? 0
  const from = Math.max(0, Math.min(first - 40, line.length - LINE_WINDOW))
  const to = Math.min(line.length, from + LINE_WINDOW)
  const kept = marks.filter(([s, e]) => e > from && s < to).map(([s, e]): MatchRange => [Math.max(s, from) - from, Math.min(e, to) - from])
  return { n, text: line.slice(from, to), ranges: kept, clippedStart: from > 0, clippedEnd: to < line.length }
}

/** A path filter as a test over a path. */
function pathTest(kind: 'substring' | 'glob' | 'regex', value: string, caseSensitive: boolean): (path: string) => boolean {
  if (kind === 'regex') {
    const re = new RegExp(value, caseSensitive ? '' : 'i')
    return (p) => re.test(p)
  }
  if (kind === 'glob') {
    const re = globRegex(value, caseSensitive)
    return (p) => re.test(p)
  }
  const fold = (s: string): string => (caseSensitive ? s : s.toLowerCase())
  // A leading `/` anchors at the root (`path:/src/` is everything under `src/`).
  if (value.startsWith('/')) {
    const prefix = fold(value.slice(1))
    return (p) => fold(p).startsWith(prefix)
  }
  const needle = fold(value)
  return (p) => fold(p).includes(needle)
}

/** The lines of `file` shown for `terms`: matching lines, each with a line of context either side. */
function resultLines(file: CorpusFile, terms: readonly CompiledTerm[]): { lines: ResultLine[]; matchLines: number } {
  const occurrences: MatchRange[] = []
  for (const t of terms) occurrences.push(...ranges(t.all, file.text, MAX_COUNTED_OCCURRENCES))
  if (occurrences.length === 0) return { lines: [], matchLines: 0 }
  const starts = lineStarts(file.text)
  // Per line: its matches, in line coordinates. A match across a newline (a regex with `\s`) marks
  // the line it starts on, up to that line's end.
  const byLine = new Map<number, MatchRange[]>()
  for (const [s, e] of occurrences) {
    const i = lineAt(starts, s)
    const lineStart = starts[i] as number
    const lineEnd = (starts[i + 1] ?? file.text.length + 1) - 1
    const list = byLine.get(i) ?? []
    list.push([s - lineStart, Math.min(e, lineEnd) - lineStart])
    byLine.set(i, list)
  }
  const matched = [...byLine.keys()].sort((a, b) => a - b)
  const shown = matched.slice(0, MAX_SHOWN_LINES)
  const wanted = new Set<number>()
  for (const i of shown) {
    if (i > 0) wanted.add(i - 1)
    wanted.add(i)
    if (i + 1 < starts.length) wanted.add(i + 1)
  }
  // A trailing newline leaves an empty "line" after the last; it is no line of the file.
  const lastLine = file.text.endsWith('\n') ? starts.length - 2 : starts.length - 1
  const lines = [...wanted]
    .filter((i) => i <= lastLine)
    .sort((a, b) => a - b)
    .map((i) => shownLine(i + 1, lineText(file.text, starts, i), byLine.has(i) ? merge(byLine.get(i) as MatchRange[]) : []))
  return { lines, matchLines: Math.min(matched.length, MAX_COUNTED_LINES) }
}

export interface SearchOptions {
  readonly offset?: number
  readonly limit?: number
  /** Stop scanning after this long (ms); the result says so ({@link SearchResult.stopped}). */
  readonly budgetMs?: number
  readonly now?: () => number
}

/** Run `query` over `files` ({@link SearchResult}). */
export function searchCorpus(files: readonly CorpusFile[], query: CodeQuery, { offset = 0, limit = 20, budgetMs = 5_000, now = () => performance.now() }: SearchOptions = {}): SearchResult {
  const started = now()
  const empty = (unknownLanguages: string[] = []): SearchResult => ({ files: [], fileCount: 0, unknownLanguages, stopped: false, searched: files.length, ms: now() - started })
  if (query.error !== null || isEmptyQuery(query)) return empty()
  const cs = query.caseSensitive
  const positive = query.terms.filter((t) => !t.negated).map((t) => compile(t.kind === 'regex' ? t.value : escapeRegex(t.value), cs, t.contentOnly))
  const negative = query.terms.filter((t) => t.negated).map((t) => compile(t.kind === 'regex' ? t.value : escapeRegex(t.value), cs, t.contentOnly))
  const unknownLanguages: string[] = []
  const wantLanguages = new Set<string>()
  const notLanguages = new Set<string>()
  for (const l of query.languages) {
    const name = searchLanguageNamed(l.value)
    if (name === null) unknownLanguages.push(l.value)
    else (l.negated ? notLanguages : wantLanguages).add(name)
  }
  // A language nobody knows matches no file (as GitHub's does), unless it was only excluded.
  if (query.languages.some((l) => !l.negated && searchLanguageNamed(l.value) === null)) return empty(unknownLanguages)
  const pathTests = query.paths.map((p) => ({ test: pathTest(p.kind, p.value, cs), negated: p.negated }))

  const hits: { file: CorpusFile; pathHits: number; occurrences: number }[] = []
  let stopped = false
  for (let at = 0; at < files.length; at++) {
    // The clock is read every 64 files: a scan of one file is microseconds.
    if ((at & 63) === 0 && at > 0 && now() - started > budgetMs) {
      stopped = true
      break
    }
    const file = files[at] as CorpusFile
    if (wantLanguages.size > 0 && (file.language === null || !wantLanguages.has(file.language))) continue
    if (file.language !== null && notLanguages.has(file.language)) continue
    if (!pathTests.every((p) => p.test(file.path) !== p.negated)) continue
    if (negative.some((t) => t.test.test(file.text) || (!t.contentOnly && t.test.test(file.path)))) continue
    let pathHits = 0
    let ok = true
    for (const t of positive) {
      const inPath = !t.contentOnly && t.test.test(file.path)
      if (inPath) pathHits += 1
      else if (!t.test.test(file.text)) {
        ok = false
        break
      }
    }
    if (!ok) continue
    let occurrences = 0
    for (const t of positive) occurrences += countMatches(t.all, file.text, MAX_COUNTED_OCCURRENCES)
    hits.push({ file, pathHits, occurrences })
  }
  // Path matches first (GitHub's file finder habit), then the most occurrences, then the shorter path.
  hits.sort((a, b) => b.pathHits - a.pathHits || b.occurrences - a.occurrences || a.file.path.length - b.file.path.length || (a.file.path < b.file.path ? -1 : 1))
  const pathMarkers = [
    ...positive.filter((t) => !t.contentOnly).map((t) => t.all),
    ...query.paths.filter((p) => !p.negated && p.kind === 'substring').map((p) => new RegExp(escapeRegex(p.value.replace(/^\//, '')), cs ? 'g' : 'gi')),
  ]
  const page = hits.slice(offset, offset + limit).map(({ file }): FileResult => {
    const { lines, matchLines } = resultLines(file, positive)
    const pathRanges = merge(pathMarkers.flatMap((re) => ranges(re, file.path, 50)))
    return { path: file.path, language: file.language, pathRanges, matchLines, lines }
  })
  return { files: page, fileCount: hits.length, unknownLanguages, stopped, searched: files.length, ms: now() - started }
}

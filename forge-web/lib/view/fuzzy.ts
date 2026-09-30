/**
 * Fuzzy file-name matching for Go to file (QW-028), GitHub's file finder: the query's characters
 * in order anywhere in the path (`netproc` finds `src/net_processing.cpp`), case-insensitive,
 * ranked so a match at the start of a name, a run of adjacent characters and a shorter path come
 * first. The scoring is fzy's (github.com/jhawthorn/fzy, MIT), which GitHub-style finders use:
 * a dynamic programme over (query, path) that rewards a match after `/`, `_`, `-`, `.` or a
 * lower-to-upper case change and a consecutive match, and charges for every skipped character.
 */

const SCORE_GAP_LEADING = -0.005
const SCORE_GAP_TRAILING = -0.005
const SCORE_GAP_INNER = -0.01
const SCORE_MATCH_CONSECUTIVE = 1.0
const SCORE_MATCH_SLASH = 0.9
const SCORE_MATCH_WORD = 0.8
const SCORE_MATCH_CAPITAL = 0.7
const SCORE_MATCH_DOT = 0.6
/** Paths longer than this are matched but not scored (fzy's own bound). */
const MATCH_MAX_LEN = 1024

/** A match: its score (higher is better) and the matched positions in the path. */
export interface FuzzyMatch {
  readonly score: number
  readonly positions: readonly number[]
}

/**
 * `text` lowercased one UTF-16 unit at a time, so each position stays where it was: a character
 * whose lowercase form is longer (`İ`) is kept as it is, and matched positions stay the path's.
 */
function foldCase(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ''
  for (const ch of text) {
    const l = ch.toLowerCase()
    out += l.length === ch.length ? l : ch
  }
  return out
}

/** Whether every character of `needle` (lowercase) appears in `haystack` (lowercase), in order. */
function hasMatch(needle: string, haystack: string): boolean {
  let at = 0
  for (const ch of needle) {
    at = haystack.indexOf(ch, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

/** The bonus for a match at `i`, by the character before it. */
function bonusAt(path: string, i: number): number {
  if (i === 0) return SCORE_MATCH_SLASH
  const prev = path[i - 1] as string
  const ch = path[i] as string
  if (prev === '/') return SCORE_MATCH_SLASH
  if (prev === '-' || prev === '_' || prev === ' ') return SCORE_MATCH_WORD
  if (prev === '.') return SCORE_MATCH_DOT
  if (prev >= 'a' && prev <= 'z' && ch >= 'A' && ch <= 'Z') return SCORE_MATCH_CAPITAL
  return 0
}

/**
 * The best way `query` matches `path`, or null when it does not (spaces in the query are ignored,
 * as GitHub's finder ignores them). An empty query matches nothing.
 */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const needle = foldCase(query.replace(/\s+/g, ''))
  if (needle === '') return null
  const lower = foldCase(path)
  if (!hasMatch(needle, lower)) return null
  const n = needle.length
  const m = path.length
  if (n === m) return { score: Infinity, positions: [...Array(m).keys()] }
  if (m > MATCH_MAX_LEN) return { score: -Infinity, positions: [] }

  // D[i][j]: the best score of needle[0..i] ending with a match at j; M[i][j]: the best score of
  // needle[0..i] within path[0..j].
  const D: Float64Array[] = []
  const M: Float64Array[] = []
  const bonus = new Float64Array(m)
  for (let j = 0; j < m; j++) bonus[j] = bonusAt(path, j)
  for (let i = 0; i < n; i++) {
    const d = new Float64Array(m)
    const mm = new Float64Array(m)
    const gap = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER
    let prev = -Infinity
    for (let j = 0; j < m; j++) {
      if (needle[i] === lower[j]) {
        let score = -Infinity
        if (i === 0) score = j * SCORE_GAP_LEADING + (bonus[j] as number)
        else if (j > 0) {
          const pm = (M[i - 1] as Float64Array)[j - 1] as number
          const pd = (D[i - 1] as Float64Array)[j - 1] as number
          score = Math.max(pm + (bonus[j] as number), pd + SCORE_MATCH_CONSECUTIVE)
        }
        d[j] = score
        prev = Math.max(score, prev + gap)
      } else {
        d[j] = -Infinity
        prev += gap
      }
      mm[j] = prev
    }
    D.push(d)
    M.push(mm)
  }

  // Walk back for the positions: the latest match on the best path, preferring a consecutive run.
  const positions = new Array<number>(n)
  let matchRequired = false
  for (let i = n - 1, j = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      const d = (D[i] as Float64Array)[j] as number
      const mm = (M[i] as Float64Array)[j] as number
      if (d !== -Infinity && (matchRequired || d === mm)) {
        // Consecutive with the next match: this one must be taken too.
        matchRequired = i > 0 && j > 0 && mm === ((D[i - 1] as Float64Array)[j - 1] as number) + SCORE_MATCH_CONSECUTIVE
        positions[i] = j
        j -= 1
        break
      }
    }
  }
  return { score: (M[n - 1] as Float64Array)[m - 1] as number, positions }
}

/** One ranked hit. */
export interface FuzzyHit extends FuzzyMatch {
  readonly path: string
}

/**
 * The `limit` best matches of `query` among `paths`, best first; ties go to the shorter path, then
 * path order.
 */
export function fuzzyRank(query: string, paths: readonly string[], limit: number): FuzzyHit[] {
  const needle = foldCase(query.replace(/\s+/g, ''))
  if (needle === '') return []
  const hits: FuzzyHit[] = []
  for (const path of paths) {
    // The cheap in-order test first: most paths fail it, and scoring is the costly part.
    if (!hasMatch(needle, foldCase(path))) continue
    const match = fuzzyMatch(needle, path)
    if (match !== null) hits.push({ path, ...match })
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return hits.slice(0, limit)
}

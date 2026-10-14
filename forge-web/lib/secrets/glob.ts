/**
 * Path globs for the allow file, matched from the repository's root (twin of `glob.rs`):
 *
 * - `*` matches any characters except `/`; `?` matches one character except `/`; a double star
 *   matches anything, `/` included, and a double star followed by `/` also matches nothing.
 * - Every pattern is anchored at the root (a leading `/` is allowed and dropped): `.env` is the
 *   root `.env` only. For any depth, start with a double star and `/`.
 * - A pattern also matches every file under a folder it matches; a trailing `/` makes it match
 *   folders only.
 */

import { trimStartBy } from './util'

/** Whether `path` (`/`-separated, relative to the root) matches `pattern`. */
export function pathMatches(pattern: string, path: string): boolean {
  const foldersOnly = pattern.endsWith('/')
  let end = pattern.length
  while (end > 0 && pattern.charAt(end - 1) === '/') end--
  const p = trimStartBy(pattern.slice(0, end), (c) => c === 0x2f)
  if (p === '') return false
  const pat = Array.from(p)
  const parts = path.split('/')
  const n = parts.length
  // Every leading run of parts: the folders, then (unless folders only) the whole path.
  for (let k = 1; k <= n; k++) {
    if (k >= n && foldersOnly) continue
    if (glob(pat, Array.from(parts.slice(0, k).join('/')))) return true
  }
  return false
}

/** Whether all of `text` matches all of `pat`. Memoized on (pattern position, text position). */
function glob(pat: readonly string[], text: readonly string[]): boolean {
  const memo = new Array<boolean | undefined>((pat.length + 1) * (text.length + 1))
  return globAt(pat, text, 0, 0, memo)
}

/** Whether `text[at..]` matches `pat[pi..]`. */
function globAt(
  pat: readonly string[],
  text: readonly string[],
  pi: number,
  at: number,
  memo: (boolean | undefined)[],
): boolean {
  const key = pi * (text.length + 1) + at
  const known = memo[key]
  if (known !== undefined) return known
  const end = text.length
  let matched = false
  const c0 = pat[pi]
  if (c0 === undefined) {
    matched = at === end
  } else if (c0 === '*' && pat[pi + 1] === '*' && pat[pi + 2] === '/') {
    // A double star and `/` also matches nothing: at `at`, or after any later `/`.
    for (let t = at; t <= end; t++) {
      if ((t === at || text[t - 1] === '/') && globAt(pat, text, pi + 3, t, memo)) {
        matched = true
        break
      }
    }
  } else if (c0 === '*' && pat[pi + 1] === '*') {
    for (let t = at; t <= end; t++) {
      if (globAt(pat, text, pi + 2, t, memo)) {
        matched = true
        break
      }
    }
  } else if (c0 === '*') {
    for (let t = at; t <= end; t++) {
      if (t !== at && text[t - 1] === '/') break
      if (globAt(pat, text, pi + 1, t, memo)) {
        matched = true
        break
      }
    }
  } else if (c0 === '?') {
    const ch = text[at]
    matched = ch !== undefined && ch !== '/' && globAt(pat, text, pi + 1, at + 1, memo)
  } else {
    matched = text[at] === c0 && globAt(pat, text, pi + 1, at + 1, memo)
  }
  memo[key] = matched
  return matched
}

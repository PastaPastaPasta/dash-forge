/**
 * Protected-pattern matching — git `wildmatch` with WM_PATHNAME semantics.
 *
 * Ports `matches_protected` + `neutralize_wildmatch` from
 * `crates/forge-core/src/rules.rs`. The Rust side uses the `glob_match` crate (which
 * matches git `wildmatch` for `*`/`**`/`?`/`[]`/`\`) after neutralizing the two
 * extensions git `wildmatch` does NOT have — leading-`!` negation and `{a,b}` brace
 * alternation — into literals. This TS port neutralizes identically and then runs a
 * faithful git-`wildmatch` matcher, so it never needs the crate's extensions at all.
 *
 * Pinned semantics (FORGE_RULES_V1):
 *   `*`  matches any run of chars EXCEPT `/` (stays within one ref segment)
 *   `**` (a whole path segment) matches across `/` (any number of segments)
 *   `?`  matches a single non-`/` char
 *   `[abc]` / `[a-z]` / `[!abc]` character classes
 *   `\x` escapes `x` to a literal
 *   every other char, incl. `{`, `}`, `,`, leading `!`, is a literal
 */

/** Whether `refName` matches ANY protected glob in `patterns`. */
export function matchesProtected(refName: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => wildmatch(neutralizeWildmatch(p), refName))
}

/**
 * Escape the two constructs git `wildmatch` treats as literals but the backing crate
 * would interpret: a leading run of `!` (negation) and every `{`/`}` (alternation).
 * Preserves everything else, including existing `\` escapes.
 */
export function neutralizeWildmatch(pattern: string): string {
  let out = ''
  let i = 0
  // A leading run of `!` toggles negation in the crate; git wildmatch treats each literal.
  while (i < pattern.length && pattern[i] === '!') {
    out += '\\!'
    i++
  }
  for (; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '{' || c === '}') out += '\\'
    out += c
  }
  return out
}

const SLASH = '/'

/**
 * git `wildmatch` (WM_PATHNAME), recursive backtracking, whole-string match.
 * Faithful to git's `wildmatch.c` `dowild` for the constructs we admit; the pattern is
 * pre-neutralized so `{`/`}`/leading-`!` never reach here as metacharacters.
 */
export function wildmatch(pattern: string, text: string): boolean {
  return dowild(pattern, 0, text, 0)
}

function dowild(p: string, pi: number, t: string, ti: number): boolean {
  let i = pi
  let j = ti
  while (i < p.length) {
    const pc = p[i] as string

    if (pc === '\\') {
      // Escaped literal.
      if (i + 1 >= p.length) return false
      const lit = p[i + 1] as string
      if (j >= t.length || t[j] !== lit) return false
      i += 2
      j += 1
      continue
    }

    if (pc === '?') {
      if (j >= t.length || t[j] === SLASH) return false
      i += 1
      j += 1
      continue
    }

    if (pc === '[') {
      if (j >= t.length || t[j] === SLASH) return false
      const res = matchClass(p, i, t[j] as string)
      if (res === null) {
        // Unterminated class: treat `[` as a literal (git falls back to a literal match).
        if (t[j] !== '[') return false
        i += 1
        j += 1
        continue
      }
      if (!res.matched) return false
      i = res.next
      j += 1
      continue
    }

    if (pc === '*') {
      // Consume the star run and decide single-star vs globstar.
      const starStart = i
      i += 1
      let globstar = false
      if (i < p.length && p[i] === '*') {
        while (i < p.length && p[i] === '*') i += 1
        const prevIsBoundary = starStart === 0 || p[starStart - 1] === SLASH
        const nextIsBoundary = i >= p.length || p[i] === SLASH
        globstar = prevIsBoundary && nextIsBoundary
      }
      const matchSlash = globstar

      // git quick-out: a globstar immediately followed by `/` may match zero segments.
      if (globstar && i < p.length && p[i] === SLASH) {
        if (dowild(p, i + 1, t, j)) return true
      }

      // Backtrack: let the star consume 0..N text chars, trying the rest at each stop.
      let k = j
      for (;;) {
        if (dowild(p, i, t, k)) return true
        if (k >= t.length) return false
        if (!matchSlash && t[k] === SLASH) return false
        k += 1
      }
    }

    // Literal char.
    if (j >= t.length || t[j] !== pc) return false
    i += 1
    j += 1
  }

  return j === t.length
}

/**
 * Match a `[...]` character class against `ch`, starting at `p[start] === '['`.
 * Returns `{ matched, next }` where `next` is the index just past the closing `]`,
 * or `null` if the class is unterminated.
 */
function matchClass(
  p: string,
  start: number,
  ch: string,
): { matched: boolean; next: number } | null {
  let i = start + 1
  let negate = false
  if (i < p.length && (p[i] === '!' || p[i] === '^')) {
    negate = true
    i += 1
  }
  let matched = false
  let first = true
  while (i < p.length) {
    const c = p[i] as string
    if (c === ']' && !first) {
      return { matched: matched !== negate, next: i + 1 }
    }
    first = false
    if (c === '\\' && i + 1 < p.length) {
      const lit = p[i + 1] as string
      if (ch === lit) matched = true
      i += 2
      continue
    }
    // Range `a-z` (when a real range, not a trailing `-`).
    if (i + 2 < p.length && p[i + 1] === '-' && p[i + 2] !== ']') {
      const lo = c.charCodeAt(0)
      const hi = (p[i + 2] as string).charCodeAt(0)
      const cc = ch.charCodeAt(0)
      if (cc >= lo && cc <= hi) matched = true
      i += 3
      continue
    }
    if (ch === c) matched = true
    i += 1
  }
  return null
}

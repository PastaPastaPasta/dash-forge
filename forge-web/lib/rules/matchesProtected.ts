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
 * Pinned semantics (FORGE_RULES):
 *   `*`  matches any run of chars EXCEPT `/` (stays within one ref segment)
 *   `**` (a whole path segment) matches across `/` (any number of segments)
 *   `?`  matches a single non-`/` char
 *   `[abc]` / `[a-z]` / `[!abc]` character classes
 *   `\x` escapes `x` to a literal
 *   every other char, incl. `{`, `}`, `,`, leading `!`, is a literal
 *
 * Loaded by plain Node (type stripping) in `render-fuzz.test.ts`: keep imports relative and
 * the syntax erasable (no enums, namespaces or `@/` aliases).
 */

/** Whether `refName` matches ANY protected glob in `patterns`. */
export function matchesProtected(refName: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => wildmatch(neutralizeWildmatch(p), refName))
}

/** Every tag, nested ones included (`refs/tags/v1`, `refs/tags/tools/v1`): `**` crosses `/`. */
export const ALL_TAGS_PATTERN = 'refs/tags/**'

/**
 * The protected patterns a new repository starts with unless its creator opts out (a client
 * convention, `forge-v2.md` §6): its default branch and every tag, so only maintainers can move
 * what people build and install from. `defaultBranch` is the short name (`main`) or the full ref.
 * Parity: forge-core `rules::default_protected_patterns` (vectors `default_protection__*`).
 */
export function defaultProtectedPatterns(defaultBranch: string): string[] {
  const short = defaultBranch.startsWith('refs/heads/') ? defaultBranch.slice('refs/heads/'.length) : defaultBranch
  return [`refs/heads/${short}`, ALL_TAGS_PATTERN]
}

/**
 * The patterns that cover every tag (see {@link missingDefaultProtection}). A list, not a test
 * against sample tags: a glob can match any finite sample and still miss a tag (one that
 * excludes names starting with `q` misses `q1`).
 */
const ALL_TAG_PATTERNS: readonly string[] = ['refs/tags/**', 'refs/**', '**']

/**
 * What of the default protection `patterns` leave uncovered on a repository whose default branch
 * is `defaultBranch`: the default patterns still needed, empty when existing patterns cover both
 * the branch and every tag. Every tag counts as covered only by a pattern that names them all
 * (`refs/tags/**`, `refs/**`, `**`): `refs/tags/*` misses nested tags and `refs/tags/v*` misses
 * `1.0`, so either still needs `refs/tags/**`. Parity: forge-core
 * `rules::missing_default_protection` (vectors `missing_default_protection__*`).
 */
export function missingDefaultProtection(defaultBranch: string, patterns: readonly string[]): string[] {
  const allTags = patterns.some((p) => ALL_TAG_PATTERNS.includes(p))
  return defaultProtectedPatterns(defaultBranch).filter((d) => (d === ALL_TAGS_PATTERN ? !allTags : !matchesProtected(d, patterns)))
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
  // dowild is pure in (pi, ti), so memoizing it turns the star backtracking — exponential
  // in the number of `*` (`*a*a*a*a*a*a*a*b` against 40 `a`s took seconds) — into at most
  // |pattern|·|text| distinct calls. On-chain inputs are small (a pattern is at most 100 chars
  // and a ref name 255 bytes, so ~26k states) and use a dense table. Anything larger (a ref
  // name nothing bounded) uses a sparse map of only the states actually reached, rather than
  // allocating |pattern|·|text| bytes up front.
  const size = (pattern.length + 1) * (text.length + 1)
  return dowild(pattern, 0, text, 0, size <= DENSE_MEMO_MAX ? denseMemo(size) : sparseMemo())
}

/** Largest pattern × text state space memoized in a flat byte table (64 KiB). */
const DENSE_MEMO_MAX = 1 << 16

/** Memoized `dowild` results by state key: undefined when not yet computed. */
interface Memo {
  get(key: number): boolean | undefined
  set(key: number, value: boolean): void
}

function denseMemo(size: number): Memo {
  const table = new Uint8Array(size) // 0 = unknown, 1 = false, 2 = true
  return {
    get: (key) => (table[key] === 0 ? undefined : table[key] === 2),
    set: (key, value) => {
      table[key] = value ? 2 : 1
    },
  }
}

function sparseMemo(): Memo {
  const map = new Map<number, boolean>()
  return { get: (key) => map.get(key), set: (key, value) => void map.set(key, value) }
}

function dowild(p: string, pi: number, t: string, ti: number, memo: Memo): boolean {
  const key = pi * (t.length + 1) + ti
  const known = memo.get(key)
  if (known !== undefined) return known
  const result = dowildUncached(p, pi, t, ti, memo)
  memo.set(key, result)
  return result
}

function dowildUncached(p: string, pi: number, t: string, ti: number, memo: Memo): boolean {
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
        if (dowild(p, i + 1, t, j, memo)) return true
      }

      // Backtrack: let the star consume 0..N text chars, trying the rest at each stop.
      let k = j
      for (;;) {
        if (dowild(p, i, t, k, memo)) return true
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

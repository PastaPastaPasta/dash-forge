/**
 * The in-repo code search query (P1-3), GitHub code search's syntax for one repository:
 *
 *   foo bar            every term must be in the file (its content or its path), anywhere
 *   "foo bar"          an exact phrase
 *   /fo+ ba[rz]/       a regular expression (JavaScript syntax)
 *   NOT foo, -foo      the file must not contain it
 *   content:foo        only the content is searched for it, never the path
 *   path:src/net       the path contains it; with `*`, `**` or `?` a glob over the whole path
 *                      (`path:*.cpp`, `path:src/**\/*.h`), anchored at the root with a leading `/`
 *                      (`path:/src/` is everything under `src/`); `path:/regex/` a regular
 *                      expression when it holds a character no path is written with (`path:/\.rs$/`)
 *   language:cpp       the file's language (GitHub's names and common aliases: `c++`, `py`, `ts`)
 *   case:yes           match case (the default ignores it)
 *
 * A qualifier written with `-` (`-path:test`, `-language:python`) excludes. `AND` is the default
 * and is dropped; what a single repo cannot apply (`repo:`, `org:`, `OR`, `symbol:` ...) is
 * reported under the box ({@link CodeQuery.ignored}), never searched for as text, as the issue
 * list does with its qualifiers (QW-020).
 *
 * Pure: shared by the search page (to say what was ignored) and the search worker.
 */

/** One content term. */
export interface CodeTerm {
  /** `literal`: a word or a quoted phrase; `regex`: a `/…/` expression. */
  readonly kind: 'literal' | 'regex'
  readonly value: string
  /** `NOT foo` / `-foo`: the file must not contain it. */
  readonly negated: boolean
  /** `content:foo`: matched in the content only (a bare term also matches the path). */
  readonly contentOnly: boolean
}

/** A `path:` filter. */
export interface PathFilter {
  readonly kind: 'substring' | 'glob' | 'regex'
  readonly value: string
  readonly negated: boolean
}

/** A `language:` filter, as typed (resolved to a language by the matcher). */
export interface LanguageFilter {
  readonly value: string
  readonly negated: boolean
}

export interface CodeQuery {
  readonly terms: readonly CodeTerm[]
  readonly paths: readonly PathFilter[]
  readonly languages: readonly LanguageFilter[]
  readonly caseSensitive: boolean
  /** Tokens that were not applied, each with why (shown under the box). */
  readonly ignored: readonly { readonly token: string; readonly why: string }[]
  /** A regular expression that does not compile, with the engine's message. */
  readonly error: string | null
}

/** Whether a query asks for anything (a qualifier alone is a query: `path:*.md` lists files). */
export function isEmptyQuery(q: CodeQuery): boolean {
  return q.terms.every((t) => t.negated) && q.paths.length === 0 && q.languages.length === 0
}

/** Qualifiers GitHub has that a search of one repository's files cannot apply, and why. */
const NOT_APPLIED: Readonly<Record<string, string>> = {
  repo: 'this search covers this repository only',
  org: 'this search covers this repository only',
  user: 'this search covers this repository only',
  owner: 'this search covers this repository only',
  symbol: 'there is no symbol index; search the name as text',
  is: 'there is nothing to filter by here',
  size: 'not supported in this search',
  enterprise: 'this search covers this repository only',
  branch: 'pick the branch or tag with the ref switcher',
}

/**
 * One raw token. `prefix` is what came before a quoted or `/…/` value (`-`, `path:`, `-path:`):
 * only a prefix written outside the quotes is a qualifier, so `"repo:x"` is text.
 */
interface Token {
  readonly prefix: string
  readonly value: string
  readonly quoted: boolean
  readonly regex: boolean
}

/**
 * Split the query into tokens: whitespace separates; `"…"` (with `\"` and `\\` escapes) is one
 * token; `/…/` is a regular expression (spaces included, as GitHub reads `/foo bar/`) when its
 * closing `/` ends the token, else a plain word (`/usr/bin`). A qualifier's value may be quoted or
 * a regex too (`path:"a b"`, `path:/x$/`).
 */
function tokenize(text: string): { tokens: Token[]; unterminated: string | null } {
  const tokens: Token[] = []
  let i = 0
  let unterminated: string | null = null
  const plainWord = (): void => {
    let j = i
    while (j < text.length && !/\s/.test(text[j] as string)) j++
    tokens.push({ prefix: '', value: text.slice(i, j), quoted: false, regex: false })
    i = j
  }
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] as string)) i++
    if (i >= text.length) break
    const prefix = /^-?(?:[A-Za-z]+:)?/.exec(text.slice(i))?.[0] ?? ''
    const at = i + prefix.length
    const open = text[at]
    if (open !== '"' && open !== '/') {
      plainWord()
      continue
    }
    let j = at + 1
    let value = ''
    let closed = false
    while (j < text.length) {
      const c = text[j] as string
      if (c === '\\' && j + 1 < text.length) {
        // In a phrase `\"` and `\\` are the characters; in a regex every escape is kept for the engine.
        const next = text[j + 1] as string
        value += open === '"' && (next === '"' || next === '\\') ? next : c + next
        j += 2
        continue
      }
      if (c === open) {
        closed = true
        j++
        break
      }
      value += c
      j++
    }
    if (open === '/') {
      // A regex closes at a `/` that ends the token, and is not empty.
      if (!closed || value === '' || (j < text.length && !/\s/.test(text[j] as string))) {
        plainWord()
        continue
      }
      tokens.push({ prefix, value, quoted: false, regex: true })
      i = j
      continue
    }
    if (!closed) unterminated = text.slice(i)
    tokens.push({ prefix, value, quoted: true, regex: false })
    i = j
  }
  return { tokens, unterminated }
}

/** A glob's special characters. */
const GLOB = /[*?]/

/** Check a regular expression compiles; its error message otherwise. */
function regexError(source: string): string | null {
  try {
    new RegExp(source)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Parse a search box's text ({@link CodeQuery}). */
export function parseCodeQuery(text: string): CodeQuery {
  const { tokens, unterminated } = tokenize(text)
  const terms: CodeTerm[] = []
  const paths: PathFilter[] = []
  const languages: LanguageFilter[] = []
  const ignored: { token: string; why: string }[] = []
  let caseSensitive = false
  let error: string | null = unterminated !== null ? `Unclosed quote in ${unterminated}` : null
  let notNext = false
  const regexOk = (source: string, shown: string): boolean => {
    const err = regexError(source)
    if (err !== null) error ??= `${shown}: ${err}`
    return err === null
  }
  for (const tok of tokens) {
    const plain = !tok.quoted && !tok.regex
    // Bare keywords (never quoted): NOT negates the next token, AND is the default, OR is not supported.
    if (plain && tok.value === 'NOT') {
      notNext = true
      continue
    }
    if (plain && tok.value === 'AND') continue
    if (plain && tok.value === 'OR') {
      ignored.push({ token: 'OR', why: 'every term must match; OR is not supported' })
      continue
    }
    // `-` and `key:` written outside a quote or regex (a plain word carries them in its value).
    let head = tok.prefix
    let body = tok.value
    if (plain) {
      head = /^-?(?:[A-Za-z]+:(?=.))?/.exec(body)?.[0] ?? ''
      body = body.slice(head.length)
      // A lone `-` is a word, not a negation.
      if (head === '-' && body === '') {
        head = ''
        body = '-'
      }
    }
    const negated = notNext || head.startsWith('-')
    notNext = false
    const key = /([A-Za-z]+):$/.exec(head)?.[1]?.toLowerCase()
    const shown = `${head}${tok.quoted ? `"${body}"` : tok.regex ? `/${body}/` : body}`
    if (key === 'path' || key === 'file' || key === 'filename') {
      // `path:/src/` reads as a directory from the root, not the regex `src`: a regex here needs a
      // character no path is written with (`path:/^src\//`, `path:/\.rs$/`).
      if (tok.regex && /^[\w./-]+$/.test(body)) paths.push({ kind: 'substring', value: `/${body}/`, negated })
      else if (tok.regex) {
        if (regexOk(body, shown)) paths.push({ kind: 'regex', value: body, negated })
      } else if (body !== '') paths.push({ kind: plain && GLOB.test(body) ? 'glob' : 'substring', value: body, negated })
      continue
    }
    if (key === 'language' || key === 'lang') {
      if (body !== '') languages.push({ value: body, negated })
      continue
    }
    if (key === 'case') {
      caseSensitive = /^(yes|true|sensitive|on)$/i.test(body)
      continue
    }
    if (key !== undefined && key !== 'content') {
      const why = Object.prototype.hasOwnProperty.call(NOT_APPLIED, key) ? NOT_APPLIED[key] : undefined
      if (why !== undefined) {
        ignored.push({ token: shown, why })
        continue
      }
      // Any other `word:word` is text (`std::string`, `http://x`), as GitHub searches it.
      body = `${head.replace(/^-/, '')}${body}`
    }
    const contentOnly = key === 'content'
    if (tok.regex) {
      if (regexOk(body, shown)) terms.push({ kind: 'regex', value: body, negated, contentOnly })
      continue
    }
    if (body === '') continue
    terms.push({ kind: 'literal', value: body, negated, contentOnly })
  }
  return { terms, paths, languages, caseSensitive, ignored, error }
}

/** Escape `text` for use as a literal inside a regular expression. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/**
 * A `path:` glob as a regular expression over a whole path: `**` crosses directories, `*` and `?`
 * do not. A leading `/` anchors it at the root; otherwise it may start at any directory (as
 * GitHub's `path:*.ts` finds `src/a.ts`). It always runs to the end of the path.
 */
export function globRegex(glob: string, caseSensitive = false): RegExp {
  const anchored = glob.startsWith('/')
  const pattern = anchored ? glob.slice(1) : glob
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` everything below.
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]*/)*'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += escapeRegex(c)
  }
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${re}$`, caseSensitive ? '' : 'i')
}

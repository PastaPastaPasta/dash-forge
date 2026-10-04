/**
 * Code owners (P1-6): which identities own which paths, read from a repository's `CODEOWNERS`
 * file, and whom a new pull request asks for review. A client convention, the TypeScript port of
 * forge-core `rules::codeowners` (whose module docs are the spec), held in parity by the
 * `code_owners__*` and `code_owner_requests__*` vectors. Pure: no SDK, no network.
 *
 * In short: the first of {@link CODEOWNERS_PATHS} at the PR's base tip; GitHub's format (last
 * matching rule wins) and GitLab's sections (`[Name]`, `^[Name]`, `[Name][n]`, default owners;
 * each section's last match, joined); gitignore patterns with GitHub's exceptions (`docs/*` owns
 * only direct children; `[` `]` are literals); tokens `@name` (DPNS), identity ids, `@org/team`,
 * e-mail and `@@role` (only the first two can be asked); requests go to current maintainers and
 * role-1 writers only, never the author, each once, at most {@link MAX_OWNER_REQUESTS}.
 */

import { base58Decode } from '../auth/base58'
import { compareStrings } from './oid'
import type { RoleOracle } from './v2'

/** Where a code owners file is looked for, in order: the first that exists wins. */
export const CODEOWNERS_PATHS = ['.forge/CODEOWNERS', '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'] as const

/** The largest code owners file read (GitHub's limit): a larger one is ignored. */
export const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024

/** The most reviewers a new PR asks for on its code owners' behalf. */
export const MAX_OWNER_REQUESTS = 15

type Tok = { readonly lit: string } | '*' | '?'
type Seg = 'any' | 'one' | readonly Tok[]

/** One rule of a code owners file. */
export interface OwnerRule {
  /** The line it is on (1-based). */
  readonly line: number
  /** The pattern as written. */
  readonly pattern: string
  /** Its owner tokens as written (or its section's default owners), in order. */
  readonly owners: readonly string[]
  /** An index into {@link CodeOwners.sections}. */
  readonly section: number
  readonly segs: readonly Seg[]
}

/** A line that was skipped as malformed: `negation` (`!pattern`) or `pattern` (`***`). */
export interface OwnersError {
  readonly line: number
  readonly error: 'negation' | 'pattern'
}

/** A parsed code owners file. */
export interface CodeOwners {
  readonly rules: readonly OwnerRule[]
  /** Lower-cased section names; index 0 is the unnamed section before any header. */
  readonly sections: readonly string[]
  readonly errors: readonly OwnersError[]
}

const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t'

/** The owner tokens of `rest`, stopping at one that starts with `#`. */
function tokens(rest: string): string[] {
  const out: string[] = []
  for (const t of rest.split(/[ \t]/)) {
    if (t === '') continue
    if (t.startsWith('#')) break
    out.push(t)
  }
  return out
}

/** A section header: its lower-cased name and default owners, or null when `line` is not one. */
function sectionHeader(line: string): { name: string; owners: string[] } | null {
  const body = line.startsWith('^') ? line.slice(1) : line
  if (!body.startsWith('[')) return null
  const inner = body.slice(1)
  const close = inner.indexOf(']')
  if (close < 0) return null
  const name = inner.slice(0, close).replace(/^[ \t]+|[ \t]+$/g, '')
  if (name === '') return null
  let rest = inner.slice(close + 1)
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end <= 1 || !/^[0-9]+$/.test(rest.slice(1, end))) return null
    rest = rest.slice(end + 1)
  }
  if (rest !== '' && !isWs(rest[0])) return null
  return { name: name.toLowerCase(), owners: tokens(rest) }
}

/** The pattern at the start of `line` (escapes kept) and the rest of the line. */
function splitPattern(line: string): [string, string] {
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (escaped) escaped = false
    else if (c === '\\') escaped = true
    else if (isWs(c)) return [line.slice(0, i), line.slice(i)]
  }
  return [line, '']
}

/** One segment's glob tokens, by code point (`\x` a literal `x`; a trailing lone `\` itself). */
function glob(seg: string): Tok[] {
  const chars = Array.from(seg)
  const out: Tok[] = []
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string
    if (c === '\\') {
      i++
      out.push({ lit: chars[i] ?? '\\' })
    } else if (c === '*' || c === '?') out.push(c)
    else out.push({ lit: c })
  }
  return out
}

/** A pattern's segments (empty: it matches nothing, as `/` alone does). */
function compile(pattern: string): Seg[] {
  const anchored = pattern.startsWith('/')
  let p = anchored ? pattern.slice(1) : pattern
  const trailing = p.endsWith('/') && !p.endsWith('\\/')
  if (trailing) p = p.slice(0, -1)
  if (p === '') return []
  const segs: Seg[] = p.split('/').map((s) => (s === '**' ? 'any' : s === '*' ? 'one' : glob(s)))
  if (!anchored && segs.length === 1 && segs[0] !== 'any') segs.unshift('any')
  if (trailing) segs.push('any')
  return segs
}

/** Whether a segment glob matches a whole path segment (`name` as code points). */
function globMatches(toks: readonly Tok[], name: readonly string[]): boolean {
  let t = 0
  let n = 0
  let star: [number, number] | null = null
  while (n < name.length) {
    const k = toks[t]
    if (k === '*') {
      star = [t, n]
      t++
    } else if (k === '?') {
      t++
      n++
    } else if (k !== undefined && k.lit === name[n]) {
      t++
      n++
    } else if (star !== null) {
      t = star[0] + 1
      n = star[1] + 1
      star = [star[0], star[1] + 1]
    } else return false
  }
  return toks.slice(t).every((k) => k === '*')
}

function matchesFrom(segs: readonly Seg[], path: readonly string[][], i: number, j: number, memo: Map<number, boolean>): boolean {
  const key = i * (path.length + 1) + j
  const known = memo.get(key)
  if (known !== undefined) return known
  const last = i + 1 === segs.length
  const seg = segs[i]
  let got: boolean
  if (seg === undefined) got = j === path.length
  else if (seg === 'any') {
    // A trailing `**`: one or more segments (everything under); elsewhere zero or more.
    if (last) got = j < path.length
    else {
      got = false
      for (let k = j; k <= path.length && !got; k++) got = matchesFrom(segs, path, i + 1, k, memo)
    }
  } else if (j === path.length) got = false
  else if (seg === 'one') got = last ? j + 1 === path.length : matchesFrom(segs, path, i + 1, j + 1, memo)
  // Any other last segment also owns everything under a directory of that name.
  else got = globMatches(seg, path[j] as string[]) && (last || matchesFrom(segs, path, i + 1, j + 1, memo))
  memo.set(key, got)
  return got
}

/** A path split into segments of code points, as the matcher reads it. */
const pathParts = (path: string): string[][] => path.split('/').map((s) => Array.from(s))

function matchesParts(rule: Pick<OwnerRule, 'segs'>, parts: readonly string[][]): boolean {
  return rule.segs.length > 0 && matchesFrom(rule.segs, parts, 0, 0, new Map())
}

/** Whether `rule`'s pattern matches `path` (a repository path, no leading `/`). */
export function ruleMatches(rule: Pick<OwnerRule, 'segs'>, path: string): boolean {
  return matchesParts(rule, pathParts(path))
}

/** Parse a code owners file (GitHub's or GitLab's format). */
export function parseCodeOwners(text: string): CodeOwners {
  const rules: OwnerRule[] = []
  const sections: string[] = ['']
  const errors: OwnersError[] = []
  let section = 0
  let defaults: string[] = []
  // A leading byte-order mark is no part of the first line.
  const body = text.startsWith('\ufeff') ? text.slice(1) : text
  body.split('\n').forEach((raw, n) => {
    const line = (raw.endsWith('\r') ? raw.slice(0, -1) : raw).replace(/^[ \t]+|[ \t]+$/g, '')
    if (line === '' || line.startsWith('#')) return
    const header = sectionHeader(line)
    if (header !== null) {
      const at = sections.indexOf(header.name)
      section = at >= 0 ? at : sections.push(header.name) - 1
      defaults = header.owners
      return
    }
    const [pattern, rest] = splitPattern(line)
    const error = pattern.startsWith('!') ? 'negation' : pattern.includes('***') ? 'pattern' : null
    if (error !== null) {
      errors.push({ line: n + 1, error })
      return
    }
    const owners = tokens(rest)
    rules.push({ line: n + 1, pattern, owners: owners.length > 0 ? owners : [...defaults], section, segs: compile(pattern) })
  })
  return { rules, sections, errors }
}

/** The rules that decide `path`'s owners: each section's last matching rule, in section order. */
export function decidingRules(owners: CodeOwners, path: string): OwnerRule[] {
  const parts = pathParts(path)
  const found: (OwnerRule | undefined)[] = owners.sections.map(() => undefined)
  let open = found.length
  for (let r = owners.rules.length - 1; r >= 0 && open > 0; r--) {
    const rule = owners.rules[r] as OwnerRule
    if (found[rule.section] === undefined && matchesParts(rule, parts)) {
      found[rule.section] = rule
      open--
    }
  }
  return found.filter((r): r is OwnerRule => r !== undefined)
}

/** The owner tokens of `path`: each section's last matching rule's, sections in order, each once. */
export function ownersOf(owners: CodeOwners, path: string): string[] {
  const out: string[] = []
  for (const rule of decidingRules(owners, path)) for (const t of rule.owners) if (!out.includes(t)) out.push(t)
  return out
}

/** Every owner token of `paths`, each once, by first appearance over the paths in code-point order. */
export function ownersOfPaths(owners: CodeOwners, paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort(compareStrings)
  const out: string[] = []
  for (const p of sorted) for (const t of ownersOf(owners, p)) if (!out.includes(t)) out.push(t)
  return out
}

/** What an owner token names. */
export type OwnerKind = 'name' | 'identity' | 'team' | 'email' | 'role' | 'invalid'

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** Whether `s` is a base58 identity id: 32 to 44 base58 characters that decode to 32 bytes. */
export function isIdentityToken(s: string): boolean {
  if (!BASE58.test(s)) return false
  try {
    return base58Decode(s).length === 32
  } catch {
    return false
  }
}

/** Classify an owner token. */
export function ownerKind(token: string): OwnerKind {
  if (token.startsWith('@@')) return 'role'
  if (token.startsWith('@')) {
    const rest = token.slice(1)
    if (rest.includes('/')) return 'team'
    if (isIdentityToken(rest)) return 'identity'
    // `label` or `label.dash` (any case): the names both clients look up in DPNS.
    return /^[A-Za-z0-9_-]+(\.dash)?$/i.test(rest) ? 'name' : 'invalid'
  }
  if (isIdentityToken(token)) return 'identity'
  const at = token.indexOf('@')
  if (at > 0) {
    const domain = token.slice(at + 1)
    if (domain.includes('.') && !domain.includes('@')) return 'email'
  }
  return 'invalid'
}

/** The identity an identity token names, or null. */
export function tokenIdentity(token: string): string | null {
  return ownerKind(token) === 'identity' ? (token.startsWith('@') ? token.slice(1) : token) : null
}

/** Why a code owner was not asked for review (forge-core `SkipReason`). */
export type SkipReason = 'team' | 'email' | 'role' | 'invalid' | 'unresolved' | 'author' | 'notApprover' | 'duplicate' | 'cap'

export interface SkippedOwner {
  readonly token: string
  readonly reason: SkipReason
  /** The identity it resolved to, when it did. */
  readonly identity?: string
}

export interface OwnerRequests {
  /** The identities to request, in token order. */
  readonly request: readonly string[]
  readonly skipped: readonly SkippedOwner[]
}

/**
 * Pick the reviewers a new PR requests from its owner `tokens` ({@link ownersOfPaths}):
 * `resolved` maps each name token to the identity its DPNS name resolved to (absent or null:
 * unresolved); identity tokens need no entry.
 */
export function codeOwnerRequests(
  tokens: readonly string[],
  resolved: ReadonlyMap<string, string | null>,
  oracle: Pick<RoleOracle, 'currentApprover'>,
  author: string,
): OwnerRequests {
  const request: string[] = []
  const skipped: SkippedOwner[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const kind = ownerKind(token)
    if (kind === 'team' || kind === 'email' || kind === 'role' || kind === 'invalid') {
      skipped.push({ token, reason: kind })
      continue
    }
    const id = kind === 'identity' ? tokenIdentity(token) : (resolved.get(token) ?? null)
    if (id === null) {
      skipped.push({ token, reason: 'unresolved' })
      continue
    }
    const reason: SkipReason | null =
      id === author ? 'author' : seen.has(id) ? 'duplicate' : !oracle.currentApprover(id) ? 'notApprover' : request.length >= MAX_OWNER_REQUESTS ? 'cap' : null
    if (reason !== null) skipped.push({ token, reason, identity: id })
    else {
      seen.add(id)
      request.push(id)
    }
  }
  return { request, skipped }
}

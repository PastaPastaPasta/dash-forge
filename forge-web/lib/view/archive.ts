/**
 * What `git archive` does to a tree besides copying its files (QW-026), for the browser's .zip:
 *
 * - `.gitattributes` of the tree archived (never the viewer's): `export-ignore` leaves a path out,
 *   `export-subst` expands `$Format:…$` in a file ({@link expandExportSubst});
 * - the placeholders `git log --format` takes (the ones a commit alone answers), `%(describe)`
 *   included, computed as `git describe` does ({@link describeCommit});
 * - each entry's Unix mode and the commit's time, which the zip writer records.
 *
 * `.gitattributes` patterns are matched as git's attr.c matches them: a pattern with no `/` is
 * matched against the basename, one with a `/` against the path from its file's directory with
 * `*` not crossing `/` and `**` crossing any number of directories. Later lines, and files deeper
 * in the tree, win.
 */

import { OID_HEX, parseTag } from './git-objects'
import type { ObjectReader } from './tree-nav'
import { mapPooled } from './pool'

// ---------------------------------------------------------------------------
// .gitattributes
// ---------------------------------------------------------------------------

/** One `.gitattributes` line, reduced to the attributes an archive reads. */
interface AttrRule {
  readonly match: (path: string, isDir: boolean) => boolean
  /** true: set; false: unset (`-attr` or `!attr`); absent: this line says nothing. */
  readonly attrs: ReadonlyMap<'export-ignore' | 'export-subst', boolean>
}

/** A git wildmatch pattern (`WM_PATHNAME`) as a regular expression over a whole path. */
function wildmatchRegex(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` at the start or after `/` matches any number of directories; a trailing `/**` everything below.
        const atStart = i === 0 || pattern[i - 1] === '/'
        if (atStart && pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
          continue
        }
        if (atStart && i + 2 === pattern.length) {
          re += '.*'
          i += 1
          continue
        }
        re += '[^/]*'
        i += 1
        continue
      }
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 2)
      if (close === -1) {
        re += '\\['
        continue
      }
      let body = pattern.slice(i + 1, close)
      const negate = body.startsWith('!') || body.startsWith('^')
      if (negate) body = body.slice(1)
      re += `[${negate ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/]/g, '\\]')}]`
      i = close
    } else if (c === '\\' && i + 1 < pattern.length) {
      re += (pattern[i + 1] as string).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      i += 1
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * A `.gitattributes` pattern, from its file's directory (`''` = the root), as attr.c's
 * `path_matches`: a trailing `/` makes it match directories only (git archive checks a directory
 * as `dir/`), a pattern with no other `/` is matched against the basename, else against the path
 * from the file's directory.
 */
function patternMatcher(pattern: string, dir: string): ((path: string, isDir: boolean) => boolean) | null {
  if (pattern === '' || pattern.startsWith('!')) return null
  const dirOnly = pattern.endsWith('/')
  const body = dirOnly ? pattern.replace(/\/+$/, '') : pattern
  if (body === '') return null
  const anchored = body.includes('/')
  const re = wildmatchRegex(anchored ? body.replace(/^\//, '') : body)
  const prefix = dir === '' ? '' : `${dir}/`
  return (path, isDir) => {
    if ((dirOnly && !isDir) || !path.startsWith(prefix)) return false
    const rel = path.slice(prefix.length)
    return re.test(anchored ? rel : rel.slice(rel.lastIndexOf('/') + 1))
  }
}

/** The pattern of a line, unquoting a C-style quoted one. */
function splitLine(line: string): [string, string] {
  if (!line.startsWith('"')) {
    const at = line.search(/\s/)
    return at === -1 ? [line, ''] : [line.slice(0, at), line.slice(at)]
  }
  let out = ''
  let i = 1
  for (; i < line.length && line[i] !== '"'; i++) {
    if (line[i] === '\\' && i + 1 < line.length) {
      const n = line[++i] as string
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n
    } else out += line[i]
  }
  return [out, line.slice(i + 1)]
}

/** The archive-relevant rules of one `.gitattributes` file at `dir`. */
export function parseGitAttributes(text: string, dir: string): AttrRule[] {
  const rules: AttrRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [pattern, rest] = splitLine(line)
    const attrs = new Map<'export-ignore' | 'export-subst', boolean>()
    for (const word of rest.trim().split(/\s+/)) {
      const unset = word.startsWith('-') || word.startsWith('!')
      const name = (unset ? word.slice(1) : word).split('=')[0]
      if (name === 'export-ignore' || name === 'export-subst') attrs.set(name, !unset)
    }
    if (attrs.size === 0) continue
    const match = patternMatcher(pattern, dir)
    if (match !== null) rules.push({ match, attrs })
  }
  return rules
}

/** How the archive treats a path. */
export interface ExportAttrs {
  readonly ignore: boolean
  readonly subst: boolean
}

/**
 * The archive's attributes from every `.gitattributes` of the tree: `files` maps each one's path
 * to its text. A path is ignored when it, or a directory above it, is `export-ignore`.
 */
export function exportAttributes(files: ReadonlyMap<string, string>): (path: string) => ExportAttrs {
  // Root first, then deeper: a deeper file's lines come later, so they win.
  const ordered = [...files.keys()].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
  const rules = ordered.flatMap((p) => {
    const slash = p.lastIndexOf('/')
    return parseGitAttributes(files.get(p) as string, slash === -1 ? '' : p.slice(0, slash))
  })
  const attr = (path: string, isDir: boolean, name: 'export-ignore' | 'export-subst'): boolean => {
    let value = false
    for (const r of rules) {
      const v = r.attrs.get(name)
      if (v !== undefined && r.match(path, isDir)) value = v
    }
    return value
  }
  return (path) => {
    // A directory left out leaves out everything under it (git archive does not descend into it).
    let ignore = false
    for (let at = path.indexOf('/'); !ignore && at !== -1; at = path.indexOf('/', at + 1)) ignore = attr(path.slice(0, at), true, 'export-ignore')
    ignore ||= attr(path, false, 'export-ignore')
    return { ignore, subst: !ignore && attr(path, false, 'export-subst') }
  }
}

// ---------------------------------------------------------------------------
// The commit, as `--format` sees it
// ---------------------------------------------------------------------------

/** An author or committer line, with the time zone the pretty dates are printed in. */
export interface Person {
  readonly name: string
  readonly email: string
  /** Seconds since the epoch. */
  readonly time: number
  /** The zone as written (`+0200`), and its offset in minutes. */
  readonly tz: string
  readonly offset: number
}

/** A commit as `$Format:` expands it. */
export interface ArchiveCommit {
  readonly oid: string
  readonly tree: string
  readonly parents: readonly string[]
  readonly author: Person
  readonly committer: Person
  readonly message: string
}

function parsePerson(value: string): Person {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(value.trim())
  if (m === null) return { name: value.trim(), email: '', time: 0, tz: '+0000', offset: 0 }
  const tz = m[4] as string
  const sign = tz.startsWith('-') ? -1 : 1
  const offset = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)))
  return { name: m[1] as string, email: m[2] as string, time: Number(m[3]), tz, offset }
}

/** Parse a commit object's bytes, keeping what `--format` prints. */
export function parseArchiveCommit(oid: string, bytes: Uint8Array): ArchiveCommit {
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes)
  const sep = text.indexOf('\n\n')
  const lines = (sep === -1 ? text : text.slice(0, sep)).split('\n')
  const field = (key: string): string => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1) ?? ''
  return {
    oid,
    tree: field('tree'),
    parents: lines.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7)),
    author: parsePerson(field('author')),
    committer: parsePerson(field('committer')),
    message: sep === -1 ? '' : text.slice(sep + 2),
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** A person's time in their own zone, as git prints each date format. */
function dateOf(p: Person, format: 'default' | 'rfc' | 'iso' | 'strict' | 'short'): string {
  const d = new Date((p.time + p.offset * 60) * 1000)
  const Y = d.getUTCFullYear()
  const M = d.getUTCMonth()
  const D = d.getUTCDate()
  const hms = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  switch (format) {
    case 'default':
      return `${DAYS[d.getUTCDay()]} ${MONTHS[M]} ${D} ${hms} ${Y} ${p.tz}`
    case 'rfc':
      return `${DAYS[d.getUTCDay()]}, ${D} ${MONTHS[M]} ${Y} ${hms} ${p.tz}`
    case 'iso':
      return `${Y}-${pad(M + 1)}-${pad(D)} ${hms} ${p.tz}`
    case 'strict': {
      const zone = p.offset === 0 ? 'Z' : `${p.tz.slice(0, 3)}:${p.tz.slice(3)}`
      return `${Y}-${pad(M + 1)}-${pad(D)}T${hms}${zone}`
    }
    case 'short':
      return `${Y}-${pad(M + 1)}-${pad(D)}`
  }
}

/** The message's subject (its first paragraph, lines joined by spaces) and body. */
function subjectAndBody(message: string): { subject: string; body: string } {
  const lines = message.split('\n')
  let i = 0
  while (i < lines.length && (lines[i] as string).trim() === '') i++
  const subject: string[] = []
  for (; i < lines.length && (lines[i] as string).trim() !== ''; i++) subject.push((lines[i] as string).trim())
  while (i < lines.length && (lines[i] as string).trim() === '') i++
  return { subject: subject.join(' '), body: lines.slice(i).join('\n') }
}

/** What `$Format:` placeholders need besides the commit. */
export interface FormatContext {
  readonly commit: ArchiveCommit
  /** An oid's shortest unique abbreviation of at least `min` digits (`%h`, and `%(describe)`'s suffix). */
  readonly abbrev: (oid: string, min?: number) => string
  /**
   * `%(describe…)` by its option text (`abbrev=12`, `''` for none): the expansion (`''` when no
   * tag describes the commit, as git's is then empty), or null to leave the placeholder as
   * written (git archive expands one `%(describe)` per archive: the ones after it stay).
   */
  readonly describe: (spec: string) => string | null
  /** The refs pointing at the commit, as `%D` prints them (`tag: v1`, `main`). */
  readonly decorations: readonly string[]
}

/** `%(describe)`'s options. */
export interface DescribeOptions {
  readonly tags: boolean
  readonly abbrev: number | null
  readonly match: readonly string[]
  readonly exclude: readonly string[]
}

/** Parse `%(describe:opt,opt=…)`'s option list; null when an option is not one git knows. */
export function parseDescribeOptions(spec: string): DescribeOptions | null {
  const out = { tags: false, abbrev: null as number | null, match: [] as string[], exclude: [] as string[] }
  if (spec === '') return out
  for (const opt of spec.split(',')) {
    const [key, value] = [opt.split('=')[0] as string, opt.includes('=') ? opt.slice(opt.indexOf('=') + 1) : null]
    if (key === 'tags') out.tags = value === null || !/^(false|no|off|0)$/i.test(value)
    else if (key === 'abbrev' && value !== null && /^\d+$/.test(value)) out.abbrev = Number(value)
    else if (key === 'match' && value !== null) out.match.push(value)
    else if (key === 'exclude' && value !== null) out.exclude.push(value)
    else return null
  }
  return out
}

/**
 * Expand a pretty format (`git log --format=<fmt>`) for one commit: the placeholders a commit
 * alone answers. One git would print from a mailmap, a reflog, notes or GPG checks, and anything
 * unknown, is left as written, as git leaves an unknown `%` sequence.
 */
export function formatCommit(fmt: string, ctx: FormatContext): string {
  const { commit } = ctx
  const { subject, body } = subjectAndBody(commit.message)
  const person = (who: 'a' | 'c', key: string): string | null => {
    const p = who === 'a' ? commit.author : commit.committer
    switch (key) {
      case 'n':
      case 'N':
        return p.name
      case 'e':
      case 'E':
        return p.email
      case 'l':
      case 'L':
        return p.email.split('@')[0] ?? ''
      case 'd':
        return dateOf(p, 'default')
      case 'D':
        return dateOf(p, 'rfc')
      case 'i':
        return dateOf(p, 'iso')
      case 'I':
        return dateOf(p, 'strict')
      case 's':
        return dateOf(p, 'short')
      case 't':
        return String(p.time)
      default:
        return null
    }
  }
  let out = ''
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i] as string
    if (c !== '%' || i + 1 >= fmt.length) {
      out += c
      continue
    }
    const n = fmt[i + 1] as string
    let value: string | null = null
    let used = 2
    if (n === '(') {
      const close = fmt.indexOf(')', i + 2)
      const inner = close === -1 ? null : fmt.slice(i + 2, close)
      if (inner !== null && (inner === 'describe' || inner.startsWith('describe:'))) {
        value = ctx.describe(inner === 'describe' ? '' : inner.slice('describe:'.length))
        used = close - i + 1
      }
    } else if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(fmt.slice(i + 2, i + 4))) {
      value = String.fromCharCode(parseInt(fmt.slice(i + 2, i + 4), 16))
      used = 4
    } else if ((n === 'a' || n === 'c') && i + 2 < fmt.length) {
      value = person(n, fmt[i + 2] as string)
      used = 3
    } else {
      const decorated = ctx.decorations.join(', ')
      const simple: Record<string, string> = {
        H: commit.oid,
        h: ctx.abbrev(commit.oid),
        T: commit.tree,
        t: ctx.abbrev(commit.tree),
        P: commit.parents.join(' '),
        p: commit.parents.map((p) => ctx.abbrev(p)).join(' '),
        s: subject,
        f: subject.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^[-.]+|[-.]+$/g, ''),
        b: body,
        B: commit.message,
        n: '\n',
        '%': '%',
        D: decorated,
        d: decorated === '' ? '' : ` (${decorated})`,
      }
      value = simple[n] ?? null
    }
    if (value === null) {
      out += c
      continue
    }
    out += value
    i += used - 1
  }
  return out
}

/**
 * `export-subst` (gitattributes(5)): each `$Format:<fmt>$` in the file replaced by the commit's
 * `<fmt>` expansion. The format runs to the next `$`.
 */
export function expandExportSubst(text: string, ctx: FormatContext): string {
  return text.replace(/\$Format:([^$]*)\$/g, (_, fmt: string) => formatCommit(fmt, ctx))
}

/**
 * The fewest digits (at least 4) that name `oid` alone, through an index read on demand: every
 * longer prefix is unique too, so `oid`'s abbreviation of at least `min` digits is its first
 * `max(min, this)` ({@link uniqueAbbrev}, worked out ahead of a synchronous expansion).
 */
export async function uniqueAbbrevLength(oid: string, findByPrefix: (prefix: string, limit?: number) => Promise<string[]>): Promise<number> {
  let len = 4
  while (len < oid.length && (await findByPrefix(oid.slice(0, len), 2)).length > 1) len++
  return len
}

/** The shortest unique abbreviation of `oid` of at least `min` digits, as git finds one. */
export function uniqueAbbrev(oid: string, min: number, findByPrefix?: (prefix: string, limit?: number) => string[]): string {
  let len = Math.max(4, min)
  if (findByPrefix === undefined) return oid.slice(0, len)
  while (len < oid.length && findByPrefix(oid.slice(0, len), 2).length > 1) len++
  return oid.slice(0, len)
}

/** git's automatic abbreviation for a repository of `objects` objects (`core.abbrev` unset): at least 7. */
export function autoAbbrevLength(objects: number): number {
  if (!(objects > 0)) return 7
  const msb = Math.floor(Math.log2(objects))
  return Math.max(7, Math.floor((msb + 1 + 1) / 2))
}

// ---------------------------------------------------------------------------
// git describe
// ---------------------------------------------------------------------------

/** A tag `git describe` may name: its short name, and what it points at. */
export interface DescribeTag {
  readonly name: string
  /** The tag ref's object: an annotated tag object, or the commit a lightweight tag names. */
  readonly oid: string
}

/** A tag peeled to its commit, as `git describe` knows it (builtin/describe.c `commit_name`). */
export interface PeeledTag {
  /** The ref's short name (`v1.0` for `refs/tags/v1.0`). */
  readonly ref: string
  readonly commit: string
  /** 2 annotated, 1 lightweight (git's `prio`). */
  readonly prio: 1 | 2
  /** The outermost tag object's tagger time (s), 0 for a lightweight tag. */
  readonly date: number
  /** What describe prints: the tag object's own name for an annotated tag, else the ref's. */
  readonly display: string
}

/** Commits {@link describeCommit} walks at most before it gives up. */
export const DESCRIBE_COMMIT_CAP = 100_000
/** git describe's `--candidates` default. */
const MAX_CANDIDATES = 10
/** Tag objects are read this many at a time. */
const TAG_READ_POOL = 16

/** A shell glob (`match=`, `exclude=`) as git's `wildmatch` without `WM_PATHNAME`. */
function globRegex(glob: string): RegExp {
  return new RegExp(`^${wildmatchRegex(glob).source.slice(1, -1).replace(/\[\^\/\]\*/g, '.*').replace(/\[\^\/\]/g, '.')}$`)
}

/**
 * Every tag peeled to the commit it names (a tag of a tree or a blob is left out, as describe
 * leaves it), in ref-name order. The tag objects are read side by side.
 */
export async function peelTags(reader: ObjectReader, tags: readonly DescribeTag[], signal?: AbortSignal): Promise<PeeledTag[]> {
  const sorted = [...tags].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const peeled = await mapPooled(sorted, TAG_READ_POOL, async (t): Promise<PeeledTag | null> => {
    signal?.throwIfAborted()
    let at = t.oid
    let prio: 1 | 2 = 1
    let date = 0
    let display = t.name
    for (let depth = 0; depth < 10; depth++) {
      const obj = await reader.readObject(at)
      if (obj.type !== 'tag') return obj.type === 'commit' ? { ref: t.name, commit: at, prio, date, display } : null
      const tag = parseTag(obj.bytes)
      if (tag === null || !OID_HEX.test(tag.object)) return null
      if (depth === 0) {
        prio = 2
        display = tag.tag || t.name
        const tagger = /\ntagger .* (\d+) [+-]\d{4}\n/.exec(`\n${new TextDecoder().decode(obj.bytes)}`)
        date = tagger === null ? 0 : Number(tagger[1])
      }
      at = tag.object
    }
    return null
  })
  return peeled.filter((t): t is PeeledTag => t !== null)
}

/**
 * The name `git describe` gives each tagged commit (its `names` map): the tags that pass `match`
 * and `exclude`, taken in ref-name order, an annotated tag over a lightweight one and, of two
 * annotated ones, the newer tagger date; otherwise the first stays (describe.c `replace_name`).
 */
export function describeNames(peeled: readonly PeeledTag[], options: Pick<DescribeOptions, 'match' | 'exclude'>): Map<string, PeeledTag> {
  const match = options.match.map(globRegex)
  const exclude = options.exclude.map(globRegex)
  const named = new Map<string, PeeledTag>()
  for (const t of peeled) {
    if ((match.length > 0 && !match.some((r) => r.test(t.ref))) || exclude.some((r) => r.test(t.ref))) continue
    const had = named.get(t.commit)
    if (had === undefined || had.prio < t.prio || (had.prio === 2 && t.prio === 2 && had.date < t.date)) named.set(t.commit, t)
  }
  return named
}

/** The description could not be worked out (the history is past its bound). */
export class DescribeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DescribeError'
  }
}

/**
 * `git describe [--tags] [--abbrev=<n>] <commit>` (builtin/describe.c `describe_commit`): the
 * nearest tag by the number of commits it does not contain, with `-<n>-g<abbrev>` after it unless
 * it names the commit itself (`abbrev` 0: the tag alone). Only annotated tags count unless `tags`.
 * The walk is git's: newest first, up to 10 candidates (or every tag there is), stopping early
 * when the last path is covered, then the best candidate's depth finished. `abbrevOf(oid, min)`
 * gives an oid's unique abbreviation (`min` undefined: git's automatic length). Null when no tag
 * describes the commit (git then fails, and `%(describe)` is empty).
 */
export async function describeCommit(
  reader: ObjectReader,
  commitOid: string,
  named: ReadonlyMap<string, PeeledTag>,
  options: Pick<DescribeOptions, 'tags' | 'abbrev'>,
  abbrevOf: (oid: string, min?: number) => string,
  { signal, cap = DESCRIBE_COMMIT_CAP }: { readonly signal?: AbortSignal; readonly cap?: number } = {},
): Promise<string | null> {
  const suffix = (depth: number): string => `-${depth}-g${abbrevOf(commitOid, options.abbrev ?? undefined)}`
  const exact = named.get(commitOid)
  if (exact !== undefined && (options.tags || exact.prio === 2)) {
    const misnamed = exact.prio === 2 && exact.display !== exact.ref
    return misnamed ? `${exact.display}${suffix(0)}` : exact.display
  }

  interface Node {
    readonly when: number
    readonly parents: readonly string[]
    flags: number
  }
  const SEEN = 1
  const nodes = new Map<string, Node>()
  const load = async (oid: string): Promise<Node> => {
    const known = nodes.get(oid)
    if (known !== undefined) return known
    signal?.throwIfAborted()
    if (nodes.size >= cap) throw new DescribeError(`gave up after ${cap} commits`)
    const obj = await reader.readObject(oid)
    if (obj.type !== 'commit') throw new DescribeError(`${oid.slice(0, 12)} is not a commit`)
    const c = parseArchiveCommit(oid, obj.bytes)
    const node: Node = { when: c.committer.time, parents: c.parents, flags: 0 }
    nodes.set(oid, node)
    return node
  }
  // git's prio_queue by commit date, newest first; ties in insertion order.
  const queue: { oid: string; when: number; seq: number }[] = []
  let seq = 0
  const put = (oid: string): void => {
    queue.push({ oid, when: (nodes.get(oid) as Node).when, seq: seq++ })
  }
  const get = (): string => {
    let best = 0
    for (let i = 1; i < queue.length; i++) {
      const q = queue[i] as (typeof queue)[number]
      const b = queue[best] as (typeof queue)[number]
      if (q.when > b.when || (q.when === b.when && q.seq < b.seq)) best = i
    }
    return (queue.splice(best, 1)[0] as (typeof queue)[number]).oid
  }
  const flagsOf = (oid: string): number => (nodes.get(oid) as Node).flags
  /** Queue `c`'s unseen parents and pass them its flags; `onParent` sees each (was it seen, its flags before). */
  const visitParents = async (c: Node, onParent?: (oid: string, seen: boolean, before: number) => void): Promise<void> => {
    const parents = await Promise.all(c.parents.map(load))
    parents.forEach((p, i) => {
      const oid = c.parents[i] as string
      const seen = (p.flags & SEEN) !== 0
      if (!seen) put(oid)
      const before = p.flags
      p.flags |= c.flags
      onParent?.(oid, seen, before)
    })
  }

  const matches: { name: string; depth: number; flag: number; order: number }[] = []
  let annotated = 0
  let gaveUpOn: string | null = null
  let seen = 0
  ;(await load(commitOid)).flags = SEEN
  put(commitOid)
  while (queue.length > 0) {
    const oid = get()
    const c = nodes.get(oid) as Node
    seen++
    if (matches.length === MAX_CANDIDATES || matches.length === named.size) {
      gaveUpOn = oid
      break
    }
    const n = named.get(oid)
    if (n !== undefined && (options.tags || n.prio === 2)) {
      const flag = 1 << (matches.length + 1)
      matches.push({ name: n.display, depth: seen - 1, flag, order: matches.length + 1 })
      c.flags |= flag
      if (n.prio === 2) annotated++
    }
    for (const m of matches) if ((c.flags & m.flag) === 0) m.depth++
    // Stop if the last remaining path is already covered by the best candidate(s).
    if (annotated > 0 && queue.length === 0) {
      let bestDepth = Infinity
      let bestWithin = 0
      for (const m of matches) {
        if (m.depth < bestDepth) {
          bestDepth = m.depth
          bestWithin = m.flag
        } else if (m.depth === bestDepth) bestWithin |= m.flag
      }
      if ((c.flags & bestWithin) === bestWithin) break
    }
    await visitParents(c)
  }
  if (matches.length === 0) return null
  matches.sort((a, b) => a.depth - b.depth || a.order - b.order)
  const best = matches[0] as (typeof matches)[number]
  if (gaveUpOn !== null) put(gaveUpOn)
  // finish_depth_computation: on until no queued commit is outside the best candidate.
  const unflagged = new Set(queue.filter((q) => (flagsOf(q.oid) & best.flag) === 0).map((q) => q.oid))
  while (queue.length > 0) {
    const oid = get()
    const c = nodes.get(oid) as Node
    if ((c.flags & best.flag) !== 0) {
      if (unflagged.size === 0) break
    } else {
      unflagged.delete(oid)
      best.depth++
    }
    await visitParents(c, (p, wasSeen, before) => {
      const after = flagsOf(p) & best.flag
      if (!wasSeen && after === 0) unflagged.add(p)
      if (wasSeen && (before & best.flag) === 0 && after !== 0) unflagged.delete(p)
    })
  }
  return options.abbrev === 0 ? best.name : `${best.name}${suffix(best.depth)}`
}

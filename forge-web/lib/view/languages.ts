/**
 * Language stats (F-5): the repo's languages by size, from file names and the sizes the object
 * locator already knows (the stored, compressed size of each blob: no blob is read), over a bounded
 * walk of the tree — like GitHub's language bar, which counts bytes by linguist's extension map and
 * skips vendored, generated and documentation files.
 *
 * The walk is bounded ({@link LANGUAGE_WALK_TREES} trees, {@link LANGUAGE_WALK_FILES} files) and shared with Go to file; when a
 * bound stops it, the result says how much it covered. Sizes are stored sizes, so the bar is an
 * approximation and says so.
 */

import { MODE_GITLINK, MODE_TREE } from '../browse'
import { readTree, type ObjectReader } from './tree-nav'
import { isSafeName } from './zip'

/** Trees and files the walk reads at most (the approved budget: tree reads only, no blobs). */
export const LANGUAGE_WALK_TREES = 300
export const LANGUAGE_WALK_FILES = 5000

/** A language: its name and the colour GitHub gives it (linguist's languages.yml). */
export interface Language {
  readonly name: string
  readonly color: string
}

const L = (name: string, color: string): Language => ({ name, color })
const RUST = L('Rust', '#dea584')
const GO = L('Go', '#00ADD8')
const C = L('C', '#555555')
const CPP = L('C++', '#f34b7d')
const TS = L('TypeScript', '#3178c6')
const JS = L('JavaScript', '#f1e05a')
const PY = L('Python', '#3572A5')
const SHELL = L('Shell', '#89e051')

/** Extension (lowercase, without the dot) → language. Programming languages and markup that count on GitHub. */
const BY_EXTENSION: Readonly<Record<string, Language>> = {
  rs: RUST,
  go: GO,
  c: C,
  h: C,
  cc: CPP,
  cpp: CPP,
  cxx: CPP,
  hpp: CPP,
  hh: CPP,
  hxx: CPP,
  ts: TS,
  tsx: TS,
  mts: TS,
  cts: TS,
  js: JS,
  jsx: JS,
  mjs: JS,
  cjs: JS,
  py: PY,
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  fish: L('Fish', '#4aae47'),
  rb: L('Ruby', '#701516'),
  java: L('Java', '#b07219'),
  kt: L('Kotlin', '#A97BFF'),
  kts: L('Kotlin', '#A97BFF'),
  swift: L('Swift', '#F05138'),
  m: L('Objective-C', '#438eff'),
  mm: L('Objective-C++', '#6866fb'),
  cs: L('C#', '#178600'),
  php: L('PHP', '#4F5D95'),
  lua: L('Lua', '#000080'),
  pl: L('Perl', '#0298c3'),
  pm: L('Perl', '#0298c3'),
  hs: L('Haskell', '#5e5086'),
  ml: L('OCaml', '#ef7a08'),
  ex: L('Elixir', '#6e4a7e'),
  exs: L('Elixir', '#6e4a7e'),
  erl: L('Erlang', '#B83998'),
  scala: L('Scala', '#c22d40'),
  clj: L('Clojure', '#db5855'),
  dart: L('Dart', '#00B4AB'),
  zig: L('Zig', '#ec915c'),
  nim: L('Nim', '#ffc200'),
  vim: L('Vim Script', '#199f4b'),
  ps1: L('PowerShell', '#012456'),
  html: L('HTML', '#e34c26'),
  htm: L('HTML', '#e34c26'),
  css: L('CSS', '#663399'),
  scss: L('SCSS', '#c6538c'),
  vue: L('Vue', '#41b883'),
  svelte: L('Svelte', '#ff3e00'),
  sql: L('SQL', '#e38c00'),
  r: L('R', '#198CE7'),
  jl: L('Julia', '#a270ba'),
  asm: L('Assembly', '#6E4C13'),
  s: L('Assembly', '#6E4C13'),
  cmake: L('CMake', '#DA3434'),
  mk: L('Makefile', '#427819'),
  y: L('Yacc', '#4B6C4B'),
  l: L('Lex', '#DBCA00'),
  jq: L('jq', '#c7254e'),
  nix: L('Nix', '#7e7eff'),
  dockerfile: L('Dockerfile', '#384d54'),
  m4: L('M4', '#cccccc'),
  awk: L('Awk', '#c30e9b'),
  tex: L('TeX', '#3D6117'),
  roff: L('Roff', '#ecdebe'),
}

/** Whole file names (lowercase) with a language of their own. */
const BY_NAME: Readonly<Record<string, Language>> = {
  makefile: L('Makefile', '#427819'),
  gnumakefile: L('Makefile', '#427819'),
  dockerfile: L('Dockerfile', '#384d54'),
  'cmakelists.txt': L('CMake', '#DA3434'),
  'configure.ac': L('M4', '#cccccc'),
}

/**
 * Paths linguist leaves out of the bar (its vendor.yml and documentation.yml, the common cases):
 * vendored code, dependencies, generated and minified files, and documentation.
 */
const EXCLUDED = /(^|\/)(vendor|vendored|third[-_]party|thirdparty|node_modules|bower_components|deps|external|dist|build)\/|(^|\/)(docs?|documentation|examples?|samples?)\/|\.min\.(js|css)$|(^|\/)\.[^/]+$/i

/** The language of a file path, or null (not a language, or excluded from the bar). */
export function languageOf(path: string): Language | null {
  if (EXCLUDED.test(path)) return null
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const byName = BY_NAME[name]
  if (byName !== undefined) return byName
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return BY_EXTENSION[name.slice(dot + 1)] ?? null
}

/** One language's share. */
export interface LanguageShare extends Language {
  readonly bytes: number
  /** Percentage of the counted bytes (one decimal). */
  readonly percent: number
}

export interface LanguageStats {
  readonly languages: readonly LanguageShare[]
  /** Files the walk saw (every kind) and trees it read. */
  readonly files: number
  readonly trees: number
  /** A bound stopped the walk: the shares cover the first `files` files only. */
  readonly truncated: boolean
}

/** Shares from `(path, bytes)` pairs: grouped by language, largest first; languages under 0.1% fold into "Other". */
export function languageShares(files: Iterable<readonly [path: string, bytes: number]>): LanguageShare[] {
  const totals = new Map<string, { lang: Language; bytes: number }>()
  let sum = 0
  for (const [path, bytes] of files) {
    const lang = languageOf(path)
    if (lang === null || bytes <= 0) continue
    const t = totals.get(lang.name) ?? { lang, bytes: 0 }
    t.bytes += bytes
    totals.set(lang.name, t)
    sum += bytes
  }
  if (sum === 0) return []
  const sorted = [...totals.values()].sort((a, b) => b.bytes - a.bytes || a.lang.name.localeCompare(b.lang.name))
  const out: LanguageShare[] = []
  let other = 0
  for (const t of sorted) {
    const percent = (t.bytes / sum) * 100
    if (percent < 0.1) other += t.bytes
    else out.push({ ...t.lang, bytes: t.bytes, percent: Math.round(percent * 10) / 10 })
  }
  if (other > 0) out.push({ name: 'Other', color: '#ededed', bytes: other, percent: Math.round((other / sum) * 1000) / 10 })
  return out
}

/** A file the walk found, with its stored size (the locator's; 0 when it cannot tell). */
export interface WalkedFile {
  readonly path: string
  readonly oid: string
  readonly mode: number
  readonly size: number
}

/** The repo's files at a commit, as far as the bounded walk went. */
export interface RepoFiles {
  readonly files: readonly WalkedFile[]
  readonly trees: number
  /** A bound stopped the walk before every tree was read. */
  readonly truncated: boolean
}

/**
 * Every file under `rootTree` (gitlinks and unsafe names skipped), breadth first, up to the
 * bounds, with its stored size from the locator: tree reads only, no blob is ever read. Go to file
 * and the language bar share one walk per commit (`repoFilesWalk` in `repo-facts.ts`).
 */
export async function walkRepoFiles(
  reader: ObjectReader,
  rootTree: string,
  { maxTrees = LANGUAGE_WALK_TREES, maxFiles = LANGUAGE_WALK_FILES }: { readonly maxTrees?: number; readonly maxFiles?: number } = {},
): Promise<RepoFiles> {
  const files: WalkedFile[] = []
  const queue: [string, string][] = [[rootTree, '']]
  let trees = 0
  while (queue.length > 0 && trees < maxTrees && files.length < maxFiles) {
    const [oid, prefix] = queue.shift() as [string, string]
    trees += 1
    for (const e of await readTree(reader, oid)) {
      // A tree is hash-checked, not sane: a hostile pusher can name an entry `..`.
      if (!isSafeName(e.name)) continue
      const path = prefix ? `${prefix}/${e.name}` : e.name
      if (e.mode === MODE_TREE) queue.push([e.oid, path])
      else if (e.mode !== MODE_GITLINK && files.length < maxFiles) files.push({ path, oid: e.oid, mode: e.mode, size: reader.locate?.(e.oid)?.length ?? 0 })
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  return { files, trees, truncated: queue.length > 0 }
}

/** The language bar of a walk. */
export function languageStats(walk: RepoFiles): LanguageStats {
  return {
    languages: languageShares(walk.files.map((f) => [f.path, f.size] as const)),
    files: walk.files.length,
    trees: walk.trees,
    truncated: walk.truncated,
  }
}

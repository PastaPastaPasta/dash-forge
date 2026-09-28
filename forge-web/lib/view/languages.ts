/**
 * Language stats (F-5): the repo's languages by size, from file names and the sizes the object
 * locator already knows (the stored, compressed size of each blob: no blob is read), over a bounded
 * walk of the tree — like GitHub's language bar, which counts bytes by linguist's extension map and
 * skips vendored, generated and documentation files.
 *
 * The walk (`walkFiles` in `zip.ts`) is bounded (`FILE_WALK_TREES` trees, `FILE_WALK_FILES` files) and shared with Go to file; when a
 * bound stops it, the result says how much it covered. Sizes are stored sizes, so the bar is an
 * approximation and says so.
 */

import type { FileWalk } from './zip'


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
const KOTLIN = L('Kotlin', '#A97BFF')
const PERL = L('Perl', '#0298c3')
const ELIXIR = L('Elixir', '#6e4a7e')
const HTML = L('HTML', '#e34c26')
const ASM = L('Assembly', '#6E4C13')
const CMAKE = L('CMake', '#DA3434')
const MAKEFILE = L('Makefile', '#427819')
const DOCKERFILE = L('Dockerfile', '#384d54')
const M4 = L('M4', '#cccccc')

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
  kt: KOTLIN,
  kts: KOTLIN,
  swift: L('Swift', '#F05138'),
  m: L('Objective-C', '#438eff'),
  mm: L('Objective-C++', '#6866fb'),
  cs: L('C#', '#178600'),
  php: L('PHP', '#4F5D95'),
  lua: L('Lua', '#000080'),
  pl: PERL,
  pm: PERL,
  hs: L('Haskell', '#5e5086'),
  ml: L('OCaml', '#ef7a08'),
  ex: ELIXIR,
  exs: ELIXIR,
  erl: L('Erlang', '#B83998'),
  scala: L('Scala', '#c22d40'),
  clj: L('Clojure', '#db5855'),
  dart: L('Dart', '#00B4AB'),
  zig: L('Zig', '#ec915c'),
  nim: L('Nim', '#ffc200'),
  vim: L('Vim Script', '#199f4b'),
  ps1: L('PowerShell', '#012456'),
  html: HTML,
  htm: HTML,
  css: L('CSS', '#663399'),
  scss: L('SCSS', '#c6538c'),
  vue: L('Vue', '#41b883'),
  svelte: L('Svelte', '#ff3e00'),
  sql: L('SQL', '#e38c00'),
  r: L('R', '#198CE7'),
  jl: L('Julia', '#a270ba'),
  asm: ASM,
  s: ASM,
  cmake: CMAKE,
  mk: MAKEFILE,
  y: L('Yacc', '#4B6C4B'),
  l: L('Lex', '#DBCA00'),
  jq: L('jq', '#c7254e'),
  nix: L('Nix', '#7e7eff'),
  dockerfile: DOCKERFILE,
  m4: M4,
  awk: L('Awk', '#c30e9b'),
  tex: L('TeX', '#3D6117'),
  roff: L('Roff', '#ecdebe'),
}

/** Whole file names (lowercase) with a language of their own. */
const BY_NAME: Readonly<Record<string, Language>> = {
  makefile: MAKEFILE,
  gnumakefile: MAKEFILE,
  dockerfile: DOCKERFILE,
  'cmakelists.txt': CMAKE,
  'configure.ac': M4,
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
  /** Files the walk saw (every kind). */
  readonly files: number
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

/** The language bar of a walk. */
export function languageStats(walk: FileWalk): LanguageStats {
  return { languages: languageShares(walk.files.map((f) => [f.path, f.size] as const)), files: walk.files.length, truncated: walk.truncated }
}

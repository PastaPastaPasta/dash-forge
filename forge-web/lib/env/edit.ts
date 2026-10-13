/**
 * One change to an environment from the browser, as `dg env set|unset|import|audience|share|
 * resave|mark-changed|edit --keep` makes it (dg `commit`): the next entries and audience from
 * {@link baseOf}, what changed, whether anything is left to save, and the lines the confirmation
 * shows (DESIGN §10). Also `.env` text (forge-core `parse_dotenv`), read in the browser only.
 * Pure: the page renders it, vitest pins it.
 */

import { audienceLabel, compareStrings as cmp, diffSnapshots, validVarName, type Audience, type Change, type EnvVar, type Snapshot } from './format'
import { oldFormatOf, snapshotOf, stateOf, type EnvBook } from './loader'
import { count } from './view'
import { EnvSaveError, baseOf, newEnvId, type Base, type Draft } from './write'

/** What a change edits, starting from the current version. */
export interface Next {
  vars: Map<string, EnvVar>
  audience: Audience | null
  markedChanged: string[]
}

/** One change, ready to seal once the people are known. */
export interface SavePlan {
  readonly env: string
  readonly base: Base
  readonly audience: Audience
  readonly vars: ReadonlyMap<string, EnvVar>
  readonly markedChanged: readonly string[]
  /** The entries that differ from the version it starts from (names only). */
  readonly changes: ReadonlyArray<readonly [string, Change]>
  /** Nothing to save: the same entries, audience and marks, one head, already in the new format. */
  readonly unchanged: boolean
}

/** The help line under the audience picker and the confirmation's note on who joins later (DESIGN §10). */
export const JOINERS_LINE = "People who join this group later get the current values when it's saved again, never earlier ones."

/** E611 (DESIGN §10): an environment has no default audience. */
export function audienceRequiredText(env: string): string {
  return `Choose who can read ${env}. An environment has no default audience: you choose it when you first save it.`
}

export function sameAudience(a: Audience | null, b: Audience): boolean {
  return a !== null && a.group === b.group && a.also.length === b.also.length && a.also.every((x, i) => x === b.also[i])
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** `audience` with its added people in order, each once (the artifact's canonical form). */
export function normalAudience(audience: Audience): Audience {
  return { group: audience.group, also: [...new Set(audience.also)].sort(cmp) }
}

/**
 * The next version of `env`: from its current one (or `keep`'s, resolving a conflict), with
 * `audience` when given and `change` applied. `again`: save it even when nothing changed (Save it
 * again). Throws {@link EnvSaveError} when it can't be changed from here or has no audience.
 */
export function planSave(
  book: EnvBook,
  env: string,
  opts: { readonly audience?: Audience; readonly keep?: string; readonly again?: boolean; readonly change?: (next: Next) => void } = {},
): SavePlan {
  const base = baseOf(book, env, opts.keep)
  const next: Next = { vars: new Map(base.vars), audience: opts.audience ?? base.audience, markedChanged: [...base.markedChanged] }
  opts.change?.(next)
  if (next.audience === null) throw new EnvSaveError(audienceRequiredText(env))
  const audience = normalAudience(next.audience)
  if (audience.group === null && audience.also.length === 0) throw new EnvSaveError(`${env} would be for nobody: choose a group or someone to share it with`)
  const markedChanged = [...new Set(next.markedChanged)].sort(cmp)
  const shape = (vars: ReadonlyMap<string, EnvVar>): Snapshot => ({ version: 2, env, audience, id: null, generatedAt: 0, to: [], toKeys: [], markedChanged: [], vars })
  const changes = diffSnapshots(base.audience === null ? null : shape(base.vars), shape(next.vars))
  const unchanged =
    changes.length === 0 && sameAudience(base.audience, audience) && sameList(markedChanged, base.markedChanged) && base.heads <= 1 && base.version === 2 && opts.again !== true
  return { env, base, audience, vars: next.vars, markedChanged, changes, unchanged }
}

/** The draft of `plan` for `people` (the people its audience resolves to). */
export function draftOf(plan: SavePlan, people: ReadonlySet<string>): Draft {
  return {
    env: plan.env,
    id: plan.base.id ?? newEnvId(),
    audience: plan.audience,
    vars: plan.vars,
    supersedes: plan.base.supersedes,
    markedChanged: plan.markedChanged,
    people,
  }
}

/** `+ A, ~ B, - C` (names only), or "no entry changed" (dg `summary`). */
export function changeSummary(changes: ReadonlyArray<readonly [string, Change]>): string {
  if (changes.length === 0) return 'no entry changed'
  const mark: Readonly<Record<Change, string>> = { added: '+', changed: '~', removed: '-' }
  return changes.map(([n, c]) => `${mark[c]} ${n}`).join(', ')
}

/** "Writers and maintainers, sent to 4 people". */
export function sentToText(audience: Audience, to: number): string {
  return `${audienceLabel(audience)}, sent to ${to === 1 ? '1 person' : `${to} people`}`
}

/** What the confirmation says beside the headline (dg `commit`'s lines), people still as ids. */
export type SaveNote =
  | { readonly kind: 'audience'; readonly from: string; readonly to: string }
  | { readonly kind: 'joiners' }
  | { readonly kind: 'oldFormat' }
  | { readonly kind: 'skipped'; readonly who: string }
  | { readonly kind: 'hidden'; readonly n: number }
  | { readonly kind: 'resolving'; readonly heads: number }

/** The confirmation's notes for `plan`, sealed for `skipped` left out. */
export function saveNotes(book: EnvBook, plan: SavePlan, skipped: readonly string[]): SaveNote[] {
  const out: SaveNote[] = []
  const was = plan.base.audience
  if (was !== null && !sameAudience(was, plan.audience)) out.push({ kind: 'audience', from: audienceLabel(was), to: audienceLabel(plan.audience) })
  if (was === null || !sameAudience(was, plan.audience)) out.push({ kind: 'joiners' })
  if (plan.base.version === 1 && oldFormatOf(book, plan.env)?.latest === true) out.push({ kind: 'oldFormat' })
  for (const who of skipped) out.push({ kind: 'skipped', who })
  if (was === null && book.resolution.hidden.length > 0) out.push({ kind: 'hidden', n: book.resolution.hidden.length })
  if (plan.base.heads > 1) out.push({ kind: 'resolving', heads: plan.base.heads })
  return out
}

/** One note as a sentence; `name` is how the page names `who`. */
export function saveNoteText(env: string, note: SaveNote, name: (id: string) => string = (id) => id): string {
  switch (note.kind) {
    case 'audience':
      return `Who can read it changes from ${note.from} to ${note.to}. Earlier versions stay readable by whoever could read them.`
    case 'joiners':
      return JOINERS_LINE
    case 'oldFormat':
      return "This saves it in the new format. Values saved in the old format stay readable by anyone who joins later: change them where they're used, then mark them changed."
    case 'skipped':
      return `${name(note.who)} has no encryption key and won't be able to read it.`
    case 'hidden':
      return `You can't read ${count(note.n, 'environment')} here. If one of them is also called ${env}, this makes a second ${env} that conflicts with it.`
    case 'resolving':
      return `This keeps one of the ${note.heads} versions of ${env} and replaces them all.`
  }
}

/** The values held in `env`'s old-format versions this reader opened, by name. */
function oldFormatValues(book: EnvBook, env: string): Map<string, string[]> {
  const held = new Map<string, string[]>()
  for (const id of stateOf(book, env)?.snapshots ?? []) {
    if (!book.oldFormat.has(id)) continue
    const s = snapshotOf(book, id)
    if (s === null) continue
    for (const [n, v] of s.vars) held.set(n, [...(held.get(n) ?? []), v.value])
  }
  return held
}

/**
 * The names `dg env mark-changed --env <env> [names]` would mark (every unmarked one when `names`
 * is empty), or why it refuses: a name with no old-format value this reader can read, or one
 * whose current value is still one of them.
 */
export function markChangedNames(book: EnvBook, env: string, names: readonly string[] = []): { readonly ok: true; readonly names: string[] } | { readonly ok: false; readonly reason: string } {
  const old = oldFormatOf(book, env)
  if (old === null) return { ok: false, reason: `${env} has no values saved in the old format` }
  const held = oldFormatValues(book, env)
  const picked = names.length === 0 ? [...old.unmarked] : [...names]
  const unknown = picked.find((n) => !held.has(n))
  if (unknown !== undefined) return { ok: false, reason: `${unknown} has no value saved in the old format in ${env} that you can read` }
  const head = stateOf(book, env)?.heads[0]
  const current = head === undefined ? null : snapshotOf(book, head)
  const still = picked.filter((n) => {
    const v = current?.vars.get(n)
    return v !== undefined && (held.get(n) ?? []).includes(v.value)
  })
  if (still.length > 0) {
    return {
      ok: false,
      reason: `${still.join(', ')} still ${still.length === 1 ? 'holds' : 'hold'} a value saved in the old format: change ${still.length === 1 ? 'it' : 'them'} where ${still.length === 1 ? "it's" : "they're"} used, then here, then mark ${still.length === 1 ? 'it' : 'them'} changed`,
    }
  }
  return { ok: true, names: picked }
}

/** A `.env` line that could not be read (the value is never repeated). */
export class DotenvError extends Error {
  constructor(
    readonly line: number,
    readonly why: string,
  ) {
    super(`line ${line}: ${why}`)
    this.name = 'DotenvError'
  }
}

const UNQUOTE: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', $: '$', '`': '`' }

/**
 * Parse `.env` text exactly as forge-core `parse_dotenv`: `NAME=value` lines, an optional
 * `export ` prefix, `#` comments and blank lines; a value bare (trimmed, an unquoted ` #` starts a
 * comment), in single quotes (as is) or in double quotes (`\n`, `\r`, `\t`, `\"`, `\\`, `\$` and
 * `` \` `` escapes; may span lines). A name given twice keeps the last value.
 */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>()
  // Rust `str::lines`: split on \n, drop one trailing \r per line, no final empty line
  // a leading byte-order mark is not part of the first name (forge-core strips it too)
  const lines = (text.startsWith('\uFEFF') ? text.slice(1) : text).split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop()
  let i = 0
  while (i < lines.length) {
    const n = i + 1
    let line = (lines[i] as string).trimStart()
    i++
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart()
    const eq = line.indexOf('=')
    if (eq < 0) throw new DotenvError(n, 'expected NAME=value')
    const name = line.slice(0, eq).trimEnd()
    if (!validVarName(name)) throw new DotenvError(n, 'not a variable name (letters, digits and `_`, not starting with a digit)')
    const rest = line.slice(eq + 1).trimStart()
    let value: string
    if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1)
      if (end < 0) throw new DotenvError(n, 'a single-quoted value is not closed on its line')
      value = rest.slice(1, end)
    } else if (rest.startsWith('"')) {
      value = ''
      let chunk = rest.slice(1)
      for (;;) {
        let closed = false
        let k = 0
        const chars = [...chunk]
        while (k < chars.length) {
          const c = chars[k++] as string
          if (c === '"') {
            closed = true
            break
          }
          if (c === '\\') {
            const e = chars[k++]
            if (e === undefined) value += '\\'
            else value += UNQUOTE[e] ?? `\\${e}`
          } else {
            value += c
          }
        }
        if (closed) break
        if (i >= lines.length) throw new DotenvError(n, 'a double-quoted value is not closed')
        value += '\n'
        chunk = lines[i] as string
        i++
      }
    } else {
      const at = rest.indexOf(' #')
      value = (at < 0 ? rest : rest.slice(0, at)).trimEnd()
    }
    out.set(name, value)
  }
  return out
}

/**
 * `values` set into `vars` as `dg env set|import` sets them: a new entry is a variable unless
 * `secret`; an existing one keeps its type (or becomes a secret) and its note.
 */
export function applySet(vars: Map<string, EnvVar>, values: ReadonlyMap<string, string>, secret: boolean): void {
  for (const [name, value] of values) {
    const old = vars.get(name)
    vars.set(name, { value, type: secret ? 'secret' : (old?.type ?? 'variable'), note: old?.note ?? '' })
  }
}

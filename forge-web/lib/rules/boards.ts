/**
 * Boards (`docs/design/boards.md`): the pure rules every client applies to a board's documents,
 * so the web and `dg board` show the same board. The Rust half is forge-core
 * `rules::boards`; the `board_*__*.json` vectors in `forge-contracts/vectors/` pin the two
 * together (`./boards.conformance.test.ts` here, `rules::boards::tests::board_vectors` there).
 *
 * - **Spec** (§2.1–§2.3, §4, §8): the board definition a `board` document's `spec` holds, parsed
 *   strictly ({@link parseSpec}) and written canonically ({@link serializeSpec}); a card's field
 *   values ({@link parseFieldValues}, {@link serializeFieldValues}).
 * - **Rank** (§2.6): base-62 fractional ranks ({@link rankBetween}, {@link implicitRank},
 *   {@link topRank}, {@link bottomRank}, {@link rerank}).
 * - **Fold** (§2.4): where every item shows ({@link foldBoard}), and the newest board revision
 *   per key ({@link newestBoards}).
 * - **Query** (§4.4): {@link parseBoardQuery}, {@link matchesBoardQuery}.
 * - **Iterations** (§2.2): {@link iterationAt}, {@link iterationRange}.
 * - **Views** (§4.1–§4.5): {@link groupRows}, {@link sortRows}, {@link columnTotals},
 *   {@link iterationProgress}.
 *
 * Everything is pure: no SDK, no clock (`now` is an input), no I/O.
 */

import { base58Decode } from '../auth/base58'
import { compareStrings } from './oid'
import { searchTerms, searchTokens } from './search-terms'

// ---------------------------------------------------------------------------------------------
// Limits (§8) and shared value shapes
// ---------------------------------------------------------------------------------------------

/** A `board.spec` holds at most this many UTF-8 bytes (the contract's `maxBytes`). */
export const SPEC_MAX_BYTES = 4096
/** A `card.f` holds at most this many UTF-8 bytes. */
export const FIELD_VALUES_MAX_BYTES = 2048
export const MAX_COLUMNS = 20
export const MAX_FIELDS = 12
export const MAX_OPTIONS = 30
export const MAX_SOURCES = 5
export const MAX_VIEWS = 8
/** A view lists at most this many table columns. */
export const MAX_VIEW_COLS = 24
/** Column, field, option and view names: 1-63 characters. */
export const NAME_MAX = 63
/** A board's description: at most this many characters. */
export const DESC_MAX = 1024
/** A source's or view's query: at most this many characters (the issue list's `Q_MAX`). */
export const QUERY_MAX = 512
/** A text field's value: 1-200 characters. */
export const TEXT_VALUE_MAX = 200
/** A column's WIP limit: 1-9999. */
export const WIP_MAX = 9999
/** An iteration field's length: 1-90 days. */
export const ITER_DAYS_MAX = 90
/** The highest iteration index a card may name. */
export const ITER_INDEX_MAX = 65535
/** Auto-archive after at most this many days (0 = off). */
export const ARCH_MAX = 3650
/** A number field's value: finite, |x| ≤ 1e15, and 0 or |x| ≥ 1e-6 (both clients print it alike). */
export const NUM_ABS_MAX = 1e15
export const NUM_ABS_MIN = 1e-6
/** An explicit rank is at most 63 characters (the `card.rank` schema). */
export const RANK_MAX = 63
/** Ranks are re-spread for at most this many items at once. */
export const RERANK_MAX = 1_000_000

/** A day in milliseconds (dates are UTC days). */
export const DAY_MS = 86_400_000

/** `s`'s length in UTF-8 bytes (what the contract's `maxBytes` counts). */
function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

/** `s`'s length in code points (what the contract's `maxLength` counts). */
function charLength(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

/** Whether `s` holds an unpaired surrogate (a string Rust could not hold). */
function hasLoneSurrogate(s: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)
}

/** The white space a name may not start or end with: JavaScript's `trim` set less the controls (refused anyway). */
function isSpace(cp: number): boolean {
  return cp === 0x20 || cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === 0xfeff
}

/** C0, DEL and C1 control characters. */
export function isControl(cp: number): boolean {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)
}

/**
 * A column, field, option or view name: 1-63 characters, no control character or `"` (a query
 * quotes names with `"`), not starting or ending with white space.
 */
function nameOk(s: unknown): s is string {
  if (typeof s !== 'string' || hasLoneSurrogate(s)) return false
  const cps = [...s].map((c) => c.codePointAt(0) as number)
  if (cps.length < 1 || cps.length > NAME_MAX) return false
  if (cps.some((cp) => isControl(cp) || cp === 0x22)) return false
  return !isSpace(cps[0] as number) && !isSpace(cps[cps.length - 1] as number)
}

/** A string of at most `max` characters with no unpaired surrogate. */
function textOk(s: unknown, max: number): s is string {
  return typeof s === 'string' && !hasLoneSurrogate(s) && charLength(s) <= max
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

/** The deepest nesting serde_json (forge-core's reader) reads: its recursion limit of 128 refuses the 128th level. */
const JSON_DEPTH_MAX = 127

/**
 * Whether forge-core's serde_json reads what `JSON.parse` read: it refuses a number out of range
 * (`1e400`, which JavaScript reads as Infinity), an unpaired surrogate escape, and nesting past
 * 127 levels. Refusing them here as well keeps the two clients' answers equal.
 */
function serdeReads(v: unknown, depth = 0): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'string') return !hasLoneSurrogate(v)
  if (typeof v !== 'object' || v === null) return true
  if (depth >= JSON_DEPTH_MAX) return false
  if (Array.isArray(v)) return v.every((x) => serdeReads(x, depth + 1))
  return Object.entries(v).every(([k, x]) => !hasLoneSurrogate(k) && serdeReads(x, depth + 1))
}

/** `JSON.parse`, or undefined when it (or forge-core's serde_json, {@link serdeReads}) would refuse the text. */
function readJson(text: string): unknown {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  return serdeReads(raw) ? raw : undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const COLOR = /^#[0-9a-fA-F]{6}$/
/** An identity or document id: 42-44 base58 characters (the web's `isIdentityId`). */
const IDENTIFIER = /^[1-9A-HJ-NP-Za-km-z]{42,44}$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's `days_from_civil`). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** The date `days` after 1970-01-01, as `YYYY-MM-DD` (Hinnant's `civil_from_days`). */
function civilFromDays(days: number): string {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0)
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** A `YYYY-MM-DD` calendar date's day number (days since 1970-01-01), or null when it is not one. */
export function dateDays(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const m = DATE.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const len = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] as number
  return d <= len ? daysFromCivil(y, mo, d) : null
}

/** The UTC date of a millisecond time, as `YYYY-MM-DD`. */
export function dateOf(ms: number): string {
  return civilFromDays(Math.floor(ms / DAY_MS))
}

// ---------------------------------------------------------------------------------------------
// Spec (§2.1-§2.3, §4)
// ---------------------------------------------------------------------------------------------

/** A status column (§2.1): `id` 1-255 stable across renames; order is the array order. */
export interface BoardColumn {
  readonly id: number
  readonly name: string
  /** `#rrggbb`. */
  readonly color?: string
  /** WIP limit (§4.5): shown and warned on, never blocking. */
  readonly wip?: number
}

/** The custom field types (§2.2). */
export type FieldType = 'sel' | 'num' | 'date' | 'iter' | 'text'

/** A single-select option. */
export interface FieldOption {
  readonly id: number
  readonly name: string
  readonly color?: string
}

/**
 * A custom field (§2.2). `options` is present exactly for `sel`; `start` (`YYYY-MM-DD`) and
 * `days` (1-90) exactly for `iter`.
 */
export interface BoardField {
  readonly id: number
  readonly name: string
  readonly type: FieldType
  readonly options?: readonly FieldOption[]
  readonly start?: string
  readonly days?: number
}

/** A source's kind: issues, pull requests, or both. */
export type SourceKind = 'i' | 'p' | 'a'

/**
 * An auto-include rule (§2.3): every item of repository `r` (absent: the home repository) of
 * kind `k` that query `q` matches is on the board. A source query reads only the item itself
 * ({@link parseSourceQuery}).
 */
export interface BoardSource {
  readonly r?: string
  readonly k: SourceKind
  readonly q: string
}

export type ViewLayout = 'board' | 'table' | 'roadmap'

/**
 * A saved view (§4). Keys name the built-in fields or a custom field as `f<id>`:
 * - `group` (columns of the board layout, sections of the table): `status` (the default),
 *   `assignee`, `label`, `milestone`, `repo` or a `sel` / `iter` field; the board layout takes
 *   only `status` and `sel` / `iter` fields.
 * - `lane` (swimlanes): the same keys but `status`, and never the grouping.
 * - `sort`: `rank` (the default), `title`, `number`, `created`, `status`, `repo`, `author`,
 *   `milestone` or any field, `-` first for descending.
 * - `cols`: the fields a card or row shows: `title`, `number`, `repo`, `state`, `author`,
 *   `assignees`, `labels`, `milestone`, `created`, `status` or any field.
 * - `date` (roadmap): one `iter` field, or a start and an end `date` field.
 */
export interface BoardView {
  readonly id: number
  readonly name: string
  readonly layout: ViewLayout
  readonly q: string
  readonly group?: string
  readonly lane?: string
  readonly sort?: string
  readonly cols?: readonly string[]
  readonly date?: readonly number[]
}

/** A board definition, `v: 1` (§2). `def` / `done` are column ids, 0 for none; `arch` is days, 0 = off. */
export interface BoardSpec {
  readonly v: 1
  readonly desc?: string
  readonly columns: readonly BoardColumn[]
  readonly def: number
  readonly done: number
  readonly sources: readonly BoardSource[]
  readonly fields: readonly BoardField[]
  readonly views: readonly BoardView[]
  readonly arch: number
}

/**
 * Why a spec was refused: not JSON or not an object (`json`), not `v: 1` (`version`), over 4096
 * bytes (`size`), or the part that is malformed. A list over its limit names the list
 * (`columns`, `fields`, `sources`, `views`); a malformed or repeated entry (an id, or a name in
 * any letter case) names the entry (`column`, `field`, `options` for a field's options, `source`,
 * `view`); `def`, `done`, `arch`, `desc` name themselves.
 */
export type SpecError =
  | 'json'
  | 'version'
  | 'size'
  | 'desc'
  | 'columns'
  | 'column'
  | 'def'
  | 'done'
  | 'sources'
  | 'source'
  | 'fields'
  | 'field'
  | 'options'
  | 'views'
  | 'view'
  | 'arch'

export type SpecResult = { readonly spec: BoardSpec } | { readonly error: SpecError }

/**
 * Names a field may not have, in any letter case: the query's own keys and the built-in fields
 * (§2.2, §4.4), so `<field>:<value>` is never ambiguous.
 */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'is', 'state', 'label', 'labels', 'assignee', 'assignees', 'author', 'milestone', 'no', 'status', 'repo', 'repository', 'title', 'number', 'created',
])

const FIELD_TYPES: readonly FieldType[] = ['sel', 'num', 'date', 'iter', 'text']
export const LAYOUTS: readonly ViewLayout[] = ['board', 'table', 'roadmap']
const GROUP_BUILTINS = ['status', 'assignee', 'label', 'milestone', 'repo']
const SORT_BUILTINS = ['rank', 'title', 'number', 'created', 'status', 'repo', 'author', 'milestone']
const COL_BUILTINS = ['title', 'number', 'repo', 'state', 'author', 'assignees', 'labels', 'milestone', 'created', 'status']

/** The field id a `f<id>` key names (1-255, no leading zero), or null. */
export function fieldKeyId(key: string): number | null {
  const m = /^f([1-9]\d{0,2})$/.exec(key)
  if (!m) return null
  const id = Number(m[1])
  return id <= 255 ? id : null
}

/** A spec's field by id. */
export function fieldById(spec: BoardSpec, id: number): BoardField | undefined {
  return spec.fields.find((f) => f.id === id)
}

/** The field a `f<id>` view key names in `fields`, or undefined. */
export function fieldOfKey(fields: readonly BoardField[], key: string): BoardField | undefined {
  const id = fieldKeyId(key)
  return id === null ? undefined : fields.find((f) => f.id === id)
}

/** Whether `key` may group a view (§2.7): Status, a built-in (not on the board layout), a `sel` / `iter` field. */
export function groupKeyOk(fields: readonly BoardField[], key: string, boardLayout: boolean): boolean {
  if (key === 'status') return true
  if (GROUP_BUILTINS.includes(key)) return !boardLayout
  const f = fieldOfKey(fields, key)
  return f !== undefined && (f.type === 'sel' || f.type === 'iter')
}

/** Whether `key` (a leading `-` for descending) may sort a view (§2.7). */
export function sortKeyOk(fields: readonly BoardField[], key: string): boolean {
  const k = key.startsWith('-') ? key.slice(1) : key
  return SORT_BUILTINS.includes(k) || fieldOfKey(fields, k) !== undefined
}

/** Whether `key` may be one of a view's `cols` (§2.7). */
export function colKeyOk(fields: readonly BoardField[], key: string): boolean {
  return COL_BUILTINS.includes(key) || fieldOfKey(fields, key) !== undefined
}

/** Whether a view's roadmap `date` (§2.7) is one `iter` field or two different `date` fields of `fields`. */
export function viewDatesOk(fields: readonly BoardField[], date: readonly number[]): boolean {
  const types = date.map((d) => fields.find((f) => f.id === d)?.type)
  const iter = types.length === 1 && types[0] === 'iter'
  const range = types.length === 2 && types[0] === 'date' && types[1] === 'date' && date[0] !== date[1]
  return iter || range
}

/** Whether `names` (compared in lower case) and `ids` repeat. */
function repeats(entries: readonly { readonly id: number; readonly name: string }[]): boolean {
  const ids = new Set(entries.map((e) => e.id))
  const names = new Set(entries.map((e) => e.name.toLowerCase()))
  return ids.size !== entries.length || names.size !== entries.length
}

class SpecRefused extends Error {
  constructor(readonly code: SpecError) {
    super(code)
  }
}

function refuse(code: SpecError): never {
  throw new SpecRefused(code)
}

/** An optional `#rrggbb`. */
function colorOf(v: unknown, code: SpecError): string | undefined {
  if (v === undefined) return undefined
  return typeof v === 'string' && COLOR.test(v) ? v : refuse(code)
}

function parseColumns(v: unknown): BoardColumn[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_COLUMNS) refuse('columns')
  const out = v.map((c): BoardColumn => {
    if (!isObject(c) || !isInt(c.id, 1, 255) || !nameOk(c.name)) refuse('column')
    const color = colorOf(c.color, 'column')
    if (c.wip !== undefined && !isInt(c.wip, 1, WIP_MAX)) refuse('column')
    return { id: c.id, name: c.name, ...(color !== undefined ? { color } : {}), ...(c.wip !== undefined ? { wip: c.wip as number } : {}) }
  })
  if (repeats(out)) refuse('column')
  return out
}

function parseColumnRef(v: unknown, columns: readonly BoardColumn[], code: 'def' | 'done'): number {
  if (v === undefined) return 0
  if (!isInt(v, 0, 255) || (v !== 0 && !columns.some((c) => c.id === v))) refuse(code)
  return v
}

function parseSources(v: unknown): BoardSource[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > MAX_SOURCES) refuse('sources')
  return v.map((s): BoardSource => {
    if (!isObject(s)) refuse('source')
    if (s.r !== undefined && !(typeof s.r === 'string' && IDENTIFIER.test(s.r))) refuse('source')
    if (s.k !== 'i' && s.k !== 'p' && s.k !== 'a') refuse('source')
    if (s.q !== undefined && !textOk(s.q, QUERY_MAX)) refuse('source')
    return { ...(s.r !== undefined ? { r: s.r as string } : {}), k: s.k, q: (s.q as string | undefined) ?? '' }
  })
}

function parseOptions(v: unknown): FieldOption[] {
  if (!Array.isArray(v) || v.length > MAX_OPTIONS) refuse('options')
  const out = v.map((o): FieldOption => {
    if (!isObject(o) || !isInt(o.id, 1, 255) || !nameOk(o.name)) refuse('options')
    const color = colorOf(o.color, 'options')
    return { id: o.id, name: o.name, ...(color !== undefined ? { color } : {}) }
  })
  if (repeats(out)) refuse('options')
  return out
}

function fieldNameOk(name: unknown): name is string {
  return nameOk(name) && !name.includes(':') && !name.startsWith('-') && !RESERVED_FIELD_NAMES.has(name.toLowerCase())
}

function parseFields(v: unknown): BoardField[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > MAX_FIELDS) refuse('fields')
  const out = v.map((f): BoardField => {
    if (!isObject(f) || !isInt(f.id, 1, 255) || !fieldNameOk(f.name)) refuse('field')
    const type = f.type as FieldType
    if (!FIELD_TYPES.includes(type)) refuse('field')
    if ((f.options !== undefined) !== (type === 'sel')) refuse('field')
    if ((f.start !== undefined || f.days !== undefined) && type !== 'iter') refuse('field')
    const base = { id: f.id, name: f.name, type }
    if (type === 'sel') return { ...base, options: parseOptions(f.options) }
    if (type === 'iter') {
      if (typeof f.start !== 'string' || dateDays(f.start) === null || !isInt(f.days, 1, ITER_DAYS_MAX)) refuse('field')
      return { ...base, start: f.start, days: f.days }
    }
    return base
  })
  if (repeats(out)) refuse('field')
  return out
}

function parseViews(v: unknown, fields: readonly BoardField[]): BoardView[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > MAX_VIEWS) refuse('views')
  const out = v.map((w): BoardView => {
    if (!isObject(w) || !isInt(w.id, 1, 255) || !nameOk(w.name)) refuse('view')
    const layout = w.layout as ViewLayout
    if (!LAYOUTS.includes(layout)) refuse('view')
    if (w.q !== undefined && !textOk(w.q, QUERY_MAX)) refuse('view')
    const str = (x: unknown): x is string | undefined => x === undefined || typeof x === 'string'
    const { group, lane, sort, cols, date } = w
    if (!str(group) || !str(lane) || !str(sort)) refuse('view')
    if (group !== undefined && !groupKeyOk(fields, group, layout === 'board')) refuse('view')
    if (lane !== undefined && (lane === 'status' || lane === (group ?? 'status') || !groupKeyOk(fields, lane, false))) refuse('view')
    if (sort !== undefined && !sortKeyOk(fields, sort)) refuse('view')
    if (cols !== undefined) {
      if (!Array.isArray(cols) || cols.length > MAX_VIEW_COLS) refuse('view')
      if (cols.some((c) => typeof c !== 'string' || !colKeyOk(fields, c)) || new Set(cols).size !== cols.length) refuse('view')
    }
    if (date !== undefined) {
      if (!Array.isArray(date) || !date.every((d) => isInt(d, 1, 255)) || !viewDatesOk(fields, date)) refuse('view')
    }
    return {
      id: w.id,
      name: w.name,
      layout,
      q: (w.q as string | undefined) ?? '',
      ...(group !== undefined ? { group } : {}),
      ...(lane !== undefined ? { lane } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(cols !== undefined ? { cols: cols as string[] } : {}),
      ...(date !== undefined ? { date: date as number[] } : {}),
    }
  })
  if (repeats(out)) refuse('view')
  return out
}

/**
 * Read a board definition (`board.spec`, §2): JSON, `v: 1`, at most 4096 UTF-8 bytes, every
 * limit of §8, ids 1-255 and unique, names unique in any letter case, every reference (`def`,
 * `done`, a view's keys) to something the spec defines. Unknown keys are tolerated (a later
 * client's optional additions read here) and dropped by {@link serializeSpec}; a known key of the
 * wrong type or shape refuses the whole spec. Checked in the canonical key order, so both
 * clients name the same first problem.
 */
export function parseSpec(json: string): SpecResult {
  if (utf8Length(json) > SPEC_MAX_BYTES) return { error: 'size' }
  const raw = readJson(json)
  if (!isObject(raw)) return { error: 'json' }
  try {
    if (raw.v !== 1) refuse('version')
    if (raw.desc !== undefined && !textOk(raw.desc, DESC_MAX)) refuse('desc')
    const columns = parseColumns(raw.columns)
    const def = parseColumnRef(raw.def, columns, 'def')
    const done = parseColumnRef(raw.done, columns, 'done')
    const sources = parseSources(raw.sources)
    const fields = parseFields(raw.fields)
    const views = parseViews(raw.views, fields)
    if (raw.arch !== undefined && !isInt(raw.arch, 0, ARCH_MAX)) refuse('arch')
    const arch = (raw.arch as number | undefined) ?? 0
    // an empty description is none (written as none)
    const desc = raw.desc === '' ? undefined : (raw.desc as string | undefined)
    return { spec: { v: 1, ...(desc !== undefined ? { desc } : {}), columns, def, done, sources, fields, views, arch } }
  } catch (e) {
    if (e instanceof SpecRefused) return { error: e.code }
    throw e
  }
}

/** The spec as canonical JSON: keys in the declared order, defaults (0, `""`, `[]`, absent) omitted. */
function canonicalSpec(spec: BoardSpec): string {
  const opt = <T>(key: string, v: T | undefined, omit: (x: T) => boolean = () => false) => (v === undefined || omit(v) ? {} : { [key]: v })
  return JSON.stringify({
    v: 1,
    ...opt('desc', spec.desc),
    columns: spec.columns.map((c) => ({ id: c.id, name: c.name, ...opt('color', c.color), ...opt('wip', c.wip) })),
    ...opt('def', spec.def, (x) => x === 0),
    ...opt('done', spec.done, (x) => x === 0),
    ...opt('sources', spec.sources.map((s) => ({ ...opt('r', s.r), k: s.k, ...opt('q', s.q, (x) => x === '') })), (x) => x.length === 0),
    ...opt(
      'fields',
      spec.fields.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        ...opt('options', f.options?.map((o) => ({ id: o.id, name: o.name, ...opt('color', o.color) }))),
        ...opt('start', f.start),
        ...opt('days', f.days),
      })),
      (x) => x.length === 0,
    ),
    ...opt(
      'views',
      spec.views.map((w) => ({
        id: w.id,
        name: w.name,
        layout: w.layout,
        ...opt('q', w.q, (x) => x === ''),
        ...opt('group', w.group),
        ...opt('lane', w.lane),
        ...opt('sort', w.sort),
        ...opt('cols', w.cols),
        ...opt('date', w.date),
      })),
      (x) => x.length === 0,
    ),
    ...opt('arch', spec.arch, (x) => x === 0),
  })
}

/**
 * Write a definition as canonical compact JSON (the declared key order, defaults omitted), so
 * equal specs are equal bytes in both clients. Refused when it would not read back
 * ({@link parseSpec}'s error) or is over 4096 bytes (`size`): what this returns always parses
 * to an equal spec.
 */
export function serializeSpec(spec: BoardSpec): { readonly json: string } | { readonly error: SpecError } {
  const json = canonicalSpec(spec)
  const back = parseSpec(json)
  if ('error' in back) return back
  // a spec carrying a value its parse normalizes away (an unknown key) is written as parsed
  return { json: canonicalSpec(back.spec) }
}

/** The Monday (UTC) of the week holding `ms`, as `YYYY-MM-DD`. */
export function mondayOf(ms: number): string {
  const days = Math.floor(ms / DAY_MS)
  // 1970-01-01 was a Thursday: (days + 3) mod 7 is days since Monday
  return civilFromDays(days - (((days + 3) % 7) + 7) % 7)
}

/**
 * The new-board template: Todo / In progress / Done (Done the done column, Todo the default),
 * the home repository's issues and pull requests, Priority (P0-P3), Estimate and a two-week
 * Iteration starting the Monday of the week of `nowMs`, a Board, a Table and a Roadmap view,
 * and auto-archive after 14 days.
 */
export function defaultSpec(homeRepoId: string, nowMs: number): BoardSpec {
  return {
    v: 1,
    columns: [
      { id: 1, name: 'Todo' },
      { id: 2, name: 'In progress' },
      { id: 3, name: 'Done' },
    ],
    def: 1,
    done: 3,
    sources: [{ r: homeRepoId, k: 'a', q: '' }],
    fields: [
      {
        id: 1,
        name: 'Priority',
        type: 'sel',
        options: [
          { id: 1, name: 'P0', color: '#d1242f' },
          { id: 2, name: 'P1', color: '#fb8f44' },
          { id: 3, name: 'P2', color: '#d4a72c' },
          { id: 4, name: 'P3', color: '#8c959f' },
        ],
      },
      { id: 2, name: 'Estimate', type: 'num' },
      { id: 3, name: 'Iteration', type: 'iter', start: mondayOf(nowMs), days: 14 },
    ],
    views: [
      { id: 1, name: 'Board', layout: 'board', q: '' },
      { id: 2, name: 'Table', layout: 'table', q: '', cols: ['title', 'status', 'assignees', 'f1', 'f2', 'f3'] },
      { id: 3, name: 'Roadmap', layout: 'roadmap', q: '', date: [3] },
    ],
    arch: 14,
  }
}

// ---------------------------------------------------------------------------------------------
// Card field values (§3.2 `f`)
// ---------------------------------------------------------------------------------------------

/** A field value: an option id (`sel`), a number (`num`), `YYYY-MM-DD` (`date`), an iteration index (`iter`) or text. */
export type FieldValue = number | string

/** A card's field values by field id (decimal, as JSON keys). */
export type FieldValues = Readonly<Record<string, FieldValue>>

/** Whether `v` is a valid value of `field`. */
export function fieldValueOk(field: BoardField, v: unknown): v is FieldValue {
  switch (field.type) {
    case 'sel':
      return isInt(v, 1, 255) && (field.options ?? []).some((o) => o.id === v)
    case 'num':
      return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= NUM_ABS_MAX && (v === 0 || Math.abs(v) >= NUM_ABS_MIN)
    case 'date':
      return dateDays(v) !== null
    case 'iter':
      return isInt(v, 0, ITER_INDEX_MAX)
    case 'text':
      return typeof v === 'string' && v !== '' && textOk(v, TEXT_VALUE_MAX)
  }
}

/** `values` less every entry for a field `spec` does not have, an option it does not have, or of the wrong type; `-0` reads as 0. */
function validValues(entries: Iterable<[string, unknown]>, spec: BoardSpec): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {}
  for (const [key, v] of entries) {
    if (!/^[1-9]\d{0,2}$/.test(key)) continue
    const field = fieldById(spec, Number(key))
    if (field === undefined || !fieldValueOk(field, v)) continue
    out[key] = v === 0 ? 0 : v
  }
  return out
}

/**
 * A card's field values (`card.f`, `{"<fieldId>": value}`), keeping only those `spec` defines
 * with a value of the field's type (a deleted field, a deleted option, a wrong type are dropped:
 * the card reads as having no value there). Not JSON or not an object reads as none.
 */
export function parseFieldValues(json: string | null, spec: BoardSpec): FieldValues {
  if (json === null || json === '') return {}
  const raw = readJson(json)
  return isObject(raw) ? validValues(Object.entries(raw), spec) : {}
}

/**
 * Field values as canonical JSON (ids ascending, invalid entries dropped as {@link
 * parseFieldValues} drops them), refused over 2048 bytes (`size`).
 */
export function serializeFieldValues(values: FieldValues, spec: BoardSpec): { readonly json: string } | { readonly error: 'size' } {
  // integer-like keys iterate in ascending numeric order
  const json = JSON.stringify(validValues(Object.entries(values), spec))
  return utf8Length(json) > FIELD_VALUES_MAX_BYTES ? { error: 'size' } : { json }
}

// ---------------------------------------------------------------------------------------------
// Rank (§2.6)
// ---------------------------------------------------------------------------------------------

/** The 62 rank digits, in ASCII (byte) order. */
export const RANK_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** A rank digit's value 0-61, or -1. */
function digitOf(c: string): number {
  const x = c.charCodeAt(0)
  if (x >= 48 && x <= 57) return x - 48
  if (x >= 65 && x <= 90) return x - 55
  if (x >= 97 && x <= 122) return x - 61
  return -1
}

/** Whether `r` is a well-formed explicit rank: 1-63 digits, not ending in `0` (the `card.rank` pattern). */
export function isExplicitRank(r: unknown): r is string {
  return typeof r === 'string' && /^[0-9A-Za-z]{0,62}[1-9A-Za-z]$/.test(r)
}

/**
 * Why no rank was made: a bound is not 0-63 rank digits (`invalid`), the lower bound is above the
 * upper (`order`), or no rank of at most 63 digits fits between them (`re-rank`: the bounds are
 * equal, or `b` is `a` + `0…0`, or the gap is used up; re-rank the column, §2.6).
 */
export type RankError = 'invalid' | 'order' | 're-rank'

export type RankResult = { readonly rank: string } | { readonly error: RankError }

/**
 * A rank strictly between `a` and `b` in byte order (`null` / `""` is open: below everything /
 * above everything), ending in a non-zero digit, at most 63 digits.
 *
 * Built digit by digit. `lo` / `hi` say whether the digits so far still equal `a`'s / `b`'s.
 * At position i the digit x may end the rank when it is above `a[i]` (or anything above 0 once
 * `a` is passed or exhausted), and below `b[i]` (or equal to it while `b` goes on: the rank is
 * then a proper prefix of `b`, which sorts first). The midpoint of the allowed digits is taken;
 * when none is allowed the rank copies `a[i]` (staying just above `a`) or, past `a`, writes `0`
 * (forced while `b[i]` is `0`), and goes on. So `a` < rank < `b` always holds, a bound may end in
 * `0` (an implicit rank), and a prefix pair (`V` / `V1`) is handled. The pairs with nothing
 * between are equal bounds and `b` = `a` + `0…0`; they end in `re-rank`, as does a rank that would
 * pass 63 digits.
 */
export function rankBetween(a: string | null, b: string | null): RankResult {
  const lo = a ?? ''
  const hi = b ?? ''
  const ok = (r: string) => r.length <= RANK_MAX && [...r].every((c) => digitOf(c) >= 0)
  if (!ok(lo) || !ok(hi)) return { error: 'invalid' }
  // two members dropping into one gap at once write one rank: nothing lies between them
  if (hi !== '' && compareStrings(lo, hi) >= 0) return { error: lo === hi ? 're-rank' : 'order' }
  let out = ''
  let loTight = true
  let hiTight = hi !== ''
  for (let i = 0; ; i++) {
    if (i >= RANK_MAX || (hiTight && i >= hi.length)) return { error: 're-rank' }
    const inLo: boolean = loTight && i < lo.length
    const floor = inLo ? digitOf(lo[i] as string) : 0
    const hd = hiTight ? digitOf(hi[i] as string) : 62
    const ceil = hiTight && i + 1 < hi.length ? hd + 1 : hd
    if (ceil - floor >= 2) return { rank: out + RANK_DIGITS[(floor + ceil) >> 1] }
    loTight = inLo
    hiTight = hiTight && floor === hd
    out += RANK_DIGITS[floor]
  }
}

/** `n` in `width` base-62 digits (clamped to 0 … 62^width − 1). */
function base62(n: number, width: number): string {
  let v = Math.max(0, Math.min(Math.floor(n), 62 ** width - 1))
  let out = ''
  for (let i = 0; i < width; i++) {
    out = RANK_DIGITS[v % 62] + out
    v = Math.floor(v / 62)
  }
  return out
}

/**
 * The rank of an item with no card, or whose newest card has no rank: `V`, its `$createdAt` in
 * 8 base-62 digits, the first 3 bytes of its `$id` (big-endian, mod 62⁴) in 4. Sourced items pool
 * in creation order, oldest first, none equal. It may end in `0`.
 */
export function implicitRank(createdAtMs: number, itemIdBytes: Uint8Array): string {
  const head = ((itemIdBytes[0] ?? 0) << 16) | ((itemIdBytes[1] ?? 0) << 8) | (itemIdBytes[2] ?? 0)
  return `V${base62(createdAtMs, 8)}${base62(head % 62 ** 4, 4)}`
}

/** The bytes of a base58 id; none when it is not base58. */
function idBytes(id: string): Uint8Array {
  try {
    return base58Decode(id)
  } catch {
    return new Uint8Array(0)
  }
}

/** {@link implicitRank} of an item by its base58 `$id`. */
export function implicitRankOf(createdAtMs: number, itemId: string): string {
  return implicitRank(createdAtMs, idBytes(itemId))
}

/** The rank that puts a card at the top of a column whose first rank is `first` (null: empty), above the sourced pool. */
export function topRank(first: string | null): RankResult {
  return rankBetween('', first === null || compareStrings(first, 'V') > 0 ? 'V' : first)
}

/** The rank that puts a card at the bottom of a column whose last rank is `last` (null: empty), below the sourced pool. */
export function bottomRank(last: string | null): RankResult {
  return rankBetween(last === null || compareStrings(last, 'W') < 0 ? 'W' : last, '')
}

/**
 * `n` evenly spaced explicit ranks, ascending, for re-ranking a column (§2.6): rank k is k/(n+1)
 * of the way from `0` to `V` (so items sourced later join below them, in the pool), in the fewest
 * digits that leave 62 free ranks between neighbours, trailing zeros dropped. `invalid` for n
 * outside 0 … 1 000 000.
 */
export function rerank(n: number): { readonly ranks: readonly string[] } | { readonly error: 'invalid' } {
  if (!Number.isInteger(n) || n < 0 || n > RERANK_MAX) return { error: 'invalid' }
  let width = 1
  while (31 * 62 ** (width - 1) < 62 * (n + 1)) width++
  const space = 31 * 62 ** (width - 1)
  const ranks: string[] = []
  for (let k = 1; k <= n; k++) ranks.push(base62(Math.floor((k * space) / (n + 1)), width).replace(/0+$/, ''))
  return { ranks }
}

// ---------------------------------------------------------------------------------------------
// Iterations (§2.2)
// ---------------------------------------------------------------------------------------------

/** One iteration of an `iter` field: index k, named "<field> k+1", `start` … `end` (the last day, inclusive). */
export interface IterationRange {
  readonly index: number
  readonly name: string
  readonly start: string
  readonly end: string
  /** `start`'s midnight UTC, and the next iteration's (exclusive end). */
  readonly startMs: number
  readonly endMs: number
}

/** An `iter` field's first day number and length in days; null when `field` is not a well-formed `iter` field. */
function iterOf(field: BoardField): { readonly start: number; readonly days: number } | null {
  const start = dateDays(field.start)
  if (field.type !== 'iter' || start === null || field.days === undefined || field.days < 1) return null
  return { start, days: field.days }
}

/** The index of `field`'s iteration holding `dateMs` (UTC days); null before its first or past index 65535, or not an `iter` field. */
export function iterationAt(field: BoardField, dateMs: number): number | null {
  const iter = iterOf(field)
  if (iter === null) return null
  const k = Math.floor((Math.floor(dateMs / DAY_MS) - iter.start) / iter.days)
  return k >= 0 && k <= ITER_INDEX_MAX ? k : null
}

/** Iteration `k` of `field`: days `start + k·days` … `start + (k+1)·days − 1`; null when not an `iter` field or k out of range. */
export function iterationRange(field: BoardField, k: number): IterationRange | null {
  const iter = iterOf(field)
  if (iter === null || !isInt(k, 0, ITER_INDEX_MAX)) return null
  const first = iter.start + k * iter.days
  const next = first + iter.days
  return { index: k, name: `${field.name} ${k + 1}`, start: civilFromDays(first), end: civilFromDays(next - 1), startMs: first * DAY_MS, endMs: next * DAY_MS }
}

// ---------------------------------------------------------------------------------------------
// Items, cards and placement (§2.4)
// ---------------------------------------------------------------------------------------------

export type ItemKind = 'issue' | 'pr'
export type ItemState = 'open' | 'closed' | 'merged'

/**
 * What a board reads of an issue or PR. `closedAt` is the `$createdAt` of its latest transition
 * into closed or merged (null when open, or unknown); `repo` is how this client labels the item's
 * repository (`owner/name`), for display only: `repo:`, grouping and sorting read `repoId`.
 * `assignees` / `author` are identity ids.
 */
export interface BoardItem {
  readonly id: string
  readonly number: number
  readonly repoId: string
  readonly repo?: string
  readonly kind: ItemKind
  readonly state: ItemState
  readonly createdAt: number
  readonly closedAt: number | null
  readonly title: string
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly milestone: string | null
  readonly author: string
}

/** Card `state` (§3.2). */
export const CARD_ACTIVE = 0
export const CARD_ARCHIVED = 1
export const CARD_REMOVED = 2

/** A `card` document as read (a private repo's opened): `col` / `rank` / `f` null when absent or unreadable. */
export interface CardDoc {
  readonly id: string
  readonly ownerId: string
  readonly updatedAt: number
  readonly item: string
  readonly col: number | null
  readonly rank: string | null
  readonly f: string | null
  readonly state: number
}

/** Why an item is archived: its newest card says so, or auto-archive (`arch`) caught it. */
export type ArchivedBy = 'card' | 'auto'

/** Where one item shows (§2.4). `col` 0 is "No status". */
export interface Placement {
  readonly id: string
  /** On the board: a source matches it or it has a card, and that card is not removed. */
  readonly on: boolean
  readonly sourced: boolean
  readonly removed: boolean
  /** The newest card's `$id`, if any. */
  readonly card: string | null
  readonly col: number
  readonly rank: string
  readonly archived: ArchivedBy | null
  readonly fields: FieldValues
}

/** A column's visible items (on the board, not archived), in rank order. */
export interface ColumnItems {
  readonly id: number
  readonly items: readonly string[]
}

export interface BoardFold {
  /** One per input item, in input order (repeated ids once). */
  readonly items: readonly Placement[]
  /** "No status" (0) first while it holds an item, then every column in order. */
  readonly columns: readonly ColumnItems[]
}

export interface FoldInput {
  readonly spec: BoardSpec
  /** The board's home repository id (a source without `r` reads it). */
  readonly home: string
  readonly items: readonly BoardItem[]
  /** The board's cards (every member's, this board's key and home repo). */
  readonly cards: readonly CardDoc[]
  readonly now: number
}

/** Whether `a` is newer than `b` by (`$updatedAt`, `$id`), the id by code point. */
function newer(a: { readonly updatedAt: number; readonly id: string }, b: { readonly updatedAt: number; readonly id: string }): boolean {
  return a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt : compareStrings(a.id, b.id) > 0
}

/** Every item's newest card over every member's, by (`$updatedAt`, `$id`) (§2.4). */
export function newestCards(cards: readonly CardDoc[]): Map<string, CardDoc> {
  const out = new Map<string, CardDoc>()
  for (const c of cards) {
    const prev = out.get(c.item)
    if (prev === undefined || newer(c, prev)) out.set(c.item, c)
  }
  return out
}

/** A `board` document as read: `spec` null when absent or unreadable. */
export interface BoardDoc {
  readonly id: string
  readonly ownerId: string
  readonly updatedAt: number
  readonly key: number
  readonly state: number
  readonly name: string | null
  readonly spec: string | null
}

/** Board `state` (§3.1). */
export const BOARD_OPEN = 0
export const BOARD_CLOSED = 1
export const BOARD_DELETED = 2

/**
 * A repository's boards: per key the newest revision over every member's by (`$updatedAt`,
 * `$id`), ascending by key, less the deleted ones (state 2) unless `withDeleted`.
 */
export function newestBoards(docs: readonly BoardDoc[], withDeleted = false): BoardDoc[] {
  const byKey = new Map<number, BoardDoc>()
  for (const d of docs) {
    const prev = byKey.get(d.key)
    if (prev === undefined || newer(d, prev)) byKey.set(d.key, d)
  }
  return [...byKey.values()].filter((d) => withDeleted || d.state !== BOARD_DELETED).sort((a, b) => a.key - b.key)
}

/**
 * Whether `source` includes `item` (§2.3): its repository (absent: `home`) and kind, and the
 * qualifiers of its query (`query`, {@link parseSourceQuery} of `source.q`).
 */
export function sourceMatches(source: BoardSource, query: BoardQuery, item: BoardItem, home: string, spec: BoardSpec, now: number): boolean {
  if ((source.r ?? home) !== item.repoId) return false
  if (source.k === 'i' && item.kind !== 'issue') return false
  if (source.k === 'p' && item.kind !== 'pr') return false
  return queryHolds(item, null, spec, query, { me: null, now })
}

/**
 * Where every item shows (§2.4). Per item: its newest card; on the board when a source matches
 * it or it has a card, unless that card is removed; its column (closed or merged → Done, unless
 * the card holds it in a column at or after Done; else the card's column while the board has it;
 * else the default); its rank (the card's, else {@link implicitRank}); archived by its card, or
 * by auto-archive once `now ≥ closedAt + arch` days for a closed or merged item whose newest card
 * is older than `closedAt` (or which has none); its field values ({@link parseFieldValues}).
 */
export function foldBoard(input: FoldInput): BoardFold {
  const { spec, home, now } = input
  const cards = newestCards(input.cards)
  const sources = spec.sources.map((s) => ({ s, q: parseSourceQuery(s.q, spec) }))
  const colIndex = new Map(spec.columns.map((c, i) => [c.id, i]))
  const doneIndex = spec.done === 0 ? undefined : colIndex.get(spec.done)
  const seen = new Set<string>()
  const items: Placement[] = []
  for (const item of input.items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const card = cards.get(item.id) ?? null
    const sourced = sources.some(({ s, q }) => sourceMatches(s, q, item, home, spec, now))
    const removed = card?.state === CARD_REMOVED
    const cardCol = card !== null && card.col !== null && colIndex.has(card.col) ? card.col : null
    const finished = item.state !== 'open'
    let col: number
    if (finished && doneIndex !== undefined && !(cardCol !== null && (colIndex.get(cardCol) as number) >= doneIndex)) col = spec.done
    else col = cardCol ?? spec.def
    let archived: ArchivedBy | null = null
    if (card?.state === CARD_ARCHIVED) archived = 'card'
    else if (spec.arch > 0 && finished && item.closedAt !== null && (card === null || card.updatedAt < item.closedAt) && now >= item.closedAt + spec.arch * DAY_MS) archived = 'auto'
    items.push({
      id: item.id,
      on: (sourced || card !== null) && !removed,
      sourced,
      removed,
      card: card?.id ?? null,
      col,
      rank: card !== null && isExplicitRank(card.rank) ? card.rank : implicitRankOf(item.createdAt, item.id),
      archived,
      fields: card === null ? {} : parseFieldValues(card.f, spec),
    })
  }
  const visible = items.filter((p) => p.on && p.archived === null).sort(byRank)
  const inCol = (id: number) => visible.filter((p) => p.col === id).map((p) => p.id)
  const none = inCol(0)
  return { items, columns: [...(none.length > 0 ? [{ id: 0, items: none }] : []), ...spec.columns.map((c) => ({ id: c.id, items: inCol(c.id) }))] }
}

/** Order within a column (§2.6): (rank, item `$id`), both by code point. */
export function byRank(a: { readonly rank: string; readonly id: string }, b: { readonly rank: string; readonly id: string }): number {
  return compareStrings(a.rank, b.rank) || compareStrings(a.id, b.id)
}

// ---------------------------------------------------------------------------------------------
// Query (§4.4)
// ---------------------------------------------------------------------------------------------

/** A comparison of a field value: `=`, `>`, `>=`, `<`, `<=`, an inclusive range `a..b`, or text `has`. */
export type QueryOp = 'eq' | 'gt' | 'ge' | 'lt' | 'le' | 'range' | 'has'

/**
 * One qualifier, every one ANDed, `not` for a leading `-`:
 * - `is`: `v` `open`, `closed` (closed or merged), `merged`, `unmerged` (open or closed), `issue`, `pr`, `archived`
 * - `label` / `milestone` (names, any case), `assignee` / `author` (an identity id or `me`), `repo` (a repository id:
 *   typed as one, or a name the client resolved, {@link repoNamesOf})
 * - `status`: `v` a column id; `no`: `v` `label`, `assignee`, `milestone`, `status` or `f<id>`
 * - `field`: field `f`, `op`, `v` (and `v2` for a range: either end may be absent, `*`): an option id
 *   (`sel`), a number (`num`), `YYYY-MM-DD` or `@today` (`date`), an iteration index or `@current` /
 *   `@next` / `@previous` (`iter`), lowercased text (`text`, `has`)
 */
export interface QueryPred {
  readonly k: 'is' | 'label' | 'milestone' | 'assignee' | 'author' | 'repo' | 'status' | 'no' | 'field'
  readonly not: boolean
  readonly v?: string | number
  readonly f?: number
  readonly op?: QueryOp
  readonly v2?: string | number
}

export interface BoardQuery {
  readonly preds: readonly QueryPred[]
  /** The free text: matched against titles, `#12` / `12` against numbers. */
  readonly text: string
  /** The qualifier tokens not applied, as typed (reported under the box, never searched). */
  readonly unresolved: readonly string[]
}

const IS_VALUES = ['open', 'closed', 'merged', 'unmerged', 'issue', 'pr', 'archived']
/** The query's own keys: a token with one of them and no value is reported, not text. */
const QUERY_KEYS = new Set(['is', 'state', 'label', 'milestone', 'assignee', 'author', 'repo', 'status', 'no'])
const LABEL_MAX = 30
const MILESTONE_MAX = 63
const ITER_RELATIVE = ['@current', '@next', '@previous']

const unquote = (s: string): string => s.replace(/"/g, '')

/** A query token's key (lowercased, unquoted, without a leading `-`), whether it is negated, and its value; null for no key. */
function tokenParts(tok: string): { readonly key: string; readonly not: boolean; readonly rawValue: string; readonly value: string } | null {
  const at = tok.indexOf(':')
  if (at <= 0) return null
  const rawKey = tok.slice(0, at)
  const not = rawKey.startsWith('-') && rawKey.length > 1
  const rawValue = tok.slice(at + 1)
  return { key: unquote(not ? rawKey.slice(1) : rawKey).toLowerCase(), not, rawValue, value: unquote(rawValue) }
}

/**
 * The repositories `text`'s `repo:` qualifiers name by name, as typed (unquoted), each once, in
 * order: `owner/name` (the owner an identity id or a DPNS name) or a bare `name` (a repository of
 * the home repository's owner). A client resolves each to its repository id before parsing
 * ({@link parseBoardQuery}'s `repos`), so `repo:` matches by id and never by how a client labels a
 * repository; a value that is itself an id needs no resolving and is not listed.
 */
export function repoNamesOf(text: string): string[] {
  const out: string[] = []
  for (const tok of searchTokens(text)) {
    const t = tokenParts(tok)
    if (t === null || t.key !== 'repo' || t.value === '' || t.rawValue.startsWith('//') || IDENTIFIER.test(t.value) || out.includes(t.value)) continue
    out.push(t.value)
  }
  return out
}

/** A person value: an identity id, or `me` (`@me`, any case). */
function personOf(v: string): string | null {
  const t = v.replace(/^@/, '')
  if (t.toLowerCase() === 'me') return 'me'
  return IDENTIFIER.test(t) ? t : null
}

const COMPARISON_OPS: Readonly<Record<string, QueryOp>> = { '>=': 'ge', '<=': 'le', '>': 'gt', '<': 'lt' }

/** A comparison value's op and operand(s), its operands still text. */
function comparison(v: string): { op: QueryOp; a: string; b?: string } {
  const range = /^(.*?)\.\.(.*)$/.exec(v)
  if (range) return { op: 'range', a: range[1] as string, b: range[2] as string }
  const m = /^(>=|<=|>|<)(.*)$/.exec(v)
  if (!m) return { op: 'eq', a: v }
  return { op: COMPARISON_OPS[m[1] as string] as QueryOp, a: m[2] as string }
}

const NUMBER = /^-?\d{1,15}(\.\d{1,15})?$/

/** A typed comparison operand: a number, a date, an iteration; null when it does not read as one. */
function operand(field: BoardField, s: string): string | number | null {
  switch (field.type) {
    case 'num':
      return NUMBER.test(s) ? Number(s) : null
    case 'date':
      return s.toLowerCase() === '@today' ? '@today' : dateDays(s) !== null ? s : null
    case 'iter': {
      const low = s.toLowerCase()
      if (ITER_RELATIVE.includes(low)) return low
      // `3` or `"Iteration 3"`: iteration 3, index 2
      const prefix = `${field.name.toLowerCase()} `
      const n = low.startsWith(prefix) ? low.slice(prefix.length) : low
      return /^[1-9]\d{0,4}$/.test(n) && Number(n) - 1 <= ITER_INDEX_MAX ? Number(n) - 1 : null
    }
    default:
      return null
  }
}

/** A custom-field qualifier's predicate, or null when the value does not read for the field. */
function fieldPred(field: BoardField, value: string, not: boolean): QueryPred | null {
  if (value === '') return null
  const base = { k: 'field' as const, not, f: field.id }
  if (field.type === 'sel') {
    const opt = (field.options ?? []).find((o) => o.name.toLowerCase() === value.toLowerCase())
    return opt ? { ...base, op: 'eq', v: opt.id } : null
  }
  if (field.type === 'text') return charLength(value) <= TEXT_VALUE_MAX ? { ...base, op: 'has', v: value.toLowerCase() } : null
  const c = comparison(value)
  if (c.op === 'range') {
    const a = c.a === '*' ? null : operand(field, c.a)
    const b = c.b === '*' ? null : operand(field, c.b as string)
    if ((c.a !== '*' && a === null) || (c.b !== '*' && b === null) || (c.a === '*' && c.b === '*')) return null
    if (a === null) return { ...base, op: 'le', v: b as string | number }
    if (b === null) return { ...base, op: 'ge', v: a }
    return { ...base, op: 'range', v: a, v2: b }
  }
  const a = operand(field, c.a)
  return a === null ? null : { ...base, op: c.op, v: a }
}

/**
 * Read a board query (§4.4): the Issues tab's qualifiers (`is:open|closed|merged|unmerged`,
 * `is:issue|pr`, `label:`, `assignee:`, `author:`, `milestone:`, `no:label|assignee|milestone`;
 * `state:` reads as `is:`), plus `status:<column>`, `no:status`, `repo:owner/name` (or a
 * repository id; a name is looked up in `repos`, the ids the client resolved the query's
 * {@link repoNamesOf} to, and one it did not resolve is reported),
 * `is:archived`, and `<field>:<value>` for a custom field by name (`priority:P0`,
 * `estimate:>3`, `estimate:1..5`, `target:<2026-11-01`, `iteration:@current`, `no:priority`).
 * Any qualifier takes a leading `-` (NOT). Keys and names match in any letter case; quote values
 * (and field names) with spaces: `status:"In progress"`, `"story points":>3`. A token whose key
 * or value names nothing on this board is reported in `unresolved`, never searched as text; a
 * key with nothing after its colon (`note:`) and a URL stay text. Values naming people take an
 * identity id or `@me` (resolve DPNS names first, as the Issues tab does).
 */
export function parseBoardQuery(text: string, spec: BoardSpec, repos: ReadonlyMap<string, string> = NO_REPOS): BoardQuery {
  return parseQuery(text, spec, false, repos)
}

const NO_REPOS: ReadonlyMap<string, string> = new Map()

/**
 * A source's query (§2.3): {@link parseBoardQuery} less what depends on the board or the reader
 * rather than the item (`status:`, `no:status`, custom fields, `is:archived`, `@me`), which goes
 * to `unresolved`: a source includes the same items for every reader, before any card. Its
 * `repo:` takes a repository id only (the fold reads nothing to resolve a name; a source names
 * its repository by `r` anyway).
 */
export function parseSourceQuery(text: string, spec: BoardSpec): BoardQuery {
  return parseQuery(text, spec, true, NO_REPOS)
}

/** Whether a predicate reads the board or the reader, not only the item. */
function boardOnly(p: QueryPred): boolean {
  if (p.k === 'status' || p.k === 'field') return true
  if (p.k === 'no') return p.v === 'status' || fieldKeyId(String(p.v)) !== null
  if (p.k === 'is') return p.v === 'archived'
  return (p.k === 'assignee' || p.k === 'author') && p.v === 'me'
}

function parseQuery(text: string, spec: BoardSpec, forSource: boolean, repos: ReadonlyMap<string, string>): BoardQuery {
  const preds: QueryPred[] = []
  const free: string[] = []
  const unresolved: string[] = []
  const fieldByName = new Map(spec.fields.map((f) => [f.name.toLowerCase(), f]))
  for (const tok of searchTokens(text)) {
    const t = tokenParts(tok)
    if (t === null || t.key === '' || (t.value === '' && !QUERY_KEYS.has(t.key) && !fieldByName.has(t.key)) || t.rawValue.startsWith('//')) {
      free.push(tok)
      continue
    }
    const { key, value, not } = t
    const pred = qualifier(key, value, not, spec, fieldByName, repos)
    if (pred === null || (forSource && boardOnly(pred))) unresolved.push(tok)
    else preds.push(pred)
  }
  return { preds, text: free.join(' '), unresolved }
}

function qualifier(key: string, value: string, not: boolean, spec: BoardSpec, fieldByName: ReadonlyMap<string, BoardField>, repos: ReadonlyMap<string, string>): QueryPred | null {
  const low = value.toLowerCase()
  switch (key) {
    case 'is':
    case 'state':
      return IS_VALUES.includes(low) && (key === 'is' || ['open', 'closed', 'merged', 'unmerged'].includes(low)) ? { k: 'is', not, v: low } : null
    case 'label':
      return value !== '' && charLength(value) <= LABEL_MAX ? { k: 'label', not, v: value } : null
    case 'milestone':
      return value !== '' && charLength(value) <= MILESTONE_MAX ? { k: 'milestone', not, v: value } : null
    case 'assignee':
    case 'author': {
      const who = personOf(value)
      return who === null ? null : { k: key, not, v: who }
    }
    case 'repo': {
      const id = IDENTIFIER.test(value) ? value : repos.get(value)
      return id !== undefined && IDENTIFIER.test(id) ? { k: 'repo', not, v: id } : null
    }
    case 'status': {
      const col = spec.columns.find((c) => c.name.toLowerCase() === low)
      return col ? { k: 'status', not, v: col.id } : null
    }
    case 'no': {
      if (['label', 'assignee', 'milestone', 'status'].includes(low)) return { k: 'no', not, v: low }
      const f = fieldByName.get(low)
      return f ? { k: 'no', not, v: `f${f.id}` } : null
    }
    default: {
      const f = fieldByName.get(key)
      return f ? fieldPred(f, value, not) : null
    }
  }
}

/** What a query reads besides the item: the viewer (`@me`) and the time (`@today`, `@current`). */
export interface QueryContext {
  readonly me: string | null
  readonly now: number
}

/** A field value's rank for comparison, resolving `@today` and the relative iterations; null: matches nothing. */
function resolveOperand(field: BoardField, v: string | number, ctx: QueryContext): string | number | null {
  if (v === '@today') return dateOf(ctx.now)
  if (typeof v === 'string' && ITER_RELATIVE.includes(v)) {
    // before the first iteration there is no current one, and the next is the first
    const cur = iterationAt(field, ctx.now)
    const before = ctx.now < (dateDays(field.start) ?? 0) * DAY_MS
    if (v === '@current') return cur
    if (v === '@next') return cur !== null ? cur + 1 : before ? 0 : null
    return cur !== null && cur > 0 ? cur - 1 : null
  }
  return v
}

function compare(x: string | number, y: string | number): number {
  if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : x > y ? 1 : 0
  return compareStrings(String(x), String(y))
}

function fieldHolds(p: QueryPred, field: BoardField, value: FieldValue | undefined, ctx: QueryContext): boolean {
  if (value === undefined) return false
  if (p.op === 'has') return String(value).toLowerCase().includes(String(p.v))
  const a = resolveOperand(field, p.v as string | number, ctx)
  if (a === null) return false
  const c = compare(value, a)
  switch (p.op) {
    case 'eq':
      return c === 0
    case 'gt':
      return c > 0
    case 'ge':
      return c >= 0
    case 'lt':
      return c < 0
    case 'le':
      return c <= 0
    case 'range': {
      const b = resolveOperand(field, p.v2 as string | number, ctx)
      return b !== null && c >= 0 && compare(value, b) <= 0
    }
    default:
      return false
  }
}

/** Whether the item's title and number hold every free-text term (the Issues tab's `matchesText`, without a body). */
function textMatches(text: string, item: BoardItem): boolean {
  const title = item.title.toLowerCase()
  return searchTerms(text).every((t) => {
    const hash = /^#(\d+)$/.exec(t.text)
    const holds = hash ? Number(hash[1]) === item.number : (/^\d+$/.test(t.text) && Number(t.text) === item.number) || title.includes(t.text)
    return holds !== t.not
  })
}

/** One predicate on the item and (for board qualifiers) its placement. */
function predHolds(p: QueryPred, item: BoardItem, placement: Placement | null, spec: BoardSpec, ctx: QueryContext): boolean {
  const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  switch (p.k) {
    case 'is':
      switch (p.v) {
        case 'open':
          return item.state === 'open'
        case 'closed':
          return item.state !== 'open'
        case 'merged':
          return item.state === 'merged'
        case 'unmerged':
          return item.state !== 'merged'
        case 'issue':
          return item.kind === 'issue'
        case 'pr':
          return item.kind === 'pr'
        default:
          return placement !== null && placement.archived !== null
      }
    case 'label':
      return item.labels.some((l) => eqi(l, p.v as string))
    case 'milestone':
      return item.milestone !== null && eqi(item.milestone, p.v as string)
    case 'assignee':
    case 'author': {
      const who = p.v === 'me' ? ctx.me : (p.v as string)
      if (who === null) return false
      return p.k === 'author' ? item.author === who : item.assignees.includes(who)
    }
    case 'repo':
      return item.repoId === p.v
    case 'status':
      return placement !== null && placement.col === p.v
    case 'no':
      switch (p.v) {
        case 'label':
          return item.labels.length === 0
        case 'assignee':
          return item.assignees.length === 0
        case 'milestone':
          return item.milestone === null
        case 'status':
          return placement !== null && placement.col === 0
        default:
          return placement !== null && placement.fields[String(fieldKeyId(p.v as string))] === undefined
      }
    case 'field': {
      const field = fieldById(spec, p.f as number)
      return field !== undefined && placement !== null && fieldHolds(p, field, placement.fields[String(p.f)], ctx)
    }
  }
}

/** Whether an item (with its placement; none for a source) holds every predicate, each negated by `-`, and the free text. */
function queryHolds(item: BoardItem, placement: Placement | null, spec: BoardSpec, query: BoardQuery, ctx: QueryContext): boolean {
  return query.preds.every((p) => predHolds(p, item, placement, spec, ctx) !== p.not) && textMatches(query.text, item)
}

/**
 * Whether an item on the board passes `query` (§4.4): it is on the board, archived exactly when
 * the query has `is:archived` (otherwise archived items are hidden), and holds every predicate
 * (each negated by `-`) and the free text. A value the item lacks never matches its qualifier
 * (so `-priority:P0` matches an item with no priority).
 */
export function matchesBoardQuery(item: BoardItem, placement: Placement, spec: BoardSpec, query: BoardQuery, ctx: QueryContext): boolean {
  if (!placement.on) return false
  const wantsArchived = query.preds.some((p) => p.k === 'is' && p.v === 'archived')
  if (!wantsArchived && placement.archived !== null) return false
  return queryHolds(item, placement, spec, query, ctx)
}

// ---------------------------------------------------------------------------------------------
// Views: grouping, sorting, totals, progress (§4.1-§4.5)
// ---------------------------------------------------------------------------------------------

/** An item with its placement, as views take them. */
export interface BoardRow {
  readonly item: BoardItem
  readonly placement: Placement
}

/** A group's key: a column id (status), an option id (`sel`), an iteration index, an identity id, a label or milestone name, a repo id; null for "No <key>". */
export interface RowGroup {
  readonly key: string | number | null
  readonly items: readonly string[]
}

/**
 * `rows` grouped by `by` (a view's `group` or `lane` key), each group's items in `rows`' order.
 * The empty group (null; "No status" is 0) comes first and only while it holds an item. Then:
 * every column in order (`status`), every option in order (`sel`), the iterations items name
 * and the current one ascending (`iter`), or the distinct values by code point (`assignee` and
 * `label`, an item in each of its own; `milestone`; `repo`, by id). An unknown key is one group.
 */
export function groupRows(rows: readonly BoardRow[], by: string, spec: BoardSpec, now: number): RowGroup[] {
  const field = fieldOfKey(spec.fields, by)
  const keysOf = (r: BoardRow): (string | number | null)[] => {
    if (by === 'status') return [r.placement.col === 0 ? null : r.placement.col]
    if (by === 'assignee') return r.item.assignees.length > 0 ? [...new Set(r.item.assignees)] : [null]
    if (by === 'label') return r.item.labels.length > 0 ? [...new Set(r.item.labels)] : [null]
    if (by === 'milestone') return [r.item.milestone]
    if (by === 'repo') return [r.item.repoId]
    const v = field === undefined ? undefined : r.placement.fields[String(field.id)]
    return [v === undefined ? null : v]
  }
  let order: (string | number)[]
  if (by === 'status') order = spec.columns.map((c) => c.id)
  else if (field?.type === 'sel') order = (field.options ?? []).map((o) => o.id)
  else if (field?.type === 'iter' || ['assignee', 'label', 'milestone', 'repo'].includes(by)) {
    const present = new Set<string | number>()
    for (const r of rows) for (const k of keysOf(r)) if (k !== null) present.add(k)
    if (field !== undefined) {
      const cur = iterationAt(field, now)
      if (cur !== null) present.add(cur)
      order = [...present].sort((a, b) => (a as number) - (b as number))
    } else order = [...present].sort((a, b) => compareStrings(String(a), String(b)))
  } else return [{ key: null, items: rows.map((r) => r.item.id) }]
  const groups = new Map<string | number | null, string[]>([[null, []], ...order.map((k): [string | number, string[]] => [k, []])])
  for (const r of rows) for (const k of keysOf(r)) groups.get(k)?.push(r.item.id)
  const empty = groups.get(null) as string[]
  const head: RowGroup[] = empty.length > 0 ? [{ key: by === 'status' ? 0 : null, items: empty }] : []
  return [...head, ...order.map((k) => ({ key: k, items: groups.get(k) as string[] }))]
}

/** A row's sort value under `key` (no `-`); undefined when it has none (sorted last either way). */
function sortValue(r: BoardRow, key: string, spec: BoardSpec): string | number | undefined {
  switch (key) {
    case 'title':
      return r.item.title.toLowerCase()
    case 'number':
      return r.item.number
    case 'created':
      return r.item.createdAt
    case 'status': {
      const i = spec.columns.findIndex((c) => c.id === r.placement.col)
      return i < 0 ? undefined : i
    }
    case 'repo':
      // by id, as `groupRows` orders repositories: the label (`item.repo`) is each client's own
      return r.item.repoId
    case 'author':
      return r.item.author
    case 'milestone':
      return r.item.milestone?.toLowerCase()
    default: {
      const field = fieldOfKey(spec.fields, key)
      const v = field === undefined ? undefined : r.placement.fields[String(field.id)]
      if (field === undefined || v === undefined) return undefined
      if (field.type === 'sel') return (field.options ?? []).findIndex((o) => o.id === v)
      return field.type === 'text' ? String(v).toLowerCase() : v
    }
  }
}

/**
 * `rows` in a view's `sort` (absent or `rank`: the column order, §2.6): by the key, `-` for
 * descending; rows without a value last in both directions; ties by (rank, item id).
 */
export function sortRows(rows: readonly BoardRow[], sort: string | undefined, spec: BoardSpec): BoardRow[] {
  const desc = sort?.startsWith('-') === true
  const key = sort === undefined ? 'rank' : desc ? sort.slice(1) : sort
  const tie = (a: BoardRow, b: BoardRow) => byRank(a.placement, b.placement)
  if (key === 'rank') return [...rows].sort((a, b) => (desc ? -tie(a, b) : tie(a, b)))
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key, spec)
    const y = sortValue(b, key, spec)
    if (x === undefined || y === undefined) return x === y ? tie(a, b) : x === undefined ? 1 : -1
    const c = compare(x, y)
    return c !== 0 ? (desc ? -c : c) : tie(a, b)
  })
}

/** The number field a view sums (§4.5): the first `num` field of its `cols`, or with no `cols` the spec's first; null for none. */
export function sumFieldOf(spec: BoardSpec, view: BoardView | null): number | null {
  const keys = view?.cols ?? spec.fields.map((f) => `f${f.id}`)
  for (const k of keys) {
    const f = fieldOfKey(spec.fields, k)
    if (f?.type === 'num') return f.id
  }
  return null
}

/** A group's totals: its item count and the sum of a number field (null with none). */
export interface Totals {
  readonly count: number
  readonly sum: number | null
}

/** `rows`' count and the sum of number field `sumField`'s values (in `rows`' order). */
export function totals(rows: readonly BoardRow[], sumField: number | null): Totals {
  if (sumField === null) return { count: rows.length, sum: null }
  let sum = 0
  for (const r of rows) {
    const v = r.placement.fields[String(sumField)]
    if (typeof v === 'number') sum += v
  }
  return { count: rows.length, sum }
}

/** A status column's totals (§4.5) and its WIP limit (null: none); `over` when the count passes it. */
export interface ColumnTotals extends Totals {
  readonly id: number
  readonly wip: number | null
  readonly over: boolean
}

/** Every status column's totals for `rows` (as {@link groupRows} by `status` groups them). */
export function columnTotals(rows: readonly BoardRow[], spec: BoardSpec, sumField: number | null): ColumnTotals[] {
  const byId = new Map(rows.map((r) => [r.item.id, r]))
  return groupRows(rows, 'status', spec, 0).map((g) => {
    const t = totals(
      g.items.map((id) => byId.get(id) as BoardRow),
      sumField,
    )
    const wip = spec.columns.find((c) => c.id === g.key)?.wip ?? null
    return { id: g.key as number, ...t, wip, over: wip !== null && t.count > wip }
  })
}

/** An iteration's progress (§4.5): items and points, all and done. Points are null without a points field. */
export interface IterationProgress {
  readonly total: number
  readonly done: number
  readonly points: number | null
  readonly donePoints: number | null
}

/**
 * Progress of iteration `k` of field `fieldId` over `rows`: the rows whose value is `k`; done is
 * in the Done column, or closed or merged.
 */
export function iterationProgress(rows: readonly BoardRow[], spec: BoardSpec, fieldId: number, k: number, pointsField: number | null): IterationProgress {
  const inIter = rows.filter((r) => r.placement.fields[String(fieldId)] === k)
  const done = inIter.filter((r) => (spec.done !== 0 && r.placement.col === spec.done) || r.item.state !== 'open')
  const all = totals(inIter, pointsField)
  const fin = totals(done, pointsField)
  return { total: all.count, done: fin.count, points: all.sum, donePoints: fin.sum }
}

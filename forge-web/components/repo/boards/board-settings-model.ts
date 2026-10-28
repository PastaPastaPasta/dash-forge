/**
 * The board settings editor's pure half (design `docs/design/boards.md` §2, §2.7, §8): new ids
 * that never bring back a deleted entry's data, the checks a name must pass (with the precise
 * reason), deleting a column or a field without leaving a view pointing at it, reordering, and
 * the definition's size against its 4096 bytes. The view-key checks are the rules' own
 * (`groupKeyOk`, `sortKeyOk`, `colKeyOk`, `viewDatesOk`); `parseSpec` / `serializeSpec` stay the
 * last word, and these say why earlier, next to the entry at fault.
 */

import {
  NAME_MAX,
  RESERVED_FIELD_NAMES,
  SPEC_MAX_BYTES,
  colKeyOk,
  groupKeyOk,
  isControl,
  serializeSpec,
  sortKeyOk,
  viewDatesOk,
  type BoardField,
  type BoardSpec,
  type BoardView as SavedView,
  type CardDoc,
} from '@/lib/rules/boards'

/** The highest id an entry may have (columns, fields, options, views: 1-255). */
export const ID_MAX = 255

/**
 * The ids a board's cards still name, which a new entry must not take: an entry's id is how a
 * card names it (a column by `col`, a field by its key in `f`, an option by its value there), so
 * a new column 3 after the old column 3 was deleted would gather the old one's items, and a new
 * option would take over a deleted one's values. Cards keep a deleted entry's id forever (only
 * readers drop what the board no longer has).
 */
export interface UsedIds {
  readonly columns: ReadonlySet<number>
  readonly fields: ReadonlySet<number>
  /** Per field id, the values its cards hold (a single select's option ids). */
  readonly options: ReadonlyMap<number, ReadonlySet<number>>
}

export const NO_USED_IDS: UsedIds = { columns: new Set(), fields: new Set(), options: new Map() }

const idOk = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= ID_MAX

/** The ids `cards` (every member's, readable ones) and the saved definition `saved` name ({@link UsedIds}). */
export function usedIds(cards: readonly Pick<CardDoc, 'col' | 'f'>[], saved: BoardSpec | null): UsedIds {
  const columns = new Set<number>(saved?.columns.map((c) => c.id) ?? [])
  const fields = new Set<number>(saved?.fields.map((f) => f.id) ?? [])
  const options = new Map<number, Set<number>>()
  const optionsOf = (f: number): Set<number> => {
    let set = options.get(f)
    if (set === undefined) options.set(f, (set = new Set()))
    return set
  }
  for (const f of saved?.fields ?? []) for (const o of f.options ?? []) optionsOf(f.id).add(o.id)
  for (const c of cards) {
    if (idOk(c.col)) columns.add(c.col)
    if (c.f === null) continue
    let values: unknown
    try {
      values = JSON.parse(c.f)
    } catch {
      continue
    }
    if (typeof values !== 'object' || values === null || Array.isArray(values)) continue
    for (const [k, v] of Object.entries(values)) {
      const id = Number(k)
      if (!idOk(id)) continue
      fields.add(id)
      if (idOk(v)) optionsOf(id).add(v)
    }
  }
  return { columns, fields, options }
}

/**
 * A new entry's id: one past every id `entries` has and every id in `taken` (what cards and the
 * saved definition still name, {@link UsedIds}); null past 255. Never the lowest free id: that
 * would be a deleted entry's, and its cards would come back.
 */
export function nextId(entries: readonly { readonly id: number }[], taken: Iterable<number> = []): number | null {
  let max = 0
  for (const e of entries) max = Math.max(max, e.id)
  for (const t of taken) max = Math.max(max, t)
  return max < ID_MAX ? max + 1 : null
}

/** Why no id is left (a board's ids are never reused). */
export const IDS_USED_UP = 'Every id up to 255 has been used on this board, so no new one can be added. Make a new board instead.'

/**
 * A new entry of `entries`: its id ({@link nextId}) and a default name ("Column 4") no entry has
 * in any letter case; null when no id is left.
 */
export function newEntry(entries: readonly { readonly id: number; readonly name: string }[], noun: string, taken: Iterable<number> = []): { readonly id: number; readonly name: string } | null {
  const id = nextId(entries, taken)
  if (id === null) return null
  const names = new Set(entries.map((e) => e.name.toLowerCase()))
  let n = entries.length + 1
  while (names.has(`${noun.toLowerCase()} ${n}`)) n++
  return { id, name: `${noun} ${n}` }
}

/** `arr` with the entry at `from` moved to `to`. */
export function moved<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= arr.length || to < 0 || to >= arr.length) return [...arr]
  const out = [...arr]
  const [x] = out.splice(from, 1)
  out.splice(to, 0, x as T)
  return out
}

/**
 * Why `name` is not a good column, field, option or view name (§2.7), or null: 1-63 characters,
 * no control character or `"`, no white space at either end, unique in any letter case among
 * `others`; a field's also no `:`, no leading `-`, and not a query key or built-in field.
 */
export function nameProblem(name: string, others: readonly string[], kind: 'column' | 'field' | 'option' | 'view'): string | null {
  if (name === '') return 'Give it a name.'
  if ([...name].length > NAME_MAX) return `Names are at most ${NAME_MAX} characters.`
  if (name.trim() !== name) return 'Names don’t start or end with a space.'
  if ([...name].some((ch) => ch === '"' || isControl(ch.codePointAt(0) as number))) return 'Names can’t hold quotes or control characters.'
  if (kind === 'field') {
    if (name.includes(':') || name.startsWith('-')) return 'Field names can’t hold a colon or start with a dash.'
    if (RESERVED_FIELD_NAMES.has(name.toLowerCase())) return `“${name}” is a built-in field.`
  }
  const low = name.toLowerCase()
  if (others.some((o) => o.toLowerCase() === low)) return `Another ${kind} has this name.`
  return null
}

/** {@link nameProblem} of `entry` among `entries` (itself left out), names trimmed as a save trims them. */
export function entryProblem(entries: readonly { readonly id: number; readonly name: string }[], entry: { readonly id: number; readonly name: string }, kind: 'column' | 'field' | 'option' | 'view'): string | null {
  return nameProblem(
    entry.name.trim(),
    entries.filter((e) => e.id !== entry.id).map((e) => e.name.trim()),
    kind,
  )
}

/** Whether any column, field, option or view name of `spec` has a {@link nameProblem} (each shown on its row). */
export function hasNameProblems(spec: BoardSpec): boolean {
  const all = <T extends { readonly id: number; readonly name: string }>(xs: readonly T[], kind: 'column' | 'field' | 'option' | 'view'): boolean => xs.some((x) => entryProblem(xs, x, kind) !== null)
  return all(spec.columns, 'column') || all(spec.fields, 'field') || all(spec.views, 'view') || spec.fields.some((f) => all(f.options ?? [], 'option'))
}

/**
 * `view` less every reference the spec's `fields` no longer back, or its layout does not take
 * (§2.7, the rules' own checks): a grouping by a deleted field (or, on the board layout, by
 * anything but Status or a single-select or iteration field), swimlanes likewise or equal to the
 * grouping, a sort or table column of a deleted field (no columns left: the default ones),
 * roadmap dates that are no longer one iteration or two date fields.
 */
export function cleanView(view: SavedView, fields: readonly BoardField[]): SavedView {
  const out: { -readonly [K in keyof SavedView]: SavedView[K] } = { ...view }
  if (out.group !== undefined && !groupKeyOk(fields, out.group, out.layout === 'board')) delete out.group
  if (out.lane !== undefined && (out.lane === 'status' || out.lane === (out.group ?? 'status') || !groupKeyOk(fields, out.lane, false))) delete out.lane
  if (out.sort !== undefined && !sortKeyOk(fields, out.sort)) delete out.sort
  if (out.cols !== undefined) {
    out.cols = out.cols.filter((c) => colKeyOk(fields, c))
    if (out.cols.length === 0) delete out.cols
  }
  if (out.date !== undefined && !viewDatesOk(fields, out.date)) delete out.date
  return out
}

/** `spec` with its views cleaned against its fields ({@link cleanView}). */
export function withCleanViews(spec: BoardSpec): BoardSpec {
  return { ...spec, views: spec.views.map((v) => cleanView(v, spec.fields)) }
}

/** `spec` less column `id`: a Default or Done that named it becomes none (its items go to the default column, or No status). */
export function withoutColumn(spec: BoardSpec, id: number): BoardSpec {
  return { ...spec, columns: spec.columns.filter((c) => c.id !== id), def: spec.def === id ? 0 : spec.def, done: spec.done === id ? 0 : spec.done }
}

/** `spec` less field `id`, and every view reference to it. Cards keep the value, which no reader shows (its id is never reused, {@link nextId}). */
export function withoutField(spec: BoardSpec, id: number): BoardSpec {
  return withCleanViews({ ...spec, fields: spec.fields.filter((f) => f.id !== id) })
}

/** `spec` with every column, field, option and view name trimmed (what a save writes: a typed space at either end is not an error). */
export function trimNames(spec: BoardSpec): BoardSpec {
  return {
    ...spec,
    columns: spec.columns.map((c) => ({ ...c, name: c.name.trim() })),
    fields: spec.fields.map((f) => ({ ...f, name: f.name.trim(), ...(f.options !== undefined ? { options: f.options.map((o) => ({ ...o, name: o.name.trim() })) } : {}) })),
    views: spec.views.map((v) => ({ ...v, name: v.name.trim() })),
  }
}

/** The definition's canonical JSON size in UTF-8 bytes, or null when the rules refuse it. */
export function specBytes(spec: BoardSpec): number | null {
  const out = serializeSpec(spec)
  // over the limit: the rules give no bytes back, so measure the uncanonical JSON (a little more)
  if ('error' in out) return out.error === 'size' ? Math.max(SPEC_MAX_BYTES + 1, new TextEncoder().encode(JSON.stringify(spec)).length) : null
  return new TextEncoder().encode(out.json).length
}

/** Whether two definitions write the same bytes. */
export function sameSpec(a: BoardSpec, b: BoardSpec): boolean {
  const x = serializeSpec(a)
  const y = serializeSpec(b)
  return 'json' in x && 'json' in y && x.json === y.json
}

/** A whole number typed into a settings field, clamped to `min`…`max` (checked when the field is left, not per keystroke); null when it is not one. */
export function clampedInt(text: string, min: number, max: number): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  return Math.min(max, Math.max(min, Number(t)))
}

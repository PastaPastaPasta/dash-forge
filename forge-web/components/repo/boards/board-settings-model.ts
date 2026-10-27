/**
 * The board settings editor's pure half (design `docs/design/boards.md` §2, §2.7, §8): new ids,
 * the checks a name must pass (with the precise reason), deleting a column or a field without
 * leaving a view pointing at it, reordering, and the definition's size against its 4096 bytes.
 * What the rules (`parseSpec` / `serializeSpec`) refuse is still the last word; these say why
 * earlier and next to the entry at fault.
 */

import { NAME_MAX, SPEC_MAX_BYTES, serializeSpec, type BoardField, type BoardSpec, type BoardView as SavedView } from '@/lib/rules/boards'

/** A new entry's id: one more than the highest (1-255), else the lowest one free; null when all 255 are taken. */
export function nextId(entries: readonly { readonly id: number }[]): number | null {
  const max = entries.reduce((m, e) => Math.max(m, e.id), 0)
  if (max < 255) return max + 1
  const used = new Set(entries.map((e) => e.id))
  for (let i = 1; i <= 255; i++) if (!used.has(i)) return i
  return null
}

/** `arr` with the entry at `from` moved to `to`. */
export function moved<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= arr.length || to < 0 || to >= arr.length) return [...arr]
  const out = [...arr]
  const [x] = out.splice(from, 1)
  out.splice(to, 0, x as T)
  return out
}

/** C0, DEL and C1 control characters. */
const isControl = (cp: number): boolean => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)

/** The names a field may not have, in any letter case (the query's keys and the built-in fields, §2.7). */
const RESERVED = new Set(['is', 'state', 'label', 'labels', 'assignee', 'assignees', 'author', 'milestone', 'no', 'status', 'repo', 'repository', 'title', 'number', 'created'])

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
    if (RESERVED.has(name.toLowerCase())) return `“${name}” is a built-in field.`
  }
  const low = name.toLowerCase()
  if (others.some((o) => o.toLowerCase() === low)) return `Another ${kind} has this name.`
  return null
}

/** Whether a view key names a field of `fields` of one of `types` (`f<id>`). */
function fieldKey(fields: readonly BoardField[], key: string, types?: readonly BoardField['type'][]): boolean {
  const m = /^f([1-9]\d{0,2})$/.exec(key)
  const f = m ? fields.find((x) => x.id === Number(m[1])) : undefined
  return f !== undefined && (types === undefined || types.includes(f.type))
}

const GROUP_BUILTINS = ['assignee', 'label', 'milestone', 'repo']
const SORT_BUILTINS = ['rank', 'title', 'number', 'created', 'status', 'repo', 'author', 'milestone']
const COL_BUILTINS = ['title', 'number', 'repo', 'state', 'author', 'assignees', 'labels', 'milestone', 'created', 'status']

/**
 * `view` less every reference the spec's `fields` no longer back, or its layout does not take
 * (§2.7): a grouping by a deleted field (or, on the board layout, by anything but Status or a
 * single-select or iteration field), swimlanes likewise or equal to the grouping, a sort or table
 * column of a deleted field, roadmap dates that are no longer one iteration or two date fields.
 */
export function cleanView(view: SavedView, fields: readonly BoardField[]): SavedView {
  const groupOk = (k: string, board: boolean): boolean => k === 'status' || (!board && GROUP_BUILTINS.includes(k)) || fieldKey(fields, k, ['sel', 'iter'])
  const out: { -readonly [K in keyof SavedView]: SavedView[K] } = { ...view }
  if (out.group !== undefined && !groupOk(out.group, out.layout === 'board')) delete out.group
  if (out.lane !== undefined && (out.lane === 'status' || out.lane === (out.group ?? 'status') || !groupOk(out.lane, false))) delete out.lane
  if (out.sort !== undefined) {
    const k = out.sort.replace(/^-/, '')
    if (!SORT_BUILTINS.includes(k) && !fieldKey(fields, k)) delete out.sort
  }
  if (out.cols !== undefined) out.cols = out.cols.filter((c) => COL_BUILTINS.includes(c) || fieldKey(fields, c))
  if (out.date !== undefined) {
    const types = out.date.map((d) => fields.find((f) => f.id === d)?.type)
    const ok = (types.length === 1 && types[0] === 'iter') || (types.length === 2 && types[0] === 'date' && types[1] === 'date' && out.date[0] !== out.date[1])
    if (!ok) delete out.date
  }
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

/** `spec` less field `id`, and every view reference to it. Cards keep the value, which no reader shows. */
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

/**
 * YAML issue forms (P1-6): GitHub's `.github/ISSUE_TEMPLATE/*.yml` schema, read at compose time
 * and filled in as a form. The issue's body is what GitHub writes for a submitted form: each
 * field's label as a `###` heading, then its answer (`_No response_` when empty); `markdown`
 * elements only guide the person filling it in and are left out.
 *
 * Only the keys GitHub defines are read (`name`, `description`, `title`, `labels`, `assignees`,
 * `body`); `projects` and `type` have no Forge counterpart and are ignored. A file that is not
 * a valid form (no name, no body, an element without its label) is not offered, as GitHub
 * lists it with an error instead of using it.
 */

import { load } from 'js-yaml'

/** A form element's answer: text (input, textarea), the picked options (dropdown) or the ticks (checkboxes). */
export type FormValue = string | readonly string[] | readonly boolean[]

interface Base {
  /** The answer's key: the element's `id`, else its position. */
  readonly key: string
  readonly label: string
  readonly description: string
  readonly required: boolean
}

export type FormElement =
  | { readonly type: 'markdown'; readonly key: string; readonly value: string }
  | (Base & { readonly type: 'input'; readonly placeholder: string; readonly value: string })
  | (Base & { readonly type: 'textarea'; readonly placeholder: string; readonly value: string; readonly render: string })
  | (Base & { readonly type: 'dropdown'; readonly options: readonly string[]; readonly multiple: boolean; readonly defaultIndex: number | null })
  | (Base & { readonly type: 'checkboxes'; readonly options: readonly { readonly label: string; readonly required: boolean }[] })

export interface IssueForm {
  readonly elements: readonly FormElement[]
}

/** The answers, by element key. */
export type FormValues = Readonly<Record<string, FormValue>>

/** A form read from YAML, or null when it is not one. */
export interface ParsedForm {
  readonly name: string
  readonly about: string
  readonly title: string
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly form: IssueForm
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')

/** `labels: [a, b]` or `labels: a, b`. */
function stringList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(str) : str(v).split(',')
  return raw.map((s) => s.trim()).filter((s) => s !== '')
}

/** One `body` element, or null when it is not valid (the whole form is then rejected). */
function element(raw: unknown, index: number): FormElement | null {
  if (!isRecord(raw)) return null
  const attrs = isRecord(raw['attributes']) ? raw['attributes'] : {}
  const id = str(raw['id']).trim()
  const key = id !== '' ? id : `field-${index}`
  const type = str(raw['type'])
  if (type === 'markdown') {
    const value = str(attrs['value'])
    return value.trim() === '' ? null : { type, key, value }
  }
  const label = str(attrs['label']).trim()
  if (label === '') return null
  const validations = isRecord(raw['validations']) ? raw['validations'] : {}
  const base = { key, label, description: str(attrs['description']), required: validations['required'] === true }
  switch (type) {
    case 'input':
      return { ...base, type, placeholder: str(attrs['placeholder']), value: str(attrs['value']) }
    case 'textarea':
      return { ...base, type, placeholder: str(attrs['placeholder']), value: str(attrs['value']), render: str(attrs['render']).trim() }
    case 'dropdown': {
      const options = Array.isArray(attrs['options']) ? attrs['options'].map(str).filter((o) => o.trim() !== '') : []
      if (options.length === 0) return null
      const d = attrs['default']
      const defaultIndex = typeof d === 'number' && Number.isInteger(d) && d >= 0 && d < options.length ? d : null
      return { ...base, type, options, multiple: attrs['multiple'] === true, defaultIndex }
    }
    case 'checkboxes': {
      const options = Array.isArray(attrs['options'])
        ? attrs['options'].flatMap((o) => (isRecord(o) && str(o['label']).trim() !== '' ? [{ label: str(o['label']), required: o['required'] === true }] : []))
        : []
      return options.length === 0 ? null : { ...base, type, options }
    }
    default:
      return null
  }
}

/** Parse a YAML issue form, or null when it is not a valid one. */
export function parseIssueForm(source: string): ParsedForm | null {
  let doc: unknown
  try {
    // js-yaml's default schema builds plain data only (no functions, no custom tags).
    doc = load(source)
  } catch {
    return null
  }
  if (!isRecord(doc) || !Array.isArray(doc['body'])) return null
  const name = str(doc['name']).trim()
  if (name === '') return null
  const elements: FormElement[] = []
  const keys = new Set<string>()
  for (const [i, raw] of doc['body'].entries()) {
    const el = element(raw, i)
    if (el === null || keys.has(el.key)) return null
    keys.add(el.key)
    elements.push(el)
  }
  // A form needs something to answer (GitHub: "at least one non-markdown field").
  if (!elements.some((e) => e.type !== 'markdown')) return null
  return {
    name,
    about: str(doc['description']).trim(),
    title: str(doc['title']),
    labels: stringList(doc['labels']),
    assignees: stringList(doc['assignees']).map((a) => a.replace(/^@/, '')),
    form: { elements },
  }
}

/** The answers a form starts with: each field's `value` or `default`, nothing ticked. */
export function initialFormValues(form: IssueForm): Record<string, FormValue> {
  const out: Record<string, FormValue> = {}
  for (const e of form.elements) {
    if (e.type === 'input' || e.type === 'textarea') out[e.key] = e.value
    else if (e.type === 'dropdown') out[e.key] = e.defaultIndex === null ? [] : [e.options[e.defaultIndex] ?? '']
    else if (e.type === 'checkboxes') out[e.key] = e.options.map(() => false)
  }
  return out
}

const NO_RESPONSE = '_No response_'

/** The issue body GitHub writes for a submitted form. */
export function formBody(form: IssueForm, values: FormValues): string {
  const parts: string[] = []
  for (const e of form.elements) {
    if (e.type === 'markdown') continue
    const v = values[e.key]
    let answer: string
    if (e.type === 'checkboxes') {
      const ticks = Array.isArray(v) ? (v as readonly boolean[]) : []
      answer = e.options.map((o, i) => `- [${ticks[i] === true ? 'X' : ' '}] ${o.label}`).join('\n')
    } else if (e.type === 'dropdown') {
      const picked = Array.isArray(v) ? (v as readonly string[]).filter((o) => o !== '') : []
      answer = picked.length === 0 ? NO_RESPONSE : picked.join(', ')
    } else {
      const s = typeof v === 'string' ? v.trim() : ''
      answer = s === '' ? NO_RESPONSE : e.type === 'textarea' && e.render !== '' ? `\`\`\`${e.render}\n${s}\n\`\`\`` : s
    }
    parts.push(`### ${e.label}\n\n${answer}`)
  }
  return parts.join('\n\n')
}

/** The labels of the required answers still missing (a required checkbox counts on its own). */
export function missingAnswers(form: IssueForm, values: FormValues): string[] {
  const out: string[] = []
  for (const e of form.elements) {
    if (e.type === 'markdown') continue
    const v = values[e.key]
    if (e.type === 'checkboxes') {
      const ticks = Array.isArray(v) ? (v as readonly boolean[]) : []
      for (const [i, o] of e.options.entries()) if (o.required && ticks[i] !== true) out.push(o.label)
    } else if (!e.required) continue
    else if (e.type === 'dropdown') {
      if (!Array.isArray(v) || (v as readonly string[]).every((o) => o === '')) out.push(e.label)
    } else if (typeof v !== 'string' || v.trim() === '') out.push(e.label)
  }
  return out
}

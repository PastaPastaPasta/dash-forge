'use client'

/**
 * A YAML issue form, filled in (P1-6; the schema and the body it makes are
 * `lib/view/issue-forms`): `markdown` elements as rendered guidance, then each field. Required
 * fields carry an asterisk; the dialog keeps "Submit" off until they are answered.
 */

import { MarkdownView } from '@/components/markdown-view'
import { Input, Textarea, disabledField } from '@/components/ui/input'
import type { FormElement, FormValue, FormValues, IssueForm } from '@/lib/view/issue-forms'
import { cn } from '@/lib/utils'

const labelClass = 'block text-dense font-medium text-anvil-700 dark:text-anvil-200'
const hintClass = 'text-[12px] text-anvil-600 dark:text-anvil-400'

function Required(): JSX.Element {
  return (
    <span className="text-danger-700 dark:text-danger-400" aria-hidden>
      {' '}*
    </span>
  )
}

/** A field's description, rendered as GitHub renders it (Markdown). */
function Description({ id, text }: { id: string; text: string }): JSX.Element | null {
  if (text.trim() === '') return null
  return (
    <div id={id} className="[&_p]:my-0">
      <MarkdownView source={text} className={hintClass} />
    </div>
  )
}

function Field({ el, idBase, value, onChange }: { el: Exclude<FormElement, { type: 'markdown' }>; idBase: string; value: FormValue | undefined; onChange: (v: FormValue) => void }): JSX.Element {
  const id = `${idBase}-${el.key}`
  const descId = `${id}-desc`
  const describedBy = el.description.trim() === '' ? undefined : descId
  if (el.type === 'checkboxes') {
    const ticks = Array.isArray(value) ? (value as readonly boolean[]) : []
    return (
      <fieldset className="space-y-1.5" aria-describedby={describedBy}>
        <legend className={labelClass}>
          {el.label}
          {el.options.some((o) => o.required) ? <Required /> : null}
        </legend>
        <Description id={descId} text={el.description} />
        {el.options.map((o, i) => (
          <label key={i} className="flex items-start gap-2 text-dense text-anvil-800 coarse:min-h-11 dark:text-anvil-200">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-forge-700"
              checked={ticks[i] === true}
              required={o.required}
              onChange={(e) => onChange(el.options.map((_, j) => (j === i ? e.target.checked : ticks[j] === true)))}
            />
            <span>
              {o.label}
              {o.required ? <Required /> : null}
            </span>
          </label>
        ))}
      </fieldset>
    )
  }
  const label = (
    <label htmlFor={id} className={labelClass}>
      {el.label}
      {el.required ? <Required /> : null}
    </label>
  )
  if (el.type === 'dropdown') {
    const picked = Array.isArray(value) ? (value as readonly string[]) : []
    return (
      <div className="space-y-1.5">
        {label}
        <Description id={descId} text={el.description} />
        <select
          id={id}
          multiple={el.multiple}
          required={el.required}
          aria-describedby={describedBy}
          value={el.multiple ? [...picked] : (picked[0] ?? '')}
          onChange={(e) => onChange(el.multiple ? Array.from(e.target.selectedOptions, (o) => o.value) : e.target.value === '' ? [] : [e.target.value])}
          className={cn(
            'w-full min-w-0 rounded-md border border-anvil-300 bg-white px-2 text-dense text-anvil-900 coarse:text-base dark:border-anvil-700 dark:bg-anvil-950 dark:text-anvil-100',
            el.multiple ? 'py-1' : 'h-9 coarse:h-11',
            disabledField,
          )}
        >
          {el.multiple ? null : <option value="">Select an option</option>}
          {el.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    )
  }
  const text = typeof value === 'string' ? value : ''
  return (
    <div className="space-y-1.5">
      {label}
      <Description id={descId} text={el.description} />
      {el.type === 'input' ? (
        <Input id={id} value={text} placeholder={el.placeholder} required={el.required} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Textarea
          id={id}
          value={text}
          placeholder={el.placeholder}
          required={el.required}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          className={cn('min-h-[96px]', el.render !== '' && 'font-mono')}
        />
      )}
    </div>
  )
}

/** The fields of `form`, answering into `values`. */
export function IssueFormFields({ form, values, onChange, idBase }: { form: IssueForm; values: FormValues; onChange: (key: string, v: FormValue) => void; idBase: string }): JSX.Element {
  return (
    <div className="space-y-4" data-testid="issue-form">
      {form.elements.map((el) =>
        el.type === 'markdown' ? (
          <div key={el.key} className="text-dense text-anvil-700 dark:text-anvil-300">
            <MarkdownView source={el.value} />
          </div>
        ) : (
          <Field key={el.key} el={el} idBase={idBase} value={values[el.key]} onChange={(v) => onChange(el.key, v)} />
        ),
      )}
    </div>
  )
}

// @vitest-environment jsdom
/** P1-6: a YAML issue form renders each field with its label, and answers flow back by key. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IssueFormFields } from './issue-form'
import { initialFormValues, parseIssueForm, type FormValue } from '@/lib/view/issue-forms'

const FORM = parseIssueForm(
  [
    'name: Bug',
    'body:',
    '  - type: markdown',
    '    attributes: { value: "Thanks for **reporting**." }',
    '  - type: input',
    '    id: version',
    '    attributes: { label: Version, description: Which one? }',
    '    validations: { required: true }',
    '  - type: dropdown',
    '    id: os',
    '    attributes: { label: OS, options: [Linux, macOS] }',
    '  - type: checkboxes',
    '    id: terms',
    '    attributes: { label: Terms, options: [{ label: I agree, required: true }] }',
  ].join('\n'),
)!.form

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('IssueFormFields', () => {
  it('renders guidance and labelled fields, and reports answers by key', () => {
    const got: [string, FormValue][] = []
    act(() => root.render(<IssueFormFields form={FORM} values={initialFormValues(FORM)} onChange={(k, v) => got.push([k, v])} idBase="t" />))
    expect(host.textContent).toContain('Thanks for reporting.')
    const input = host.querySelector<HTMLInputElement>('#t-version')!
    expect(input.required).toBe(true)
    expect(host.querySelector('label[for="t-version"]')?.textContent).toContain('Version')
    expect(input.getAttribute('aria-describedby')).toBe('t-version-desc')
    const select = host.querySelector<HTMLSelectElement>('#t-os')!
    act(() => {
      select.value = 'macOS'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const box = host.querySelector<HTMLInputElement>('input[type=checkbox]')!
    act(() => box.click())
    expect(got).toEqual([
      ['os', ['macOS']],
      ['terms', [true]],
    ])
  })
})

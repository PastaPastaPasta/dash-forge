// @vitest-environment jsdom
/**
 * QW2-066: the issue sidebar's pickers carry no control inside a control (a checkbox in an
 * option button), every button has a name, and the assignee swatches are a named picture.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LabelDef } from '@/lib/repo'

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId}</span> }))

const { AssigneePicker, LabelPicker } = await import('./target-rail')
const { AssigneeAvatars } = await import('./issue-bits')

const A = 'AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA'
const B = 'BbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB'
const labels: LabelDef[] = [
  { name: 'bug', color: '#ee0701', description: "Something isn't working", retired: false, createdAt: 1, id: 'l1' },
  { name: 'docs', color: '#0075ca', description: '', retired: false, createdAt: 2, id: 'l2' },
]

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (el: JSX.Element): void => act(() => root.render(el))
const click = (el: Element | null | undefined): void => act(() => (el as HTMLElement).click())
const button = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))

/** Every button has a name (text or aria-label) and holds no other control. */
function expectCleanButtons(): void {
  const buttons = [...host.querySelectorAll('button')]
  expect(buttons.length).toBeGreaterThan(0)
  for (const b of buttons) {
    expect(b.querySelector('input, button, select, textarea, a'), b.outerHTML).toBeNull()
    expect((b.getAttribute('aria-label') ?? b.textContent ?? '').trim(), b.outerHTML).not.toBe('')
  }
}

describe('issue sidebar pickers (QW2-066)', () => {
  it('the assignee picker: tick marks, not nested checkboxes, and a named add button', () => {
    render(<AssigneePicker assignees={[A]} members={[A, B]} canEdit onToggle={() => undefined} />)
    click(button('Edit assignees'))
    const options = [...host.querySelectorAll('[data-testid="assignee-option"]')]
    expect(options.map((o) => o.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    expect(options.map((o) => o.querySelector('[data-checked]') !== null)).toEqual([true, false])
    expectCleanButtons()
    expect(host.querySelector('button[aria-label="Assign this identity"]')).not.toBeNull()
  })

  it('the label picker: tick marks, not nested checkboxes', () => {
    render(<LabelPicker applied={['bug']} defs={labels} byName={new Map(labels.map((l) => [l.name, l]))} canEdit onToggle={() => undefined} onDefine={() => undefined} />)
    click(button('Edit labels'))
    const options = [...host.querySelectorAll('[data-testid="label-option"]')]
    expect(options).toHaveLength(2)
    expect(options.map((o) => o.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    expectCleanButtons()
  })

  it('the assignee swatches are one named picture', () => {
    render(<AssigneeAvatars ids={[A, B]} />)
    const el = host.querySelector('[data-testid="assignees"]')
    expect(el?.getAttribute('role')).toBe('img')
    expect(el?.getAttribute('aria-label')).toBe(`Assigned to ${A.slice(0, 8)}, ${B.slice(0, 8)}`)
  })
})

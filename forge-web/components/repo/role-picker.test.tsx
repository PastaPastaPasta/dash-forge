// @vitest-environment jsdom
/** RC2 member roles: the Collaborators role picker (a reader only on a private repo) and badge. */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role } from '@/lib/rules/v2'
import { RoleBadge, RolePicker } from './role-picker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const offered = (): string[] => [...host.querySelectorAll('[role="radio"]')].map((b) => b.getAttribute('data-role') ?? '')

describe('RolePicker', () => {
  it('offers writer, triage and maintainer on a public repo: no reader', () => {
    act(() => root.render(<RolePicker value="writer" onChange={() => undefined} visibility="public" />))
    expect(offered()).toEqual(['writer', 'triage', 'maintainer'])
  })

  it('offers a reader on a private repo', () => {
    act(() => root.render(<RolePicker value="writer" onChange={() => undefined} visibility="private" />))
    expect(offered()).toEqual(['writer', 'triage', 'reader', 'maintainer'])
  })

  it('marks the picked role, says what each may do, and reports a pick', () => {
    const onChange = vi.fn<(r: Role) => void>()
    act(() => root.render(<RolePicker value="triage" onChange={onChange} visibility="public" />))
    const triage = host.querySelector('[data-role="triage"]') as HTMLButtonElement
    expect(triage.getAttribute('aria-checked')).toBe('true')
    expect(triage.title).toMatch(/Cannot push or merge/)
    act(() => (host.querySelector('[data-role="maintainer"]') as HTMLButtonElement).click())
    expect(onChange).toHaveBeenCalledWith('maintainer')
  })

  it('leaves out an excluded role (a role change does not offer the current one)', () => {
    act(() => root.render(<RolePicker value="writer" onChange={() => undefined} visibility="private" exclude={['writer']} />))
    expect(offered()).toEqual(['triage', 'reader', 'maintainer'])
  })
})

describe('RoleBadge', () => {
  it('names the role', () => {
    act(() => root.render(<RoleBadge role="reader" />))
    expect(host.textContent).toBe('READER')
  })
})

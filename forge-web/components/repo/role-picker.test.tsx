// @vitest-environment jsdom
/** RC2 member roles: the Collaborators role picker (a reader on public and private repos) and badge. */

import { act, useState } from 'react'
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
  it('offers a reader on a public repo too (it reads the members-only content)', () => {
    act(() => root.render(<RolePicker value="writer" onChange={() => undefined} visibility="public" />))
    expect(offered()).toEqual(['writer', 'triage', 'reader', 'maintainer'])
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

  it('QW4-037: is one Tab stop, and the arrow keys move focus and the selection, wrapping', () => {
    function Stateful(): JSX.Element {
      const [role, setRole] = useState<Role>('writer')
      return <RolePicker value={role} onChange={setRole} visibility="public" />
    }
    act(() => root.render(<Stateful />))
    const radio = (r: Role): HTMLButtonElement => host.querySelector(`[data-role="${r}"]`) as HTMLButtonElement
    const press = (key: string): void => {
      act(() => {
        ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }
    expect(['writer', 'triage', 'reader', 'maintainer'].map((r) => radio(r as Role).tabIndex)).toEqual([0, -1, -1, -1])
    act(() => radio('writer').focus())
    press('ArrowRight')
    expect(document.activeElement).toBe(radio('triage'))
    expect(radio('triage').getAttribute('aria-checked')).toBe('true')
    expect(['writer', 'triage', 'reader', 'maintainer'].map((r) => radio(r as Role).tabIndex)).toEqual([-1, 0, -1, -1])
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown')
    expect(document.activeElement).toBe(radio('writer'))
    press('ArrowLeft')
    expect(radio('maintainer').getAttribute('aria-checked')).toBe('true')
    press('Home')
    expect(radio('writer').getAttribute('aria-checked')).toBe('true')
    press('End')
    expect(document.activeElement).toBe(radio('maintainer'))
  })

  it('as a role change, offers plain buttons (picking one opens its confirmation, so the arrows do not pick)', () => {
    const onChange = vi.fn<(r: Role) => void>()
    act(() => root.render(<RolePicker action value="writer" onChange={onChange} visibility="public" exclude={['writer']} />))
    const group = host.querySelector('[data-testid="role-picker"]')!
    expect(group.getAttribute('role')).toBe('group')
    expect(group.querySelector('[role="radio"]')).toBeNull()
    const triage = host.querySelector('[data-role="triage"]') as HTMLButtonElement
    act(() => triage.focus())
    act(() => {
      triage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
    act(() => triage.click())
    expect(onChange).toHaveBeenCalledWith('triage')
  })
})

describe('RoleBadge', () => {
  it('names the role', () => {
    act(() => root.render(<RoleBadge role="reader" />))
    expect(host.textContent).toBe('READER')
  })
})

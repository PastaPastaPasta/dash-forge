// @vitest-environment jsdom
/**
 * Changing an open PR's base (event kind 8): the picker offers the repo's other branches, never
 * the current base or the PR's own source branch, and asks the page to confirm the pick.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EditBase, baseChoices } from './edit-base'

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

const button = (label: string): HTMLButtonElement => {
  const b = [...host.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === label || x.textContent === label)
  if (!b) throw new Error(`no button ${label}`)
  return b
}

describe('baseChoices', () => {
  it('offers every branch but the current base and the PR’s own source, by name', () => {
    expect(baseChoices(['refs/heads/main', 'refs/heads/dev', 'refs/heads/feat', 'refs/tags/v1', 'refs/heads/alpha'], 'refs/heads/main', 'refs/heads/feat')).toEqual([
      'refs/heads/alpha',
      'refs/heads/dev',
    ])
  })
  it('keeps a same-named branch when the source is in a fork', () => {
    expect(baseChoices(['refs/heads/main', 'refs/heads/feat'], 'refs/heads/main', null)).toEqual(['refs/heads/feat'])
  })
})

describe('EditBase', () => {
  it('asks to retarget to the picked branch', () => {
    const onPick = vi.fn()
    act(() => root.render(<EditBase branches={['refs/heads/main', 'refs/heads/dev', 'refs/heads/next']} current="refs/heads/main" source={null} disabledReason={null} onPick={onPick} />))
    act(() => button('Change the base branch').click())
    const select = host.querySelector<HTMLSelectElement>('#pr-base-select')!
    expect([...select.options].map((o) => o.textContent)).toEqual(['dev', 'next'])
    act(() => {
      select.value = 'refs/heads/next'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => button('Change base').click())
    expect(onPick).toHaveBeenCalledWith('refs/heads/next')
    expect(host.querySelector('#pr-base-select')).toBeNull()
  })
  it('is disabled with the reason when the viewer cannot sign', () => {
    act(() => root.render(<EditBase branches={['refs/heads/main', 'refs/heads/dev']} current="refs/heads/main" source={null} disabledReason="Sign in to change the base" onPick={() => {}} />))
    const b = button('Change the base branch')
    expect(b.disabled).toBe(true)
    expect(b.title).toBe('Sign in to change the base')
  })
  it('shows nothing when there is no other branch', () => {
    act(() => root.render(<EditBase branches={['refs/heads/main']} current="refs/heads/main" source={null} disabledReason={null} onPick={() => {}} />))
    expect(host.innerHTML).toBe('')
  })
})

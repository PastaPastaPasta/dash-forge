// @vitest-environment jsdom
/**
 * Settings → Appearance: the theme as three radios (the stored choice checked), and the diff
 * choices, all kept in this browser and shown signed out (the settings page renders it before
 * any identity check).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PREFS_KEY } from '@/lib/view/prefs'

let theme: string | undefined = 'dark'
const setTheme = vi.fn((t: string) => {
  theme = t
})
vi.mock('next-themes', () => ({ useTheme: () => ({ theme, setTheme }) }))

const { AppearancePanel } = await import('./appearance-panel')

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  setTheme.mockClear()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const radio = (value: string): HTMLInputElement => el.querySelector(`input[type="radio"][value="${value}"]`)!
const box = (label: RegExp): HTMLInputElement =>
  [...el.querySelectorAll('label')].find((l) => label.test(l.textContent ?? ''))!.querySelector('input')!

describe('AppearancePanel', () => {
  it('checks the stored theme and sets another', () => {
    theme = 'dark'
    act(() => root.render(<AppearancePanel />))
    expect(radio('dark').checked).toBe(true)
    expect(radio('system').checked).toBe(false)
    // One radio group: one Tab stop, arrows move between the options.
    expect(new Set([...el.querySelectorAll('input[type="radio"]')].map((r) => (r as HTMLInputElement).name))).toEqual(new Set(['theme']))
    act(() => radio('light').click())
    expect(setTheme).toHaveBeenCalledWith('light')
  })

  it('shows an unknown stored theme as System', () => {
    theme = 'sepia'
    act(() => root.render(<AppearancePanel />))
    expect(radio('system').checked).toBe(true)
  })

  it('keeps the diff choices in this browser', () => {
    act(() => root.render(<AppearancePanel />))
    act(() => box(/Blue and orange/).click())
    act(() => box(/Hide whitespace/).click())
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>
    expect(stored['palette']).toBe('colorblind')
    expect(stored['ignoreWhitespace']).toBe(true)
  })

  it('is on the settings page before the sign-in check', () => {
    const page = readFileSync(join(__dirname, '../app/settings/page.tsx'), 'utf8')
    const signedOut = page.slice(page.indexOf('if (!identity) {'), page.indexOf('const credits'))
    expect(signedOut).toContain('{appearance}')
  })
})

/**
 * The WAI-ARIA radio group keyboard pattern (QW4-037) for a `role="radiogroup"` of
 * `role="radio"` buttons: the group is one Tab stop (the checked radio, or the first when none
 * is), and the arrow keys move focus and the selection to the next or previous enabled radio,
 * wrapping; Home and End go to the first and the last. Space and Enter still select, as a
 * button does. https://www.w3.org/WAI/ARIA/apg/patterns/radio/
 */

import type { KeyboardEvent } from 'react'

const FORWARD = new Set(['ArrowRight', 'ArrowDown'])
const BACK = new Set(['ArrowLeft', 'ArrowUp'])

/** The group's `onKeyDown`: moves to the radio the key names and selects it (by clicking it). */
export function onRadioGroupKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const forward = FORWARD.has(e.key)
  const back = BACK.has(e.key)
  if (!forward && !back && e.key !== 'Home' && e.key !== 'End') return
  if (e.altKey || e.ctrlKey || e.metaKey) return
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')].filter(
    (r) => !(r as HTMLButtonElement).disabled && r.getAttribute('aria-disabled') !== 'true',
  )
  if (radios.length === 0) return
  const at = radios.findIndex((r) => r === e.target || r.contains(e.target as Node))
  const index =
    e.key === 'Home' ? 0 : e.key === 'End' ? radios.length - 1 : at === -1 ? 0 : (at + (forward ? 1 : -1) + radios.length) % radios.length
  e.preventDefault()
  const next = radios[index]!
  next.focus()
  if (next.getAttribute('aria-checked') !== 'true') next.click()
}

/** A radio's `tabIndex`: only the checked radio, or the first when none is checked, is a Tab stop. */
export function radioTabIndex(checked: boolean, index: number, anyChecked: boolean): 0 | -1 {
  return checked || (!anyChecked && index === 0) ? 0 : -1
}

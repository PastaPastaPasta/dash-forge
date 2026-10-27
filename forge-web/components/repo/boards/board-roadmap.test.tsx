// @vitest-environment jsdom
/**
 * The board's roadmap layout (design `docs/design/boards.md` §4.3): which fields it plots, the
 * bars and their text, unscheduled items, today and the iterations, zoom, dragging a date bar
 * (one card write), and the list for screen readers.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span>{identityId.slice(0, 4)}</span> }))

import { BoardRoadmap, barOf, roadmapDates, timelineSpan } from './board-roadmap'
import { HOME, NOW, SPEC, dayNo, fold, hookState, id, layoutProps, ITEMS } from './layout-fixture'
import type { BoardLayoutProps } from './layout-props'
import type { BoardSpec } from '@/lib/rules/boards'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const render = (props: BoardLayoutProps): void => act(() => root.render(<BoardRoadmap {...props} />))
const bars = (): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('[data-testid="roadmap-bar"]')]
const rowOf = (c: string): HTMLElement => el.querySelector(`[data-item="${id(c)}"]`) as HTMLElement
const pointer = (target: Element, type: string, clientX: number): void => act(() => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })))

describe('roadmapDates and barOf', () => {
  it('plots the first iteration field by default, else the first two date fields', () => {
    const view = { id: 1, name: 'R', layout: 'roadmap' as const, q: '' }
    expect(roadmapDates(SPEC, view)).toMatchObject({ kind: 'iter', field: { id: 3 } })
    expect(roadmapDates(SPEC, { ...view, date: [4, 5] })).toMatchObject({ kind: 'range', start: { id: 4 }, end: { id: 5 } })
    const noIter: BoardSpec = { ...SPEC, fields: SPEC.fields.filter((f) => f.type !== 'iter') }
    expect(roadmapDates(noIter, view)).toMatchObject({ kind: 'range', start: { id: 4 }, end: { id: 5 } })
    expect(roadmapDates({ ...SPEC, fields: [] }, view)).toBeNull()
  })

  it('runs a bar across its iteration, or between its dates', () => {
    const placements = fold()
    const rowOf = (c: string) => ({ item: ITEMS.find((i) => i.id === id(c))!, placement: placements.get(id(c))! })
    const iter = roadmapDates(SPEC, { id: 1, name: 'R', layout: 'roadmap', q: '' })!
    // Iteration 2 (index 1) of a 14-day cadence from Monday 2026-10-26
    expect(barOf(rowOf('b'), iter)).toEqual({ start: dayNo('2026-11-09'), end: dayNo('2026-11-22'), single: false })
    expect(barOf(rowOf('d'), iter)).toBeNull()
    const range = roadmapDates(SPEC, { id: 1, name: 'R', layout: 'roadmap', q: '', date: [4, 5] })!
    expect(barOf(rowOf('a'), range)).toEqual({ start: dayNo('2026-10-26'), end: dayNo('2026-11-06'), single: false })
    // only a start: a one-day mark
    expect(barOf(rowOf('c'), range)).toEqual({ start: dayNo('2026-11-02'), end: dayNo('2026-11-02'), single: true })
  })

  it('spans whole periods around every bar and today', () => {
    const today = Math.floor(NOW / 86_400_000)
    const s = timelineSpan([{ start: today + 100, end: today + 120, single: false }], today, 'months')
    expect(s.from).toBeLessThanOrEqual(today)
    expect(s.to).toBeGreaterThan(today + 120)
    // months start on the 1st
    expect(new Date(s.from * 86_400_000).toISOString().slice(8, 10)).toBe('01')
    const w = timelineSpan([], today, 'weeks')
    // weeks start on a Monday
    expect(new Date(w.from * 86_400_000).getUTCDay()).toBe(1)
  })
})

describe('BoardRoadmap', () => {
  it('draws a named bar per scheduled item, lists the rest beside it and for screen readers', () => {
    const props = layoutProps({ layout: 'roadmap' })
    render(props)
    // by iteration: a (Iteration 1) and b (Iteration 2) have one
    expect(bars()).toHaveLength(2)
    expect(bars()[0]?.getAttribute('aria-label')).toBe('#1 Write the parser: Oct 26 – Nov 8, 2026, Todo')
    expect(bars()[1]?.getAttribute('aria-label')).toBe('#2 Ship the table: Nov 9 – Nov 22, 2026, In progress')
    const unscheduled = el.querySelector('[data-testid="roadmap-unscheduled"]') as HTMLElement
    expect(unscheduled.textContent).toContain('Unscheduled 3')
    expect(unscheduled.textContent).toContain('Fix the roadmap')
    expect(unscheduled.textContent).toContain('A private item')
    expect(unscheduled.textContent).not.toContain('Secret')
    expect(el.querySelector('[data-testid="roadmap-list"]')?.querySelectorAll('li')).toHaveLength(2)
    expect(el.querySelector('[data-testid="roadmap-today"]')).not.toBeNull()
    // the iteration bands are named in the header
    expect(el.textContent).toContain('Iteration 1')
  })

  it('opens the item from its bar and from the unscheduled list', () => {
    const props = layoutProps({ layout: 'roadmap' }, { state: hookState({ can: { place: false, edit: false } }) })
    render(props)
    act(() => bars()[1]?.click())
    expect(props.onOpenItem).toHaveBeenCalledWith(id('b'))
    const listed = [...el.querySelectorAll<HTMLButtonElement>('[data-testid="roadmap-unscheduled"] button')]
    act(() => listed[0]?.click())
    expect(props.onOpenItem).toHaveBeenCalledTimes(2)
  })

  it('switches zoom', () => {
    render(layoutProps({ layout: 'roadmap' }))
    const zoom = (name: string) => [...el.querySelectorAll<HTMLButtonElement>('[aria-label="Zoom"] button')].find((b) => b.textContent === name) as HTMLButtonElement
    expect(zoom('Months').getAttribute('aria-pressed')).toBe('true')
    const before = bars()[0]?.style.width
    act(() => zoom('Weeks').click())
    expect(zoom('Weeks').getAttribute('aria-pressed')).toBe('true')
    expect(bars()[0]?.style.width).not.toBe(before)
  })

  it('moves a date bar by dragging it: one card write with both dates', async () => {
    const props = layoutProps({ layout: 'roadmap', date: [4, 5] })
    render(props)
    const bar = rowOf('a').querySelector('[data-testid="roadmap-bar"]') as HTMLElement
    expect(bar.getAttribute('aria-label')).toBe('#1 Write the parser: Oct 26 – Nov 6, 2026, Todo')
    // months zoom: 6 px a day, so 42 px is a week
    pointer(bar, 'pointerdown', 100)
    pointer(bar, 'pointermove', 142)
    await act(async () => void bar.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 142 })))
    expect(props.state.write).toHaveBeenCalledTimes(1)
    expect(props.state.write).toHaveBeenCalledWith({ id: id('a'), repoId: HOME }, { fields: { 4: '2026-11-02', 5: '2026-11-13' } })
    expect(props.onOpenItem).not.toHaveBeenCalled()
  })

  it('stretches a bar by its end, and a press without a move opens the item', async () => {
    const props = layoutProps({ layout: 'roadmap', date: [4, 5] })
    render(props)
    const bar = rowOf('a').querySelector('[data-testid="roadmap-bar"]') as HTMLElement
    const end = bar.lastElementChild as HTMLElement
    pointer(end, 'pointerdown', 100)
    pointer(end, 'pointermove', 112)
    await act(async () => void end.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 112 })))
    expect(props.state.write).toHaveBeenCalledWith({ id: id('a'), repoId: HOME }, { fields: { 5: '2026-11-08' } })
    pointer(bar, 'pointerdown', 50)
    await act(async () => void bar.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 51 })))
    expect(props.onOpenItem).toHaveBeenCalledWith(id('a'))
    expect(props.state.write).toHaveBeenCalledTimes(1)
  })

  it('explains itself when the board has no date to plot', () => {
    render(layoutProps({ layout: 'roadmap' }, { spec: { ...SPEC, fields: SPEC.fields.filter((f) => f.type === 'sel') } }))
    expect(el.textContent).toContain('Nothing to plot yet')
  })
})

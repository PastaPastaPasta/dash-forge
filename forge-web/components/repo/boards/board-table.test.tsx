// @vitest-environment jsdom
/**
 * The board's table layout (design `docs/design/boards.md` §4.2): its columns, sort requests,
 * groups with totals, in-place edits (one card write each), the keyboard grid, and what a
 * visitor gets.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/author', () => ({ Author: ({ identityId }: { identityId: string }) => <span data-author={identityId}>{identityId.slice(0, 4)}</span> }))

import { BoardTable, nextSort, tableColumns } from './board-table'
import { HOME, ITEMS, SPEC, hookState, id, layoutProps } from './layout-fixture'
import type { BoardLayoutProps } from './layout-props'

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

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const render = (props: BoardLayoutProps): void => act(() => root.render(<BoardTable {...props} />))
const headers = (): string[] => [...el.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '')
const row = (c: string): HTMLTableRowElement => el.querySelector(`tr[data-item="${id(c)}"]`) as HTMLTableRowElement
const cell = (c: string, i: number): HTMLTableCellElement => row(c).querySelectorAll('td')[i] as HTMLTableCellElement
const key = (target: Element, k: string, init: KeyboardEventInit = {}): void => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })))
const typeInto = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('tableColumns and nextSort', () => {
  it('defaults to Title, Status, Assignees, Labels and every field; Title always leads', () => {
    expect(tableColumns(SPEC, { id: 1, name: 'T', layout: 'table', q: '' })).toEqual(['title', 'status', 'assignees', 'labels', 'f1', 'f2', 'f3', 'f4', 'f5'])
    expect(tableColumns(SPEC, { id: 1, name: 'T', layout: 'table', q: '', cols: ['status', 'title', 'f2'] })).toEqual(['title', 'status', 'f2'])
    expect(tableColumns(SPEC, { id: 1, name: 'T', layout: 'table', q: '', cols: ['number'] })).toEqual(['title', 'number'])
  })
  it('cycles ascending, descending, board order', () => {
    expect(nextSort(undefined, 'title')).toBe('title')
    expect(nextSort('title', 'title')).toBe('-title')
    expect(nextSort('-title', 'title')).toBeUndefined()
    expect(nextSort('-number', 'title')).toBe('title')
  })
})

describe('BoardTable', () => {
  it('shows a row per item with the view columns, a private item as such', () => {
    render(layoutProps({ cols: ['title', 'status', 'f1', 'f2', 'labels'] }))
    expect(headers()).toEqual(['Title', 'Status', 'Priority', 'Estimate', 'Labels'])
    expect(el.querySelectorAll('tbody tr[data-item]')).toHaveLength(5)
    expect(cell('a', 0).textContent).toContain('Write the parser')
    expect(cell('a', 0).textContent).toContain('#1')
    expect(cell('a', 1).textContent).toBe('Todo')
    expect(cell('a', 2).textContent).toBe('P0')
    expect(cell('a', 3).textContent).toBe('3')
    expect(cell('a', 4).textContent).toBe('bug')
    expect(cell('d', 1).textContent).toBe('Done')
    // another repo's item this reader cannot open
    expect(cell('e', 0).textContent).toContain('A private item')
    expect(cell('e', 0).textContent).not.toContain('Secret')
  })

  it('sorts by the view and asks the shell for a header sort', () => {
    const props = layoutProps({ cols: ['title', 'f2'], sort: '-f2' })
    render(props)
    const order = [...el.querySelectorAll('tbody tr[data-item]')].map((r) => r.getAttribute('data-item'))
    // estimates 5, 3, 2; the two without one last
    expect(order.slice(0, 3)).toEqual([id('b'), id('a'), id('c')])
    const th = el.querySelectorAll('thead th')[1] as HTMLElement
    expect(th.getAttribute('aria-sort')).toBe('descending')
    act(() => (el.querySelector('[data-testid="sort-f2"]') as HTMLButtonElement).click())
    expect(props.onViewChange).toHaveBeenCalledWith({ sort: undefined })
    act(() => (el.querySelector('[data-testid="sort-title"]') as HTMLButtonElement).click())
    expect(props.onViewChange).toHaveBeenLastCalledWith({ sort: 'title' })
  })

  it('groups into sections with counts, WIP over its limit, and the number field sum', () => {
    render(layoutProps({ group: 'status', cols: ['title', 'f2'] }))
    const sections = [...el.querySelectorAll('[data-testid="board-table-section"]')]
    expect(sections.map((s) => s.querySelector('th')?.textContent)).toEqual([
      expect.stringContaining('Todo'),
      expect.stringContaining('In progress'),
      expect.stringContaining('Done'),
    ])
    const progress = sections[1] as HTMLElement
    expect(progress.querySelector('[data-testid="section-count"]')?.textContent).toContain('2 / 1')
    expect(progress.querySelector('[data-testid="section-count"]')?.className).toContain('danger')
    expect(progress.querySelector('[data-testid="section-sum"]')?.textContent).toBe('Estimate: 7')
    expect(sections[0]?.querySelector('[data-testid="section-sum"]')?.textContent).toBe('Estimate: 3')
  })

  it('edits Status in place with one card write of its column', async () => {
    const props = layoutProps({ cols: ['title', 'status'] })
    render(props)
    act(() => cell('a', 1).click())
    const select = cell('a', 1).querySelector('select') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(document.activeElement).toBe(select)
    await act(async () => {
      select.value = '2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(props.state.write).toHaveBeenCalledTimes(1)
    expect(props.state.write).toHaveBeenCalledWith({ id: id('a'), repoId: HOME }, { col: 2 })
    expect(cell('a', 1).querySelector('select')).toBeNull()
  })

  it('moves through the grid with the keyboard, edits with Enter, cancels with Escape', async () => {
    const props = layoutProps({ cols: ['title', 'status', 'f2'] })
    render(props)
    const first = cell('a', 0)
    expect(first.tabIndex).toBe(0)
    expect(cell('a', 1).tabIndex).toBe(-1)
    act(() => first.focus())
    key(first, 'ArrowRight')
    key(document.activeElement as Element, 'ArrowRight')
    expect(document.activeElement).toBe(cell('a', 2))
    expect(cell('a', 2).tabIndex).toBe(0)
    expect(first.tabIndex).toBe(-1)
    // Escape leaves the value alone, and focus comes back to the cell
    key(cell('a', 2), 'Enter')
    let input = cell('a', 2).querySelector('input') as HTMLInputElement
    typeInto(input, '9')
    key(input, 'Escape')
    await settle()
    expect(props.state.write).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(cell('a', 2))
    // Enter writes it
    key(cell('a', 2), 'Enter')
    input = cell('a', 2).querySelector('input') as HTMLInputElement
    typeInto(input, '8')
    await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    await settle()
    expect(props.state.write).toHaveBeenCalledWith({ id: id('a'), repoId: HOME }, { fields: { 2: 8 } })
    // a bad number is refused before any write; fixed, and left, it is written
    key(cell('a', 2), 'Enter')
    input = cell('a', 2).querySelector('input') as HTMLInputElement
    typeInto(input, 'lots')
    key(input, 'Enter')
    expect(cell('a', 2).querySelector('[role="alert"]')?.textContent).toBe('Enter a number.')
    expect(props.state.write).toHaveBeenCalledTimes(1)
    typeInto(input, '6')
    act(() => input.blur())
    expect(props.state.write).toHaveBeenLastCalledWith({ id: id('a'), repoId: HOME }, { fields: { 2: 6 } })
    expect(cell('a', 2).querySelector('input')).toBeNull()
    // down a row, and Enter on the title opens the item
    act(() => cell('a', 2).focus())
    key(cell('a', 2), 'ArrowDown')
    key(document.activeElement as Element, 'Home')
    key(document.activeElement as Element, 'Enter')
    expect(props.onOpenItem).toHaveBeenCalledWith(id('b'))
  })

  it('leaving an editor (Tab, a click elsewhere) leaves focus where it went; a refused value is put back', async () => {
    const props = layoutProps({ cols: ['title', 'f2'] })
    const outside = document.createElement('input')
    document.body.append(outside)
    render(props)
    act(() => cell('a', 1).click())
    const input = cell('a', 1).querySelector('input') as HTMLInputElement
    typeInto(input, 'lots')
    act(() => outside.focus())
    await settle()
    expect(document.activeElement).toBe(outside)
    expect(cell('a', 1).querySelector('input')).toBeNull()
    expect(cell('a', 1).textContent).toBe('3')
    expect(props.state.write).not.toHaveBeenCalled()
    outside.remove()
  })

  it('keeps an edit on its item when a poll reorders the rows', async () => {
    const props = layoutProps({ cols: ['title', 'f2'] })
    render(props)
    act(() => cell('a', 1).click())
    const input = cell('a', 1).querySelector('input') as HTMLInputElement
    typeInto(input, '4')
    // a poll: item b now sorts first
    render({ ...props, rows: [...props.rows].reverse(), view: { ...props.view, sort: '-number' } })
    expect(row('a').querySelector('input')).toBe(input)
    expect(row('e').querySelector('input')).toBeNull()
    await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(props.state.write).toHaveBeenCalledWith({ id: id('a'), repoId: HOME }, { fields: { 2: 4 } })
  })

  it('a closed item’s Status offers no column before Done', () => {
    render(layoutProps({ cols: ['title', 'status'] }))
    act(() => cell('d', 1).click())
    const options = [...(cell('d', 1).querySelector('select') as HTMLSelectElement).options]
    expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
      ['Todo', true],
      ['In progress', true],
      ['Done', false],
    ])
    expect(cell('d', 1).querySelector('select')?.getAttribute('title')).toBe('Closed items show in Done, or in a column after it.')
  })

  it('a keyboard step through a select writes on Enter, once', async () => {
    const props = layoutProps({ cols: ['title', 'f1'] })
    render(props)
    act(() => cell('a', 1).click())
    const select = cell('a', 1).querySelector('select') as HTMLSelectElement
    for (const v of ['2', '3']) {
      key(select, 'ArrowDown')
      await act(async () => {
        select.value = v
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    expect(props.state.write).not.toHaveBeenCalled()
    await act(async () => void select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(props.state.write).toHaveBeenCalledTimes(1)
    expect(props.state.write).toHaveBeenCalledWith({ id: id('a'), repoId: HOME }, { fields: { 1: 3 } })
  })

  it('opens the item from a row; a visitor edits nothing', () => {
    const props = layoutProps({ cols: ['title', 'status'] }, { state: hookState({ can: { place: false, edit: false } }) })
    render(props)
    act(() => cell('b', 1).click())
    expect(cell('b', 1).querySelector('select')).toBeNull()
    expect(props.onOpenItem).toHaveBeenCalledWith(id('b'))
    expect(cell('b', 1).getAttribute('aria-readonly')).toBe('true')
  })

  it('marks archived and pending rows', () => {
    const base = layoutProps({ cols: ['title'] })
    const placements = new Map(base.placements)
    placements.set(id('d'), { ...(placements.get(id('d')) as NonNullable<ReturnType<typeof placements.get>>), archived: 'auto' })
    render({ ...base, placements, items: ITEMS, rows: ITEMS.map((item) => ({ item, placement: placements.get(item.id)! })), state: hookState({ pending: new Set([id('b')]) }) })
    expect(cell('d', 0).querySelector('[data-testid="archived-badge"]')).not.toBeNull()
    expect(row('b').getAttribute('aria-busy')).toBe('true')
    expect(cell('b', 0).textContent).toContain('Saving')
  })

  it('says so when nothing matches', () => {
    render(layoutProps({}, { items: [], rows: [] }))
    expect(el.textContent).toContain('No items match')
  })
})

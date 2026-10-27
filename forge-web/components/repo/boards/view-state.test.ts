/**
 * The board page's view state (`docs/design/boards.md` §4): the URL's unsaved changes over a saved
 * view, filtering, the board layout's columns and lanes, and where a drop in a filtered column lands.
 */

import { describe, expect, it } from 'vitest'

import { foldBoard, parseBoardQuery } from '@/lib/rules/boards'

import { CARDS, HOME, ITEMS, ME, NOW, SPEC, id } from './layout-fixture'
import { asksArchived, beforeOf, changeParams, dropIndex, effectiveView, kanbanLayout, rankedColumn, readUrlView, shownRows, withArchived } from './view-state'

const fold = foldBoard({ spec: SPEC, home: HOME, items: ITEMS, cards: CARDS, now: NOW })
const url = (q: string) => readUrlView(new URLSearchParams(q))

describe('the view in force', () => {
  it('starts from the saved view the URL names, else the first, and marks URL changes as unsaved', () => {
    expect(effectiveView(SPEC, url('')).view.name).toBe('Board')
    expect(effectiveView(SPEC, url('')).dirty).toBe(false)
    expect(effectiveView(SPEC, url('view=2')).view.layout).toBe('table')
    const changed = effectiveView(SPEC, url('view=1&q=label:bug&lane=f1&sort=-f2'))
    expect(changed.dirty).toBe(true)
    expect(changed.view).toMatchObject({ id: 1, q: 'label:bug', lane: 'f1', sort: '-f2' })
    // The saved values again are no change.
    expect(effectiveView(SPEC, url('view=1&q=')).dirty).toBe(false)
  })

  it('writes a layout change as params, an emptied key as an empty param', () => {
    expect(changeParams({ sort: 'title', group: undefined })).toEqual({ sort: 'title', group: '' })
    expect(changeParams({ cols: ['title', 'f1'] })).toEqual({ cols: 'title,f1' })
  })

  it('toggles is:archived in the query', () => {
    expect(withArchived('label:bug', true)).toBe('label:bug is:archived')
    expect(asksArchived('label:bug is:archived')).toBe(true)
    expect(withArchived('label:bug IS:archived', false)).toBe('label:bug')
  })
})

describe('filtering and grouping', () => {
  it('shows the items the query matches, @me as the signed-in identity', () => {
    const shown = (q: string, me: string | null = ME) => shownRows(ITEMS, fold, SPEC, parseBoardQuery(q, SPEC), { me, now: NOW }).map((r) => r.item.number)
    expect(shown('')).toEqual([1, 2, 3, 4, 5])
    expect(shown('label:bug')).toEqual([1])
    expect(shown('assignee:@me')).toEqual([2])
    expect(shown('assignee:@me', null)).toEqual([])
    expect(shown('status:"In progress"')).toEqual([2, 3])
    expect(shown('priority:P0')).toEqual([1])
  })

  it('makes a column per status and per lane value', () => {
    const rows = shownRows(ITEMS, fold, SPEC, parseBoardQuery('', SPEC), { me: ME, now: NOW })
    const plain = kanbanLayout(rows, SPEC, { id: 1, name: 'B', layout: 'board', q: '' }, NOW)
    expect(plain.columns.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect(plain.columns.map((c) => c.items.length)).toEqual([2, 2, 1])
    const laned = kanbanLayout(rows, SPEC, { id: 1, name: 'B', layout: 'board', q: '', lane: 'f1' }, NOW)
    // "No Priority" first (items 3, 4, 5), then P0 and P1 holding one each, then the empty P2 and P3.
    expect(laned.lanes.map((l) => l.key)).toEqual([null, 1, 2, 3, 4])
    expect(laned.lanes[1]?.cells.get('c1')).toEqual([id('a')])
    // Grouped by a select field: its options are the columns, Status cannot be the lane.
    const byField = kanbanLayout(rows, SPEC, { id: 1, name: 'B', layout: 'board', q: '', group: 'f1', lane: 'status' }, NOW)
    expect(byField.columns[0]?.key).toEqual({ kind: 'field', field: 1, value: null })
    expect(byField.lane).toBeNull()
  })

  it('drops into a filtered column just where the gap is', () => {
    const ranked = [{ id: 'a', rank: '1' }, { id: 'h', rank: '2' }, { id: 'b', rank: '3' }, { id: 'x', rank: '4' }]
    // Shown: a, b (h hidden by the filter). Before b; after the last shown: before what follows it (x).
    expect(beforeOf(['a', 'b'], ranked, 1, 'm')).toBe('b')
    expect(beforeOf(['a', 'b'], ranked, 2, 'm')).toBe('x')
    expect(beforeOf([], ranked, 0, 'm')).toBeNull()
    expect(dropIndex([10, 30, 50], 35)).toBe(2)
    expect(dropIndex([10, 30], 99)).toBe(2)
    expect(rankedColumn(fold, { kind: 'status', col: 2 }).map((c) => c.id)).toEqual([id('b'), id('c')])
  })
})

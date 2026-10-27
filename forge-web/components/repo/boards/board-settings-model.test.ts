/**
 * The board settings editor's pure half and the new-board templates (design
 * `docs/design/boards.md` §2.7, §8): ids, name checks, deleting what views point at, the size,
 * and that every template is a definition the rules accept.
 */

import { describe, expect, it } from 'vitest'

import { defaultSpec, parseSpec, serializeSpec, SPEC_MAX_BYTES, type BoardSpec } from '@/lib/rules/boards'
import { BOARD_TEMPLATES, boardTemplate } from './board-templates'
import { clampedInt, cleanView, entryProblem, hasNameProblems, moved, nameProblem, newEntry, nextId, sameSpec, specBytes, trimNames, usedIds, withoutColumn, withoutField } from './board-settings-model'

const HOME = 'Home1111111111111111111111111111111111111111'
const NOW = Date.UTC(2026, 9, 27, 12)
const SPEC = defaultSpec(HOME, NOW)

describe('board templates', () => {
  it.each(BOARD_TEMPLATES.map((t) => [t.key, t] as const))('%s is a definition the rules write and read back', (_key, t) => {
    const spec = t.spec(HOME, NOW)
    const out = serializeSpec(spec)
    expect('json' in out ? parseSpec(out.json) : out).toEqual({ spec })
  })
  it('Kanban is the rules template; Bug triage sources issues labelled bug; Empty sources nothing', () => {
    expect(boardTemplate('kanban').spec(HOME, NOW)).toEqual(defaultSpec(HOME, NOW))
    expect(boardTemplate('triage').spec(HOME, NOW).sources).toEqual([{ r: HOME, k: 'i', q: 'label:bug' }])
    expect(boardTemplate('sprint').spec(HOME, NOW).columns.map((c) => c.name)).toEqual(['Backlog', 'Todo', 'In progress', 'In review', 'Done'])
    expect(boardTemplate('sprint').spec(HOME, NOW).fields.map((f) => f.type)).toEqual(['iter', 'num'])
    const empty = boardTemplate('empty').spec(HOME, NOW)
    expect(empty.columns).toHaveLength(1)
    expect(empty.sources).toEqual([])
    expect(boardTemplate('nonsense').key).toBe('kanban')
  })
})

describe('ids never come back', () => {
  it('takes one past every id the entries, the saved board and the cards name; none past 255', () => {
    expect(nextId([])).toBe(1)
    expect(nextId([{ id: 1 }, { id: 5 }])).toBe(6)
    // column 3 was deleted in the draft, but cards still name it
    expect(nextId([{ id: 1 }, { id: 2 }], [3])).toBe(4)
    expect(nextId([{ id: 255 }, { id: 1 }])).toBeNull()
    expect(nextId([{ id: 1 }], [255])).toBeNull()
  })
  it('reads the ids cards name: columns, fields and each field’s option values', () => {
    const cards = [
      { col: 7, f: JSON.stringify({ 1: 9, 2: 3.5, 12: 'x' }) },
      { col: null, f: '{"5":4,"abc":1,"300":2}' },
      { col: 0, f: 'not json' },
    ]
    const used = usedIds(cards, SPEC)
    expect([...used.columns].sort((a, b) => a - b)).toEqual([1, 2, 3, 7])
    expect([...used.fields].sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 12])
    expect([...(used.options.get(1) ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 9])
    expect([...(used.options.get(5) ?? [])]).toEqual([4])
  })
  it('names a new entry after its noun, and none when no id is left', () => {
    expect(newEntry(SPEC.columns, 'Column', [7])).toEqual({ id: 8, name: 'Column 4' })
    expect(newEntry([{ id: 1, name: 'column 2' }], 'Column')).toEqual({ id: 2, name: 'Column 3' })
    expect(newEntry([{ id: 255, name: 'x' }], 'Column')).toBeNull()
  })
  it('moves an entry and leaves bad moves alone', () => {
    expect(moved(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moved(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moved(['a', 'b'], 0, 5)).toEqual(['a', 'b'])
  })
})

describe('nameProblem', () => {
  it('says what is wrong with a name', () => {
    expect(nameProblem('Todo', ['Done'], 'column')).toBeNull()
    expect(nameProblem('', [], 'column')).toBe('Give it a name.')
    expect(nameProblem('x'.repeat(64), [], 'column')).toBe('Names are at most 63 characters.')
    expect(nameProblem(' Todo', [], 'column')).toBe('Names don’t start or end with a space.')
    expect(nameProblem('say "hi"', [], 'view')).toBe('Names can’t hold quotes or control characters.')
    expect(nameProblem('done', ['Done'], 'column')).toBe('Another column has this name.')
    expect(nameProblem('Due: soon', [], 'field')).toBe('Field names can’t hold a colon or start with a dash.')
    expect(nameProblem('-x', [], 'field')).toBe('Field names can’t hold a colon or start with a dash.')
    expect(nameProblem('Status', [], 'field')).toBe('“Status” is a built-in field.')
    // a column may be called Status
    expect(nameProblem('Status', [], 'column')).toBeNull()
    expect(entryProblem([{ id: 1, name: 'Todo ' }, { id: 2, name: 'todo' }], { id: 2, name: 'todo' }, 'column')).toBe('Another column has this name.')
    expect(hasNameProblems(SPEC)).toBe(false)
    expect(hasNameProblems({ ...SPEC, views: [{ id: 1, name: 'A', layout: 'board', q: '' }, { id: 2, name: 'a', layout: 'board', q: '' }] })).toBe(true)
  })
  it('reads a typed whole number when it is left, clamped', () => {
    expect(clampedInt('21', 1, 90)).toBe(21)
    expect(clampedInt('121', 1, 90)).toBe(90)
    expect(clampedInt('0', 1, 90)).toBe(1)
    expect(clampedInt('', 1, 90)).toBeNull()
    expect(clampedInt('1.5', 1, 90)).toBeNull()
  })
})

describe('deleting what views point at', () => {
  it('drops a deleted field from every view, so the definition still saves', () => {
    const spec: BoardSpec = { ...SPEC, views: [...SPEC.views, { id: 4, name: 'By priority', layout: 'board', q: '', group: 'f1', lane: 'f3', sort: '-f2' }] }
    const out = withoutField(withoutField(spec, 3), 1)
    expect(out.fields.map((f) => f.id)).toEqual([2])
    expect(out.views.find((v) => v.id === 3)).toEqual({ id: 3, name: 'Roadmap', layout: 'roadmap', q: '' })
    expect(out.views.find((v) => v.id === 2)?.cols).toEqual(['title', 'status', 'assignees', 'f2'])
    expect(out.views.find((v) => v.id === 4)).toEqual({ id: 4, name: 'By priority', layout: 'board', q: '', sort: '-f2' })
    expect('json' in serializeSpec(out)).toBe(true)
  })
  it('drops a table column list that empties (the default columns show)', () => {
    expect(cleanView({ id: 1, name: 'V', layout: 'table', q: '', cols: ['f9'] }, SPEC.fields)).toEqual({ id: 1, name: 'V', layout: 'table', q: '' })
  })
  it('drops a grouping the board layout does not take', () => {
    expect(cleanView({ id: 1, name: 'V', layout: 'board', q: '', group: 'assignee' }, SPEC.fields)).toEqual({ id: 1, name: 'V', layout: 'board', q: '' })
    expect(cleanView({ id: 1, name: 'V', layout: 'table', q: '', group: 'assignee', lane: 'assignee' }, SPEC.fields)).toEqual({ id: 1, name: 'V', layout: 'table', q: '', group: 'assignee' })
  })
  it('a deleted Default or Done column becomes none', () => {
    const out = withoutColumn(SPEC, 3)
    expect(out.done).toBe(0)
    expect(out.def).toBe(1)
    expect(withoutColumn(SPEC, 1).def).toBe(0)
  })
})

describe('size and sameness', () => {
  it('measures the canonical bytes, and says when it is over', () => {
    expect(specBytes(SPEC)).toBe(new TextEncoder().encode((serializeSpec(SPEC) as { json: string }).json).length)
    const big: BoardSpec = { ...SPEC, desc: 'é'.repeat(1000), sources: Array.from({ length: 5 }, () => ({ r: HOME, k: 'a' as const, q: 'x'.repeat(500) })) }
    expect(specBytes(big)).toBeGreaterThan(SPEC_MAX_BYTES)
    expect(specBytes({ ...SPEC, columns: [] })).toBeNull()
  })
  it('compares by the written bytes, and trims names', () => {
    expect(sameSpec(SPEC, { ...SPEC, desc: '' })).toBe(true)
    expect(sameSpec(SPEC, { ...SPEC, desc: 'x' })).toBe(false)
    expect(sameSpec(SPEC, { ...SPEC, arch: 0 })).toBe(false)
    const padded = trimNames({ ...SPEC, columns: [{ id: 1, name: ' Todo ' }] })
    expect(padded.columns[0]?.name).toBe('Todo')
  })
})

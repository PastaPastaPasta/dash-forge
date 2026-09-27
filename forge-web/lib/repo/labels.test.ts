import { describe, expect, it } from 'vitest'

import { checkLabelInput, labelTextColor, newestLabels } from './labels'

describe('label definitions', () => {
  it('keeps the newest definition per name, sorted by name', () => {
    const labels = newestLabels([
      { $id: 'a', $createdAt: 1, name: 'bug', color: '#D73A4A', description: 'old' },
      { $id: 'b', $createdAt: 5, name: 'bug', color: '#b60205', description: 'new' },
      { $id: 'c', $createdAt: 2, name: 'Docs', color: 'red' },
      { $id: 'd', $createdAt: 3, name: '' },
    ])
    expect(labels.map((l) => [l.name, l.color, l.description])).toEqual([
      ['bug', '#b60205', 'new'],
      ['Docs', '', ''], // a malformed colour reads as none
    ])
  })

  it('breaks a same-time tie by id, as forge-core does', () => {
    const labels = newestLabels([
      { $id: 'b', $createdAt: 1, name: 'x', color: '#000000' },
      { $id: 'a', $createdAt: 1, name: 'x', color: '#ffffff' },
    ])
    expect(labels[0]?.color).toBe('#000000')
  })

  it('refuses what the schema refuses', () => {
    expect(() => checkLabelInput({ name: ' ' })).toThrow(/name/)
    expect(() => checkLabelInput({ name: 'x'.repeat(31) })).toThrow(/30/)
    expect(() => checkLabelInput({ name: 'ok', color: 'red' })).toThrow(/colour/)
    expect(() => checkLabelInput({ name: 'ok', description: 'd'.repeat(201) })).toThrow(/200/)
    expect(() => checkLabelInput({ name: 'ok', color: '#1f883d', description: 'fine' })).not.toThrow()
  })

  it('picks readable text on light and dark fills', () => {
    expect(labelTextColor('#fef2c0')).toBe('#1f2328')
    expect(labelTextColor('#0052cc')).toBe('#ffffff')
    expect(labelTextColor('nope')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'

import { checkLabelInput, contrastRatio, LABEL_COLORS, labelTextColor, newestLabels } from './labels'

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

  it('meets 4.5:1 against the colour it renders, mid-tone fills included (QW2-067)', () => {
    // The fills axe flagged: the ink (#1f2328) on them was 3.51:1 and 4.16:1.
    for (const fill of ['#ee0701', '#128a0c', '#159818']) {
      expect(contrastRatio(fill, labelTextColor(fill) ?? ''), fill).toBeGreaterThanOrEqual(4.5)
    }
    // A sweep of the colour cube, and GitHub's palette.
    const steps = ['00', '15', '33', '66', '80', '98', 'b0', 'cc', 'ee', 'ff']
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const fill = `#${r}${g}${b}`
      expect(contrastRatio(fill, labelTextColor(fill) ?? ''), fill).toBeGreaterThanOrEqual(4.5)
    }
    for (const fill of LABEL_COLORS) expect(contrastRatio(fill, labelTextColor(fill) ?? ''), fill).toBeGreaterThanOrEqual(4.5)
    // Light fills keep the theme's ink rather than jumping to black.
    expect(labelTextColor('#ffffff')).toBe('#1f2328')
  })
})

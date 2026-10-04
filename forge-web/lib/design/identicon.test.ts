/** The identicon avatar: deterministic, mirrored, never empty, and AA-coloured. */

import { describe, expect, it } from 'vitest'

import { hslToRgb, whiteContrast } from './avatar'
import { identiconCells, identiconFill, IDENTICON_SIZE } from './identicon'

describe('identicon', () => {
  it('draws the same pattern for the same seed and another for another', () => {
    expect(identiconCells('alice')).toEqual(identiconCells('alice'))
    const seeds = ['alice', 'bob', 'carol', 'dave', 'erin']
    const patterns = new Set(seeds.map((s) => JSON.stringify(identiconCells(s))))
    expect(patterns.size).toBe(seeds.length)
  })

  it('is a 5×5 grid mirrored left to right, with at least one cell filled', () => {
    for (let i = 0; i < 200; i++) {
      const cells = identiconCells(`seed-${i}`)
      expect(cells).toHaveLength(IDENTICON_SIZE)
      for (const row of cells) {
        expect(row).toHaveLength(IDENTICON_SIZE)
        expect(row).toEqual([...row].reverse())
      }
      expect(cells.some((r) => r.some(Boolean))).toBe(true)
    }
  })

  it('colours with an AA fill', () => {
    const m = /hsl\((\d+) 45% (\d+)%\)/.exec(identiconFill('alice'))
    expect(m).not.toBeNull()
    expect(whiteContrast(hslToRgb(Number(m![1]), 0.45, Number(m![2]) / 100))).toBeGreaterThanOrEqual(4.5)
  })
})

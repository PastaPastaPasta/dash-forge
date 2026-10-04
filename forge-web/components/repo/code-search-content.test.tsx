import { describe, expect, it } from 'vitest'

import type { ResultLine } from '@/lib/view/code-match'
import { collapsed } from './code-search-content'

const line = (n: number, hit: boolean): ResultLine => ({ n, text: `l${n}`, ranges: hit ? [[0, 1]] : [], clippedStart: false, clippedEnd: false })

describe('a result collapsed', () => {
  it('stops after the third matching line and its next line of context, even inside one run', () => {
    // An include block: ten matching lines in a row, with context either side.
    const lines = [line(3, false), ...Array.from({ length: 10 }, (_, i) => line(4 + i, true)), line(14, false)]
    expect(collapsed(lines).map((l) => l.n)).toEqual([3, 4, 5, 6])
    const spread = [line(1, true), line(2, false), line(9, false), line(10, true), line(11, false), line(20, true), line(21, false), line(40, true)]
    expect(collapsed(spread).map((l) => l.n)).toEqual([1, 2, 9, 10, 11, 20, 21])
  })
})

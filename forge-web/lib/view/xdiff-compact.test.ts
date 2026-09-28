/**
 * The xdiff compaction port (F-5): its whitespace is git's, and a failure inside it never fails a
 * blame (lineMap falls back to the uncompacted alignment).
 */

import { describe, expect, it, vi } from 'vitest'

import { getIndent } from './xdiff-compact'

describe('getIndent (xdiffi.c get_indent)', () => {
  it('counts spaces and tabs (to the next multiple of 8)', () => {
    expect(getIndent('    x\n')).toBe(4)
    expect(getIndent('\tx\n')).toBe(8)
    expect(getIndent('  \tx\n')).toBe(8)
  })

  it('treats a line of space, \\t, \\n and \\r only as blank (-1), as git’s isspace does', () => {
    expect(getIndent('  \t\r\n')).toBe(-1)
  })

  it('does not treat \\v or \\f as whitespace (git’s isspace does not)', () => {
    expect(getIndent('\vx\n')).toBe(0)
    expect(getIndent('\f\n')).toBe(0)
  })
})

describe('lineMap when compaction fails', () => {
  it('falls back to the uncompacted alignment instead of throwing', async () => {
    vi.resetModules()
    vi.doMock('./xdiff-compact', () => ({
      compactChanges: () => {
        throw new Error('xdiff compaction: group sync broken')
      },
    }))
    const { lineMap } = await import('./blame-core')
    expect([...(lineMap('a\nb\n', 'a\nx\nb\n') as Int32Array)]).toEqual([0, -1, 1])
    vi.doUnmock('./xdiff-compact')
  })
})

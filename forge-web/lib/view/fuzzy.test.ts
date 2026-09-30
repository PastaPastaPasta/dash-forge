/** Go to file's fuzzy ranking (QW-028): GitHub's file finder, which dash's QA compared against. */

import { describe, expect, it } from 'vitest'

import { fuzzyMatch, fuzzyRank } from './fuzzy'

const DASH = [
  'src/test/evo_trivialvalidation.cpp',
  'src/test/util/validation.cpp',
  'src/validation.cpp',
  'src/validation.h',
  'src/net_processing.cpp',
  'src/net_processing.h',
  'src/net.cpp',
  'src/qt/locale/dash_de.ts',
  'doc/release-notes.md',
]

describe('fuzzyRank', () => {
  it('puts the file named exactly first, before deeper and longer names', () => {
    expect(fuzzyRank('validation.cpp', DASH, 3).map((h) => h.path)).toEqual([
      'src/validation.cpp',
      'src/test/util/validation.cpp',
      'src/test/evo_trivialvalidation.cpp',
    ])
  })

  it('matches characters in order across word breaks, as GitHub does', () => {
    expect(fuzzyRank('netproc', DASH, 5).map((h) => h.path).sort()).toEqual(['src/net_processing.cpp', 'src/net_processing.h'])
    expect(fuzzyRank('NETPROC.h', DASH, 5)[0]?.path).toBe('src/net_processing.h')
    // Spaces are ignored.
    expect(fuzzyRank('net proc.cpp', DASH, 1)[0]?.path).toBe('src/net_processing.cpp')
  })

  it('finds nothing for an empty query or characters out of order', () => {
    expect(fuzzyRank('  ', DASH, 5)).toEqual([])
    expect(fuzzyRank('ppcten', DASH, 5)).toEqual([])
  })

  it('bounds what it returns', () => {
    expect(fuzzyRank('s', DASH, 2)).toHaveLength(2)
  })
})

describe('fuzzyMatch', () => {
  it('reports the matched positions, preferring a run at the start of a name', () => {
    const m = fuzzyMatch('val', 'src/validation.cpp')
    expect(m?.positions).toEqual([4, 5, 6])
    expect(fuzzyMatch('np', 'src/net_processing.cpp')?.positions).toEqual([4, 8])
  })

  it('keeps positions on the path when lowercasing would change its length', () => {
    const m = fuzzyMatch('md', 'İstanbul/README.md')
    expect(m?.positions.map((p) => 'İstanbul/README.md'[p])).toEqual(['m', 'd'])
  })

  it('is null when a character is missing', () => {
    expect(fuzzyMatch('xyz', 'src/validation.cpp')).toBeNull()
  })

  it('scores a whole-path match highest', () => {
    expect(fuzzyMatch('src/net.cpp', 'src/net.cpp')?.score).toBe(Infinity)
  })
})

import { describe, expect, it } from 'vitest'

import { AncestryError, MAX_ANCESTRY_STEPS, parseAncestry, walkAncestry } from './ancestry'
import { Store } from './diff-fixtures'

describe('parseAncestry (QW3-046)', () => {
  it('splits git ancestry suffixes off a revision', () => {
    expect(parseAncestry('master~5', 'main')).toEqual({ rev: 'master', steps: [{ op: '~', n: 5 }] })
    expect(parseAncestry('v1.0^2~3', 'main')).toEqual({ rev: 'v1.0', steps: [{ op: '^', n: 2 }, { op: '~', n: 3 }] })
    expect(parseAncestry('feature/x^^', 'main')).toEqual({ rev: 'feature/x', steps: [{ op: '^', n: 1 }, { op: '^', n: 1 }] })
    expect(parseAncestry('a4d46dd~', 'main')).toEqual({ rev: 'a4d46dd', steps: [{ op: '~', n: 1 }] })
  })

  it('reads HEAD and @ as the default branch', () => {
    expect(parseAncestry('HEAD~5', 'master')).toEqual({ rev: 'master', steps: [{ op: '~', n: 5 }] })
    expect(parseAncestry('@^', 'develop')).toEqual({ rev: 'develop', steps: [{ op: '^', n: 1 }] })
    expect(parseAncestry('HEAD', 'master')).toEqual({ rev: 'master', steps: [] })
  })

  it('leaves a plain name alone', () => {
    expect(parseAncestry('release/v2', 'main')).toEqual({ rev: 'release/v2', steps: [] })
    expect(parseAncestry('', 'main')).toEqual({ rev: '', steps: [] })
  })
})

describe('walkAncestry', () => {
  // r ← a ← b ← m (a merge of b and side, which forks off a)
  const s = new Store()
  const t = s.files({ 'f.txt': 'x' })
  const r = s.commit(t)
  const a = s.commit(t, [r])
  const b = s.commit(t, [a])
  const side = s.commit(t, [a])
  const m = s.commit(t, [b, side])
  const reader = s.reader()

  it('follows first parents for ~n and the n-th parent for ^n', async () => {
    expect(await walkAncestry(reader, m, [{ op: '~', n: 3 }], 'm~3')).toBe(r)
    expect(await walkAncestry(reader, m, [{ op: '^', n: 2 }], 'm^2')).toBe(side)
    expect(await walkAncestry(reader, m, [{ op: '^', n: 2 }, { op: '~', n: 1 }], 'm^2~')).toBe(a)
    expect(await walkAncestry(reader, m, [{ op: '^', n: 0 }], 'm^0')).toBe(m)
  })

  it('says when the steps lead to no commit', async () => {
    await expect(walkAncestry(reader, m, [{ op: '~', n: 4 }], 'master~4')).rejects.toThrow(new AncestryError('master~4 goes back past the first commit.'))
    await expect(walkAncestry(reader, b, [{ op: '^', n: 2 }], 'b^2')).rejects.toBeInstanceOf(AncestryError)
  })

  it('refuses to walk farther back than it reads', async () => {
    await expect(walkAncestry(reader, m, [{ op: '~', n: MAX_ANCESTRY_STEPS + 1 }], 'm~1001')).rejects.toThrow(/more than 1,000 commits back/)
  })
})

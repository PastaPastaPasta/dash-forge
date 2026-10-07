/**
 * QW2-048: an issue's cross-references ("mentioned this issue in #4") and the merge a close came
 * from ("closed this as completed in #3").
 */

import { describe, expect, it } from 'vitest'

import { ISSUE_CLOSE, ISSUE_REOPEN } from '../rules/transition'
import { CLOSED_IN_WINDOW_MS, closedIn, referencedNumbers } from './cross-refs'

describe('referencedNumbers', () => {
  it('finds #n references, closing or not, deduplicated and ascending', () => {
    expect(referencedNumbers('Refs #2. Fixes #1, see #2 and (#10)')).toEqual([1, 2, 10])
    expect(referencedNumbers('#7 at the start\n#8 on a line')).toEqual([7, 8])
  })

  it('skips #n glued to a word, an entity, another repo or a path, and #0', () => {
    expect(referencedNumbers('issue#3 &#35; owner/repo#4 page.html#5 ##6 #0 #12abc')).toEqual([])
  })

  it('skips code: fenced blocks and inline spans', () => {
    const body = ['Refs #2', '```python', 'x = 1  # comment #9', '```', 'and `#11` in code', '~~~', '#12', '~~~', 'then #13'].join('\n')
    expect(referencedNumbers(body)).toEqual([2, 13])
  })

  it('skips link destinations: an in-page anchor is not a reference', () => {
    expect(referencedNumbers('[Install](#2-install) and ![x](#3) but #4 [see #5](https://x.test/y)')).toEqual([4, 5])
  })

  it('an unclosed fence runs to the end', () => {
    expect(referencedNumbers('#1\n```\n#2\n#3')).toEqual([1])
  })
})

describe('closedIn', () => {
  const pull = (n: number): { number: number } => ({ number: n })
  const merge = (actor: string, createdAt: number): { actor: string; createdAt: number } => ({ actor, createdAt })
  const close = (actor: string, createdAt: number, kind = ISSUE_CLOSE): { kind: number; actor: string; createdAt: number } => ({ kind, actor, createdAt })

  it('names the merge by the same identity just before the close', () => {
    expect(closedIn(close('owner', 1_000_000), [{ pull: pull(3), merge: merge('owner', 990_000) }])).toEqual(pull(3))
  })

  it('takes the latest of several merges in the window', () => {
    const merges = [
      { pull: pull(3), merge: merge('owner', 900_000) },
      { pull: pull(5), merge: merge('owner', 950_000) },
    ]
    expect(closedIn(close('owner', 1_000_000), merges)).toEqual(pull(5))
  })

  it('ignores another identity, a merge after the close, or one too long before it', () => {
    expect(closedIn(close('owner', 1_000_000), [{ pull: pull(3), merge: merge('member', 990_000) }])).toBeNull()
    expect(closedIn(close('owner', 1_000_000), [{ pull: pull(3), merge: merge('owner', 1_000_001) }])).toBeNull()
    expect(closedIn(close('owner', 1_000_000 + CLOSED_IN_WINDOW_MS + 1), [{ pull: pull(3), merge: merge('owner', 1_000_000) }])).toBeNull()
  })

  it('never explains a reopen', () => {
    expect(closedIn(close('owner', 1_000_000, ISSUE_REOPEN), [{ pull: pull(3), merge: merge('owner', 990_000) }])).toBeNull()
  })

  it('judges a close that names its merge by that alone', () => {
    const named = { ...close('owner', 1_000_000), closedByPr: 7 }
    const merges = [{ pull: pull(3), merge: merge('owner', 990_000) }]
    expect(closedIn(named, merges, (n) => (n === 7 ? pull(7) : null))).toEqual(pull(7))
    // a named PR that does not hold is a plain close, never the timing guess
    expect(closedIn(named, merges, () => null)).toBeNull()
    // without a judge (a private repo) the timing match stands
    expect(closedIn(named, merges)).toEqual(pull(3))
  })
})

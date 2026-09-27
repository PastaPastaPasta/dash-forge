import { describe, expect, it } from 'vitest'

import { Store } from './diff-fixtures'
import { appliedSuggestions, prCommits } from './pr-commits'

describe('prCommits', () => {
  it('lists base..head newest first, including merged-in side commits', async () => {
    const s = new Store()
    const t = s.files({ 'a.txt': 'a\n' })
    const base = s.commit(t, [], 'base')
    const other = s.commit(s.files({ 'a.txt': 'b\n' }), [base], 'on main')
    const c1 = s.commit(s.files({ 'a.txt': 'c\n' }), [base], 'feat: one')
    const merge = s.commit(s.files({ 'a.txt': 'd\n' }), [c1, other], "Merge branch 'main' into feature")
    const c2 = s.commit(s.files({ 'a.txt': 'e\n' }), [merge], 'feat: two\n\nbody')
    const r = await prCommits(s.reader(), [other, base], c2)
    expect(r.commits.map((c) => c.subject)).toEqual(['feat: two', "Merge branch 'main' into feature", 'feat: one'])
    expect(r.total).toBe(3)
    expect(r.truncated).toBe(false)
  })

  it('lists the whole history when the base is empty', async () => {
    const s = new Store()
    const a = s.commit(s.files({ x: '1' }), [], 'root')
    const b = s.commit(s.files({ x: '2' }), [a], 'next')
    expect((await prCommits(s.reader(), [''], b)).commits.map((c) => c.oid)).toEqual([b, a])
  })
})

describe('appliedSuggestions', () => {
  it('maps each Forge-Suggestion trailer to the oldest commit naming it', async () => {
    const s = new Store()
    const base = s.commit(s.files({ x: '1' }), [], 'base')
    const one = s.commit(s.files({ x: '2' }), [base], 'Apply suggestions from code review\n\nCo-authored-by: a <a@users.forge.invalid>\nForge-Suggestion: C1\nForge-Suggestion: C2')
    const two = s.commit(s.files({ x: '3' }), [one], 'again\n\nForge-Suggestion: C2')
    const r = await prCommits(s.reader(), [base], two)
    const applied = appliedSuggestions(r.commits)
    expect(applied.get('C1')).toBe(one)
    expect(applied.get('C2')).toBe(one)
    expect(applied.has('base')).toBe(false)
  })
})

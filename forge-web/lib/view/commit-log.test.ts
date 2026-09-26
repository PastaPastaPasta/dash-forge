/** The file list's lazy commit column and the ref bar's commit count. */

import { describe, expect, it } from 'vitest'

import { countCommits, lastCommitsForDir } from './commit-log'
import { Store } from './diff-fixtures'

describe('lastCommitsForDir', () => {
  const s = new Store()
  const c1 = s.commit(s.files({ 'README.md': 'hi', 'src/a.rs': '1', 'src/b.rs': '1' }), [], 'initial')
  const c2 = s.commit(s.files({ 'README.md': 'hi', 'src/a.rs': '2', 'src/b.rs': '1' }), [c1], 'change a')
  const c3 = s.commit(s.files({ 'README.md': 'hello', 'src/a.rs': '2', 'src/b.rs': '1' }), [c2], 'edit readme')

  it('names the newest commit that touched each root entry', async () => {
    const got = await lastCommitsForDir(s.reader(), c3, '', ['README.md', 'src'])
    expect(got.get('README.md')?.subject).toBe('edit readme')
    expect(got.get('src')?.subject).toBe('change a')
  })

  it('works inside a subdirectory and reaches the root commit', async () => {
    const got = await lastCommitsForDir(s.reader(), c3, 'src', ['a.rs', 'b.rs'])
    expect(got.get('a.rs')?.oid).toBe(c2)
    expect(got.get('b.rs')?.oid).toBe(c1)
  })

  it('leaves entries unchanged within the window blank', async () => {
    const got = await lastCommitsForDir(s.reader(), c3, 'src', ['b.rs'], 2)
    expect(got.has('b.rs')).toBe(false)
  })
})

describe('countCommits', () => {
  it('counts first-parent history, capped', async () => {
    const s = new Store()
    let tip = s.commit(s.files({ a: '0' }))
    for (let i = 1; i < 5; i++) tip = s.commit(s.files({ a: String(i) }), [tip])
    expect(await countCommits(s.reader(), tip)).toEqual({ count: 5, capped: false })
    expect(await countCommits(s.reader(), tip, 3)).toEqual({ count: 3, capped: true })
  })
})

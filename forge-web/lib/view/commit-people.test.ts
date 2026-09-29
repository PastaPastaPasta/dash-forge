import { describe, expect, it } from 'vitest'

import { parseCommit } from './git-objects'
import { coAuthorsOf, commitPeople } from './commit-people'

const commit = (author: string, committer: string, message: string) =>
  parseCommit(new TextEncoder().encode(`tree ${'a'.repeat(40)}\nauthor ${author}\ncommitter ${committer}\n\n${message}`))

describe('commitPeople (L-26)', () => {
  it('names the committer and both dates when someone else committed (9dde9e425: DCG-Claude authored, pasta committed)', () => {
    const c = commit('DCG-Claude <c@dcg.dev> 1790208000 +0000', 'pasta <pasta@dash.org> 1790294400 +0000', 'fix: thing\n')
    const p = commitPeople(c)
    expect(p.author.name).toBe('DCG-Claude')
    expect(p.committer).toMatchObject({ name: 'pasta', when: 1790294400000 })
    expect(p.committerIsAuthor).toBe(false)
  })

  it('has no separate committer when the author committed at the same time', () => {
    const who = 'A <a@x> 1700000000 +0000'
    expect(commitPeople(commit(who, who, 'x\n')).committer).toBeNull()
  })

  it('keeps the commit date when the author committed later (a rebase)', () => {
    const p = commitPeople(commit('A <a@x> 1700000000 +0000', 'A <a@x> 1700090000 +0000', 'x\n'))
    expect(p.committer?.when).toBe(1700090000000)
    expect(p.committerIsAuthor).toBe(true)
  })

  it('reads Co-authored-by trailers of the last paragraph only, each co-author once, never the author', () => {
    const msg = 'feat: x\n\nCo-authored-by: Not A Trailer <n@x>\nbody text\n\nSigned-off-by: A <a@x>\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\nco-authored-by: B <b@x>\nCo-authored-by: B <B@x>\nCo-authored-by: A <a@x>\n'
    expect(coAuthorsOf(msg).map((p) => p.name)).toEqual(['Claude Opus 5.5 (1M context)', 'B', 'B', 'A'])
    const p = commitPeople(commit('A <a@x> 1 +0000', 'A <a@x> 1 +0000', msg))
    expect(p.coAuthors).toEqual([
      { name: 'Claude Opus 5.5 (1M context)', email: 'noreply@anthropic.com' },
      { name: 'B', email: 'b@x' },
    ])
  })

  it('a one-paragraph message has no trailers', () => {
    expect(coAuthorsOf('Co-authored-by: B <b@x>\n')).toEqual([])
  })
})

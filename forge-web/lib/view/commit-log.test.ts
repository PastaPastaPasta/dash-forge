/** The file list's lazy commit column and the ref bar's commit count. */

import { describe, expect, it } from 'vitest'

import { countCommits, historyWalker, lastCommitsForDir, walkCommitColumn, type LastCommitColumn } from './commit-log'
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
    const got = await lastCommitsForDir(s.reader(), c3, 'src', ['b.rs'], { limit: 2 })
    expect(got.has('b.rs')).toBe(false)
  })

  // L-41: the column fills in as the walk goes instead of all at once at the end.
  it('reports each step that settles more entries, newest first', async () => {
    const seen: string[][] = []
    await lastCommitsForDir(s.reader(), c3, '', ['README.md', 'src'], { onFound: (found) => seen.push([...found.keys()].sort()) })
    expect(seen).toEqual([['README.md'], ['README.md', 'src']])
  })

  // An older entry on a real repo sits hundreds of commits back (dashpay/dash): 60 left most
  // of the root blank. The default window reaches it.
  it('looks back hundreds of commits by default', async () => {
    const big = new Store()
    let tip = big.commit(big.files({ 'old.txt': 'x', 'hot.txt': '0' }), [], 'add old')
    for (let i = 1; i <= 300; i++) tip = big.commit(big.files({ 'old.txt': 'x', 'hot.txt': String(i) }), [tip], `hot ${i}`)
    const got = await lastCommitsForDir(big.reader(), tip, '', ['old.txt', 'hot.txt'])
    expect(got.get('hot.txt')?.subject).toBe('hot 300')
    expect(got.get('old.txt')?.subject).toBe('add old')
  })

  it('walks through the reader’s read-ahead walker and flushes it', async () => {
    const base = s.reader()
    let flushed = 0
    let walked = 0
    const reader = {
      ...base,
      forHistoryWalk: () => ({
        readObject: (oid: string) => {
          walked++
          return base.readObject(oid)
        },
        flush: () => void flushed++,
      }),
    }
    await lastCommitsForDir(reader, c3, '', ['README.md'])
    await countCommits(reader, c3)
    expect(walked).toBeGreaterThan(0)
    expect(flushed).toBe(2)
  })

  it('shares one walker between the count and the column when given one', async () => {
    let made = 0
    const base = s.reader()
    const reader = { ...base, forHistoryWalk: () => (made++, { ...base, flush: () => undefined }) }
    const walker = historyWalker(reader)
    await Promise.all([lastCommitsForDir(reader, c3, '', ['README.md', 'src'], { walker }), countCommits(reader, c3, 100, { walker })])
    expect(made).toBe(1)
  })

  it('stops when its signal aborts', async () => {
    const big = new Store()
    let tip = big.commit(big.files({ a: '0' }), [], 'root')
    for (let i = 1; i <= 50; i++) tip = big.commit(big.files({ a: '0', b: String(i) }), [tip], `c${i}`)
    const cancel = new AbortController()
    let steps = 0
    const base = big.reader()
    const reader = {
      readObject: (oid: string) => {
        if (++steps === 10) cancel.abort()
        return base.readObject(oid)
      },
    }
    await expect(lastCommitsForDir(reader, tip, '', ['a'], { signal: cancel.signal })).rejects.toThrow()
    expect(steps).toBeLessThan(20)
    await expect(countCommits(reader, tip, 1000, { signal: cancel.signal })).rejects.toThrow()
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

describe('walkCommitColumn (the repo home’s commit column)', () => {
  /** A history where `a` changes at the tip, `b` 30 commits down, and the read breaks at 10. */
  function history() {
    const st = new Store()
    let tip = st.commit(st.files({ a: '0', b: '0' }), [], 'root')
    tip = st.commit(st.files({ a: '0', b: '1' }), [tip], 'b changed')
    for (let i = 1; i <= 30; i++) tip = st.commit(st.files({ a: '0', b: '1', c: String(i) }), [tip], `c${i}`)
    tip = st.commit(st.files({ a: '1', b: '1', c: '30' }), [tip], 'a changed')
    return { st, tip }
  }

  it('keeps what the walk found when it fails later', async () => {
    const { st, tip } = history()
    const base = st.reader()
    let reads = 0
    const reader = {
      readObject: (oid: string) => {
        if (++reads > 12) return Promise.reject(new Error('node went away'))
        return base.readObject(oid)
      },
    }
    const states: LastCommitColumn[] = []
    await walkCommitColumn(reader, tip, ['a', 'b'], (s) => states.push(s))
    const last = states[states.length - 1] as LastCommitColumn
    expect(last.done).toBe(true)
    expect(last.failed).toBe(true)
    expect(last.found.get('a')?.subject).toBe('a changed')
    expect(last.found.has('b')).toBe(false)
    expect(states[0]).toEqual({ found: new Map(), done: false, failed: false })
  })

  it('reports nothing once aborted', async () => {
    const { st, tip } = history()
    const stop = new AbortController()
    const states: LastCommitColumn[] = []
    await walkCommitColumn(st.reader(), tip, ['a', 'b'], (s) => {
      states.push(s)
      if (s.found.size > 0) stop.abort()
    }, { signal: stop.signal })
    expect(states.every((s) => !s.done)).toBe(true)
  })

  it('finishes with every name it found and done set', async () => {
    const { st, tip } = history()
    const states: LastCommitColumn[] = []
    await walkCommitColumn(st.reader(), tip, ['a', 'b'], (s) => states.push(s))
    const last = states[states.length - 1] as LastCommitColumn
    expect(last).toMatchObject({ done: true, failed: false })
    expect([...last.found.keys()].sort()).toEqual(['a', 'b'])
  })
})

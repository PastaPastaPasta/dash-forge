/** The file list's lazy commit column and the ref bar's commit count. */

import { describe, expect, it, vi } from 'vitest'

import { countCommits, historyWalker, lastCommitsForDir, walkCommitColumn, WALK_TREES_AHEAD, type IndexedHistory, type LastCommit, type LastCommitColumn } from './commit-log'
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

  // QW4-004: a column walked from a tag on dashpay/dash read 400 commits' trees one after the
  // other, each its own index and pack query (180 requests). Read side by side, they share queries.
  it('reads the trees of the commits ahead side by side, with the same answer', async () => {
    const big = new Store()
    let tip = big.commit(big.files({ 'old.txt': 'x', 'hot.txt': '0' }), [], 'add old')
    for (let i = 1; i <= 120; i++) tip = big.commit(big.files({ 'old.txt': 'x', 'hot.txt': String(i) }), [tip], `hot ${i}`)
    const base = big.reader()
    let inFlight = 0
    let most = 0
    const reader = {
      readObject: async (oid: string) => {
        inFlight += 1
        most = Math.max(most, inFlight)
        await new Promise((r) => setTimeout(r, 0))
        inFlight -= 1
        return base.readObject(oid)
      },
    }
    const got = await lastCommitsForDir(reader, tip, '', ['old.txt', 'hot.txt'])
    expect(got.get('old.txt')?.subject).toBe('add old')
    expect(got.get('hot.txt')?.subject).toBe('hot 120')
    expect(most).toBeGreaterThan(WALK_TREES_AHEAD / 2)
  })

  it('reads nothing ahead for a walk that settles in a few commits', async () => {
    const st = new Store()
    let tip = st.commit(st.files({ a: '0', b: '0' }), [], 'root')
    for (let i = 1; i <= 60; i++) tip = st.commit(st.files({ a: String(i), b: i === 59 ? '1' : i >= 59 ? '1' : '0' }), [tip], `c${i}`)
    const base = st.reader()
    let reads = 0
    const reader = { readObject: (oid: string) => (reads++, base.readObject(oid)) }
    const got = await lastCommitsForDir(reader, tip, '', ['a', 'b'])
    expect(got.get('b')?.subject).toBe('c59')
    // The tip, its parent and the one before, and their trees.
    expect(reads).toBeLessThanOrEqual(6)
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
    expect(last).toMatchObject({ done: true, failed: false, source: 'walk' })
    expect([...last.found.keys()].sort()).toEqual(['a', 'b'])
    expect(last.more).toBeUndefined()
  })
})

describe('the commit column with a history index', () => {
  /** `a` changes at the tip; `b` long ago; 30 commits in between. */
  function history() {
    const st = new Store()
    let tip = st.commit(st.files({ a: '0', b: '0' }), [], 'root')
    const old = st.commit(st.files({ a: '0', b: '1' }), [tip], 'b changed')
    tip = old
    for (let i = 1; i <= 30; i++) tip = st.commit(st.files({ a: '0', b: '1', c: String(i) }), [tip], `c${i}`)
    const indexed = tip
    tip = st.commit(st.files({ a: '1', b: '1', c: '30' }), [tip], 'a changed')
    return { st, tip, old, indexed }
  }
  /** An index of `indexTip` answering every path it is asked for, counting loads. */
  function index(indexTip: string, old: string) {
    let loads = 0
    const paths = new Map<string, LastCommit>(['a', 'b', 'c'].map((p) => [p, { oid: old, subject: `indexed ${p}`, when: 5_000 }]))
    const h: IndexedHistory = {
      covers: (tip) => tip === indexTip,
      async load(tip) {
        loads++
        expect(tip).toBe(indexTip)
        return { paths, commitCount: 0 }
      },
    }
    return { h, loads: () => loads }
  }
  function counting(st: Store) {
    const base = st.reader()
    let reads = 0
    return { reader: { readObject: (oid: string) => (reads++, base.readObject(oid)) }, reads: () => reads }
  }

  it('an index of the tip answers every name without reading history', async () => {
    const { st, tip, old } = history()
    const { h, loads } = index(tip, old)
    const { reader, reads } = counting(st)
    const states: LastCommitColumn[] = []
    await walkCommitColumn(reader, tip, ['a', 'b'], (s) => states.push(s), { history: h })
    const last = states[states.length - 1] as LastCommitColumn
    expect(last).toMatchObject({ done: true, failed: false, source: 'index' })
    expect(last.found.get('b')?.subject).toBe('indexed b')
    expect(reads()).toBe(0)
    expect(loads()).toBe(1)
  })

  it('an index of an older tip: only the commits since it are walked', async () => {
    const { st, tip, old, indexed } = history()
    const { h } = index(indexed, old)
    const { reader, reads } = counting(st)
    const states: LastCommitColumn[] = []
    await walkCommitColumn(reader, tip, ['a', 'b'], (s) => states.push(s), { history: h })
    const last = states[states.length - 1] as LastCommitColumn
    expect(last.found.get('a')?.subject).toBe('a changed')
    expect(last.found.get('b')?.subject).toBe('indexed b')
    expect(last.more).toBeUndefined()
    // The tip and its tree, the indexed commit and its tree: never the 30 below it.
    expect(reads()).toBeLessThanOrEqual(4)
  })

  it('in a subdirectory the index is asked for full paths', async () => {
    const st = new Store()
    const tip = st.commit(st.files({ 'src/x.rs': '1' }), [], 'root')
    const h: IndexedHistory = {
      covers: () => true,
      // Keyed by full path: `x.rs` alone would not be found.
      load: async () => ({ paths: new Map([['src/x.rs', { oid: tip, subject: 's', when: 1 }]]), commitCount: 1 }),
    }
    const states: LastCommitColumn[] = []
    await walkCommitColumn(st.reader(), tip, ['x.rs'], (s) => states.push(s), { history: h, dirPath: 'src' })
    expect(states[states.length - 1]?.found.get('x.rs')?.subject).toBe('s')
  })

  it('without an index: a date bound for what the window missed, and a way further back', async () => {
    const { st, tip } = history()
    const states: LastCommitColumn[] = []
    await walkCommitColumn(st.reader(), tip, ['a', 'b'], (s) => states.push(s), { limit: 5 })
    let last = states[states.length - 1] as LastCommitColumn
    expect(last).toMatchObject({ done: true, failed: false, source: 'walk' })
    expect(last.found.has('b')).toBe(false)
    expect(last.olderThan).toBeGreaterThan(0)
    expect(last.more).toBeTypeOf('function')
    // "Search older history" continues from where the walk stopped, 5 more at a time.
    for (let i = 0; i < 10 && !states[states.length - 1]?.found.has('b'); i++) {
      const more = states[states.length - 1]?.more
      if (more === undefined) break
      const before = states.length
      more()
      // The continued walk reads as under way at once (cells pending, no second control).
      expect(states[before]).toMatchObject({ done: false })
      expect(states[before]?.more).toBeUndefined()
      await vi.waitFor(() => {
        expect(states.length).toBeGreaterThan(before)
        expect(states[states.length - 1]?.done).toBe(true)
      })
    }
    last = states[states.length - 1] as LastCommitColumn
    expect(last.found.get('b')?.subject).toBe('b changed')
    expect(last.found.get('a')?.subject).toBe('a changed')
    expect(last.more).toBeUndefined()
    expect(last.olderThan).toBeUndefined()
  })
})

describe('countCommits with a history index', () => {
  const counted = (covers: (tip: string) => boolean, commitCount: number): IndexedHistory => ({
    covers,
    load: async () => ({ paths: new Map(), commitCount }),
  })
  function chain(n: number) {
    const s = new Store()
    const tips: string[] = []
    let tip = s.commit(s.files({ a: '0' }))
    tips.push(tip)
    for (let i = 1; i < n; i++) tips.push((tip = s.commit(s.files({ a: String(i) }), [tip])))
    return { s, tips, tip }
  }

  it('is exact from an index of the tip', async () => {
    const { s, tip } = chain(3)
    const got = await countCommits(s.reader(), tip, 100, { history: counted((t) => t === tip, 33_553) })
    expect(got).toEqual({ count: 33_553, capped: false, fromIndex: true })
  })

  it('adds the commits since an older index, exact without merges', async () => {
    const { s, tips, tip } = chain(6)
    const at = tips[2] as string
    const got = await countCommits(s.reader(), tip, 100, { history: counted((t) => t === at, 1_000) })
    expect(got).toEqual({ count: 1_003, capped: false, fromIndex: true })
  })

  it('is a lower bound when a merge was walked past', async () => {
    const s = new Store()
    const root = s.commit(s.files({ a: '0' }))
    const side = s.commit(s.files({ a: '0', b: '1' }), [root], 'side')
    const merge = s.commit(s.files({ a: '0', b: '1' }), [root, side], 'merge')
    const got = await countCommits(s.reader(), merge, 100, { history: counted((t) => t === root, 10) })
    expect(got).toEqual({ count: 11, capped: true, fromIndex: true })
  })
})

describe('a history index that will not load', () => {
  function history() {
    const st = new Store()
    let tip = st.commit(st.files({ a: '0', b: '0' }), [], 'root')
    tip = st.commit(st.files({ a: '0', b: '1' }), [tip], 'b changed')
    const indexed = tip
    for (let i = 1; i <= 5; i++) tip = st.commit(st.files({ a: '0', b: '1', c: String(i) }), [tip], `c${i}`)
    tip = st.commit(st.files({ a: '1', b: '1', c: '5' }), [tip], 'a changed')
    return { st, tip, indexed }
  }
  /** Covers `tip`, but its artifact is missing or corrupt. */
  const broken = (covered: string): IndexedHistory => ({
    covers: (t) => t === covered,
    load: () => Promise.reject(new Error('history index truncated')),
  })

  it('an index of the tip that fails: the column walks instead', async () => {
    const { st, tip } = history()
    const states: LastCommitColumn[] = []
    await walkCommitColumn(st.reader(), tip, ['a', 'b'], (s) => states.push(s), { history: broken(tip) })
    const last = states[states.length - 1] as LastCommitColumn
    expect(last).toMatchObject({ done: true, failed: false, source: 'walk' })
    expect(last.found.get('a')?.subject).toBe('a changed')
    expect(last.found.get('b')?.subject).toBe('b changed')
  })

  it('an index the walk stops at that fails: the walk goes on past it', async () => {
    const { st, tip, indexed } = history()
    const states: LastCommitColumn[] = []
    await walkCommitColumn(st.reader(), tip, ['a', 'b'], (s) => states.push(s), { history: broken(indexed) })
    const last = states[states.length - 1] as LastCommitColumn
    expect(last).toMatchObject({ done: true, failed: false })
    expect(last.found.get('b')?.subject).toBe('b changed')
  })

  it('the count walks on too', async () => {
    const { st, tip } = history()
    expect(await countCommits(st.reader(), tip, 100, { history: broken(tip) })).toEqual({ count: 8, capped: false })
  })
})

/**
 * The Commits page's full log (QW-006): every commit reachable from the tip, in `git log`'s order,
 * paged. The list followed first parents only, so dash listed 8,366 of its 34,007 commits under
 * "The whole history". Checked against real git (skipped where git is not installed) over random
 * histories with merges, equal commit dates and skewed clocks.
 */

import { describe, expect, it } from 'vitest'

import { gitLog, HAVE_GIT } from '../merge/git-oracle'
import { dateOrderedPage, pathDateOrderedPage, type DateWalk } from './date-log'
import { Store } from './diff-fixtures'
import { logPage } from './path-history'

/** Every page of the log from `tip`, `limit` at a time. */
async function wholeLog(s: Store, tip: string, limit: number): Promise<{ oids: string[]; pages: number }> {
  const reader = { ...s.reader(), memoScope: {} }
  const oids: string[] = []
  let from: string | DateWalk | null = tip
  let pages = 0
  while (from !== null) {
    const page = await dateOrderedPage(reader, from, { limit })
    oids.push(...page.entries.map((e) => e.oid))
    from = page.next
    pages += 1
  }
  return { oids, pages }
}

describe('the full commit log', () => {
  it('lists the commits a merge brought in, which the first-parent log leaves out', async () => {
    const s = new Store()
    const tree = s.files({ f: 'x' })
    const base = s.commitAt(tree, [], 100, 'base')
    const side1 = s.commitAt(tree, [base], 110, 'side 1')
    const main1 = s.commitAt(tree, [base], 120, 'main 1')
    const side2 = s.commitAt(tree, [side1], 130, 'side 2')
    const merge = s.commitAt(tree, [main1, side2], 140, 'merge')
    const got = await wholeLog(s, merge, 40)
    expect(got.oids).toEqual([merge, side2, main1, side1, base])
    const firstParent = await logPage(s.reader(), merge)
    expect(firstParent.entries.map((e) => e.oid)).toEqual([merge, main1, base])
    const want = gitLog(s.objects.values(), [merge])
    if (want !== null) expect(got.oids).toEqual(want[0])
  })

  it('pages without repeating or dropping a commit, and leaves the walk it started from as it was', async () => {
    const s = new Store()
    const tree = s.files({ f: 'x' })
    let tip = s.commitAt(tree, [], 1)
    for (let i = 2; i <= 30; i++) tip = s.commitAt(tree, [tip], i)
    const first = await dateOrderedPage(s.reader(), tip, { limit: 10 })
    const walk = first.next as DateWalk
    const queued = [...walk.queue]
    const seen = new Set(walk.seen)
    const a = await dateOrderedPage(s.reader(), walk, { limit: 10 })
    const b = await dateOrderedPage(s.reader(), walk, { limit: 10 })
    expect(b.entries).toEqual(a.entries)
    expect([...walk.queue]).toEqual(queued)
    expect(new Set(walk.seen)).toEqual(seen)
    const all = await wholeLog(s, tip, 10)
    expect(all.oids).toHaveLength(30)
    expect(new Set(all.oids).size).toBe(30)
    expect(all.pages).toBe(3)
  })

  it.skipIf(!HAVE_GIT)('matches git log over random histories (merges, equal dates, skewed clocks)', async () => {
    const rand = prng(20260930)
    const s = new Store()
    const tips: string[] = []
    for (let c = 0; c < 40; c++) {
      const tree = s.files({ f: `case ${c}` })
      const commits: string[] = []
      const heads: string[] = []
      let clock = 1_000
      for (let i = 0; i < 60; i++) {
        // Mostly forward in time, with ties and the odd commit dated before its parents.
        const r = rand()
        clock += r < 0.25 ? 0 : r < 0.35 ? -Math.floor(rand() * 50) : Math.floor(rand() * 20)
        let parents: string[]
        if (commits.length === 0) parents = []
        else if (heads.length > 1 && rand() < 0.25) {
          // Merge two branch heads (sometimes an octopus of three).
          const n = heads.length > 2 && rand() < 0.2 ? 3 : 2
          parents = heads.splice(0, n)
        } else {
          const at = Math.floor(rand() * heads.length)
          const parent = heads.length > 0 && rand() < 0.8 ? (heads.splice(at, 1)[0] as string) : (commits[Math.floor(rand() * commits.length)] as string)
          parents = [parent]
        }
        const oid = s.commitAt(tree, parents, clock, `c${c} ${i}`)
        commits.push(oid)
        heads.push(oid)
      }
      // One tip over every head: all 60 commits reachable.
      tips.push(heads.length > 1 ? s.commitAt(tree, heads, clock + 1, `c${c} tip`) : (heads[0] as string))
    }
    const want = gitLog(s.objects.values(), tips) as string[][]
    let branchy = 0
    for (const [i, tip] of tips.entries()) {
      const got = await wholeLog(s, tip, 7)
      expect(got.oids).toEqual(want[i])
      if ((await logPage(s.reader(), tip, { limit: 1000 })).entries.length < got.oids.length) branchy += 1
    }
    // The histories are not straight lines: the first-parent log misses commits of most of them.
    expect(branchy).toBeGreaterThan(30)
  })
})

/** Every page of `path`'s full history from `tip`, `limit` at a time. */
async function wholePathLog(s: Store, tip: string, path: string, limit: number): Promise<string[]> {
  const reader = { ...s.reader(), memoScope: {} }
  const oids: string[] = []
  let from: string | DateWalk | null = tip
  while (from !== null) {
    const page = await pathDateOrderedPage(reader, from, path, { limit, cap: 100_000 })
    oids.push(...page.entries.map((e) => e.oid))
    from = page.next
  }
  return oids
}

describe('a path’s full history (QW2-041)', () => {
  it('lists a side branch’s own change, which the first-parent History stands a merge in for', async () => {
    const s = new Store()
    const base = s.commitAt(s.files({ f: '1', g: '1' }), [], 100, 'base')
    const side = s.commitAt(s.files({ f: '2', g: '1' }), [base], 110, 'side edits f')
    const main1 = s.commitAt(s.files({ f: '1', g: '2' }), [base], 120, 'main edits g')
    const merge = s.commitAt(s.files({ f: '2', g: '2' }), [main1, side], 130, 'merge')
    expect(await wholePathLog(s, merge, 'f', 40)).toEqual([side, base])
    const firstParent = await logPage(s.reader(), merge, { path: 'f' })
    expect(firstParent.entries.map((e) => e.oid)).toEqual([merge, base])
    const want = gitLog(s.objects.values(), [merge], 'f')
    if (want !== null) expect([side, base]).toEqual(want[0])
  })

  it('stops at its cap and goes on from where it stopped', async () => {
    const s = new Store()
    let tip = s.commitAt(s.files({ f: 'start' }), [], 1)
    for (let i = 2; i <= 50; i++) tip = s.commitAt(s.files({ f: 'start', n: String(i) }), [tip], i)
    const reader = { ...s.reader(), memoScope: {} }
    const first = await pathDateOrderedPage(reader, tip, 'f', { cap: 20 })
    expect(first.entries).toHaveLength(0)
    expect(first.capped).toBe(true)
    expect(first.examined).toBe(20)
    const rest = await pathDateOrderedPage(reader, first.next as DateWalk, 'f', { cap: 100 })
    expect(rest.entries).toHaveLength(1)
    expect(rest.next).toBeNull()
  })

  it.skipIf(!HAVE_GIT)('matches git log -- <path> over random histories with merges', async () => {
    const rand = prng(20260931)
    const s = new Store()
    const cases: { tip: string; path: string }[] = []
    for (let c = 0; c < 30; c++) {
      const commits: { oid: string; files: Record<string, string> }[] = []
      const heads: { oid: string; files: Record<string, string> }[] = []
      let clock = 1_000
      for (let i = 0; i < 50; i++) {
        clock += Math.floor(rand() * 20)
        let parents: { oid: string; files: Record<string, string> }[]
        if (commits.length === 0) parents = []
        else if (heads.length > 1 && rand() < 0.25) parents = heads.splice(0, 2)
        else {
          const at = Math.floor(rand() * heads.length)
          parents = [heads.length > 0 && rand() < 0.8 ? heads.splice(at, 1)[0]! : commits[Math.floor(rand() * commits.length)]!]
        }
        // A merge takes one side's files, or edits on top (an "evil" merge); others edit a few.
        const files: Record<string, string> = { ...(parents[rand() < 0.5 ? 0 : parents.length - 1]?.files ?? { g: 'g0' }) }
        if (parents.length < 2 || rand() < 0.2) {
          if (rand() < 0.3) files['f'] = `c${c} ${i}`
          if (rand() < 0.3) files['d/x'] = `x ${i}`
          if (rand() < 0.5) files['g'] = `g ${i}`
        }
        const oid = s.commitAt(s.files(files), parents.map((p) => p.oid), clock, `c${c} ${i}`)
        commits.push({ oid, files })
        heads.push({ oid, files })
      }
      const tip = heads.length > 1 ? s.commitAt(s.files(heads[0]!.files), heads.map((h) => h.oid), clock + 1, `c${c} tip`) : heads[0]!.oid
      cases.push({ tip, path: c % 2 === 0 ? 'f' : 'd' })
    }
    const objects = [...s.objects.values()]
    let branchy = 0
    for (const path of ['f', 'd']) {
      const tips = cases.filter((c) => c.path === path).map((c) => c.tip)
      const wants = gitLog(objects, tips, path) as string[][]
      for (const [i, tip] of tips.entries()) {
        const want = wants[i] as string[]
        expect(await wholePathLog(s, tip, path, 7), `${tip} ${path}`).toEqual(want)
        if ((await logPage(s.reader(), tip, { path, limit: 1000 })).entries.length !== want.length) branchy += 1
      }
    }
    // The histories are not straight lines: the first-parent History differs from most of them.
    expect(branchy).toBeGreaterThan(10)
  })
})

/** A tiny deterministic PRNG, so a failure is reproducible from its seed. */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}

/**
 * Blame (F-5) against real git (skipped where git is not installed; run locally and in CI):
 *
 *  - the spec's case: a file written over 3 commits, blamed line for line as
 *    `git blame --first-parent` blames it;
 *  - a property: random edit histories of one file (inserts, deletes, replacements, moved and
 *    duplicated lines, a lost final newline) with unrelated files changing alongside, and the
 *    file sometimes moved away and back — every line's commit equals git's;
 *  - the bounds: too large and binary files are refused, the version cap marks the result
 *    partial, progress is reported and a signal stops the walk; History and Blame of the same
 *    file share their reads.
 *
 * Where a changed run of lines could align at several places (the file repeats lines around it),
 * git picks one by its change compaction and indent heuristic; `xdiff-compact.ts` is a port of
 * those, and without it ~4% of these cases blamed a repeated line on the other commit.
 *
 * `FORGE_BLAME_CASES` sets the random cases (2,000 by default, a fixed seed, so every run checks the same histories), `FORGE_BLAME_SEED` the seed.
 */

import { describe, expect, it } from 'vitest'

import { gitBlame, gitBlameMany, HAVE_GIT } from '../merge/git-oracle'
import { BLAME_MAX_BYTES, BlameRefusedError, BlameStoppedError, blameFile, toHunks, type BlameResult } from './blame'
import { lineMap } from './blame-core'
import { Store } from './diff-fixtures'
import { logPage } from './path-history'

const CASES = Number(process.env['FORGE_BLAME_CASES'] ?? '2000')
const SEED = Number(process.env['FORGE_BLAME_SEED'] ?? '20260928')

/** Each line's commit, from the hunks. */
function owners(r: BlameResult): string[] {
  return r.hunks.flatMap((h) => new Array<string>(h.count).fill(h.oid))
}

describe('lineMap', () => {
  it('maps unchanged lines and marks inserted ones', () => {
    expect([...(lineMap('a\nb\nc\n', 'a\nx\nb\nc\n') as Int32Array)]).toEqual([0, -1, 1, 2])
    expect([...(lineMap('a\nb\n', 'b\n') as Int32Array)]).toEqual([1])
  })

  it('treats a line that only gained its final newline as changed, as git does', () => {
    expect([...(lineMap('a\nb', 'a\nb\n') as Int32Array)]).toEqual([0, -1])
  })
})

describe('toHunks', () => {
  it('groups consecutive lines of one commit', () => {
    expect(toHunks(['a', 'a', 'b', 'a'])).toEqual([
      { start: 1, count: 2, oid: 'a' },
      { start: 3, count: 1, oid: 'b' },
      { start: 4, count: 1, oid: 'a' },
    ])
  })
})

describe.skipIf(!HAVE_GIT)('blame matches git blame --first-parent', () => {
  it('a file written over 3 commits (the spec case)', async () => {
    const s = new Store()
    const c1 = s.commit(s.files({ 'src/main.rs': 'fn main() {\n    println!("hello");\n}\n', 'README.md': 'r\n' }), [], 'one')
    const c2 = s.commit(s.files({ 'src/main.rs': 'fn main() {\n    println!("hello");\n    println!("checked");\n}\n', 'README.md': 'r\n' }), [c1], 'two')
    const c3 = s.commit(
      s.files({ 'src/main.rs': 'fn main() {\n    let name = arg();\n    println!("hello, {name}");\n    println!("checked");\n}\n', 'README.md': 'R\n' }),
      [c2],
      'three',
    )
    const got = await blameFile(s.reader(), c3, 'src/main.rs')
    const want = gitBlame(s.objects.values(), c3, 'src/main.rs')
    expect(owners(got)).toEqual(want)
    // Spelled out, so the expectation reads without git too.
    expect(owners(got)).toEqual([c1, c3, c3, c2, c1])
    expect(got.partial).toBe(false)
    expect(got.versions).toBe(2)
    expect([...got.commits.keys()].sort()).toEqual([c1, c2, c3].sort())
  })

  it('names only the commits that own lines (an edit overwritten later is not counted)', async () => {
    // c1 writes the line, c2 edits it, c3 edits it again: git blame names c3 alone.
    const s = new Store()
    const c1 = s.commit(s.files({ f: 'one\n' }), [], 'one')
    const c2 = s.commit(s.files({ f: 'two\n' }), [c1], 'two')
    const c3 = s.commit(s.files({ f: 'three\n' }), [c2], 'three')
    const got = await blameFile(s.reader(), c3, 'f')
    expect(owners(got)).toEqual(gitBlame(s.objects.values(), c3, 'f'))
    expect([...got.commits.keys()]).toEqual([c3])
  })

  it('a merge commit: blame follows the first parent, as --first-parent does', async () => {
    const s = new Store()
    const base = s.commit(s.files({ f: 'a\nb\nc\n' }), [], 'base')
    const side = s.commit(s.files({ f: 'a\nB\nc\n' }), [base], 'side')
    const main = s.commit(s.files({ f: 'a\nb\nc\nd\n' }), [base], 'main')
    const merge = s.commit(s.files({ f: 'a\nB\nc\nd\n' }), [main, side], 'merge')
    const got = await blameFile(s.reader(), merge, 'f')
    expect(owners(got)).toEqual(gitBlame(s.objects.values(), merge, 'f'))
    expect(owners(got)).toEqual([base, merge, base, main])
  })

  it('follows a file back through an exact rename (a move to another directory), as git does', async () => {
    const s = new Store()
    const c1 = s.commit(s.files({ 'src/fzf/main.go': 'package main\n\nfunc main() {}\n', 'x': '1' }), [], 'one')
    const c2 = s.commit(s.files({ 'src/fzf/main.go': 'package main\n\n// run\nfunc main() {}\n', 'x': '2' }), [c1], 'two')
    const moved = s.commit(s.files({ 'main.go': 'package main\n\n// run\nfunc main() {}\n', 'x': '3' }), [c2], 'move to the root')
    const c4 = s.commit(s.files({ 'main.go': 'package main\n\n// run\nfunc main() { go() }\n', 'x': '3' }), [moved], 'four')
    const got = await blameFile(s.reader(), c4, 'main.go')
    expect(owners(got)).toEqual(gitBlame(s.objects.values(), c4, 'main.go'))
    expect(owners(got)).toEqual([c1, c1, c2, c4])
    expect(got.renames).toEqual([{ commit: moved, from: 'src/fzf/main.go', to: 'main.go' }])
    expect(got.partial).toBe(false)
  })

  it(`random histories (${CASES} cases, seed ${SEED})`, async () => {
    const rand = prng(SEED)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
    const words = ['alpha', 'beta', 'gamma', 'delta', '}', '', 'return x', 'let y = 1;', '// note', 'fn f() {']
    // One store for every case (each its own history, file under `case<c>/`), so git writes the
    // objects once and runs one blame per case.
    const s = new Store()
    const cases: { tip: string; path: string; got: string[] }[] = []
    for (let c = 0; c < CASES; c++) {
      const path = `case${c}/dir/file.txt`
      let lines = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => pick(words))
      let tip = s.commit(s.files({ [path]: `${lines.join('\n')}\n`, 'other.txt': `${c}:0` }), [], `root ${c}`)
      let finalNewline = true
      let present = true
      const commits = 1 + Math.floor(rand() * 8)
      for (let k = 0; k < commits; k++) {
        const op = rand()
        if (op < 0.1 && present) {
          present = false // deleted in this commit
        } else if (!present) {
          present = true // re-added
        } else {
          const at = Math.floor(rand() * (lines.length + 1))
          if (op < 0.4) lines.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(words)))
          else if (op < 0.6 && lines.length > 1) lines.splice(at, 1 + Math.floor(rand() * 2))
          else if (op < 0.8 && lines.length > 0) lines[Math.min(at, lines.length - 1)] = `${pick(words)} ${k}`
          else if (op < 0.9 && lines.length > 1) lines = [...lines.slice(1), lines[0] as string]
          else finalNewline = !finalNewline
        }
        const files: Record<string, string> = { 'other.txt': `${c}:${k}` }
        if (present) files[path] = lines.join('\n') + (finalNewline ? '\n' : '')
        tip = s.commit(s.files(files), [tip], `c${c}.${k}`)
      }
      if (!present) tip = s.commit(s.files({ [path]: `${lines.join('\n')}\n`, 'other.txt': `${c}:end` }), [tip], `readd ${c}`)
      cases.push({ tip, path, got: owners(await blameFile(s.reader(), tip, path)) })
    }
    const want = gitBlameMany(s.objects.values(), cases.map((k) => [k.tip, k.path] as const)) as string[][]
    cases.forEach((k, c) => expect(k.got, `case ${c}`).toEqual(want[c]))
  }, 180_000)

  it('a repeated line that moves: the copies git pairs, not another minimal pairing (L-70)', async () => {
    // Two minimal edit scripts keep 2 lines: both "\ty" (new lines 1 and 4), or "a" and one "\ty"
    // (new lines 3 and 4). xdiff finds the first; a plain Myers diff (our old alignment) found the
    // second, blaming line 1 on "two" and line 3 on "one".
    const s = new Store()
    const one = s.commit(s.files({ f: '\nc\na\n\ty\n\n}\n\ty\n' }), [], 'one')
    const two = s.commit(s.files({ f: '\ty\nb\na\n\ty\na\n' }), [one], 'two')
    const got = owners(await blameFile(s.reader(), two, 'f'))
    expect(got).toEqual(gitBlame(s.objects.values(), two, 'f'))
    expect(got).toEqual([one, two, two, one, two])
  })
})

describe('blame bounds', () => {
  it('a file untouched for more than a History page cap is exact, not partial', async () => {
    // The file changes once, then 60 commits touch only other files; a small page cap (10) would
    // stop each History page early. The walk goes on to the file's commits and says nothing is partial.
    const s = new Store()
    const c1 = s.commit(s.files({ f: 'a\n', g: '0' }), [], 'one')
    const c2 = s.commit(s.files({ f: 'a\nb\n', g: '0' }), [c1], 'two')
    let tip = c2
    for (let i = 1; i <= 60; i++) tip = s.commit(s.files({ f: 'a\nb\n', g: String(i) }), [tip], `g ${i}`)
    const got = await blameFile(s.reader(), tip, 'f', { pageCap: 10 })
    expect(owners(got)).toEqual([c1, c2])
    expect(got.partial).toBe(false)
  })

  it('stops at the total commit budget and says the result is partial', async () => {
    const s = new Store()
    const c1 = s.commit(s.files({ f: 'a\n', g: '0' }), [], 'one')
    let tip = c1
    for (let i = 1; i <= 50; i++) tip = s.commit(s.files({ f: 'a\n', g: String(i) }), [tip], `g ${i}`)
    const got = await blameFile(s.reader(), tip, 'f', { maxCommits: 20 })
    expect(got.partial).toBe(true)
    // Nothing older than the budget was read: no commit of the first 30 was walked.
    expect(s.reads).not.toContain(c1)
  })

  // QW-005: dash's validation.cpp came from main.cpp in one commit that renamed it and cut it down
  // (bitcoin#9260); git blame follows that rename, and the walk gave its 921 older lines to it.
  it('follows a rename with edits, as git blame does (a file renamed and cut down)', async () => {
    const s = new Store()
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const c1 = s.commit(s.files({ 'src/main.cpp': `${body.join('\n')}\n`, 'src/other.h': 'x\n' }), [], 'one')
    const edited = [...body]
    edited[3] = 'line 3 edited'
    const c2 = s.commit(s.files({ 'src/main.cpp': `${edited.join('\n')}\n`, 'src/other.h': 'x\n' }), [c1], 'two')
    // The rename: main.cpp becomes validation.cpp, six lines go, one comes.
    const cut = [...edited.slice(0, 20), 'moved here', ...edited.slice(26)]
    const peacock = s.commit(s.files({ 'src/validation.cpp': `${cut.join('\n')}\n`, 'src/other.h': 'y\n' }), [c2], 'kill main.cpp')
    const later = [...cut]
    later[0] = 'line 0 later'
    const c4 = s.commit(s.files({ 'src/validation.cpp': `${later.join('\n')}\n`, 'src/other.h': 'y\n' }), [peacock], 'four')
    const got = await blameFile(s.reader(), c4, 'src/validation.cpp')
    expect(got.renames).toEqual([{ commit: peacock, from: 'src/main.cpp', to: 'src/validation.cpp' }])
    expect(got.partial).toBe(false)
    const want = gitBlame(s.objects.values(), c4, 'src/validation.cpp')
    if (want !== null) expect(owners(got)).toEqual(want)
    expect(owners(got).filter((o) => o === peacock)).toHaveLength(1)
    expect(owners(got)[3]).toBe(c2)
    expect(owners(got)[1]).toBe(c1)
  })

  it('a change too large to check for a rename leaves the lines it added unresolved, not on it', async () => {
    // 450 files deleted with the path's addition: scoring them all is over the rename read budget.
    const s = new Store()
    const gone: Record<string, string> = {}
    for (let i = 0; i < 450; i++) gone[`d/f${i}`] = `file ${i}\n${'filler\n'.repeat(i % 5)}`
    const c1 = s.commit(s.files(gone), [], 'one')
    const c2 = s.commit(s.files({ 'new.txt': 'a\nb\n' }), [c1], 'replace everything')
    const c3 = s.commit(s.files({ 'new.txt': 'a\nb\nc\n' }), [c2], 'three')
    const got = await blameFile(s.reader(), c3, 'new.txt')
    expect(got.boundary).toEqual({ oid: c2, reason: 'rename', lines: 2 })
    expect(got.cursor).toBeNull()
    expect(got.hunks).toEqual([
      { start: 1, count: 2, oid: c2, unresolved: true },
      { start: 3, count: 1, oid: c3 },
    ])
  })

  it('refuses a file over the size cap and a binary file, reading neither whole', async () => {
    const s = new Store()
    const big = s.commit(s.files({ big: 'x'.repeat(BLAME_MAX_BYTES + 1), bin: 'a\u0000b' }))
    await expect(blameFile(s.reader(), big, 'big')).rejects.toMatchObject({ reason: 'too-large' })
    await expect(blameFile(s.reader(), big, 'bin')).rejects.toBeInstanceOf(BlameRefusedError)
    await expect(blameFile(s.reader(), big, 'missing')).rejects.toMatchObject({ reason: 'not-a-file' })
  })

  it('stops at the version cap, says the result is partial, and reports progress', async () => {
    const s = new Store()
    let text = 'base\n'
    let tip = s.commit(s.files({ f: text }), [], 'root')
    for (let i = 0; i < 12; i++) {
      text = `${text}line ${i}\n`
      tip = s.commit(s.files({ f: text }), [tip], `add ${i}`)
    }
    const seen: number[] = []
    // Searching reports too (versions 0, commits examined): the compared versions come in order.
    const got = await blameFile(s.reader(), tip, 'f', { maxVersions: 5, onProgress: (p) => p.versions > 0 && !seen.includes(p.versions) && seen.push(p.versions) })
    expect(got.partial).toBe(true)
    expect(got.versions).toBe(5)
    expect(seen.slice(0, 5)).toEqual([1, 2, 3, 4, 5])
    expect(got.hunks.at(-1)?.count).toBe(1) // line 13 is the newest's
  })

  it('stops when its signal aborts', async () => {
    // Each commit prepends a line, so the old lines stay open all the way down.
    const s = new Store()
    let text = 'root\n'
    let tip = s.commit(s.files({ f: text }))
    for (let i = 1; i < 50; i++) tip = s.commit(s.files({ f: (text = `${i}\n${text}`) }), [tip])
    const stop = new AbortController()
    let last = 0
    const run = blameFile(s.reader(), tip, 'f', {
      signal: stop.signal,
      onProgress: (p) => {
        last = p.versions
        if (p.versions === 3) stop.abort()
      },
    })
    await expect(run).rejects.toThrow()
    expect(last).toBe(3)
  })

  it('a stopped run hands back what it attributed: the compared versions exact, the rest on the oldest reached (L-23)', async () => {
    const s = new Store()
    const commits: string[] = []
    let text = 'root\n'
    let tip = s.commit(s.files({ f: text }))
    commits.push(tip)
    for (let i = 1; i < 20; i++) {
      tip = s.commit(s.files({ f: (text = `${i}\n${text}`) }), [tip])
      commits.push(tip)
    }
    const stop = new AbortController()
    const run = blameFile(s.reader(), tip, 'f', {
      signal: stop.signal,
      onProgress: (p) => {
        if (p.versions === 3) stop.abort()
      },
    })
    const err = await run.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BlameStoppedError)
    const partial = (err as BlameStoppedError).partial!
    expect(partial.partial).toBe(true)
    const got = owners(partial)
    // The newest three lines are exact (their commits were compared); the rest sit on the oldest reached.
    expect(got.slice(0, 3)).toEqual([commits[19], commits[18], commits[17]])
    expect(new Set(got.slice(3)).size).toBe(1)
  })

  it('reports progress while it searches, before any version is found (L-23)', async () => {
    // The file changed once, long ago: the walk examines many commits before the first version.
    const s = new Store()
    const c1 = s.commit(s.files({ f: 'a\n', g: '0' }), [], 'one')
    const c2 = s.commit(s.files({ f: 'a\nb\n', g: '0' }), [c1], 'two')
    let tip = c2
    for (let i = 1; i <= 120; i++) tip = s.commit(s.files({ f: 'a\nb\n', g: String(i) }), [tip], `g ${i}`)
    const searching: number[] = []
    await blameFile(s.reader(), tip, 'f', { onProgress: (p) => p.versions === 0 && searching.push(p.examined) })
    expect(searching.length).toBeGreaterThanOrEqual(2)
    expect(searching.at(-1)).toBeGreaterThanOrEqual(100)
  })

  it('shares its reads with the History walk of the same file (no object read twice)', async () => {
    const s = new Store()
    let tip = s.commit(s.files({ f: '0\n', g: '0' }))
    for (let i = 1; i < 20; i++) tip = s.commit(s.files({ f: i % 2 ? `${i}\n` : '0\n', g: String(i) }), [tip])
    const reader = { ...s.reader(), memoScope: {} }
    await logPage(reader, tip, { path: 'f' })
    const afterHistory = s.reads.length
    await blameFile(reader, tip, 'f')
    // Only the file's own versions (blobs) are new; commits and trees came from the History walk.
    const blobs = new Set(s.reads.slice(afterHistory))
    for (const oid of blobs) expect(s.objects.get(oid)?.type).toBe('blob')
  })
})

// QW-005: dash's validation.cpp (490 first-parent versions) hit the 200-version cap, and every line
// still open was blamed on the 200th version's commit: 3,098 lines on a commit git gives none of.
describe('blame past its caps (QW-005)', () => {
  /** A history where each commit rewrites one old line and adds one, so lines stay open far back. */
  function longHistory(n: number): { s: Store; commits: string[] } {
    const s = new Store()
    const commits: string[] = []
    let lines = ['root 0', 'root 1', 'root 2', 'root 3']
    let tip = s.commit(s.files({ f: `${lines.join('\n')}\n`, g: '0' }), [], 'root')
    commits.push(tip)
    for (let i = 1; i < n; i++) {
      // Every third commit leaves f alone, so the versions are not every commit.
      if (i % 3 !== 0) {
        lines = [...lines]
        lines[(i * 7) % lines.length] = `edit ${i}`
        lines.splice((i * 3) % (lines.length + 1), 0, `add ${i}`)
      }
      tip = s.commit(s.files({ f: `${lines.join('\n')}\n`, g: String(i) }), [tip], `c ${i}`)
      commits.push(tip)
    }
    return { s, commits }
  }

  it('leaves the lines past the version cap unattributed, never on the oldest version reached', async () => {
    const { s, commits } = longHistory(40)
    const tip = commits.at(-1) as string
    const want = gitBlame(s.objects.values(), tip, 'f')
    const got = await blameFile(s.reader(), tip, 'f', { maxVersions: 5 })
    expect(got.partial).toBe(true)
    expect(got.boundary).toMatchObject({ reason: 'versions' })
    const boundary = got.boundary!.oid
    const unresolved = got.hunks.filter((h) => h.unresolved === true)
    expect(unresolved.length).toBeGreaterThan(0)
    expect(unresolved.every((h) => h.oid === boundary)).toBe(true)
    expect(got.boundary!.lines).toBe(unresolved.reduce((n, h) => n + h.count, 0))
    // Every line given a commit has git's commit; no line is given the boundary's.
    const attributed = got.hunks.filter((h) => h.unresolved !== true)
    for (const h of attributed) {
      expect(h.oid).not.toBe(boundary)
      if (want !== null) for (let k = 0; k < h.count; k++) expect(h.oid).toBe(want[h.start - 1 + k])
    }
    expect(got.cursor).not.toBeNull()
  })

  it('continues from the cursor, run after run, to exactly the uncapped answer (and git’s)', async () => {
    const { s, commits } = longHistory(40)
    const tip = commits.at(-1) as string
    const whole = await blameFile(s.reader(), tip, 'f')
    expect(whole.partial).toBe(false)
    let got = await blameFile(s.reader(), tip, 'f', { maxVersions: 4 })
    const first = got.cursor!
    let runs = 1
    while (got.cursor !== null) {
      got = await blameFile(s.reader(), tip, 'f', { maxVersions: 4, resume: got.cursor })
      runs += 1
    }
    expect(runs).toBeGreaterThan(3)
    expect(got.partial).toBe(false)
    expect(got.boundary).toBeNull()
    expect(got.hunks).toEqual(whole.hunks)
    expect(got.versions).toBe(whole.versions)
    expect([...got.commits.keys()].sort()).toEqual([...whole.commits.keys()].sort())
    const want = gitBlame(s.objects.values(), tip, 'f')
    if (want !== null) expect(owners(got)).toEqual(want)
    // A cursor is never changed by the run continued from it: continuing from it again answers alike.
    const again = await blameFile(s.reader(), tip, 'f', { maxVersions: 4, resume: first })
    const twice = await blameFile(s.reader(), tip, 'f', { maxVersions: 4, resume: first })
    expect(twice.hunks).toEqual(again.hunks)
    expect(twice.versions).toBe(again.versions)
  })

  it('continues past the commit budget and past a followed rename', async () => {
    const s = new Store()
    const c1 = s.commit(s.files({ 'old/f': 'a\nb\n', g: '0' }), [], 'one')
    const c2 = s.commit(s.files({ 'old/f': 'a\nB\nc\n', g: '0' }), [c1], 'two')
    const moved = s.commit(s.files({ f: 'a\nB\nc\n', g: '0' }), [c2], 'move')
    let tip = moved
    for (let i = 1; i <= 30; i++) tip = s.commit(s.files({ f: 'a\nB\nc\n', g: String(i) }), [tip], `g ${i}`)
    tip = s.commit(s.files({ f: 'a\nB\nc\nd\n', g: 'x' }), [tip], 'four')
    let got = await blameFile(s.reader(), tip, 'f', { maxCommits: 8, pageCap: 8 })
    expect(got.boundary?.reason).toBe('commits')
    // The tip's version was found but not the one before it: no line can be given a commit yet.
    expect(got.hunks).toEqual([{ start: 1, count: 4, oid: tip, unresolved: true }])
    while (got.cursor !== null) got = await blameFile(s.reader(), tip, 'f', { maxCommits: 8, pageCap: 8, resume: got.cursor })
    expect(owners(got)).toEqual([c1, c2, c2, tip])
    expect(got.renames).toEqual([{ commit: moved, from: 'old/f', to: 'f' }])
    const want = gitBlame(s.objects.values(), tip, 'f')
    if (want !== null) expect(owners(got)).toEqual(want)
  })

  it('a file no capped walk found a version of: every line unresolved at the tip, and the walk goes on', async () => {
    const s = new Store()
    const c1 = s.commit(s.files({ f: 'a\n', g: '0' }), [], 'one')
    let tip = c1
    for (let i = 1; i <= 30; i++) tip = s.commit(s.files({ f: 'a\n', g: String(i) }), [tip], `g ${i}`)
    let got = await blameFile(s.reader(), tip, 'f', { maxCommits: 10, pageCap: 10 })
    expect(got.boundary).toEqual({ oid: tip, reason: 'commits', lines: 1 })
    expect(got.hunks).toEqual([{ start: 1, count: 1, oid: tip, unresolved: true }])
    while (got.cursor !== null) got = await blameFile(s.reader(), tip, 'f', { maxCommits: 10, pageCap: 10, resume: got.cursor })
    expect(owners(got)).toEqual([c1])
    expect(got.partial).toBe(false)
  })

  it('a run stopped before it found any version still hands back a cursor that goes on', async () => {
    const s = new Store()
    const c1 = s.commit(s.files({ f: 'a\n', g: '0' }), [], 'one')
    let tip = c1
    for (let i = 1; i <= 120; i++) tip = s.commit(s.files({ f: 'a\n', g: String(i) }), [tip], `g ${i}`)
    const stop = new AbortController()
    const err = await blameFile(s.reader(), tip, 'f', {
      signal: stop.signal,
      onProgress: (p) => {
        if (p.examined >= 50) stop.abort()
      },
    }).catch((e: unknown) => e)
    const partial = (err as BlameStoppedError).partial!
    expect(partial.boundary).toEqual({ oid: tip, reason: 'stopped', lines: 1 })
    let got = await blameFile(s.reader(), tip, 'f', { resume: partial.cursor! })
    while (got.cursor !== null) got = await blameFile(s.reader(), tip, 'f', { resume: got.cursor })
    expect(owners(got)).toEqual([c1])
  })

  it('a stopped run’s partial result continues to the uncapped answer', async () => {
    const { s, commits } = longHistory(30)
    const tip = commits.at(-1) as string
    const whole = await blameFile(s.reader(), tip, 'f')
    const stop = new AbortController()
    const err = await blameFile(s.reader(), tip, 'f', {
      signal: stop.signal,
      onProgress: (p) => {
        if (p.versions === 3) stop.abort()
      },
    }).catch((e: unknown) => e)
    const partial = (err as BlameStoppedError).partial!
    expect(partial.boundary?.reason).toBe('stopped')
    expect(partial.hunks.some((h) => h.unresolved === true)).toBe(true)
    let got = await blameFile(s.reader(), tip, 'f', { resume: partial.cursor! })
    while (got.cursor !== null) got = await blameFile(s.reader(), tip, 'f', { resume: got.cursor })
    expect(got.hunks).toEqual(whole.hunks)
  })

  it('refuses a cursor of another file', async () => {
    const { s, commits } = longHistory(12)
    const tip = commits.at(-1) as string
    const got = await blameFile(s.reader(), tip, 'f', { maxVersions: 2 })
    await expect(blameFile(s.reader(), tip, 'g', { resume: got.cursor! })).rejects.toThrow(/another file/)
  })

  it('toHunks puts unattributed lines in their own hunks at the boundary', () => {
    expect(toHunks(['a', null, null, 'b'], 'b')).toEqual([
      { start: 1, count: 1, oid: 'a' },
      { start: 2, count: 2, oid: 'b', unresolved: true },
      { start: 4, count: 1, oid: 'b' },
    ])
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

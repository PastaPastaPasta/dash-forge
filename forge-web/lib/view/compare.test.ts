/**
 * Compare (L-30) against real git on random histories: for pairs of commits, {@link loadComparison}
 * must give `git merge-base`, the commits of `git log base..head`, and the files of
 * `git diff -M --name-status base...head`. Plus the New PR form's ref params (L-47). Skipped
 * without git where it needs it.
 */

import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { HAVE_GIT, scratchRepo, writeLiterally } from '../merge/git-oracle'
import { Store } from './diff-fixtures'
import { branchRefName, headKeyOf, loadComparison, sortBranches } from './compare'

function prng(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}

/** A random history: two lines of work that fork, merge into each other, and rename files. */
function history(s: Store, rand: () => number): string[] {
  const commits: string[] = []
  const files = new Map<string, string>([['README.md', 'readme\n'], ['src/a.c', 'int a;\n'.repeat(30)]])
  let tipA = s.commit(s.files(Object.fromEntries(files)), [], 'root')
  let tipB = tipA
  let stateA = new Map(files)
  let stateB = new Map(files)
  commits.push(tipA)
  for (let i = 0; i < 40; i++) {
    const onA = rand() < 0.5
    const state = new Map(onA ? stateA : stateB)
    const op = rand()
    const paths = [...state.keys()]
    const pick = paths[Math.floor(rand() * paths.length)] as string
    if (op < 0.4) state.set(pick, `${state.get(pick)}edit ${i}\n`)
    else if (op < 0.55 && paths.length > 1) {
      const body = state.get(pick) as string
      state.delete(pick)
      state.set(`moved/${i}-${pick.split('/').pop()}`, rand() < 0.5 ? body : `${body}and ${i}\n`)
    } else state.set(`new/${i}.txt`, `file ${i}\n`)
    const merge = rand() < 0.15
    const parents = onA ? (merge ? [tipA, tipB] : [tipA]) : merge ? [tipB, tipA] : [tipB]
    // A merge takes this side's files plus the other side's: good enough for a test history.
    if (merge) for (const [k, v] of onA ? stateB : stateA) if (!state.has(k)) state.set(k, v)
    const c = s.commit(s.files(Object.fromEntries(state)), parents, `c${i}`)
    commits.push(c)
    if (onA) {
      tipA = c
      stateA = state
    } else {
      tipB = c
      stateB = state
    }
  }
  return commits
}

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  return r.stdout.toString().trim()
}

describe.skipIf(!HAVE_GIT)('loadComparison matches git', () => {
  it('merge base, base..head commits and the base...head diff over random pairs', async () => {
    const s = new Store()
    const rand = prng(20260929)
    const commits = history(s, rand)
    const { dir, done } = scratchRepo()
    try {
      writeLiterally(dir, s.objects.values())
      const r = s.reader()
      let diffs = 0
      for (let k = 0; k < 40; k++) {
        const base = commits[Math.floor(rand() * commits.length)] as string
        const head = commits[Math.floor(rand() * commits.length)] as string
        const got = await loadComparison(r, base, head)
        const mb = git(dir, ['merge-base', base, head])
        if (base === head) {
          expect(got.kind).toBe('identical')
          continue
        }
        if (mb === head) {
          expect(got.kind, `${base}...${head}`).toBe('up-to-date')
          continue
        }
        expect(got.kind).toBe('diff')
        if (got.kind !== 'diff') continue
        diffs += 1
        expect(got.mergeBase).toBe(mb)
        expect(new Set(got.commits.commits.map((c) => c.oid))).toEqual(new Set(git(dir, ['log', '--format=%H', `${base}..${head}`]).split('\n').filter(Boolean)))
        expect(got.commits.total).toBe(got.commits.commits.length)
        const names = git(dir, ['diff', '-M', '--name-status', `${base}...${head}`])
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [st, ...paths] = l.split('\t')
            return `${(st as string)[0]} ${paths.join(' ')}`
          })
          .sort()
        const ours = got.diff.changes
          .map((c) => (c.status === 'renamed' ? `R ${c.oldPath} ${c.path}` : `${c.status[0]!.toUpperCase()} ${c.path}`))
          .sort()
        expect(ours, `${base}...${head}`).toEqual(names)
      }
      expect(diffs).toBeGreaterThan(10)
    } finally {
      done()
    }
  }, 60_000)
})

describe('loadComparison', () => {
  it('says when the histories share nothing', async () => {
    const s = new Store()
    const a = s.commit(s.files({ a: '1' }), [], 'a')
    const b = s.commit(s.files({ b: '1' }), [], 'b')
    expect((await loadComparison(s.reader(), a, b)).kind).toBe('unrelated')
  })
})

// L-30 / L-47: the New PR form takes `?base=master&head=develop` as GitHub's links write them.
describe('New PR ref params', () => {
  it('reads a base as a branch', () => {
    expect(['master', 'heads/master', 'refs/heads/master'].map(branchRefName)).toEqual(['refs/heads/master', 'refs/heads/master', 'refs/heads/master'])
    expect(branchRefName('')).toBe('')
  })

  it('reads a head as a branch of this repo, or as a repo:branch key', () => {
    expect(headKeyOf('develop', 'REPO')).toBe('REPO:refs/heads/develop')
    expect(headKeyOf('feature/x', 'REPO')).toBe('REPO:refs/heads/feature/x')
    expect(headKeyOf('REPO:refs/heads/develop', 'REPO')).toBe('REPO:refs/heads/develop')
    expect(headKeyOf('FORK:fix', 'REPO')).toBe('FORK:refs/heads/fix')
    expect(headKeyOf('', 'REPO')).toBe('')
  })

  it('sorts branches with the default first, then by name', () => {
    const refs = ['refs/heads/v20.1.x', 'refs/heads/develop', 'refs/heads/master', 'refs/heads/backport'].map((refName) => ({ refName }))
    expect(sortBranches(refs, 'develop').map((r) => r.refName)).toEqual(['refs/heads/develop', 'refs/heads/backport', 'refs/heads/master', 'refs/heads/v20.1.x'])
  })
})

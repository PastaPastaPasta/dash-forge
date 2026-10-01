/**
 * git's ancestry suffixes on a revision (`master~5`, `HEAD^`, `v1.0^2~3`), as GitHub's compare
 * accepts them (QW3-046: `compare/?base=HEAD~5` said "No branch, tag or commit named HEAD~5").
 * `~n` follows the first parent n times; `^n` takes the n-th parent (`^` alone is `^1`, `^0` the
 * commit itself). `HEAD` and `@` name the default branch: a repo here has no checked-out HEAD.
 * A ref name cannot hold `~` or `^` (`git check-ref-format`), so a suffix is never part of one.
 */

import { readCommit, type ObjectReader } from './tree-nav'

/** One step back: `~` (first parent, `n` times) or `^` (the `n`-th parent). */
export interface AncestryStep {
  readonly op: '~' | '^'
  readonly n: number
}

/** A revision split into the name it starts from and the steps back from there. */
export interface Ancestry {
  /** The branch, tag or commit id the steps start from (`HEAD`/`@` already the default branch). */
  readonly rev: string
  readonly steps: readonly AncestryStep[]
}

/** Commits a walk reads at most: farther back is refused rather than read one by one. */
export const MAX_ANCESTRY_STEPS = 1000

/** `master~5` → `{ rev: 'master', steps: [~5] }`; a plain name → no steps. */
export function parseAncestry(param: string, defaultBranch: string): Ancestry {
  const m = /^(.*?)((?:[~^]\d*)+)$/.exec(param)
  const rev = m === null ? param : (m[1] as string)
  const named = rev === 'HEAD' || rev === '@' ? defaultBranch : rev
  // A bare suffix (`~3`) names no revision (git: "unknown revision"): kept whole, it matches no ref.
  if (m !== null && rev === '') return { rev: param, steps: [] }
  if (m === null) return { rev: named, steps: [] }
  const steps = [...(m[2] as string).matchAll(/([~^])(\d*)/g)].map(([, op, n]) => ({ op: op as '~' | '^', n: n === '' ? 1 : Number(n) }))
  return { rev: named, steps }
}

/** A suffix that leads to no commit: past the root, or to a parent the commit does not have. */
export class AncestryError extends Error {}

/**
 * The commit `steps` lead back to from `oid` (a commit), reading each commit on the way through a
 * history walker (block read-ahead, one ranged read per block rather than per commit) when the
 * reader has one.
 */
export async function walkAncestry(source: ObjectReader, oid: string, steps: readonly AncestryStep[], label: string): Promise<string> {
  const total = steps.reduce((sum, s) => sum + (s.op === '~' ? s.n : 1), 0)
  if (total > MAX_ANCESTRY_STEPS) throw new AncestryError(`${label} is more than ${MAX_ANCESTRY_STEPS.toLocaleString('en-US')} commits back; compare with a commit id instead.`)
  const walker = source.forHistoryWalk?.()
  try {
    return await walk(walker ?? source, oid, steps, label)
  } finally {
    walker?.flush()
  }
}

async function walk(reader: ObjectReader, oid: string, steps: readonly AncestryStep[], label: string): Promise<string> {
  let at = oid
  for (const step of steps) {
    if (step.op === '^') {
      if (step.n === 0) continue
      const parent = (await readCommit(reader, at)).parents[step.n - 1]
      if (parent === undefined) throw new AncestryError(`${label}: commit ${at.slice(0, 7)} has no parent number ${step.n}.`)
      at = parent
      continue
    }
    for (let i = 0; i < step.n; i++) {
      const parent = (await readCommit(reader, at)).parents[0]
      if (parent === undefined) throw new AncestryError(`${label} goes back past the first commit.`)
      at = parent
    }
  }
  return at
}

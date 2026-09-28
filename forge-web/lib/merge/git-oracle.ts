/**
 * TEST HELPER ONLY — real git as the judge of what the merge may accept (imported by
 * `git-parity.test.ts`; never by app code). Objects are written into scratch repositories
 * literally, so git's checks run afterwards: `fsck --strict`, clone and log for whole
 * histories, and `merge-tree --write-tree` for merges. Every function returns null when git
 * is not installed, and the tests skip.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GitObject } from '../browse'

/** Whether a git binary is on PATH. */
export const HAVE_GIT = spawnSync('git', ['--version']).status === 0

/** A scratch repository, removed by `done()`. */
export function scratchRepo(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-git-oracle-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Write `objects` into repository `dir` as loose objects, without git's checks. */
export function writeLiterally(dir: string, objects: Iterable<GitObject>): void {
  for (const o of objects) {
    const r = spawnSync('git', ['hash-object', '--literally', '-w', '-t', o.type, '--stdin'], { cwd: dir, input: o.bytes })
    if (r.status !== 0) throw new Error(`git hash-object failed: ${r.stderr.toString()}`)
  }
}

/** `-c fsck.<id>=ignore` for each of `relaxed`: git's checks with those demoted. */
function relaxing(relaxed: readonly string[]): string[] {
  return relaxed.flatMap((id) => ['-c', `fsck.${id}=ignore`])
}

/**
 * The oids `git fsck --strict` reports an error or warning for, among the loose objects of
 * `dir` (every object, reachable or not), or null without git. `relaxed`: msg-ids git is told
 * to ignore (`-c fsck.<id>=ignore`), every other check at `--strict` severity.
 */
export function gitStrictRejects(dir: string, relaxed: readonly string[] = []): Set<string> | null {
  if (!HAVE_GIT) return null
  const r = spawnSync('git', [...relaxing(relaxed), 'fsck', '--strict', '--no-dangling', '--no-progress', '--unreachable'], { cwd: dir, maxBuffer: 1 << 26 })
  const out = new Set<string>()
  for (const line of `${r.stdout.toString()}\n${r.stderr.toString()}`.split('\n')) {
    const m = /^(?:error|warning) in (?:commit|tree|blob|tag) ([0-9a-f]{40})/.exec(line)
    if (m) out.add(m[1] as string)
  }
  return out
}

/**
 * `git merge-tree --write-tree` for each `[ours, theirs]` commit pair in `dir` (batched
 * through `--stdin`): the merged tree oid when clean, else null. Null without git.
 */
export function gitMergeTrees(dir: string, pairs: readonly (readonly [string, string])[]): (string | null)[] | null {
  if (!HAVE_GIT) return null
  const r = spawnSync('git', ['merge-tree', '--stdin', '--name-only', '--no-messages', '-z'], {
    cwd: dir,
    input: pairs.map(([o, t]) => `${o} ${t}\n`).join(''),
    maxBuffer: 1 << 26,
  })
  if (r.status !== 0 && r.status !== 1) throw new Error(`git merge-tree failed: ${r.stderr.toString()}`)
  // Each result: "<status>\0<tree>\0" then, when conflicted, NUL-terminated paths, then "\0".
  const fields = r.stdout.toString().split('\0')
  const results: (string | null)[] = []
  let i = 0
  while (results.length < pairs.length) {
    const status = fields[i++]
    const tree = fields[i++] as string
    if (status === '1') {
      results.push(tree)
    } else {
      results.push(null)
      while (i < fields.length && fields[i] !== '') i++
    }
    i++ // the empty field ending the result
  }
  return results
}

/**
 * Write `objects` into a scratch repository (literally, so git's checks run afterwards, not on
 * the way in), point `main` at `tip`, and report whether `git fsck --strict` (with the
 * `relaxed` msg-ids ignored), `git log` and a `git clone` of it all succeed. Null without git.
 */
export function gitAcceptsHistory(objects: Iterable<GitObject>, tip: string, relaxed: readonly string[] = []): { fsck: boolean; log: boolean; clone: boolean } | null {
  if (!HAVE_GIT) return null
  const { dir, done } = scratchRepo()
  try {
    writeLiterally(dir, objects)
    execFileSync('git', ['update-ref', 'refs/heads/main', tip], { cwd: dir })
    const ok = (args: string[], cwd = dir): boolean => spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0
    const clone = join(dir, '..', `${dir.split('/').pop() as string}-clone`)
    const result = {
      fsck: ok([...relaxing(relaxed), 'fsck', '--strict', '--no-dangling']),
      log: ok(['log', '--format=%H', 'main']),
      clone: ok(['clone', '-q', `file://${dir}`, clone], tmpdir()),
    }
    rmSync(clone, { recursive: true, force: true })
    return result
  } finally {
    done()
  }
}

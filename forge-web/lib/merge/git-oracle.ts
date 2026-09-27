/**
 * TEST HELPER ONLY — real git as the judge of what the merge may accept (imported by
 * `security.test.ts`; never by app code). `git hash-object` without `--literally` runs git's
 * own fsck checks on an object; a scratch repository then proves the stronger properties
 * (`fsck --strict`, clone, log) for whole histories. Every function returns null when git is
 * not installed, and the tests skip.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GitObject } from '../browse'

/** Whether a git binary is on PATH. */
export const HAVE_GIT = spawnSync('git', ['--version']).status === 0

/** Whether git's fsck accepts `obj` on its own (`git hash-object -t <type>`), or null without git. */
export function gitAcceptsObject(obj: GitObject, dir: string): boolean | null {
  if (!HAVE_GIT) return null
  const r = spawnSync('git', ['hash-object', '-t', obj.type, '--stdin'], { cwd: dir, input: obj.bytes })
  return r.status === 0
}

/** A scratch repository, removed by `done()`. */
export function scratchRepo(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-git-oracle-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Write `objects` into a scratch repository (literally, so git's checks run afterwards, not on
 * the way in), point `main` at `tip`, and report whether `git fsck --strict`, `git log` and a
 * `git clone` of it all succeed. Null without git.
 */
export function gitAcceptsHistory(objects: Iterable<GitObject>, tip: string): { fsck: boolean; log: boolean; clone: boolean } | null {
  if (!HAVE_GIT) return null
  const { dir, done } = scratchRepo()
  try {
    for (const o of objects) {
      execFileSync('git', ['hash-object', '--literally', '-w', '-t', o.type, '--stdin'], { cwd: dir, input: o.bytes })
    }
    execFileSync('git', ['update-ref', 'refs/heads/main', tip], { cwd: dir })
    const ok = (args: string[], cwd = dir): boolean => spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0
    const clone = join(dir, '..', `${dir.split('/').pop() as string}-clone`)
    const result = {
      fsck: ok(['fsck', '--strict', '--no-dangling']),
      log: ok(['log', '--format=%H', 'main']),
      clone: ok(['clone', '-q', `file://${dir}`, clone], tmpdir()),
    }
    rmSync(clone, { recursive: true, force: true })
    return result
  } finally {
    done()
  }
}

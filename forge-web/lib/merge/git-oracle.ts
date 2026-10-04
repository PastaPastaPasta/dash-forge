/**
 * TEST HELPER ONLY — real git as the judge of what the merge may accept (imported by
 * `git-parity.test.ts`; never by app code). Objects are written into scratch repositories
 * literally, so git's checks run afterwards: `fsck --strict`, clone and log for whole
 * histories, and `merge-tree --write-tree` for merges. Every function returns null when git
 * is not installed, and the tests skip.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
 * Write well-formed `objects` into repository `dir`, one `git hash-object --stdin-paths` per
 * object type instead of one process per object (git checks them on the way in, so only for
 * objects git accepts; use {@link writeLiterally} for malformed ones).
 */
export function writeBatched(dir: string, objects: Iterable<GitObject>): void {
  const byType = new Map<GitObject['type'], string[]>()
  let n = 0
  for (const o of objects) {
    const file = join(dir, `.obj-${n++}`)
    writeFileSync(file, o.bytes)
    const list = byType.get(o.type)
    if (list === undefined) byType.set(o.type, [file])
    else list.push(file)
  }
  for (const [type, files] of byType) {
    const r = spawnSync('git', ['hash-object', '-w', '-t', type, '--stdin-paths'], { cwd: dir, input: files.join('\n'), maxBuffer: 1 << 28 })
    if (r.status !== 0) throw new Error(`git hash-object failed: ${r.error?.message ?? r.stderr.toString()}`)
    for (const f of files) rmSync(f)
  }
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
 * `git blame --first-parent` of `path` at `tip` over `objects` (written literally into a scratch
 * repository): the commit each line is blamed on, in line order. Null without git.
 */
export function gitBlame(objects: Iterable<GitObject>, tip: string, path: string): string[] | null {
  return gitBlameMany(objects, [[tip, path]])?.[0] ?? null
}

/**
 * {@link gitBlame} for many `[tip, path]` pairs over one set of objects: the objects are written
 * once, and each pair costs one `git blame` process. Null without git.
 */
export function gitBlameMany(objects: Iterable<GitObject>, targets: readonly (readonly [string, string])[]): string[][] | null {
  if (!HAVE_GIT) return null
  const { dir, done } = scratchRepo()
  try {
    writeBatched(dir, objects)
    return targets.map(([tip, path]) => {
      const r = spawnSync('git', ['-c', 'blame.ignoreRevsFile=', 'blame', '--first-parent', '--porcelain', tip, '--', path], { cwd: dir, maxBuffer: 1 << 26 })
      if (r.status !== 0) throw new Error(`git blame failed: ${r.stderr.toString()}`)
      // Porcelain: each line's header is `<oid> <orig line> <final line>[ <count>]`, then the
      // commit's headers (first time only), then a TAB and the line itself.
      const owners: string[] = []
      for (const line of r.stdout.toString().split('\n')) {
        const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line)
        if (m) owners[Number(m[2]) - 1] = m[1] as string
      }
      return owners
    })
  } finally {
    done()
  }
}

/**
 * `git log --format=%H <tip> [-- <path>]` for each of `tips` over `objects` (written once into a
 * scratch repository): every commit reachable from the tip (that changed `path`), in git's order.
 * Null without git.
 */
export function gitLog(objects: Iterable<GitObject>, tips: readonly string[], path?: string): string[][] | null {
  if (!HAVE_GIT) return null
  const { dir, done } = scratchRepo()
  try {
    writeBatched(dir, objects)
    return tips.map((tip) => {
      const r = spawnSync('git', ['log', '--format=%H', tip, ...(path !== undefined ? ['--', path] : [])], { cwd: dir, maxBuffer: 1 << 26 })
      if (r.status !== 0) throw new Error(`git log failed: ${r.stderr.toString()}`)
      return r.stdout.toString().split('\n').filter((l) => l !== '')
    })
  } finally {
    done()
  }
}

/**
 * `git merge-tree --write-tree` for each `[ours, theirs]` commit pair in `dir` (batched
 * through `--stdin`): the merged tree oid when clean, else null. Null without git.
 */
export function gitMergeTrees(dir: string, pairs: readonly (readonly [string, string])[]): (string | null)[] | null {
  if (!HAVE_GIT) return null
  const r = spawnSync('git', ['merge-tree', '--stdin', '--name-only', '--no-messages', '-z'], {
    cwd: dir,
    // No user configuration: a `merge.renames` or `merge.directoryRenames` would change answers.
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
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

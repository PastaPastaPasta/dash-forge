/**
 * Real git as the judge of the browser's rebase merge (skipped where git is not installed): for
 * random PR histories against a base that moved on — line edits in files both sides change,
 * adds, deletes and mode flips, commits that start empty, commits whose change the base already
 * has (git drops them once empty), cherry-picks of base commits (git skips them by patch-id),
 * messages with leading blank lines or no final newline, odd author lines and signed commits —
 * whenever the browser rebases, `git rebase --merge <base tip>` run with the same committer and
 * time ends on the identical commit (same oid, so every commit is the same bytes); whenever the
 * browser fast-forwards, git leaves the head as it is. Whatever git cannot rebase cleanly, the
 * browser refuses.
 *
 * `FORGE_PARITY_CASES` sets the cases (300 by default), `FORGE_PARITY_SEED` the seed.
 */

import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { gitOidHex, MODE_TREE, type GitObject } from '../browse'
import { BrowseReader, ObjectLocator } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { Store } from '../view/diff-fixtures'
import { parseCommit } from '../view/git-objects'
import { runMerge, type MergeInput } from './engine'
import { HAVE_GIT, scratchRepo, writeBatched } from './git-oracle'
import { editLines, GIT_ENV, linesText, pick, prng, randomLines } from './parity-fixtures'

const CASES = Number(process.env['FORGE_PARITY_CASES'] ?? '300')
const SEED = Number(process.env['FORGE_PARITY_SEED'] ?? '20261004')

const ME = { name: 'Merger', email: 'm@example.com', timestamp: 1_700_000_000, timezoneOffset: -60 }
const input = (baseTip: string, headOid: string): MergeInput => ({ baseTip, headOid, prNumber: 3, sourceLabel: 'feature', author: ME, headInBase: false, rebase: true })

type Files = Map<string, { readonly content: string; readonly mode: number }>

const PATHS = ['a', 'b', 'c', 'd/x', 'd/y', 'e/z']
const MESSAGES = ['subject\n', 'subject\n\nbody line\n', '\n\n  \nafter blank lines\n', 'no final newline', 'trailing  \n\n\n', '# not a comment\n', '\t\n\tindented\n', 'é unicode\n', '']
const AUTHORS = ['Ann <ann@example.com> 1500000000 +0000', 'Bob B <bob@x> 1500000100 -0700', ' Spaced  Name  <s@x> 1500000200 +0100', 'Zone <z@x> 1500000300 -0000', 'Odd <o@x> 1500000400 +0175']
const SIG = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----'

function buildTree(s: Store, files: Files): string {
  const dirs = new Map<string, Files>()
  const here: { name: string; oid: string; mode: number }[] = []
  for (const [p, f] of files) {
    const slash = p.indexOf('/')
    if (slash === -1) here.push({ name: p, oid: s.blob(f.content), mode: f.mode })
    else {
      const sub: Files = dirs.get(p.slice(0, slash)) ?? new Map()
      sub.set(p.slice(slash + 1), f)
      dirs.set(p.slice(0, slash), sub)
    }
  }
  for (const [dir, sub] of dirs) here.push({ name: dir, oid: buildTree(s, sub), mode: MODE_TREE })
  return s.tree(here)
}

/** A random change: lines edited in a file or two (often a file the other side edits), sometimes an add, a delete or a mode flip. */
function edit(from: Files, tag: string, rand: () => number): Files {
  const out: Files = new Map(from)
  for (let k = 1 + Math.floor(rand() * 2); k > 0; k--) {
    const r = rand()
    const p = pick(rand, PATHS)
    const f = out.get(p)
    if (r < 0.7 && f !== undefined) {
      const lines = f.content.split('\n').slice(0, f.content.endsWith('\n') ? -1 : undefined)
      out.set(p, { content: linesText(editLines(lines, rand, tag), rand), mode: f.mode })
    } else if (r < 0.82) out.set(p, { content: linesText([`${p} ${rand() < 0.4 ? 'same' : tag}`, ...randomLines(rand, 6)], rand), mode: 0o100644 })
    else if (r < 0.92) out.delete(p)
    else if (f !== undefined) out.set(p, { content: f.content, mode: f.mode === 0o100644 ? 0o100755 : 0o100644 })
  }
  if (out.size === 0) out.set('keep', { content: `keep ${tag}\n`, mode: 0o100644 })
  return out
}

/** A commit with exact bytes: any author line and message, optionally signed. */
function rawCommit(s: Store, tree: string, parent: string, author: string, committerAt: number, message: string, signed: boolean): string {
  const text = `tree ${tree}\nparent ${parent}\nauthor ${author}\ncommitter Dev <dev@x> ${committerAt} +0200\n${signed ? `${SIG}\n` : ''}\n${message}`
  const bytes = new TextEncoder().encode(text)
  const oid = gitOidHex('commit', bytes)
  s.objects.set(oid, { type: 'commit', bytes })
  return oid
}

async function packed(pack: Uint8Array): Promise<GitObject[]> {
  const rows = await indexPacks([pack])
  const r = new BrowseReader(ObjectLocator.parse(serializeLocator(rows)), memoryPackSource([pack]))
  return Promise.all(rows.map((row) => r.readObject(row.oidHex)))
}

/** `git rebase --merge <base>` of `head` in `dir` as the merger at ME's time: the new HEAD, or null when it stops. */
function gitRebase(dir: string, base: string, head: string): string | null {
  const run = (args: string[], env: NodeJS.ProcessEnv = GIT_ENV) => spawnSync('git', args, { cwd: dir, env, maxBuffer: 1 << 26 })
  run(['checkout', '-q', '-f', '--detach', head])
  run(['clean', '-fdxq'])
  const env = { ...GIT_ENV, GIT_COMMITTER_NAME: ME.name, GIT_COMMITTER_EMAIL: ME.email, GIT_COMMITTER_DATE: `${ME.timestamp} +0100` }
  const r = run(['rebase', '--merge', '-q', base], env)
  if (r.status !== 0) {
    run(['rebase', '--abort'])
    return null
  }
  return run(['rev-parse', 'HEAD']).stdout.toString().trim()
}

describe.skipIf(!HAVE_GIT)('the browser rebase is git rebase, commit for commit', () => {
  it('random PR histories against a moved base', async () => {
    const s = new Store()
    const rand = prng(SEED)
    const cases: { base: string; head: string; web: string | null; kind: string; picks: number; dupOrEmpty: boolean }[] = []
    let clock = 1_600_000_000
    for (let n = 0; n < CASES; n++) {
      const baseFiles: Files = new Map()
      for (const p of PATHS) if (rand() < 0.6) baseFiles.set(p, { content: linesText([p, ...randomLines(rand, 14)], rand), mode: 0o100644 })
      if (baseFiles.size === 0) baseFiles.set('a', { content: 'a\n', mode: 0o100644 })
      const mergeBase = s.commit(buildTree(s, baseFiles))
      // The base moves on (or not: a fast-forward), keeping each commit's change for cherry-picks.
      const upstream: { before: Files; after: Files }[] = []
      let baseTip = mergeBase
      let files = baseFiles
      const ups = rand() < 0.12 ? 0 : 1 + Math.floor(rand() * 3)
      for (let i = 0; i < ups; i++) {
        const next = edit(files, `u${i}`, rand)
        upstream.push({ before: files, after: next })
        baseTip = s.commit(buildTree(s, next), [baseTip])
        files = next
      }
      // The PR: a few commits from the merge base, some empty, some repeating a base change.
      let head = mergeBase
      let mine = baseFiles
      let dupOrEmpty = false
      const picks = 1 + Math.floor(rand() * 4)
      for (let i = 0; i < picks; i++) {
        const r = rand()
        let next: Files
        if (r < 0.08) next = mine
        else if (r < 0.2 && upstream.length > 0) {
          // A base commit's change, applied here too (a cherry-pick, or the same fix made twice).
          const u = pick(rand, upstream)
          next = new Map(mine)
          for (const p of new Set([...u.before.keys(), ...u.after.keys()])) {
            const after = u.after.get(p)
            if (after === u.before.get(p)) continue
            if (after === undefined) next.delete(p)
            else next.set(p, after)
          }
          dupOrEmpty = true
        } else next = edit(mine, `h${i}`, rand)
        if (next === mine) dupOrEmpty = true
        head = rawCommit(s, buildTree(s, next), head, pick(rand, AUTHORS), clock++, pick(rand, MESSAGES), rand() < 0.15)
        mine = next
      }
      const out = await runMerge(s.reader(), input(baseTip, head))
      let web: string | null = null
      if (out.kind === 'rebase' || out.kind === 'fast-forward') {
        for (const o of await packed(out.pack)) s.objects.set(gitOidHex(o.type, o.bytes), o)
        web = out.newTip
      } else if (out.kind !== 'conflict') throw new Error(`case ${n}: unexpected ${out.kind}${'reason' in out ? `: ${out.reason}` : ''}`)
      cases.push({ base: baseTip, head, web, kind: out.kind, picks, dupOrEmpty })
    }
    const { dir, done } = scratchRepo()
    try {
      writeBatched(dir, s.objects.values())
      const wrong: string[] = []
      let gitClean = 0
      for (const c of cases) {
        const git = gitRebase(dir, c.base, c.head)
        if (git !== null) gitClean++
        if (c.web !== null && c.web !== git) wrong.push(`${c.base}..${c.head} (${c.kind}): web ${c.web}, git ${git ?? 'STOPPED'}`)
      }
      expect(wrong).toEqual([])
      // Not vacuous: real rebases of several commits, fast-forwards, refusals, and rebases where
      // git skipped or dropped a commit (or kept an empty one) all occur.
      const rebased = cases.filter((c) => c.kind === 'rebase')
      expect(rebased.length).toBeGreaterThan(CASES / 5)
      expect(rebased.filter((c) => c.picks > 1).length).toBeGreaterThan(CASES / 10)
      expect(rebased.filter((c) => c.dupOrEmpty).length).toBeGreaterThan(CASES / 40)
      expect(cases.filter((c) => c.kind === 'fast-forward').length).toBeGreaterThan(CASES / 30)
      expect(cases.filter((c) => c.kind === 'conflict').length).toBeGreaterThan(CASES / 30)
      // What git rebases and the browser leaves to the CLI stays a minority.
      expect(gitClean - rebased.length - cases.filter((c) => c.kind === 'fast-forward').length).toBeLessThan(gitClean / 2)
      // The rebased commits keep the PR's authors and messages, and name the merger as committer.
      const sample = rebased[0]
      if (sample?.web) expect(parseCommit((s.objects.get(sample.web) as GitObject).bytes).committer).toMatchObject({ name: ME.name, email: ME.email, when: ME.timestamp * 1000 })
    } finally {
      done()
    }
  }, 900_000)
})

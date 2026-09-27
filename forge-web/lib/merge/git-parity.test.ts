/**
 * Real git as the judge (skipped where git is not installed; run locally and in CI):
 *
 *  - what the browser merge produces from ordinary histories — fast-forwards, merge commits,
 *    subdirectories, symlinks, executables, gitlinks, non-ASCII names — passes
 *    `git fsck --strict`, `git log` and `git clone` when written into a real repository;
 *  - property (a): for random pairs of tree edits (every file mode, renames, directory moves,
 *    file<->directory swaps, identical adds), the browser refuses exactly when the owner's
 *    file-level rule says so, and whenever it says a merge is clean,
 *    `git merge-tree --write-tree` is clean too and writes the identical tree;
 *  - property (b): random mutations of well-formed commits and trees, and trees naming git's
 *    special files in every mode — the web's checks never accept one `git fsck --strict`
 *    rejects.
 *
 * `FORGE_PARITY_CASES` sets the cases per property (300 by default; the local gate runs a few
 * thousand), `FORGE_PARITY_SEED` the seed.
 */

import { afterAll, describe, expect, it } from 'vitest'

import { gitOidHex, MODE_GITLINK, MODE_TREE, type GitObject } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { BrowseReader, ObjectLocator } from '../browse'
import { Store } from '../view/diff-fixtures'
import { checkCommit, checkTree, parseCommit } from '../view/git-objects'
import { runMerge, type MergeInput } from './engine'
import { gitAcceptsHistory, gitMergeTrees, gitStrictRejects, HAVE_GIT, scratchRepo, writeLiterally } from './git-oracle'

const ME = { name: 'Merger', email: 'm@example.com', timestamp: 1_700_000_000, timezoneOffset: -60 }
const input = (baseTip: string, headOid: string): MergeInput => ({ baseTip, headOid, prNumber: 9, sourceLabel: 'refs/heads/feature', title: 'Feature', author: ME, headInBase: false })

/** Cases per property. */
const CASES = Number(process.env['FORGE_PARITY_CASES'] ?? '300')
/** The PRNG seed (`FORGE_PARITY_SEED`), so a failure is reproducible and other seeds can be tried. */
const SEED = Number(process.env['FORGE_PARITY_SEED'] ?? '20260926')

/** The objects a merge pack carries. */
async function packed(pack: Uint8Array): Promise<GitObject[]> {
  const rows = await indexPacks([pack])
  const r = new BrowseReader(ObjectLocator.parse(serializeLocator(rows)), memoryPackSource([pack]))
  return Promise.all(rows.map((row) => r.readObject(row.oidHex)))
}

describe.skipIf(!HAVE_GIT)('what the browser merge produces, git accepts', () => {
  it('a merge commit over directories, an executable, a symlink, a gitlink and non-ASCII names', async () => {
    const s = new Store()
    const sub = '1'.repeat(40)
    const tree = (a: string, b: string): string =>
      s.tree([
        { name: 'README.md', oid: s.blob(a) },
        { name: 'src', oid: s.files({ 'main.rs': b, 'lib/util.rs': 'u\n' }), mode: MODE_TREE },
        { name: 'run.sh', oid: s.blob('#!/bin/sh\n'), mode: 0o100755 },
        { name: 'link', oid: s.blob('README.md'), mode: 0o120000 },
        { name: 'vendor', oid: sub, mode: MODE_GITLINK },
        { name: 'café.txt', oid: s.blob('é\n') },
        { name: '\u{1f600}.md', oid: s.blob('smile\n') },
      ])
    const root = s.commit(tree('r\n', 'fn main() {}\n'))
    const base = s.commit(tree('R\n', 'fn main() {}\n'), [root])
    const head = s.commit(tree('r\n', 'fn main() { run() }\n'), [root])
    const out = await runMerge(s.reader(), input(base, head))
    if (out.kind !== 'merge') throw new Error(out.kind)
    const verdict = gitAcceptsHistory([...s.objects.values(), ...(await packed(out.pack))], out.newTip)
    expect(verdict).toEqual({ fsck: true, log: true, clone: true })
  }, 60_000)

  it('a fast-forward', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const head = s.commit(s.files({ 'a.txt': 'b\n', 'd/e.txt': 'e\n' }), [base])
    const out = await runMerge(s.reader(), input(base, head))
    if (out.kind !== 'fast-forward') throw new Error(out.kind)
    expect(gitAcceptsHistory([...s.objects.values(), ...(await packed(out.pack))], out.newTip)).toEqual({ fsck: true, log: true, clone: true })
  }, 60_000)
})

/** A tiny deterministic PRNG, so a failure is reproducible from its seed. */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 0x1_0000_0000
  }
}

/** A random element of `xs`. */
const pick = <T,>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T

// ---------------------------------------------------------------------------
// (a) refused exactly by the rule; clean in the browser ⇒ clean in git, with the same tree
// ---------------------------------------------------------------------------

/** A file-level entry: a blob's content (file or symlink target), or a gitlink's commit oid. */
type Files = Map<string, { readonly content: string; readonly mode: number }>

/** A tree for `files` (`/`-separated paths). */
function buildTree(s: Store, files: Files): string {
  const dirs = new Map<string, Files>()
  const here: { name: string; oid: string; mode: number }[] = []
  for (const [p, f] of files) {
    const slash = p.indexOf('/')
    if (slash === -1) here.push({ name: p, oid: f.mode === MODE_GITLINK ? f.content : s.blob(f.content), mode: f.mode })
    else {
      const dir = p.slice(0, slash)
      const sub: Files = dirs.get(dir) ?? new Map()
      sub.set(p.slice(slash + 1), f)
      dirs.set(dir, sub)
    }
  }
  for (const [dir, sub] of dirs) here.push({ name: dir, oid: buildTree(s, sub), mode: MODE_TREE })
  return s.tree(here)
}

const PATHS = ['a', 'b', 'd/x', 'd/y', 'd/e/z', 'd/e/q', 'e/w', 'f', 'l', 'm']
const DIRS = ['d', 'd/e', 'e']
const FILE_MODES = [0o100644, 0o100755, 0o120000, MODE_GITLINK]

/** An entry of `mode` whose content depends on `seed` (a gitlink gets a commit oid). */
function entry(mode: number, seed: string): { content: string; mode: number } {
  if (mode !== MODE_GITLINK) return { content: `${seed}\n`, mode }
  let h = 7
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return { content: h.toString(16).padStart(8, '0').repeat(5), mode }
}

/**
 * A random edit of `from`: adds (sometimes the same bytes both sides add), content and mode
 * changes across files, executables, symlinks and gitlinks, deletions, whole directories
 * removed or moved, a file replaced by a directory and a directory by a file — often on the
 * paths the other side touches too, or above or below them.
 */
function randomEdit(from: Files, tag: string, rand: () => number): Files {
  const one = <T,>(xs: readonly T[]): T => pick(rand, xs)
  const out: Files = new Map(from)
  for (let k = 1 + Math.floor(rand() * 3); k > 0; k--) {
    const r = rand()
    if (r < 0.2) {
      const p = one(PATHS)
      // Half the time the same bytes whichever side adds them.
      out.set(p, entry(one(FILE_MODES), rand() < 0.5 ? `${p} same` : `${p} ${tag}`))
    } else if (r < 0.3) {
      const p = one([...out.keys()])
      const f = out.get(p)
      if (f !== undefined) out.set(p, entry(one(FILE_MODES.filter((m) => m !== f.mode)), f.content))
    } else if (r < 0.45) {
      out.delete(one(PATHS))
    } else if (r < 0.6) {
      // A directory removed, or moved elsewhere whole (a directory rename).
      const d = one(DIRS)
      const moved = rand() < 0.5 ? `m${tag}` : null
      for (const q of [...out.keys()]) {
        if (!q.startsWith(`${d}/`)) continue
        const f = out.get(q) as { content: string; mode: number }
        out.delete(q)
        if (moved !== null) out.set(`${moved}/${q.slice(d.length + 1)}`, f)
      }
    } else if (r < 0.7) {
      // A file renamed (same content).
      const p = one([...out.keys()])
      const f = out.get(p)
      if (f !== undefined) {
        out.delete(p)
        out.set(`${p}${tag}`, f)
      }
    } else if (r < 0.8) {
      out.set(`${one(DIRS)}/n${rand() < 0.5 ? 'same' : tag}`, entry(0o100644, `new ${tag}`))
    } else if (r < 0.9) {
      // A file replaced by a directory of that name.
      const p = one(['a', 'b', 'f', 'l'])
      out.delete(p)
      out.set(`${p}/in${tag}`, entry(0o100644, `in ${tag}`))
    } else {
      // A directory replaced by a file of that name.
      const d = one(DIRS)
      for (const q of [...out.keys()]) if (q.startsWith(`${d}/`)) out.delete(q)
      out.set(d, entry(one(FILE_MODES), `${d} ${tag}`))
    }
  }
  // A path cannot be a file and a directory at once: drop the file.
  for (const q of [...out.keys()]) if ([...out.keys()].some((o) => o.startsWith(`${q}/`))) out.delete(q)
  if (out.size === 0) out.set('keep', entry(0o100644, `keep ${tag}`))
  return out
}

/**
 * The owner's rule, straight from the file lists: refuse when a path — or an ancestor or
 * descendant of it — is touched (added, modified, deleted, mode changed) by both sides, or
 * when one side deleted every file of a base directory and the other added under it.
 */
function ruleRefuses(base: Files, ours: Files, theirs: Files): boolean {
  const touched = (side: Files): string[] => {
    const paths = new Set([...base.keys(), ...side.keys()])
    return [...paths].filter((p) => {
      const b = base.get(p)
      const x = side.get(p)
      return b?.content !== x?.content || b?.mode !== x?.mode
    })
  }
  const to = touched(ours)
  const tt = touched(theirs)
  const related = (p: string, q: string): boolean => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)
  if (to.some((p) => tt.some((q) => related(p, q)))) return true
  const dirsOf = (files: Files): Set<string> => {
    const out = new Set<string>()
    for (const p of files.keys()) for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) out.add(p.slice(0, i))
    return out
  }
  for (const d of dirsOf(base)) {
    const under = (files: Files): boolean => [...files.keys()].some((p) => p.startsWith(`${d}/`))
    for (const [emptier, other] of [
      [ours, theirs],
      [theirs, ours],
    ] as const) {
      const addsUnder = [...other.keys()].some((p) => p.startsWith(`${d}/`) && !base.has(p))
      if (!under(emptier) && addsUnder) return true
    }
  }
  return false
}

describe.skipIf(!HAVE_GIT)('property (a): the browser refuses exactly by the rule, and a clean merge is git merge-tree', () => {
  it('random edit pairs against the rule and git merge-tree --write-tree', async () => {
    const { dir, done } = scratchRepo()
    try {
      const s = new Store()
      const rand = prng(SEED + 1)
      const cases: { ours: string; theirs: string; web: string | null }[] = []
      const ruleBroken: string[] = []
      for (let n = 0; n < CASES; n++) {
        const baseFiles: Files = new Map()
        for (const p of PATHS) if (rand() < 0.6) baseFiles.set(p, entry(rand() < 0.8 ? 0o100644 : pick(rand, FILE_MODES), p))
        if (baseFiles.size === 0) baseFiles.set('a', entry(0o100644, 'a'))
        const oursFiles = randomEdit(baseFiles, 'o', rand)
        const theirsFiles = randomEdit(baseFiles, 't', rand)
        const b = s.commit(buildTree(s, baseFiles))
        const ours = s.commit(buildTree(s, oursFiles), [b])
        const theirs = s.commit(buildTree(s, theirsFiles), [b])
        const out = await runMerge(s.reader(), input(ours, theirs))
        let web: string | null = null
        if (out.kind === 'merge') {
          const objects = await packed(out.pack)
          for (const o of objects) s.objects.set(gitOidHex(o.type, o.bytes), o)
          web = parseCommit((s.objects.get(out.newTip) as GitObject).bytes).tree
        } else if (out.kind !== 'conflict' && out.kind !== 'fast-forward' && out.kind !== 'up-to-date') {
          throw new Error(`case ${n}: unexpected ${out.kind}`)
        }
        if (out.kind !== 'merge' && out.kind !== 'conflict') continue
        // Refused exactly when the rule says so, in both directions.
        if ((out.kind === 'conflict') !== ruleRefuses(baseFiles, oursFiles, theirsFiles)) {
          ruleBroken.push(`case ${n}: web ${out.kind}; base ${JSON.stringify([...baseFiles.keys()])} ours ${JSON.stringify([...oursFiles])} theirs ${JSON.stringify([...theirsFiles])}`)
        }
        cases.push({ ours, theirs, web })
      }
      expect(ruleBroken.slice(0, 5)).toEqual([])
      writeLiterally(dir, s.objects.values())
      const git = gitMergeTrees(dir, cases.map((c) => [c.ours, c.theirs] as const)) ?? []
      const wrong = cases.flatMap((c, i) => (c.web !== null && c.web !== git[i] ? [`${c.ours}..${c.theirs}: web ${c.web}, git ${git[i] ?? 'CONFLICT'}`] : []))
      expect(wrong).toEqual([])
      // Not vacuous: clean merges and refusals both occur often.
      const clean = cases.filter((c) => c.web !== null).length
      expect(clean).toBeGreaterThan(cases.length / 10)
      expect(cases.length - clean).toBeGreaterThan(cases.length / 10)
    } finally {
      done()
    }
  }, 900_000)
})

// ---------------------------------------------------------------------------
// (b) the web accepts nothing git fsck --strict rejects
// ---------------------------------------------------------------------------

const INTERESTING = [0x00, 0x0a, 0x20, 0x2f, 0x2e, 0x30, 0x3c, 0x3e, 0x5c, 0x7f, 0xef, 0xbb, 0xbf, 0xff, 0x2b, 0x2d, 0x7e, 0x3a]

/** Mutate `bytes`: flip, insert, delete or duplicate a line, biased towards interesting bytes. */
function mutate(bytes: Uint8Array, rand: () => number): Uint8Array {
  const arr = [...bytes]
  const at = Math.floor(rand() * (arr.length + 1))
  const byte = (): number => (rand() < 0.7 ? pick(rand, INTERESTING) : Math.floor(rand() * 256))
  switch (Math.floor(rand() * 5)) {
    case 0:
      if (arr.length > 0) arr[Math.min(at, arr.length - 1)] = byte()
      break
    case 1:
      arr.splice(at, 0, byte())
      break
    case 2:
      arr.splice(at, 1 + Math.floor(rand() * 4))
      break
    case 3: {
      const text = new TextDecoder('latin1').decode(new Uint8Array(arr))
      const lines = text.split('\n')
      const i = Math.floor(rand() * lines.length)
      lines.splice(i, 0, lines[i] as string)
      return Uint8Array.from(lines.join('\n'), (c) => c.charCodeAt(0))
    }
    default:
      arr.unshift(0xef, 0xbb, 0xbf)
  }
  return new Uint8Array(arr)
}

const webAccepts = (o: GitObject): boolean => {
  try {
    if (o.type === 'commit') checkCommit(gitOidHex(o.type, o.bytes), o.bytes)
    else checkTree(gitOidHex(o.type, o.bytes), o.bytes)
    return true
  } catch {
    return false
  }
}

/** Names on the edge of git's `.git` and special-file rules. */
const NAMES = [
  '.gitmodules',
  'gitmod~1',
  'gitmod~5',
  'gi7eba~1',
  'gi7eba~0',
  '~1234567',
  '.GITMODULES.',
  '.gitmodules:x',
  '.g‌itmodules',
  '.gitattributes',
  'gi7d29~1',
  'gitatt~1',
  '.gitignore',
  'gi250a~1',
  '.mailmap',
  '.git',
  'git~1',
  'git~2',
  '.GIT ',
  '.g‌it',
  '.git:x',
  'x',
]
const MODES = ['100644', '100755', '120000', '40000', '160000', '100664']

describe.skipIf(!HAVE_GIT)('property (b): the web never accepts an object git fsck --strict rejects', () => {
  const { dir, done } = scratchRepo()
  afterAll(done)

  it('mutated commits and trees, and trees naming special files, judged by one fsck', () => {
    const s = new Store()
    const gm = s.blob('[submodule "x"]\n\tpath = x\n\turl = https://e.com/x\n')
    const tree = s.tree([
      { name: 'a.txt', oid: s.blob('a\n') },
      { name: 'dir', oid: s.files({ 'x.rs': 'x\n' }), mode: MODE_TREE },
      { name: 'link', oid: s.blob('a.txt'), mode: 0o120000 },
      { name: 'sub', oid: '1'.repeat(40), mode: MODE_GITLINK },
    ])
    const parent = s.commit(tree)
    const commit = s.commit(tree, [parent], 'message\nbody')
    const seeds: GitObject[] = [s.objects.get(tree) as GitObject, s.objects.get(commit) as GitObject]
    const sub = s.files({ q: 'q\n' })
    const rand = prng(SEED)
    const accepted = new Map<string, GitObject>()
    // A known-bad tree (out of order) shows fsck really judges these unreachable objects.
    const canary: GitObject = { type: 'tree', bytes: new Uint8Array([...new TextEncoder().encode('100644 b'), 0, ...Buffer.from(gm, 'hex'), ...new TextEncoder().encode('100644 a'), 0, ...Buffer.from(gm, 'hex')]) }
    for (let n = 0; n < CASES; n++) {
      let obj: GitObject
      if (n % 3 === 2) {
        const name = pick(rand, NAMES)
        const mode = pick(rand, MODES)
        const target = mode === '40000' ? sub : mode === '160000' ? '2'.repeat(40) : gm
        obj = { type: 'tree', bytes: new Uint8Array([...new TextEncoder().encode(`${mode} ${name}`), 0, ...Buffer.from(target, 'hex')]) }
      } else {
        const seed = seeds[n % 2] as GitObject
        let bytes = seed.bytes
        for (let k = 1 + Math.floor(rand() * 3); k > 0; k--) bytes = mutate(bytes, rand)
        obj = { type: seed.type, bytes }
      }
      if (webAccepts(obj)) accepted.set(gitOidHex(obj.type, obj.bytes), obj)
    }
    // The objects the trees name are written too, so fsck judges every entry (a .gitmodules
    // blob included), not only the tree bytes.
    writeLiterally(dir, [...s.objects.values(), ...accepted.values(), canary])
    const rejected = gitStrictRejects(dir) ?? new Set<string>()
    const disagreements = [...accepted.keys()].filter((oid) => rejected.has(oid)).map((oid) => Buffer.from((accepted.get(oid) as GitObject).bytes).toString('hex'))
    expect(disagreements).toEqual([])
    // Not vacuous: fsck judged the canary, and enough mutants reached it.
    expect(rejected.has(gitOidHex('tree', canary.bytes))).toBe(true)
    expect(accepted.size).toBeGreaterThan(CASES / 20)
  }, 900_000)
})

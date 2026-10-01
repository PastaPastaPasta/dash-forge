/**
 * The browser .zip against `git archive` (QW-026): `.gitattributes` (export-ignore,
 * export-subst), `$Format:` placeholders, `git describe`, Unix modes, the commit's time and the
 * archive comment. The parts that can be are checked against real git; skipped without git.
 */

import { spawnSync } from 'node:child_process'

import { unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { gitOidHex, MODE_TREE } from '../browse'
import { HAVE_GIT, scratchRepo, writeLiterally } from '../merge/git-oracle'
import {
  autoAbbrevLength,
  describeCommit,
  exportAttributes,
  formatCommit,
  describeNames,
  parseArchiveCommit,
  peelTags,
  uniqueAbbrev,
  type DescribeTag,
  type FormatContext,
} from './archive'
import { Store } from './diff-fixtures'
import { planArchive, readZipFiles, substituteFiles } from './zip'
import { withArchiveComment, zipEntries } from './zip-entries'

const enc = new TextEncoder()

/** Put a raw object of `type` into the store; its oid. */
function raw(s: Store, type: 'commit' | 'tag', text: string): string {
  const bytes = enc.encode(text)
  const oid = gitOidHex(type, bytes)
  s.objects.set(oid, { type, bytes })
  return oid
}

function git(dir: string, args: string[], input?: Uint8Array): { out: string; bytes: Buffer; status: number | null } {
  const r = spawnSync('git', args, {
    cwd: dir,
    input,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', TZ: process.env['TZ'] ?? '' },
    maxBuffer: 1 << 26,
  })
  return { out: r.stdout.toString().trim(), bytes: r.stdout, status: r.status }
}

const findIn = (s: Store) => (prefix: string, limit = 2): string[] => [...s.objects.keys()].filter((o) => o.startsWith(prefix)).slice(0, limit)

describe('.gitattributes for an archive', () => {
  it('matches basenames and anchored paths, lets later lines and deeper files win, and ignores whole directories', () => {
    const attrs = exportAttributes(
      new Map([
        ['.gitattributes', 'src/version.c export-subst\n*.md export-ignore\nREADME.md -export-ignore\n/ci export-ignore\ndocs/**/*.png export-ignore\n# a comment\n"odd name.txt" export-ignore\n'],
        ['lib/.gitattributes', 'keep.md -export-ignore\n*.c export-subst\n'],
      ]),
    )
    expect(attrs('src/version.c')).toEqual({ ignore: false, subst: true })
    expect(attrs('notes.md').ignore).toBe(true)
    expect(attrs('deep/dir/notes.md').ignore).toBe(true)
    expect(attrs('README.md').ignore).toBe(false)
    expect(attrs('lib/keep.md').ignore).toBe(false)
    expect(attrs('lib/x.c').subst).toBe(true)
    expect(attrs('src/other.c').subst).toBe(false)
    // An anchored directory: everything under it.
    expect(attrs('ci/build.sh').ignore).toBe(true)
    expect(attrs('src/ci/build.sh').ignore).toBe(false)
    expect(attrs('docs/a/b/c.png').ignore).toBe(true)
    expect(attrs('docs/c.png').ignore).toBe(true)
    expect(attrs('odd name.txt').ignore).toBe(true)
  })

  it('takes a directory-only pattern for the directory and everything in it, never for a file of that name', () => {
    const attrs = exportAttributes(new Map([['.gitattributes', '/tests/ export-ignore\nfixtures/ export-ignore\n']]))
    expect(attrs('tests/a_test.c').ignore).toBe(true)
    expect(attrs('src/tests/a.c').ignore).toBe(false)
    expect(attrs('lib/fixtures/data.json').ignore).toBe(true)
    // A file named like the directory pattern is not a directory.
    expect(attrs('fixtures').ignore).toBe(false)
  })
})

describe('$Format: placeholders', () => {
  const s = new Store()
  const tree = s.files({ a: 'a\n' })
  const parent = s.commit(tree)
  const oid = raw(
    s,
    'commit',
    `tree ${tree}\nparent ${parent}\nauthor Ada Lovelace <ada@example.com> 1700000000 +0200\ncommitter Bob <bob@example.com> 1700003600 -0530\n\nFix the thing\nacross two lines\n\nThe body.\n`,
  )
  const commit = parseArchiveCommit(oid, s.objects.get(oid)!.bytes)
  const ctx: FormatContext = { commit, abbrev: (o, min = 7) => o.slice(0, min), describe: (spec) => (spec === 'bogus' ? null : 'v1.0-3-gabcdef'), decorations: ['main', 'tag: v1.1'] }

  it('expands what git log --format would', () => {
    expect(formatCommit('%H|%h|%T|%P|%p', ctx)).toBe(`${oid}|${oid.slice(0, 7)}|${tree}|${parent}|${parent.slice(0, 7)}`)
    expect(formatCommit('%an <%ae> %al', ctx)).toBe('Ada Lovelace <ada@example.com> ada')
    expect(formatCommit('%ad|%aD|%ai|%aI|%at|%as', ctx)).toBe(
      // 1700000000 is 2023-11-14 22:13:20 UTC: in the author's +0200, past midnight.
      'Wed Nov 15 00:13:20 2023 +0200|Wed, 15 Nov 2023 00:13:20 +0200|2023-11-15 00:13:20 +0200|2023-11-15T00:13:20+02:00|1700000000|2023-11-15',
    )
    expect(formatCommit('%cn %cI', ctx)).toBe('Bob 2023-11-14T17:43:20-05:30')
    expect(formatCommit('%s', ctx)).toBe('Fix the thing across two lines')
    expect(formatCommit('%b', ctx)).toBe('The body.\n')
    expect(formatCommit('a%nb %% %x41 %d %D %(describe) %(describe:abbrev=12)', ctx)).toBe('a\nb % A  (main, tag: v1.1) main, tag: v1.1 v1.0-3-gabcdef v1.0-3-gabcdef')
    // Unknown placeholders stay as written, as git leaves them.
    expect(formatCommit('%Q %(foo) %(describe:bogus)', ctx)).toBe('%Q %(foo) %(describe:bogus)')
  })

  it('abbreviates as git does', () => {
    expect(autoAbbrevLength(0)).toBe(7)
    expect(autoAbbrevLength(5_000)).toBe(7)
    // dashpay/dash: ~500k objects is 10 digits, git's `--short` there.
    expect(autoAbbrevLength(500_000)).toBe(10)
    expect(uniqueAbbrev('abcdef1234', 4, (p) => (p.length < 6 ? ['abcdef1234', 'abcde99999'] : ['abcdef1234']))).toBe('abcdef')
  })
})

describe('substituteFiles, as git archive expands', () => {
  /** A two-commit repo whose tip has `files`, an annotated tag on the root and two tags on the tip. */
  function repo(files: Record<string, string>, { tagged = true, when = 1_700_000_000 } = {}) {
    const s = new Store()
    const root = s.commit(s.files({ a: '1\n' }), [], 'root')
    const tree = s.files({ '.gitattributes': '*.txt export-subst\n', ...files })
    const tip = raw(s, 'commit', `tree ${tree}\nparent ${root}\nauthor A <a@x> ${when} +0000\ncommitter A <a@x> ${when} +0000\n\ntip\n`)
    const tag = (target: string, name: string, time: number): DescribeTag => ({
      name,
      oid: raw(s, 'tag', `object ${target}\ntype commit\ntag ${name}\ntagger T <t@x> ${time} +0000\n\n${name}\n`),
    })
    const tags = tagged ? [tag(root, 'v1.0', 1), tag(tip, 'v2.0', 5), tag(tip, 'v2.0-final', 9)] : []
    return { s, tip, tags }
  }
  async function expand(files: Record<string, string>, opts: { tagged?: boolean; when?: number } = {}): Promise<Record<string, string>> {
    const { s, tip, tags } = repo(files, opts)
    const reader = Object.assign(s.reader(), { findByPrefix: async (p: string, limit?: number) => findIn(s)(p, limit), objectCount: s.objects.size })
    const plan = await planArchive(reader, tip)
    const entries = await readZipFiles(reader, plan.files, () => undefined)
    await substituteFiles(reader, plan, entries, { tags, heads: [{ name: 'main', oid: tip }] })
    return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, new TextDecoder().decode(v)]))
  }

  it('expands the first %(describe) whatever its option spelling, and leaves the ones after it', async () => {
    const got = await expand({ 'a.txt': '$Format:%(describe:tags=true)$ $Format:%(describe)$\n', 'b.txt': '$Format:%(describe:abbrev=0)$\n' })
    // Both tags are on the tip: the newer tagger date wins, as describe's replace_name picks.
    expect(got['a.txt']).toBe('v2.0-final %(describe)\n')
    expect(got['b.txt']).toBe('%(describe:abbrev=0)\n')
  })

  it('writes nothing for %(describe) when no tag describes the commit, as git does', async () => {
    expect((await expand({ 'a.txt': 'v="$Format:%(describe)$"\n' }, { tagged: false }))['a.txt']).toBe('v=""\n')
  })

  it('names every tag at the commit in %d', async () => {
    expect((await expand({ 'a.txt': '$Format:%d$\n' }))['a.txt']).toBe(' (main, tag: v2.0, tag: v2.0-final)\n')
  })

  it('zips a commit dated before 1980 (the DOS date is clamped; the UT field keeps the time)', async () => {
    const { s, tip } = repo({ 'a.txt': 'x\n' }, { tagged: false, when: 86_400 })
    const reader = s.reader()
    const plan = await planArchive(reader, tip)
    const entries = await readZipFiles(reader, plan.files, () => undefined)
    const zip = zipSync(zipEntries(entries, { modes: {}, mtime: plan.mtime, comment: tip }), { level: 6 })
    expect(Object.keys(unzipSync(zip))).toContain('a.txt')
    expect(centralDirectory(zip).get('a.txt')?.ut).toBe(86_400)
  })
})

/** A history with merges, annotated and lightweight tags, some tags on one commit. */
function taggedHistory(s: Store): { commits: string[]; tags: DescribeTag[] } {
  let x = 7
  const rand = (): number => ((x = (x * 1103515245 + 12345) >>> 0), x / 2 ** 32)
  const commits: string[] = []
  let a = s.commit(s.files({ f: '0\n' }), [], 'root')
  let b = a
  commits.push(a)
  const tags: DescribeTag[] = []
  let time = 1_600_000_000
  const tag = (target: string, name: string, annotated: boolean): void => {
    if (!annotated) {
      tags.push({ name, oid: target })
      return
    }
    time += 10
    tags.push({ name, oid: raw(s, 'tag', `object ${target}\ntype commit\ntag ${name}\ntagger T <t@example.com> ${time} +0000\n\n${name}\n`) })
  }
  for (let i = 1; i < 60; i++) {
    const onA = rand() < 0.6
    const merge = i % 7 === 0
    const parents = onA ? (merge ? [a, b] : [a]) : merge ? [b, a] : [b]
    const c = s.commit(s.files({ f: `${i}\n` }), parents, `c${i}`)
    commits.push(c)
    if (onA) a = c
    else b = c
    if (i % 9 === 0) tag(c, `v${i}`, true)
    if (i % 13 === 0) tag(c, `light${i}`, false)
    if (i === 27) tag(c, `v${i}-again`, true)
  }
  return { commits, tags }
}

describe.skipIf(!HAVE_GIT)('git describe, against git', () => {
  it('names the same tag and depth for every commit, annotated only and with --tags', async () => {
    const s = new Store()
    const { commits, tags } = taggedHistory(s)
    const { dir, done } = scratchRepo()
    try {
      writeLiterally(dir, s.objects.values())
      for (const t of tags) git(dir, ['update-ref', `refs/tags/${t.name}`, t.oid])
      const reader = s.reader()
      const abbrevOf = (oid: string, min = 7): string => uniqueAbbrev(oid, min, findIn(s))
      const peeled = await peelTags(reader, tags)
      for (const opts of [{ tags: false, abbrev: 12 }, { tags: true, abbrev: 7 }, { tags: false, abbrev: 0 }, { tags: false, abbrev: null }]) {
        const named = describeNames(peeled, { match: [], exclude: [] })
        for (const c of commits) {
          const want = git(dir, ['describe', ...(opts.abbrev === null ? [] : [`--abbrev=${opts.abbrev}`]), ...(opts.tags ? ['--tags'] : []), c])
          const got = await describeCommit(reader, c, named, opts, abbrevOf)
          expect(got ?? '', `${c} ${JSON.stringify(opts)}`).toBe(want.status === 0 ? want.out : '')
        }
      }
    } finally {
      done()
    }
  })

  it('takes match= and exclude= as git does', async () => {
    const s = new Store()
    const { commits, tags } = taggedHistory(s)
    const { dir, done } = scratchRepo()
    try {
      writeLiterally(dir, s.objects.values())
      for (const t of tags) git(dir, ['update-ref', `refs/tags/${t.name}`, t.oid])
      const reader = s.reader()
      const named = describeNames(await peelTags(reader, tags), { match: ['v*'], exclude: ['*-again'] })
      const tip = commits[commits.length - 1] as string
      const got = await describeCommit(reader, tip, named, { tags: false, abbrev: 7 }, (o, m = 7) => uniqueAbbrev(o, m, findIn(s)))
      expect(got).toBe(git(dir, ['describe', '--abbrev=7', '--match', 'v*', '--exclude', '*-again', tip]).out)
    } finally {
      done()
    }
  })
})

/** The central directory's entries: name, "made by" OS byte, external attributes, and the UT time. */
function centralDirectory(zip: Uint8Array): Map<string, { os: number; attrs: number; ut: number | null }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const out = new Map<string, { os: number; attrs: number; ut: number | null }>()
  for (let at = 0; at + 46 <= zip.length; ) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      at++
      continue
    }
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen))
    let ut: number | null = null
    for (let e = at + 46 + nameLen; e + 4 <= at + 46 + nameLen + extraLen; ) {
      const id = view.getUint16(e, true)
      const len = view.getUint16(e + 2, true)
      if (id === 0x5455 && len >= 5) ut = view.getUint32(e + 5, true)
      e += 4 + len
    }
    out.set(name, { os: view.getUint8(at + 5), attrs: view.getUint32(at + 38, true), ut })
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** The archive comment (end-of-central-directory record's). */
function archiveComment(zip: Uint8Array): string {
  for (let at = zip.length - 22; at >= 0; at--) {
    const view = new DataView(zip.buffer, zip.byteOffset + at)
    if (view.getUint32(0, true) === 0x06054b50) return new TextDecoder().decode(zip.subarray(at + 22, at + 22 + view.getUint16(20, true)))
  }
  return ''
}

describe.skipIf(!HAVE_GIT)('the browser zip against git archive --format=zip', () => {
  it('the same files, contents (export-subst expanded, export-ignore left out), modes, times and comment', async () => {
    const s = new Store()
    const script = s.blob('#!/bin/sh\necho hi\n')
    const version = s.blob('const char* v = "$Format:%H %h %an %ad %cI %s$";\n#define DESC "$Format:%(describe:abbrev=12)$"\n')
    const src = s.tree([
      { name: 'version.c', oid: version },
      { name: 'main.c', oid: s.blob('int main(void) { return 0; }\n') },
    ])
    const ci = s.files({ 'build.yml': 'on: push\n' })
    const tree = s.tree([
      { name: '.gitattributes', oid: s.blob('src/version.c export-subst\n/ci export-ignore\n*.log export-ignore\n') },
      { name: 'autogen.sh', oid: script, mode: 0o100755 },
      { name: 'ci', oid: ci, mode: MODE_TREE },
      { name: 'debug.log', oid: s.blob('noise\n') },
      { name: 'link', oid: s.blob('src/main.c'), mode: 0o120000 },
      { name: 'README.md', oid: s.blob('# hi\n') },
      { name: 'src', oid: src, mode: MODE_TREE },
    ])
    const root = s.commit(s.files({ README: 'x\n' }), [], 'root')
    const tagObj = raw(s, 'tag', `object ${root}\ntype commit\ntag v0.1\ntagger T <t@example.com> 1600000000 +0000\n\nv0.1\n`)
    const tip = raw(
      s,
      'commit',
      `tree ${tree}\nparent ${root}\nauthor Ada <ada@example.com> 1700000000 +0200\ncommitter Ada <ada@example.com> 1700000500 +0200\n\nRelease prep\n`,
    )
    const { dir, done } = scratchRepo()
    try {
      writeLiterally(dir, s.objects.values())
      git(dir, ['update-ref', 'refs/tags/v0.1', tagObj])
      const want = new Uint8Array(git(dir, ['archive', '--format=zip', '--prefix=p/', tip]).bytes)

      // The browser's pipeline, as the clone box runs it.
      const reader = Object.assign(s.reader(), { findByPrefix: async (p: string, limit?: number) => findIn(s)(p, limit), objectCount: s.objects.size })
      const plan = await planArchive(reader, tip)
      const entries = await readZipFiles(reader, plan.files, () => undefined)
      await substituteFiles(reader, plan, entries, { tags: [{ name: 'v0.1', oid: tagObj }], heads: [] })
      const rooted: Record<string, Uint8Array> = {}
      const modes: Record<string, number> = {}
      for (const f of plan.files) modes[`p/${f.path}`] = f.mode
      for (const [path, bytes] of Object.entries(entries)) rooted[`p/${path}`] = bytes
      const meta = { modes, mtime: plan.mtime, comment: tip }
      const got = withArchiveComment(zipSync(zipEntries(rooted, meta), { level: 6 }), meta.comment)

      const wantFiles = unzipSync(want)
      const gotFiles = unzipSync(got)
      expect(Object.keys(gotFiles).sort()).toEqual(Object.keys(wantFiles).sort())
      for (const [name, bytes] of Object.entries(wantFiles)) expect(new TextDecoder().decode(gotFiles[name]), name).toBe(new TextDecoder().decode(bytes))
      // `$Format:` really was expanded (not merely equal because both left it).
      expect(new TextDecoder().decode(gotFiles['p/src/version.c'])).toContain(`${tip} ${tip.slice(0, 7)} Ada Wed Nov 15 00:13:20 2023 +0200`)
      expect(new TextDecoder().decode(gotFiles['p/src/version.c'])).toContain('v0.1-1-g')

      const wantDir = centralDirectory(want)
      const gotDir = centralDirectory(got)
      for (const [name, w] of wantDir) {
        const g = gotDir.get(name)
        expect(g, name).toBeDefined()
        expect({ name, os: g?.os, attrs: g?.attrs, ut: g?.ut }).toEqual({ name, os: w.os, attrs: w.attrs, ut: w.ut })
      }
      expect(gotDir.get('p/autogen.sh')?.attrs).toBe((0o100755 << 16) >>> 0)
      expect(archiveComment(got)).toBe(archiveComment(want))
      expect(archiveComment(got)).toBe(tip)
    } finally {
      done()
    }
  })
})

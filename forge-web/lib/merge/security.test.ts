/**
 * Regressions from the security review of the browser merge (each reproduced an attack on the
 * code before the fix). A PR author controls the head's commits and trees; none of these may
 * make the merge move a branch to history git reads differently, or can't fetch.
 */

import { describe, expect, it } from 'vitest'

import { gitOidHex, MODE_GITLINK, MODE_TREE } from '../browse'
import { indexPacks } from '../browse/indexer'
import { Store } from '../view/diff-fixtures'
import { checkMerge, mergeMessage, runMerge, textOnlyMergeDriver, TEXT_MERGE_MAX_CHARS, type MergeInput } from './engine'
import { missingFromClosure } from './verify'

const ME = { name: 'M', email: 'm@x', timestamp: 1_700_000_000, timezoneOffset: 0 }
const enc = (t: string): Uint8Array => new TextEncoder().encode(t)
const input = (baseTip: string, headOid: string): MergeInput => ({ baseTip, headOid, prNumber: 1, sourceLabel: 'x', author: ME, headInBase: false })

/** Store a hand-written commit (the Store only writes well-formed ones). */
function rawCommit(s: Store, text: string): string {
  const bytes = enc(text)
  const oid = gitOidHex('commit', bytes)
  s.objects.set(oid, { type: 'commit', bytes })
  return oid
}

/** Store a hand-written tree: entries as given, in the given order, modes as given; names may be raw bytes. */
function rawTree(s: Store, entries: readonly { mode: string; name: string | Uint8Array; oid: string }[]): string {
  const parts: number[] = []
  for (const e of entries) {
    parts.push(...enc(`${e.mode} `), ...(typeof e.name === 'string' ? enc(e.name) : e.name), 0)
    for (let i = 0; i < 40; i += 2) parts.push(parseInt(e.oid.slice(i, i + 2), 16))
  }
  const bytes = new Uint8Array(parts)
  const oid = gitOidHex('tree', bytes)
  s.objects.set(oid, { type: 'tree', bytes })
  return oid
}

const ID = 'A <a@b> 1700000100 +0000'

describe('C1: commits git and this client would read differently are refused', () => {
  it('a second tree/parent pair (git reads the first: a silent revert of the base)', async () => {
    const s = new Store()
    const told = s.files({ 'auth.c': 'vulnerable\n' })
    const x = s.commit(told)
    const basetip = s.commit(s.files({ 'auth.c': 'fixed\n' }), [x], 'security fix')
    const tgood = s.files({ README: 'readme\n', 'auth.c': 'fixed\n' })
    const head = rawCommit(s, `tree ${told}\nparent ${x}\ntree ${tgood}\nparent ${basetip}\nauthor ${ID}\ncommitter ${ID}\n\nAdd README\n`)
    expect(await checkMerge(s.reader(), input(basetip, head))).toBe('malformed')
    expect((await runMerge(s.reader(), input(basetip, head))).kind).toBe('malformed')
  })

  it('two tree headers', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const head = rawCommit(s, `tree ${s.files({ 'a.txt': 'EVIL\n' })}\ntree ${s.files({ 'a.txt': 'good\n' })}\nparent ${base}\nauthor ${ID}\ncommitter ${ID}\n\nm\n`)
    expect((await runMerge(s.reader(), input(base, head))).kind).toBe('malformed')
  })

  it('a parent after the committer (git ignores it)', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n' }))
    const base = s.commit(s.files({ 'a.txt': 'b\n' }), [root])
    const head = rawCommit(s, `tree ${s.files({ 'a.txt': 'attacker\n' })}\nauthor ${ID}\ncommitter ${ID}\nparent ${base}\n\nm\n`)
    expect((await runMerge(s.reader(), input(base, head))).kind).toBe('malformed')
  })

  it('trees with bad modes, bad names, duplicates or out of order', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const b = s.blob('x\n')
    for (const entries of [
      [{ mode: '100664', name: 'a', oid: b }],
      [{ mode: '0100644', name: 'a', oid: b }],
      [{ mode: '100644', name: '.git', oid: b }],
      [{ mode: '100644', name: '..', oid: b }],
      [{ mode: '100644', name: 'a/b', oid: b }],
      [{ mode: '100644', name: 'b', oid: b }, { mode: '100644', name: 'a', oid: b }],
      [{ mode: '100644', name: 'a', oid: b }, { mode: '100644', name: 'a', oid: b }],
    ]) {
      const head = s.commit(rawTree(s, entries), [base])
      expect((await runMerge(s.reader(), input(base, head))).kind).toBe('malformed')
    }
  })
})

describe('M3: the pack walk decides by what objects are, and by mode and oid together', () => {
  it('a blob first named as a gitlink, then as a file, is packed', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const baseRepo = s.reader(s.snapshot())
    const secret = s.blob('attacker blob\n')
    const c1 = s.commit(s.tree([{ name: 'a.txt', oid: s.blob('a\n') }, { name: 'sub', oid: secret, mode: MODE_GITLINK }]), [base])
    const c2 = s.commit(s.tree([{ name: 'a.txt', oid: s.blob('a\n') }, { name: 'sub', oid: secret }]), [c1])
    const out = await runMerge(s.reader(), input(base, c2))
    if (out.kind !== 'fast-forward') throw new Error(out.kind)
    const oids = new Set((await indexPacks([out.pack])).map((r) => r.oidHex))
    expect(oids.has(secret)).toBe(true)
    expect(await missingFromClosure(out.pack, out.newTip, base, baseRepo)).toEqual([])
  })

  it('a non-canonical tree mode (040755) is refused, not walked around', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const sub = s.tree([{ name: 'x', oid: s.blob('new file in odd-mode dir\n') }])
    const head = s.commit(s.tree([{ name: 'a.txt', oid: s.blob('a\n') }, { name: 'd', oid: sub, mode: 0o40755 }]), [base])
    expect((await runMerge(s.reader(), input(base, head))).kind).toBe('malformed')
  })

  it('a tree listed under a file mode is refused', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const sub = s.tree([{ name: 'x', oid: s.blob('x\n') }])
    const head = s.commit(s.tree([{ name: 'a.txt', oid: s.blob('a\n') }, { name: 'd', oid: sub }]), [base])
    expect((await runMerge(s.reader(), input(base, head))).kind).toBe('malformed')
  })
})

describe('M2: a small history cannot make the merge check run away', () => {
  it('a tree DAG (2^k paths over k objects) hits the read budget', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n' }))
    const base = s.commit(s.files({ 'a.txt': 'b\n' }), [root])
    let t = s.tree([{ name: 'f', oid: s.blob('x\n') }])
    for (let i = 0; i < 20; i++) t = s.tree([{ name: 'l', oid: t, mode: MODE_TREE }, { name: 'r', oid: t, mode: MODE_TREE }])
    const head = s.commit(s.tree([{ name: 'a.txt', oid: s.blob('a\n') }, { name: 'bomb', oid: t, mode: MODE_TREE }]), [root])
    await expect(checkMerge(s.reader(), input(base, head), 2_000)).rejects.toThrow(/reads more than 2000 objects/)
  }, 30_000)

  it('files over the text limit are conflicts, not merged in the tab', () => {
    const big = 'x\n'.repeat(TEXT_MERGE_MAX_CHARS / 2 + 1)
    expect(textOnlyMergeDriver({ branches: ['b', 'o', 't'], contents: [big, `${big}a\n`, `b\n${big}`] }).cleanMerge).toBe(false)
  })
})

describe('L1: the PR title cannot forge lines in the merge commit', () => {
  it('collapses CR, LF and NUL and caps the length', () => {
    const msg = mergeMessage(3, 'refs/heads/x', 'Fix\n\nSigned-off-by: someone <x@y>\r\0more' + 'z'.repeat(500))
    const [subject, blank, body, ...rest] = msg.split('\n')
    expect(subject).toBe('Merge pull request #3 from refs/heads/x')
    expect(blank).toBe('')
    expect(body?.startsWith('Fix Signed-off-by: someone <x@y> more')).toBe(true)
    expect(body?.length).toBe(200)
    expect(rest).toEqual([''])
  })
})

/** Commit bytes with a UTF-8 BOM before "tree " (git: "bogus commit object"). */
function bomCommit(s: Store, tree: string, parent: string, msg: string): string {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(`tree ${tree}\nparent ${parent}\nauthor ${ID}\ncommitter ${ID}\n\n${msg}\n`)])
  const oid = gitOidHex('commit', bytes)
  s.objects.set(oid, { type: 'commit', bytes })
  return oid
}

describe('C1-a: a byte-order mark before "tree" is refused (git cannot read the commit)', () => {
  it('as the head', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const head = bomCommit(s, s.files({ 'a.txt': 'b\n' }), base, 'bom')
    expect((await runMerge(s.reader(), input(base, head))).kind).toBe('malformed')
  })

  it('in the middle of a three-way merged history', async () => {
    const s = new Store()
    const m = s.commit(s.files({ 'a.txt': '1\n', 'b.txt': '1\n' }))
    const baseTip = s.commit(s.files({ 'a.txt': '2\n', 'b.txt': '1\n' }), [m])
    const bom = bomCommit(s, s.files({ 'a.txt': '1\n', 'b.txt': '2\n' }), m, 'bom')
    const head = s.commit(s.files({ 'a.txt': '1\n', 'b.txt': '3\n' }), [bom])
    expect(await checkMerge(s.reader(), input(baseTip, head))).toBe('malformed')
    expect((await runMerge(s.reader(), input(baseTip, head))).kind).toBe('malformed')
  })
})

describe('C1-b: a blob-mode entry naming a commit or tag is refused', () => {
  it('file, executable and symlink modes over a commit and a tag', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const a = s.blob('a\n')
    const tagBytes = enc(`object ${base}\ntype commit\ntag v\ntagger ${ID}\n\nt\n`)
    const tag = gitOidHex('tag', tagBytes)
    s.objects.set(tag, { type: 'tag', bytes: tagBytes })
    for (const target of [base, tag]) {
      for (const mode of ['100644', '100755', '120000']) {
        const head = s.commit(rawTree(s, [{ mode: '100644', name: 'a.txt', oid: a }, { mode, name: 'evil', oid: target }]), [base])
        expect((await runMerge(s.reader(), input(base, head))).kind, `${mode} over ${target === tag ? 'tag' : 'commit'}`).toBe('malformed')
      }
    }
  })
})

describe('C1-c: names that are not UTF-8 are refused (the merge would rewrite them)', () => {
  it('a Latin-1 name beside the merged files', async () => {
    const s = new Store()
    const one = s.blob('1\n')
    const two = s.blob('2\n')
    const lat = s.blob('latin\n')
    const cafe = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
    const t = (a: string, b: string): string => rawTree(s, [{ mode: '100644', name: 'a.txt', oid: a }, { mode: '100644', name: 'b.txt', oid: b }, { mode: '100644', name: cafe, oid: lat }])
    const m = s.commit(t(one, one))
    const baseTip = s.commit(t(two, one), [m])
    const head = s.commit(t(one, two), [m])
    expect(await checkMerge(s.reader(), input(baseTip, head))).toBe('malformed')
    expect((await runMerge(s.reader(), input(baseTip, head))).kind).toBe('malformed')
  })

  it('a name that would collide with U+FFFD once decoded', async () => {
    const s = new Store()
    const x1 = s.blob('1\n')
    const x2 = s.blob('2\n')
    const fffd = new Uint8Array([0xef, 0xbf, 0xbd])
    const m = s.commit(rawTree(s, [{ mode: '100644', name: 'a.txt', oid: x1 }, { mode: '100644', name: fffd, oid: s.blob('GOOD\n') }]))
    const baseTip = s.commit(rawTree(s, [{ mode: '100644', name: 'a.txt', oid: x2 }, { mode: '100644', name: fffd, oid: s.blob('GOOD\n') }]), [m])
    const head = s.commit(
      rawTree(s, [{ mode: '100644', name: 'a.txt', oid: x1 }, { mode: '100644', name: fffd, oid: s.blob('GOOD\n') }, { mode: '100644', name: new Uint8Array([0xff]), oid: s.blob('EVIL\n') }]),
      [m],
    )
    expect(await checkMerge(s.reader(), input(baseTip, head))).toBe('malformed')
  })
})

describe('C1-d: a type change both sides touched is a conflict, as in git', () => {
  it('a file one side edits and the other turns into a symlink', async () => {
    const s = new Store()
    const body = 'l1\nl2\nl3\nl4\nl5\n'
    const m = s.commit(s.files({ cfg: body }))
    const baseTip = s.commit(s.files({ cfg: body.replace('l1', 'L1') }), [m])
    const head = s.commit(s.tree([{ name: 'cfg', oid: s.blob(body.replace('l5', '/etc/passwd')), mode: 0o120000 }]), [m])
    expect(await checkMerge(s.reader(), input(baseTip, head))).toBe('conflict')
    expect(await runMerge(s.reader(), input(baseTip, head))).toEqual({ kind: 'conflict', paths: ['cfg'] })
  })
})

describe("C1-e: the check and the merge agree on git's byte order", () => {
  it('names whose UTF-16 and UTF-8 orders differ merge to a tree git accepts, or not at all', async () => {
    const s = new Store()
    const one = s.blob('1\n')
    const two = s.blob('2\n')
    const x = s.blob('x\n')
    // UTF-8 bytes: EF BC 81 (U+FF01) < F0 9F 98 80 (U+1F600); UTF-16: D83D < FF01.
    const t = (a: string, b: string): string =>
      rawTree(s, [{ mode: '100644', name: 'a.txt', oid: a }, { mode: '100644', name: 'b.txt', oid: b }, { mode: '100644', name: '！', oid: x }, { mode: '100644', name: '\u{1f600}', oid: x }])
    const m = s.commit(t(one, one))
    const baseTip = s.commit(t(two, one), [m])
    const head = s.commit(t(one, two), [m])
    const check = await checkMerge(s.reader(), input(baseTip, head))
    const run = await runMerge(s.reader(), input(baseTip, head))
    expect(run.kind === 'merge' ? 'merge' : run.kind).toBe(check)
    expect(['merge', 'malformed']).toContain(check)
  })
})

describe('C1-f: fsck parity on headers and names', () => {
  it('refuses NUL in a header, zero-padded dates, a .gitmodules symlink and .git look-alikes', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const t = s.files({ 'a.txt': 'b\n' })
    for (const text of [
      `tree ${t}\nparent ${base}\nauthor ${ID}\ncommitter ${ID}\nencoding x\0y\n\nm\n`,
      `tree ${t}\nparent ${base}\nauthor A <a@b> 01700000100 +0000\ncommitter ${ID}\n\nm\n`,
    ]) {
      expect((await runMerge(s.reader(), input(base, rawCommit(s, text)))).kind).toBe('malformed')
    }
    const b = s.blob('x\n')
    for (const [mode, name] of [
      ['120000', '.gitmodules'],
      ['100644', '.git.'],
      ['100644', '.GIT'],
      ['100644', 'git~1'],
      ['100644', '.g‌it'],
      ['100644', '.git::$INDEX_ALLOCATION'],
      ['100644', 'a\\b'],
    ] as const) {
      const head = s.commit(rawTree(s, [{ mode: '100644', name: 'a.txt', oid: b }, { mode, name, oid: b }].sort((x, y) => (x.name < y.name ? -1 : 1))), [base])
      expect((await runMerge(s.reader(), input(base, head))).kind, name).toBe('malformed')
    }
  })
})

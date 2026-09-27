/**
 * Regressions from the third adversarial review of the browser merge (each repro failed on the
 * code before the fix). The product rule since then: the browser never merges file contents —
 * a fast-forward, or a merge commit when the two sides changed disjoint paths — and everything
 * it reads or writes passes `git fsck --strict`, for fast-forwards and merges alike, with the
 * check and the run always agreeing.
 */

import { describe, expect, it } from 'vitest'

import { gitOidHex, MODE_TREE } from '../browse'
import { Store } from '../view/diff-fixtures'
import { checkCommit, checkTree, MalformedObjectError, specialFileName } from '../view/git-objects'
import { checkMerge, runMerge, type MergeInput } from './engine'

const ME = { name: 'M', email: 'm@x', timestamp: 1_700_000_000, timezoneOffset: 0 }
const input = (baseTip: string, headOid: string): MergeInput => ({ baseTip, headOid, prNumber: 1, sourceLabel: 'x', author: ME, headInBase: false })
const enc = (t: string): Uint8Array => new TextEncoder().encode(t)
const ID = 'A <a@b> 1700000100 +0000'

interface Raw {
  readonly mode: string
  readonly name: string
  readonly oid: string
}

/** A hand-written tree, entries sorted as git does (directories compare as `name/`). */
function rawTree(s: Store, entries: readonly Raw[]): string {
  const key = (e: Raw): string => (e.mode === '40000' ? `${e.name}/` : e.name)
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))))
  const parts: number[] = []
  for (const e of sorted) {
    parts.push(...enc(`${e.mode} ${e.name}`), 0)
    for (let i = 0; i < 40; i += 2) parts.push(parseInt(e.oid.slice(i, i + 2), 16))
  }
  const bytes = new Uint8Array(parts)
  const oid = gitOidHex('tree', bytes)
  s.objects.set(oid, { type: 'tree', bytes })
  return oid
}

function rawCommit(s: Store, text: string): string {
  const bytes = enc(text)
  const oid = gitOidHex('commit', bytes)
  s.objects.set(oid, { type: 'commit', bytes })
  return oid
}

const E = (mode: string, name: string, oid: string): Raw => ({ mode, name, oid })

/** Check and run, which must agree; the run's kind. */
async function verdict(s: Store, base: string, head: string): Promise<string> {
  const check = await checkMerge(s.reader(), input(base, head))
  const run = (await runMerge(s.reader(), input(base, head))).kind
  expect(run, 'checkMerge and runMerge disagree').toBe(check)
  return run
}

describe('no content-level merges: every shape a text merge got wrong is a conflict', () => {
  const G = '  grant(user, ADMIN);\n'
  it('the base branch deletes a duplicate line the PR moved (diff3 kept the grant, git drops it)', async () => {
    const s = new Store()
    const m = s.commit(s.files({ 'acl.c': ['if (ok) {\n', G, G, '}\n', G, G, G, 'audit();\n'].join('') }))
    const baseTip = s.commit(s.files({ 'acl.c': ['if (ok) {\n', G, G, '}\n', G, G, 'audit();\n'].join('') }), [m])
    const head = s.commit(s.files({ 'acl.c': ['if (ok) {\n', G, G, '}\n', 'audit();\n', G, G, 'audit();\n'].join('') }), [m])
    expect(await verdict(s, baseTip, head)).toBe('conflict')
  })

  it('bare CR and U+2028 outside the edited hunks can no longer be stripped', async () => {
    for (const sep of ['\r', ' ', ' ']) {
      const s = new Store()
      const f = (a: string, e: string): string => `// setup${sep}verify(token);\n${a}\nB\nC\nD\n${e}\n`
      const m = s.commit(s.files({ 'auth.js': f('A', 'E') }))
      const baseTip = s.commit(s.files({ 'auth.js': f('A2', 'E') }), [m])
      const head = s.commit(s.files({ 'auth.js': f('A', 'E2') }), [m])
      expect(await verdict(s, baseTip, head)).toBe('conflict')
    }
  })

  it('add/add of the same content with different modes (either way round)', async () => {
    for (const [ours, theirs] of [
      ['100644', '100755'],
      ['100755', '100644'],
    ]) {
      const s = new Store()
      const x = s.blob('#!/bin/sh\necho hi\n')
      const a = s.blob('a\n')
      const m = s.commit(rawTree(s, [E('100644', 'a.txt', a)]))
      const baseTip = s.commit(rawTree(s, [E('100644', 'a.txt', a), E(ours as string, 'run.sh', x)]), [m])
      const head = s.commit(rawTree(s, [E('100644', 'a.txt', a), E(theirs as string, 'run.sh', x)]), [m])
      expect(await verdict(s, baseTip, head)).toBe('conflict')
    }
  })

  it('add/add of different content, and a criss-cross history', async () => {
    const s = new Store()
    const m = s.commit(s.files({ 'a.txt': 'a\n' }))
    const baseTip = s.commit(s.files({ 'a.txt': 'a\n', 'n.txt': 'x\ny\n' }), [m])
    const head = s.commit(s.files({ 'a.txt': 'a\n', 'n.txt': 'x\ny\nz\n' }), [m])
    expect(await verdict(s, baseTip, head)).toBe('conflict')

    const c = new Store()
    const r = c.commit(c.files({ 'a.txt': '1\n2\n3\n4\n5\n' }))
    const x = c.commit(c.files({ 'a.txt': 'X\n2\n3\n4\n5\n' }), [r])
    const y = c.commit(c.files({ 'a.txt': '1\n2\n3\n4\nY\n' }), [r])
    const b1 = c.commit(c.files({ 'a.txt': 'X\n2\n3\n4\nY\n' }), [x, y])
    const h1 = c.commit(c.files({ 'a.txt': 'X\n2\n3\n4\nY\n' }), [y, x])
    const tip = c.commit(c.files({ 'a.txt': 'X\nB\n3\n4\nY\n' }), [b1])
    const hd = c.commit(c.files({ 'a.txt': 'X\n2\n3\nH\nY\n' }), [h1])
    expect(await verdict(c, tip, hd)).toBe('conflict')
  })
})

describe('tree-level shapes (renames, deletes, type changes) are conflicts where both sides touched a path', () => {
  const body = '1\n2\n3\n4\n5\n6\n7\n8\n'
  const cases: [string, (s: Store) => [string, string]][] = [
    ['rename vs delete', (s) => {
      const k = s.blob('k\n')
      const m = s.commit(rawTree(s, [E('100644', 'f', s.blob(body)), E('100644', 'k', k)]))
      return [s.commit(rawTree(s, [E('100644', 'g', s.blob(body)), E('100644', 'k', k)]), [m]), s.commit(rawTree(s, [E('100644', 'k', k)]), [m])]
    }],
    ['rename/rename to different names', (s) => {
      const m = s.commit(rawTree(s, [E('100644', 'f', s.blob(body))]))
      return [s.commit(rawTree(s, [E('100644', 'g', s.blob(body))]), [m]), s.commit(rawTree(s, [E('100644', 'h', s.blob(body))]), [m])]
    }],
    ['directory rename vs add inside', (s) => {
      const k = s.blob('k\n')
      const d = s.files({ 'a.c': 'a\n', 'b.c': 'b\n', 'c.c': 'c\n' })
      const m = s.commit(rawTree(s, [E('40000', 'd', d), E('100644', 'k', k)]))
      const bt = s.commit(rawTree(s, [E('40000', 'e', d), E('100644', 'k', k)]), [m])
      const hd = s.commit(rawTree(s, [E('40000', 'd', s.files({ 'a.c': 'a\n', 'b.c': 'b\n', 'c.c': 'c\n', 'new.c': 'backdoor\n' })), E('100644', 'k', k)]), [m])
      return [bt, hd]
    }],
    ['mode-only vs content', (s) => {
      const a = s.blob('1\n2\n')
      const m = s.commit(rawTree(s, [E('100644', 'f', a)]))
      return [s.commit(rawTree(s, [E('100755', 'f', a)]), [m]), s.commit(rawTree(s, [E('100644', 'f', s.blob('1\n2x\n'))]), [m])]
    }],
    ['delete vs mode-only', (s) => {
      const a = s.blob('1\n')
      const k = s.blob('k\n')
      const m = s.commit(rawTree(s, [E('100644', 'f', a), E('100644', 'k', k)]))
      return [s.commit(rawTree(s, [E('100644', 'k', k)]), [m]), s.commit(rawTree(s, [E('100755', 'f', a), E('100644', 'k', k)]), [m])]
    }],
    ['symlink both edited', (s) => {
      const m = s.commit(rawTree(s, [E('120000', 'l', s.blob('a/b/c'))]))
      return [s.commit(rawTree(s, [E('120000', 'l', s.blob('a/B/c'))]), [m]), s.commit(rawTree(s, [E('120000', 'l', s.blob('a/b/C'))]), [m])]
    }],
    ['dir delete vs inner modify', (s) => {
      const k = s.blob('k\n')
      const m = s.commit(rawTree(s, [E('40000', 'd', s.files({ x: '1\n', y: '1\n' })), E('100644', 'k', k)]))
      return [s.commit(rawTree(s, [E('100644', 'k', k)]), [m]), s.commit(rawTree(s, [E('40000', 'd', s.files({ x: '2\n', y: '1\n' })), E('100644', 'k', k)]), [m])]
    }],
    ['file->dir vs modify', (s) => {
      const k = s.blob('k\n')
      const m = s.commit(rawTree(s, [E('100644', 'a', s.blob('1\n')), E('100644', 'k', k)]))
      return [s.commit(rawTree(s, [E('100644', 'a', s.blob('2\n')), E('100644', 'k', k)]), [m]), s.commit(rawTree(s, [E('40000', 'a', s.files({ z: 'z\n' })), E('100644', 'k', k)]), [m])]
    }],
    ['add file a vs add dir a', (s) => {
      const k = s.blob('k\n')
      const m = s.commit(rawTree(s, [E('100644', 'k', k)]))
      return [s.commit(rawTree(s, [E('100644', 'a', s.blob('1\n')), E('100644', 'k', k)]), [m]), s.commit(rawTree(s, [E('40000', 'a', s.files({ z: 'z\n' })), E('100644', 'k', k)]), [m])]
    }],
    ['gitlink -> tree vs gitlink bump', (s) => {
      const k = s.blob('k\n')
      const m = s.commit(rawTree(s, [E('100644', 'k', k), E('160000', 'sub', '1'.repeat(40))]))
      return [s.commit(rawTree(s, [E('100644', 'k', k), E('160000', 'sub', '2'.repeat(40))]), [m]), s.commit(rawTree(s, [E('100644', 'k', k), E('40000', 'sub', s.files({ z: 'z\n' }))]), [m])]
    }],
    ['dir deleted one side, a file of that name added the other', (s) => {
      const k = s.blob('k\n')
      const m = s.commit(rawTree(s, [E('40000', 'd', s.files({ x: '1\n' })), E('100644', 'k', k)]))
      return [s.commit(rawTree(s, [E('100644', 'k', k)]), [m]), s.commit(rawTree(s, [E('100644', 'd', s.blob('f\n')), E('100644', 'k', k)]), [m])]
    }],
    ['dir emptied vs add inside', (s) => {
      const k = s.blob('k\n')
      const m = s.commit(rawTree(s, [E('40000', 'd', s.files({ x: '1\n' })), E('100644', 'k', k)]))
      return [s.commit(rawTree(s, [E('100644', 'k', k)]), [m]), s.commit(rawTree(s, [E('40000', 'd', s.files({ x: '1\n', y: 'new\n' })), E('100644', 'k', k)]), [m])]
    }],
    ['a subdirectory moved out one side, a file added in it the other', (s) => {
      const k = s.blob('k\n')
      const sub = s.files({ a: '1\n2\n3\n4\n5\n6\n' })
      const m = s.commit(rawTree(s, [E('40000', 'd', rawTree(s, [E('40000', 'sub', sub), E('100644', 'keep', k)])), E('100644', 'k', k)]))
      const bt = s.commit(rawTree(s, [E('40000', 'd', rawTree(s, [E('100644', 'keep', k)])), E('40000', 'e', sub), E('100644', 'k', k)]), [m])
      const hd = s.commit(rawTree(s, [E('40000', 'd', rawTree(s, [E('40000', 'sub', s.files({ a: '1\n2\n3\n4\n5\n6\n', b: 'new\n' })), E('100644', 'keep', k)])), E('100644', 'k', k)]), [m])
      return [bt, hd]
    }],
  ]
  for (const [label, build] of cases) {
    it(label, async () => {
      const s = new Store()
      const [baseTip, head] = build(s)
      expect(await verdict(s, baseTip, head)).toBe('conflict')
    })
  }

  it('rename one side, unrelated edit the other, and a file added next to a deletion: clean', async () => {
    const s = new Store()
    const f = s.blob(body)
    const m = s.commit(rawTree(s, [E('100644', 'f', f), E('100644', 'k', s.blob('k\n'))]))
    const bt = s.commit(rawTree(s, [E('100644', 'g', f), E('100644', 'k', s.blob('k\n'))]), [m])
    const hd = s.commit(rawTree(s, [E('100644', 'f', f), E('100644', 'k', s.blob('k2\n'))]), [m])
    expect(await verdict(s, bt, hd)).toBe('merge')
  })
})

describe('fsck parity on every new object, fast-forwards included', () => {
  async function ffWith(entry: (s: Store) => Raw): Promise<string> {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const head = s.commit(rawTree(s, [E('100644', 'a.txt', s.blob('a\n')), entry(s)]), [base])
    return verdict(s, base, head)
  }

  it('M1: a symlink under any name a filesystem reads as .gitmodules (the NTFS fall-back short names included)', async () => {
    for (const name of ['gi7eba~1', 'GI7EBA~9', '~1234567', 'g~123456', 'gi7e~123', 'gitmod~1', 'GITMOD~4', '.gitmodules.', '.gitmodules::$DATA', '.GitModules', '.g‌itmodules']) {
      expect(await ffWith((s) => E('120000', name, s.blob('/etc/passwd'))), name).toBe('malformed')
    }
  })

  it('.gitignore and .mailmap as symbolic links (fsck --strict reports them; found by the property test)', async () => {
    for (const name of ['.gitignore', 'gi250a~1', '.mailmap', 'maba30~1', '.MAILMAP.']) {
      expect(await ffWith((s) => E('120000', name, s.blob('x'))), name).toBe('malformed')
    }
  })

  it('M1: names git does not read as .gitmodules stay allowed', async () => {
    for (const name of ['gitmod~5', 'gi7eba~0', 'gi7eba~1x', 'xgitmodules', '.gitmodulesx']) {
      expect(await ffWith((s) => E('120000', name, s.blob('x'))), name).toBe('fast-forward')
    }
  })

  it('M1: the ports match git on its own examples', () => {
    const cases: [string, 'gitmodules' | 'gitattributes' | null][] = [
      ['.gitmodules', 'gitmodules'],
      ['.GITMODULES . .', 'gitmodules'],
      ['gitmod~1', 'gitmodules'],
      ['gitmod~4 ', 'gitmodules'],
      ['gitmod~5', null],
      ['gi7eba~1', 'gitmodules'],
      ['gi7eb~12', 'gitmodules'],
      ['~1000000', 'gitmodules'],
      ['~9999999', 'gitmodules'],
      ['gi7eba~a', null],
      ['.gitattributes', 'gitattributes'],
      ['gitatt~1', 'gitattributes'],
      ['gi7d29~1', 'gitattributes'],
      ['.gitignore', null],
    ]
    for (const [name, want] of cases) expect(specialFileName(name), name).toBe(want)
  })

  it('H3: .gitmodules and .gitattributes (any directory, any alias) only as files, and never new or changed in the browser', async () => {
    const gm = '[submodule "x"]\n\tpath = x\n\turl = https://e.com/x\n'
    for (const make of [
      (s: Store) => E('40000', '.gitmodules', s.files({ x: 'x\n' })),
      () => E('160000', '.gitmodules', '1'.repeat(40)),
      (s: Store) => E('40000', '.gitattributes', s.files({ x: 'x\n' })),
      (s: Store) => E('120000', '.gitattributes', s.blob('x')),
      (s: Store) => E('100644', '.gitmodules', s.blob(gm)),
      (s: Store) => E('100644', '.gitmodules', s.blob('[submodule "x"]\n\tpath = x\n\turl = --upload-pack=touch /tmp/pwn\n')),
      (s: Store) => E('100644', 'GITMOD~1', s.blob(gm)),
      (s: Store) => E('100644', '.gitattributes', s.blob(`${'a'.repeat(3000)} x\n`)),
      (s: Store) => E('40000', 'sub', rawTree(s, [E('100644', '.gitmodules', s.blob(gm))])),
    ]) {
      expect(await ffWith(make)).toBe('malformed')
    }
  })

  it('H3: an unchanged .gitmodules in the base does not block a merge', async () => {
    const s = new Store()
    const gm = s.blob('[submodule "x"]\n\tpath = x\n\turl = https://e.com/x\n')
    const t = (a: string, b: string): string => rawTree(s, [E('100644', '.gitmodules', gm), E('100644', 'a', s.blob(a)), E('100644', 'b', s.blob(b))])
    const m = s.commit(t('1\n', '1\n'))
    expect(await verdict(s, s.commit(t('2\n', '1\n'), [m]), s.commit(t('1\n', '2\n'), [m]))).toBe('merge')
  })

  it('M2: an entry naming the null oid (a gitlink included)', async () => {
    expect(await ffWith(() => E('160000', 'sub', '0'.repeat(40)))).toBe('malformed')
    expect(await ffWith(() => E('100644', 'z', '0'.repeat(40)))).toBe('malformed')
  })

  it('M3: trees nested deeper than git walks (a fast-forward and a merge)', async () => {
    const s = new Store()
    const m = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'b\n' }))
    const baseTip = s.commit(s.files({ 'a.txt': 'A\n', 'b.txt': 'b\n' }), [m])
    let t = s.tree([{ name: 'f', oid: s.blob('x\n') }])
    for (let i = 0; i < 2049; i++) t = s.tree([{ name: 'd', oid: t, mode: MODE_TREE }])
    const deep = (parents: string[]): string => s.commit(s.tree([{ name: 'a.txt', oid: s.blob('a\n') }, { name: 'b.txt', oid: s.blob('b\n') }, { name: 'd', oid: t, mode: MODE_TREE }]), parents)
    expect(await verdict(s, m, deep([m]))).toBe('malformed')
    expect(await verdict(s, baseTip, deep([m]))).toBe('malformed')
  }, 120_000)

  it('M3: 2048 levels (git walks those) are fine', async () => {
    const s = new Store()
    const m = s.commit(s.files({ 'a.txt': 'a\n' }))
    let t = s.tree([{ name: 'f', oid: s.blob('x\n') }])
    for (let i = 0; i < 2047; i++) t = s.tree([{ name: 'd', oid: t, mode: MODE_TREE }])
    const head = s.commit(s.tree([{ name: 'a.txt', oid: s.blob('a\n') }, { name: 'd', oid: t, mode: MODE_TREE }]), [m])
    expect(await verdict(s, m, head)).toBe('fast-forward')
  }, 120_000)

  it('L1: a date git cannot hold (over 2^63 - 1)', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const t = s.files({ 'a.txt': 'b\n' })
    for (const date of ['9223372036854775808', '99999999999999999999']) {
      const head = rawCommit(s, `tree ${t}\nparent ${base}\nauthor A <a@b> ${date} +0000\ncommitter ${ID}\n\nm\n`)
      expect(await verdict(s, base, head), date).toBe('malformed')
    }
    const max = rawCommit(s, `tree ${t}\nparent ${base}\nauthor A <a@b> 9223372036854775807 +0000\ncommitter ${ID}\n\nm\n`)
    expect(await verdict(s, base, max)).toBe('fast-forward')
  })

  it('a NUL byte anywhere in a commit, the message included (nulInCommit)', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const head = rawCommit(s, `tree ${s.files({ 'a.txt': 'b\n' })}\nparent ${base}\nauthor ${ID}\ncommitter ${ID}\n\nm\0x\n`)
    expect(await verdict(s, base, head)).toBe('malformed')
  })

  it('L3: a fast-forward over a malformed tree: the check says what the run does', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const head = s.commit(rawTree(s, [E('100664', 'a.txt', s.blob('a\n'))]), [base])
    expect(await verdict(s, base, head)).toBe('malformed')
  })

  it('a duplicate parent line (git accepts it) still fast-forwards', async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }))
    const head = rawCommit(s, `tree ${s.files({ 'a.txt': 'b\n' })}\nparent ${base}\nparent ${base}\nauthor ${ID}\ncommitter ${ID}\n\nm\n`)
    expect(await verdict(s, base, head)).toBe('fast-forward')
  })

  it('checkCommit and checkTree refuse with MalformedObjectError', () => {
    expect(() => checkCommit('0'.repeat(40), enc(`tree ${'1'.repeat(40)}\nauthor ${ID}\ncommitter ${ID}\n\n\0`))).toThrow(MalformedObjectError)
    expect(() => checkTree('0'.repeat(40), new Uint8Array([...enc('100644 a'), 0, ...new Uint8Array(20)]))).toThrow(MalformedObjectError)
  })
})

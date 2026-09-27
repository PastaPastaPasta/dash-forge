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

/** Store a hand-written tree: entries as given, in the given order, modes as given. */
function rawTree(s: Store, entries: readonly { mode: string; name: string; oid: string }[]): string {
  const parts: number[] = []
  for (const e of entries) {
    parts.push(...enc(`${e.mode} ${e.name}\0`))
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

/**
 * Squash and merge in the browser (review-parity M1), with `dg pr merge --squash`'s message, and
 * the conflicting paths a check reports (F7). Real git judges the result where it is installed.
 */

import { describe, expect, it } from 'vitest'

import { BrowseReader, ObjectLocator, type GitObject } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { Store } from '../view/diff-fixtures'
import { parseCommit } from '../view/git-objects'
import { checkMergeDetailed, runMerge, squashDraft, squashMessage, type MergeInput } from './engine'
import { gitAcceptsHistory, HAVE_GIT } from './git-oracle'

const ME = { name: 'Merger', email: 'm@example.com', timestamp: 1_700_000_000, timezoneOffset: 0 }
const input = (baseTip: string, headOid: string, squash?: string): MergeInput => ({
  baseTip,
  headOid,
  prNumber: 7,
  sourceLabel: 'refs/heads/feature',
  title: 'Feature',
  author: ME,
  headInBase: false,
  ...(squash !== undefined ? { squash: { message: squash } } : {}),
})

async function packed(pack: Uint8Array): Promise<GitObject[]> {
  const rows = await indexPacks([pack])
  const r = new BrowseReader(ObjectLocator.parse(serializeLocator(rows)), memoryPackSource([pack]))
  return Promise.all(rows.map((row) => r.readObject(row.oidHex)))
}

describe('the squash message box', () => {
  const pr = { title: 'Greet', body: '', number: 7 }
  const me = 'M <m@x>'
  it('waits for the authors, then credits them; an edit wins', () => {
    expect(squashDraft(pr, null, me, null)).toMatchObject({ ready: false, problem: expect.stringMatching(/Reading the PR/) })
    expect(squashDraft(pr, { authors: ['A <a@x>'], complete: true }, me, null)).toEqual({ message: 'Greet (#7)\n\nCo-authored-by: A <a@x>', ready: true, warning: null, problem: null })
    expect(squashDraft(pr, null, me, 'Mine').message).toBe('Mine')
  })
  it('never waits forever: an unreadable commit list gives a message without authors, and says so', () => {
    const d = squashDraft(pr, { error: 'the head repo is unreachable' }, me, null)
    expect(d).toMatchObject({ message: 'Greet (#7)', ready: true, problem: null })
    expect(d.warning).toMatch(/could not be read \(the head repo is unreachable\).*no Co-authored-by lines/)
  })
  it('says why Squash is disabled with an empty message, and warns about a capped list', () => {
    expect(squashDraft(pr, { authors: [], complete: true }, me, '  ').problem).toBe('Write a commit message to squash and merge.')
    expect(squashDraft(pr, { authors: [], complete: false }, me, null).warning).toMatch(/more commits than the page lists/)
  })
})

describe('squashMessage (parity with dg squash_message)', () => {
  it('title (#n), the body, and Co-authored-by for every author but the committer', () => {
    expect(squashMessage('Greet', 'Body text\n\n', 7, ['A <a@x>', 'M <m@x>', 'B <b@x>'], 'M <m@x>')).toBe('Greet (#7)\n\nBody text\n\nCo-authored-by: A <a@x>\nCo-authored-by: B <b@x>')
    expect(squashMessage('Greet', '', 7, [], 'M <m@x>')).toBe('Greet (#7)')
    expect(squashMessage('Two\nlines', '', 1, [], '')).toBe('Two lines (#1)')
  })
})

describe('squash and merge', () => {
  it('one commit on the base tip with the merged tree; nothing of the head history is pushed', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'b\n' }), [], 'root')
    const base = s.commit(s.files({ 'a.txt': 'A\n', 'b.txt': 'b\n' }), [root], 'on main')
    const h1 = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'B\n' }), [root], 'feature 1')
    const h2 = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'B2\n', 'c.txt': 'c\n' }), [h1], 'feature 2')
    const msg = squashMessage('Feature', '', 7, ['C <c@x>'], 'Merger <m@example.com>')
    const out = await runMerge(s.reader(), input(base, h2, msg))
    if (out.kind !== 'squash') throw new Error(out.kind)
    const objects = await packed(out.pack)
    const commits = objects.filter((o) => o.type === 'commit')
    expect(commits).toHaveLength(1)
    const c = parseCommit((commits[0] as GitObject).bytes)
    expect(c.parents).toEqual([base])
    expect(c.message).toBe(`${msg}\n`)
    if (HAVE_GIT) expect(gitAcceptsHistory([...s.objects.values(), ...objects], out.newTip)).toEqual({ fsck: true, log: true, clone: true })
  }, 60_000)

  it('the check sizes the pack before it is built: an upper bound on what the merge stores', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'b\n' }), [], 'root')
    const base = s.commit(s.files({ 'a.txt': 'A\n', 'b.txt': 'b\n' }), [root], 'on main')
    const head = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'B'.repeat(4000) + '\n' }), [root], 'feature')
    for (const squash of [undefined, squashMessage('Feature', '', 7, [], 'M <m@x>')]) {
      const checked = await checkMergeDetailed(s.reader(), input(base, head, squash))
      const built = await runMerge(s.reader(), input(base, head, squash))
      if (built.kind !== 'merge' && built.kind !== 'squash') throw new Error(built.kind)
      expect(checked.packEstimate).not.toBeNull()
      expect(checked.packEstimate!.bytes).toBeGreaterThanOrEqual(built.pack.length)
      expect(checked.packEstimate!.objectCount).toBeGreaterThanOrEqual(built.objectCount)
    }
  })

  it("squashes a head that descends from the base to the head's own tree", async () => {
    const s = new Store()
    const base = s.commit(s.files({ 'a.txt': 'a\n' }), [], 'base')
    const head = s.commit(s.files({ 'a.txt': 'b\n' }), [base], 'change')
    const out = await runMerge(s.reader(), input(base, head, 'Change (#7)'))
    if (out.kind !== 'squash') throw new Error(out.kind)
    const c = parseCommit(((await packed(out.pack)).find((o) => o.type === 'commit') as GitObject).bytes)
    expect(c.tree).toBe(parseCommit((s.objects.get(head) as GitObject).bytes).tree)
    expect(c.parents).toEqual([base])
  })
})

describe('the check names the conflicting paths', () => {
  it('lists both-sides edits', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n', 'src/x.rs': 'x\n' }), [], 'root')
    const base = s.commit(s.files({ 'a.txt': 'A\n', 'src/x.rs': 'X\n' }), [root], 'main')
    const head = s.commit(s.files({ 'a.txt': 'a2\n', 'src/x.rs': 'x2\n' }), [root], 'feature')
    const r = await checkMergeDetailed(s.reader(), input(base, head))
    expect(r.check).toBe('conflict')
    expect([...r.conflictPaths].sort()).toEqual(['a.txt', 'src/x.rs'])
  })
})

/**
 * Squash and merge in the browser (review-parity M1), with `dg pr merge --squash`'s message, and
 * the conflicting paths a check reports (F7). Real git judges the result where it is installed.
 */

import { describe, expect, it } from 'vitest'

import { BrowseReader, ObjectLocator, type GitObject } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { Store } from '../view/diff-fixtures'
import { parseCommit } from '../view/git-objects'
import { MEMBERS_MESSAGE_WARNING, checkMergeDetailed, mergeMessage, membersSquashMessage, packSizeBound, runMerge, squashAuthor, squashDraft, squashMessage, type MergeInput } from './engine'
import { writePack } from './pack-writer'
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
    expect(squashDraft(pr, null, me, null)).toMatchObject({ ready: false, problem: expect.stringMatching(/Reading the PR/), author: null })
    // QW4-008: the PR's author (its oldest commit's) authors the squash; the others are co-authors.
    expect(squashDraft(pr, { authors: ['A <a@x>'], complete: true }, me, null)).toEqual({ message: 'Greet (#7)', ready: true, warning: null, problem: null, author: { name: 'A', email: 'a@x' } })
    expect(squashDraft(pr, { authors: ['A <a@x>', 'M <m@x>', 'B <b@x>'], complete: true }, me, null)).toMatchObject({
      message: 'Greet (#7)\n\nCo-authored-by: M <m@x>\nCo-authored-by: B <b@x>',
      author: { name: 'A', email: 'a@x' },
    })
    expect(squashDraft(pr, null, me, 'Mine').message).toBe('Mine')
  })
  it('never waits forever: an unreadable commit list gives a message without authors, and says so', () => {
    const d = squashDraft(pr, { error: 'the head repo is unreachable' }, me, null)
    expect(d).toMatchObject({ message: 'Greet (#7)', ready: true, problem: null, author: null })
    expect(d.warning).toMatch(/could not be read \(the head repo is unreachable\).*no Co-authored-by lines/)
  })
  it('says why Squash is disabled with an empty message, and warns about a capped list', () => {
    expect(squashDraft(pr, { authors: [], complete: true }, me, '  ').problem).toBe('Write a commit message to squash and merge.')
    expect(squashDraft(pr, { authors: [], complete: false }, me, null).warning).toMatch(/more commits than the page lists/)
  })
})

describe('squashAuthor (QW4-008)', () => {
  it("is the oldest commit's author, or null (the merger) when unknown or not a valid ident", () => {
    expect(squashAuthor({ authors: ['First Author <f@x>', 'B <b@x>'], complete: true })).toEqual({ name: 'First Author', email: 'f@x' })
    // A capped list's first entry is not the oldest commit: the merger authors it, and is told so.
    expect(squashAuthor({ authors: ['Capped <c@x>'], complete: false })).toBeNull()
    expect(squashDraft({ title: 'T', body: '', number: 1 }, { authors: ['Capped <c@x>'], complete: false }, 'M <m@x>', null).warning).toMatch(/you are the commit's author/)
    // As git writes it: crud stripped from both ends of each part, and refused when nothing is left.
    // (git 2.56: `author John Doe, <"j@x">` becomes `John Doe <j@x>`; "Jr." keeps its dot; `,;` alone is refused.)
    expect(squashAuthor({ authors: [' John Doe, <"j@x">'], complete: true })).toEqual({ name: 'John Doe', email: 'j@x' })
    expect(squashAuthor({ authors: ['A Jr. <j@x>'], complete: true })).toEqual({ name: 'A Jr.', email: 'j@x' })
    expect(squashAuthor({ authors: [',; <j@x>'], complete: true })).toBeNull()
    expect(squashAuthor(null)).toBeNull()
    expect(squashAuthor({ error: 'unreadable' })).toBeNull()
    expect(squashAuthor({ authors: [], complete: true })).toBeNull()
    expect(squashAuthor({ authors: ['Bad <name> <b@x>'], complete: true })).toBeNull()
    expect(squashAuthor({ authors: [' <nobody@x>'], complete: true })).toBeNull()
  })
})

describe('squashMessage (parity with dg squash_message)', () => {
  it("does not list the squash commit's own author again, whatever spacing their line has", () => {
    expect(squashMessage('T', '', 1, ['A  <a@x>', 'B <b@x>'], 'A <a@x>')).toBe('T (#1)\n\nCo-authored-by: B <b@x>')
  })
  it("title (#n), the body, and Co-authored-by for every author but the squash commit's own", () => {
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

  it("is authored by the PR's author and committed by the merger (QW4-008)", async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n' }), [], 'root')
    const h1 = s.commit(s.files({ 'a.txt': 'a2\n' }), [root], 'feature')
    const commitText = async (out: Awaited<ReturnType<typeof runMerge>>): Promise<{ text: string; objects: GitObject[]; tip: string }> => {
      if (out.kind !== 'squash') throw new Error(out.kind)
      const objects = await packed(out.pack)
      return { text: new TextDecoder().decode((objects.find((o) => o.type === 'commit') as GitObject).bytes), objects, tip: out.newTip }
    }
    const by = await commitText(await runMerge(s.reader(), { ...input(root, h1), squash: { message: 'Feature (#7)', author: { name: 'Contributor', email: 'c@example.com' } } }))
    expect(by.text).toContain('\nauthor Contributor <c@example.com> 1700000000 +0000\ncommitter Merger <m@example.com> 1700000000 +0000\n')
    if (HAVE_GIT) expect(gitAcceptsHistory([...s.objects.values(), ...by.objects], by.tip)).toEqual({ fsck: true, log: true, clone: true })
    // Without one (the commits were unreadable), the merger is both.
    const self = await commitText(await runMerge(s.reader(), input(root, h1, 'Feature (#7)')))
    expect(self.text).toContain('\nauthor Merger <m@example.com> 1700000000 +0000\ncommitter Merger <m@example.com> 1700000000 +0000\n')
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

  it('bounds the pack even when the objects do not compress (random blobs, big and tiny)', () => {
    let seed = 7
    const random = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => ((seed = (seed * 1_103_515_245 + 12_345) >>> 0) >>> 24))
    const objects: GitObject[] = [0, 1, 5, 300, 70_000, 200_000].map((n) => ({ type: 'blob', bytes: random(n) }))
    expect(packSizeBound(objects)).toBeGreaterThanOrEqual(writePack(objects).bytes.length)
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

describe('a members-only PR merges with a public message that names only its number', () => {
  it('squash: #N and the co-authors, never the title or body; the draft warns', () => {
    expect(membersSquashMessage(4, [], 'Me <m>')).toBe('#4')
    expect(membersSquashMessage(4, ['Me <m>', 'Ann <a@x>'], 'Me <m>')).toBe('#4\n\nCo-authored-by: Ann <a@x>')
    const d = squashDraft({ title: 'SECRET title', body: 'SECRET body', number: 4, audience: 'members' }, { authors: ['Ann <a@x>'], complete: true }, 'Me <m>', null)
    expect(d.message).not.toMatch(/SECRET/)
    expect(d.warning).toBe(MEMBERS_MESSAGE_WARNING)
  })

  it('squash: the public-message warning stays when the authors are unknown or incomplete', () => {
    const pr = { title: 'SECRET', body: '', number: 4, audience: 'members' as const }
    const unread = squashDraft(pr, { error: 'node down' }, 'Me <m>', null).warning ?? ''
    expect(unread.startsWith(MEMBERS_MESSAGE_WARNING)).toBe(true)
    expect(unread).toMatch(/could not be read \(node down\)/)
    const partial = squashDraft(pr, { authors: ['Ann <a@x>'], complete: false }, 'Me <m>', 'edited').warning ?? ''
    expect(partial.startsWith(MEMBERS_MESSAGE_WARNING)).toBe(true)
    expect(partial).toMatch(/more commits than the page lists/)
  })

  it('merge commit: the default without a title is the subject alone (the panel passes no title for a members-only PR)', () => {
    expect(mergeMessage(4, 'feature', '')).toBe('Merge pull request #4 from feature\n')
  })
})

/**
 * Commits to a PR branch: applied suggestions (ported from `dg`'s `branch.rs` tests, and the
 * shared `suggestion__*` rule) and "Update branch", with real git as the judge where it is
 * installed (the history passes `git fsck --strict`, `git log`, `git clone`).
 */

import { describe, expect, it } from 'vitest'

import { BrowseReader, gitOidHex, ObjectLocator, type GitObject } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { Store } from '../view/diff-fixtures'
import { parseCommit } from '../view/git-objects'
import { applyAll, applySuggestionCommit, planSuggestion, readTextFile, suggestionMessage, SuggestionRefused, unapplicable, updateBranchCommit, type SuggestionComment } from './branch-commit'
import { gitAcceptsHistory, HAVE_GIT } from './git-oracle'

const HEAD = '3'.repeat(40)
const ME = { name: 'Applier', email: 'a@users.forge.invalid', timestamp: 1_700_000_000, timezoneOffset: 0 }

const comment = (id: string, start: number | null, line: number, side: number, oid: string, body: string): SuggestionComment => ({
  id,
  author: 'rev',
  body,
  anchor: { path: 'src/a.rs', line, startLine: start, side, commitOid: oid },
})

async function packed(pack: Uint8Array): Promise<GitObject[]> {
  const rows = await indexPacks([pack])
  const r = new BrowseReader(ObjectLocator.parse(serializeLocator(rows)), memoryPackSource([pack]))
  return Promise.all(rows.map((row) => r.readObject(row.oidHex)))
}

describe('suggestion planning (parity with dg)', () => {
  it('applies bottom-up and refuses overlaps', () => {
    const files = new Map([['src/a.rs', 'a\nb\nc\nd\ne\n']])
    const one = planSuggestion(comment('c1', 2, 3, 1, HEAD, '```suggestion\nBC\n```'), HEAD)
    const two = planSuggestion(comment('c2', null, 5, 1, HEAD, '```suggestion\nE\nE2\n```'), HEAD)
    expect(applyAll([one, two], files).get('src/a.rs')).toBe('a\nBC\nd\nE\nE2\n')
    const overlapping = planSuggestion(comment('c3', 3, 4, 1, HEAD, '```suggestion\nx\n```'), HEAD)
    expect(() => applyAll([one, overlapping], files)).toThrow(/overlap/)
  })

  it('says why a suggestion cannot be applied', () => {
    const old = '4'.repeat(40)
    expect(() => planSuggestion(comment('x', null, 1, 1, old, '```suggestion\ny\n```'), HEAD)).toThrow(/was made on/)
    expect(() => planSuggestion(comment('x', null, 1, 0, HEAD, '```suggestion\ny\n```'), HEAD)).toThrow(/old side/)
    expect(() => planSuggestion(comment('x', null, 1, 1, HEAD, 'no block'), HEAD)).toThrow(/no ```suggestion/)
    expect(() => planSuggestion(comment('x', null, 1, 1, HEAD, '```suggestion\na\n```\n```suggestion\nb\n```'), HEAD)).toThrow(/2 suggestion blocks/)
    const past = planSuggestion(comment('p', 4, 5, 1, HEAD, '```suggestion\nz\n```'), HEAD)
    expect(() => applyAll([past], new Map([['src/a.rs', 'one\n']]))).toThrow(SuggestionRefused)
  })

  it('says in the UI why a suggestion has no Apply button', () => {
    expect(unapplicable(comment('ok', null, 1, 1, HEAD, '```suggestion\ny\n```'), HEAD)).toBeNull()
    expect(unapplicable(comment('two', null, 1, 1, HEAD, '```suggestion\na\n```\n```suggestion\nb\n```'), HEAD)).toBe('This comment holds 2 suggestion blocks: apply it by hand.')
    expect(unapplicable(comment('old', null, 1, 1, '4'.repeat(40), '```suggestion\ny\n```'), HEAD)).toMatch(/^Outdated/)
    expect(unapplicable(comment('left', null, 1, 0, HEAD, '```suggestion\ny\n```'), HEAD)).toBe('This suggestion is on the old side of the diff.')
  })

  it("writes dg's trailers byte for byte", () => {
    const plans = [{ commentId: 'C1d', reviewer: 'Rev1', path: 'a', start: 1, end: 1, text: '' }]
    const m = suggestionMessage(plans, new Map([['Rev1', 'alice.dash']]))
    expect(m).toBe('Apply suggestions from code review\n\nCo-authored-by: alice.dash <Rev1@users.forge.invalid>\nForge-Suggestion: C1d')
  })
})

describe('the suggestion commit', () => {
  it('rewrites only the suggested lines of a nested file, parent = head, git accepts it', async () => {
    const s = new Store()
    const tree = s.files({ 'src/a.rs': 'fn a() {\n    1\n}\n', 'src/b.rs': 'b\n', 'README.md': 'r\n' })
    const head = s.commit(tree, [], 'head')
    const plan = planSuggestion(
      { id: 'C1', author: 'Rev', body: 'Use two.\n\n```suggestion\n    2\n```', anchor: { path: 'src/a.rs', line: 2, startLine: null, side: 1, commitOid: head } },
      head,
    )
    const out = await applySuggestionCommit(s.reader(), head, [plan], ME, new Map())
    const objects = await packed(out.pack.bytes)
    // The pack holds the new commit, the two rewritten trees and the new blob: nothing else.
    expect(objects.map((o) => o.type).sort()).toEqual(['blob', 'commit', 'tree', 'tree'])
    const commit = parseCommit((objects.find((o) => o.type === 'commit') as GitObject).bytes)
    expect(commit.parents).toEqual([head])
    expect(commit.message).toContain('Forge-Suggestion: C1')
    const store = [...s.objects.values(), ...objects]
    const byOid = new Map(store.map((o) => [gitOidHex(o.type, o.bytes), o]))
    const r = { readObject: async (oid: string) => byOid.get(oid) ?? Promise.reject(new Error(`missing ${oid}`)) }
    expect(await readTextFile(r, commit.tree, 'src/a.rs')).toBe('fn a() {\n    2\n}\n')
    expect(await readTextFile(r, commit.tree, 'src/b.rs')).toBe('b\n')
    if (HAVE_GIT) expect(gitAcceptsHistory(store, out.commit)).toEqual({ fsck: true, log: true, clone: true })
  }, 60_000)

  it('keeps a UTF-8 byte order mark, as dg keeps the raw bytes', async () => {
    const s = new Store()
    const head = s.commit(s.files({ 'src/a.rs': '﻿one\ntwo\n' }), [], 'head')
    const plan = planSuggestion({ id: 'C', author: 'R', body: '```suggestion\nTWO\n```', anchor: { path: 'src/a.rs', line: 2, startLine: null, side: 1, commitOid: head } }, head)
    const out = await applySuggestionCommit(s.reader(), head, [plan], ME, new Map())
    const blob = (await packed(out.pack.bytes)).find((o) => o.type === 'blob') as GitObject
    expect([...blob.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(blob.bytes)).toBe('﻿one\nTWO\n')
  })

  it('refuses a file that is not in the head', async () => {
    const s = new Store()
    const head = s.commit(s.files({ 'x.txt': 'x\n' }), [], 'head')
    const plan = planSuggestion({ id: 'C', author: 'R', body: '```suggestion\ny\n```', anchor: { path: 'src/a.rs', line: 1, startLine: null, side: 1, commitOid: head } }, head)
    await expect(applySuggestionCommit(s.reader(), head, [plan], ME, new Map())).rejects.toThrow(/not a regular text file/)
  })
})

describe('update branch (merge the base into the PR branch)', () => {
  it('merges disjoint changes (parents head, base), is up to date when the head has the base, refuses overlaps', async () => {
    const s = new Store()
    const root = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'b\n' }), [], 'root')
    const base = s.commit(s.files({ 'a.txt': 'A\n', 'b.txt': 'b\n' }), [root], 'base moved')
    const head = s.commit(s.files({ 'a.txt': 'a\n', 'b.txt': 'B\n' }), [root], 'feature')
    const out = await updateBranchCommit(s.reader(), head, base, 'refs/heads/main', 'refs/heads/feature', ME)
    expect(out.plan.kind).toBe('merge')
    const objects = await packed(out.commit!.pack.bytes)
    const c = parseCommit((objects.find((o) => o.type === 'commit') as GitObject).bytes)
    expect(c.parents).toEqual([head, base])
    expect(c.message).toBe("Merge branch 'main' into feature\n")
    if (HAVE_GIT) expect(gitAcceptsHistory([...s.objects.values(), ...objects], out.commit!.commit)).toEqual({ fsck: true, log: true, clone: true })

    const already = s.commit(s.files({ 'a.txt': 'A\n', 'b.txt': 'B\n' }), [head, base], 'merged')
    expect((await updateBranchCommit(s.reader(), already, base, 'refs/heads/main', 'refs/heads/feature', ME)).plan.kind).toBe('up-to-date')

    const clash = s.commit(s.files({ 'a.txt': 'a, differently\n', 'b.txt': 'b\n' }), [root], 'clash')
    const refused = await updateBranchCommit(s.reader(), clash, base, 'refs/heads/main', 'refs/heads/feature', ME)
    expect(refused.plan).toEqual({ kind: 'conflict', paths: ['a.txt'] })
  }, 60_000)
})

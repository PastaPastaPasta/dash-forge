/**
 * A path's versions from the push-time history index (v2, `docs/design/history-index.md`):
 * `pathVersions` answers from the index's list with no commit or tree reads past the start's
 * own entry, pages on from the list, walks on past a list that stops short of the path's first
 * commit, and falls back to the walk when the index is missing, stale, behind or fails to load.
 * Every answer equals the plain walk's. Blame over the index blames every line as the walk does.
 */

import { describe, expect, it } from 'vitest'

import type { HistoryIndex, IndexedVersion } from '../browse/history-index'
import { blameFile } from './blame'
import { Store } from './diff-fixtures'
import { attachHistory, type HistorySource } from './history-source'
import { entryMode, entryOid, isFileMode, pathEntryAt, pathVersions } from './path-history'
import type { PrefixReader } from './commit-log'

/** `n` commits: `a.txt` changes every 3rd, `dir/b.txt` every 5th, `c.txt` every one; `late.txt` appears at 30. */
function history(n: number): { s: Store; tips: string[] } {
  const s = new Store()
  const tips: string[] = []
  let tip: string | undefined
  for (let i = 0; i < n; i++) {
    const files: Record<string, string> = {
      'a.txt': `a\n${Math.floor(i / 3)}\nend\n`,
      'dir/b.txt': String(Math.floor(i / 5)),
      'c.txt': String(i),
    }
    if (i >= 30) files['late.txt'] = `late ${Math.floor(i / 7)}\n`
    tip = s.commit(s.files(files), tip === undefined ? [] : [tip], `commit ${i}`)
    tips.push(tip)
  }
  return { s, tips }
}

/** A reader of the store with its own memo scope and the locator's prefix lookup. */
function readerOf(s: Store): PrefixReader & { memoScope: object } {
  return {
    ...s.reader(),
    memoScope: {},
    findByPrefix: (prefix: string, limit = 2) => [...s.objects.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit),
  }
}

/** Every version of `path` from `tip`, by the plain walk (a reader no index is attached to). */
async function walked(s: Store, tip: string, path: string): Promise<string[]> {
  const page = await pathVersions(readerOf(s), tip, path, { limit: 100_000, cap: 100_000 })
  return page.entries.map((e) => e.oid)
}

/** The index a pusher would publish for `tip`, `limit` versions per path, built from the walk. */
async function indexOf(s: Store, tip: string, paths: readonly string[], limit: number): Promise<HistoryIndex> {
  const reader = readerOf(s)
  const versions = new Map<string, { versions: IndexedVersion[]; complete: boolean }>()
  for (const path of paths) {
    const page = await pathVersions(reader, tip, path, { limit: 100_000, cap: 100_000 })
    const list: IndexedVersion[] = []
    for (const e of page.entries.slice(0, limit)) {
      const entry = (await pathEntryAt(reader, reader, e.oid, path)) as string
      const mode = entryMode(entry)
      list.push({
        commit: { oid: e.oid, subject: e.subject, when: e.author.when, author: e.author.name },
        mode,
        oidPrefix: isFileMode(mode) ? entryOid(entry).slice(0, 12) : '',
      })
    }
    versions.set(path, { versions: list, complete: page.next === null && page.entries.length <= limit })
  }
  return { tip, base: null, commitCount: 0, firstParentCount: 0, rootWhen: 0, tipWhen: 0, paths: new Map(), versions, versionLimit: limit }
}

/** A fresh reader of the store whose history source answers `tip` with `load`. */
function indexedReader(s: Store, tip: string, load: () => Promise<HistoryIndex>): PrefixReader {
  const reader = readerOf(s)
  const source: HistorySource = { byTip: new Map(), covers: (t) => t === tip, load }
  attachHistory(reader.memoScope, source)
  return reader
}

/** Every page of `path`'s versions from `tip`, 7 at a time. */
async function paged(reader: PrefixReader, tip: string, path: string): Promise<{ oids: string[]; indexed: number }> {
  const oids: string[] = []
  let indexed = 0
  let next: string | null = tip
  while (next !== null) {
    const page = await pathVersions(reader, next, path, { limit: 7 })
    oids.push(...page.entries.map((e) => e.oid))
    indexed += page.indexed
    next = page.next
  }
  return { oids, indexed }
}

describe('pathVersions from the history index', () => {
  it('answers the first page with no walk: only the start commit and the trees on the path are read', async () => {
    const { s, tips } = history(120)
    const tip = tips[119] as string
    const ix = await indexOf(s, tip, ['a.txt', 'dir/b.txt', 'dir'], 256)
    const reader = indexedReader(s, tip, () => Promise.resolve(ix))
    s.reads.length = 0
    const page = await pathVersions(reader, tip, 'a.txt')
    // The tip commit and its root tree, to check the list against the tip's entry: nothing else.
    expect(s.reads.length).toBeLessThanOrEqual(2)
    expect(page.indexed).toBe(40)
    expect(page.examined).toBe(0)
    expect(page.entries.map((e) => e.oid)).toEqual((await walked(s, tip, 'a.txt')).slice(0, 40))
    // Each version carries its `mode:oid`, resolved from the prefix: Blame reads no tree for it.
    for (const e of page.entries) expect(e.entry).toBe(await pathEntryAt(readerOf(s), readerOf(s), e.oid, 'a.txt'))
    // Author and subject come with the list (a.txt last changed at commit 117).
    expect(page.entries[0]).toMatchObject({ subject: 'commit 117', author: { name: 'Test' } })
  })

  it('pages on from the list and matches the walk to the path’s first commit, for files and directories', async () => {
    const { s, tips } = history(120)
    const tip = tips[119] as string
    for (const path of ['a.txt', 'dir/b.txt', 'dir', 'late.txt']) {
      const ix = await indexOf(s, tip, [path], 256)
      const reader = indexedReader(s, tip, () => Promise.resolve(ix))
      const got = await paged(reader, tip, path)
      const want = await walked(s, tip, path)
      expect(got.oids, path).toEqual(want)
      expect(got.indexed, path).toBe(want.length)
    }
  })

  it('walks on past a list cut at its limit, from the oldest listed commit’s parent', async () => {
    const { s, tips } = history(120)
    const tip = tips[119] as string
    const ix = await indexOf(s, tip, ['a.txt'], 10)
    expect(ix.versions?.get('a.txt')?.complete).toBe(false)
    const reader = indexedReader(s, tip, () => Promise.resolve(ix))
    const got = await paged(reader, tip, 'a.txt')
    expect(got.oids).toEqual(await walked(s, tip, 'a.txt'))
    expect(got.indexed).toBe(10)
  })

  it('does not believe a list whose newest version is not the start’s entry: it walks', async () => {
    const { s, tips } = history(60)
    const tip = tips[59] as string
    const ix = await indexOf(s, tip, ['a.txt'], 256)
    const list = ix.versions?.get('a.txt')
    const stale: HistoryIndex = {
      ...ix,
      versions: new Map([['a.txt', { ...list!, versions: [{ ...list!.versions[0]!, oidPrefix: '000000000000' }, ...list!.versions.slice(1)] }]]),
    }
    const reader = indexedReader(s, tip, () => Promise.resolve(stale))
    const page = await pathVersions(reader, tip, 'a.txt', { limit: 100 })
    expect(page.indexed).toBe(0)
    expect(page.entries.map((e) => e.oid)).toEqual(await walked(s, tip, 'a.txt'))
  })

  it('walks when the index fails to load, or has no list for the path', async () => {
    const { s, tips } = history(60)
    const tip = tips[59] as string
    const failing = indexedReader(s, tip, () => Promise.reject(new Error('artifact unreadable')))
    const page = await pathVersions(failing, tip, 'a.txt', { limit: 100 })
    expect(page.indexed).toBe(0)
    expect(page.entries.map((e) => e.oid)).toEqual(await walked(s, tip, 'a.txt'))
    const v1 = indexedReader(s, tip, async () => ({ ...(await indexOf(s, tip, [], 1)), versions: null }))
    expect((await pathVersions(v1, tip, 'a.txt', { limit: 100 })).indexed).toBe(0)
  })

  it('an index a few commits behind: the walk stops at its tip and the list answers the rest', async () => {
    const { s, tips } = history(120)
    const behind = tips[112] as string
    const tip = tips[119] as string
    const ix = await indexOf(s, behind, ['a.txt'], 256)
    const reader = indexedReader(s, behind, () => Promise.resolve(ix))
    const page = await pathVersions(reader, tip, 'a.txt', { limit: 1000 })
    expect(page.entries.map((e) => e.oid)).toEqual(await walked(s, tip, 'a.txt'))
    expect(page.examined).toBeLessThanOrEqual(8)
    expect(page.indexed).toBeGreaterThan(30)
  })

  it('the whole-repo log never asks the index', async () => {
    const { s, tips } = history(20)
    let loads = 0
    const reader = indexedReader(s, tips[19] as string, () => {
      loads++
      return Promise.reject(new Error('unused'))
    })
    expect((await pathVersions(reader, tips[19] as string, '')).entries).toHaveLength(20)
    expect(loads).toBe(0)
  })
})

describe('a wrong list is not believed (review L1, L2)', () => {
  it('a cut list whose oldest commit this repository does not hold: the walk answers', async () => {
    const { s, tips } = history(120)
    const tip = tips[119] as string
    const ix = await indexOf(s, tip, ['a.txt'], 10)
    const list = ix.versions!.get('a.txt')!
    const last = list.versions.at(-1)!
    const bogus: HistoryIndex = {
      ...ix,
      versions: new Map([['a.txt', { ...list, versions: [...list.versions.slice(0, -1), { ...last, commit: { ...last.commit, oid: 'ee'.repeat(20) } }] }]]),
    }
    const reader = indexedReader(s, tip, () => Promise.resolve(bogus))
    const page = await pathVersions(reader, tip, 'a.txt', { limit: 1000 })
    expect(page.entries.map((e) => e.oid)).toEqual(await walked(s, tip, 'a.txt'))
  })

  it('a later page resumes in a served list only where the trees agree with it', async () => {
    const { s, tips } = history(120)
    const tip = tips[119] as string
    const ix = await indexOf(s, tip, ['a.txt'], 256)
    const list = ix.versions!.get('a.txt')!
    // The second version's blob is misstated: the first page (one entry) is served, the second
    // (starting there) is not believed and walks.
    const wrong: HistoryIndex = {
      ...ix,
      versions: new Map([['a.txt', { ...list, versions: [list.versions[0]!, { ...list.versions[1]!, oidPrefix: '000000000000' }, ...list.versions.slice(2)] }]]),
    }
    const reader = indexedReader(s, tip, () => Promise.resolve(wrong))
    const first = await pathVersions(reader, tip, 'a.txt', { limit: 1 })
    expect(first.indexed).toBe(1)
    const second = await pathVersions(reader, first.next as string, 'a.txt', { limit: 1000 })
    expect(second.indexed).toBe(0)
    expect([...first.entries, ...second.entries].map((e) => e.oid)).toEqual(await walked(s, tip, 'a.txt'))
  })

  it('Blame reads a version from the trees when the index’s blob is not the file’s', async () => {
    const { s, tips } = history(60)
    const tip = tips[59] as string
    const plain = await blameFile(readerOf(s), tip, 'a.txt')
    const ix = await indexOf(s, tip, ['a.txt'], 256)
    const list = ix.versions!.get('a.txt')!
    // The second version's prefix names the tip's root tree instead of a blob.
    const tree = (await pathEntryAt(readerOf(s), readerOf(s), tip, '')) as string
    const wrong: HistoryIndex = {
      ...ix,
      versions: new Map([['a.txt', { ...list, versions: [list.versions[0]!, { ...list.versions[1]!, oidPrefix: entryOid(tree).slice(0, 12) }, ...list.versions.slice(2)] }]]),
    }
    const got = await blameFile(indexedReader(s, tip, () => Promise.resolve(wrong)), tip, 'a.txt')
    expect(got.hunks).toEqual(plain.hunks)
  })
})

describe('blame over the history index', () => {
  it('blames every line as the walk does, reading no commit past the tip', async () => {
    const { s, tips } = history(90)
    const tip = tips[89] as string
    const plain = await blameFile(readerOf(s), tip, 'a.txt')
    const ix = await indexOf(s, tip, ['a.txt'], 256)
    const reader = indexedReader(s, tip, () => Promise.resolve(ix))
    s.reads.length = 0
    const got = await blameFile(reader, tip, 'a.txt')
    expect(got.hunks).toEqual(plain.hunks)
    expect(got.versions).toBe(plain.versions)
    expect([...got.commits.keys()].sort()).toEqual([...plain.commits.keys()].sort())
    expect(got.commits.get(got.hunks[0]!.oid)).toMatchObject({ author: { name: 'Test' } })
    // Past the tip's commit and root tree, only blobs, one per version compared, and the commit
    // that added the file (checked for a rename, as the walk does at the end of the history).
    const commits = s.reads.filter((oid) => s.objects.get(oid)?.type === 'commit')
    const trees = s.reads.filter((oid) => s.objects.get(oid)?.type === 'tree')
    expect(commits).toEqual([tip, tips[0]])
    expect(trees).toHaveLength(1)
    const blobs = s.reads.filter((oid) => s.objects.get(oid)?.type === 'blob')
    expect(blobs.length).toBe(got.versions + 1)
  })

  it('with the list cut short, walks on and still matches', async () => {
    const { s, tips } = history(90)
    const tip = tips[89] as string
    const plain = await blameFile(readerOf(s), tip, 'a.txt')
    const reader = indexedReader(s, tip, () => indexOf(s, tip, ['a.txt'], 4))
    const got = await blameFile(reader, tip, 'a.txt')
    expect(got.hunks).toEqual(plain.hunks)
  })
})

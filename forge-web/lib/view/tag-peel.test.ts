/**
 * L-01, L-02, L-32, L-63: annotated tags are peeled to what they name (nested tags too), a tag of
 * a tree or a blob is told apart from a broken read, short ids in `?ref=` resolve, and the errors
 * no retry can fix are marked permanent.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { gitOidHex, ObjectTooLargeError, type GitObject } from '../browse'
import { CommitIdError, loadCommitChanges, resolveCommitOid, type PrefixReader } from './commit-log'
import { Store } from './diff-fixtures'
import { parseTag } from './git-objects'
import { logPage } from './path-history'
import { selectedTip, selectRef } from './refs'
import { isPermanentReadError, peekDeclared, peekTip, peelCached, peeledCommitOf, resetTipCache, resolveTip, rootTreeOf } from './tip'
import { ObjectTypeError, peel, peelToCommit, readBlob, readCommit, readTree, TAG_PEEL_MAX, type ObjectReader } from './tree-nav'
import { listFiles } from './zip'

const enc = new TextEncoder()

/** An annotated tag object naming `object`, stored in `s`. */
function tag(s: Store, object: string, type: GitObject['type'], name: string): string {
  const bytes = enc.encode(`object ${object}\ntype ${type}\ntag ${name}\ntagger T <t@example.com> 1 +0000\n\n${name}\n`)
  const oid = gitOidHex('tag', bytes)
  s.objects.set(oid, { type: 'tag', bytes })
  return oid
}

/** A reader over `s` that also answers prefix lookups (the locator's sorted index). */
function prefixReader(s: Store): PrefixReader {
  const inner = s.reader()
  return {
    ...inner,
    findByPrefix: (p, limit = 16) => [...s.objects.keys()].filter((o) => o.startsWith(p)).sort().slice(0, limit),
    objectType: async (oid) => s.objects.get(oid)?.type ?? null,
    memoScope: s,
  }
}

function repo(): { s: Store; commit: string; root: string; blob: string } {
  const s = new Store()
  const blob = s.blob('hello\n')
  const root = s.tree([{ name: 'README.md', oid: blob }])
  return { s, commit: s.commit(root), root, blob }
}

afterEach(() => resetTipCache())

describe('parseTag', () => {
  it('reads the object, type and name of an annotated tag', () => {
    const { s, commit } = repo()
    const t = tag(s, commit, 'commit', 'v1.0')
    expect(parseTag(s.objects.get(t)!.bytes)).toEqual({ object: commit, type: 'commit', tag: 'v1.0' })
  })

  it('refuses a tag whose header does not start with object and type', () => {
    expect(parseTag(enc.encode('type commit\nobject abc\n\n'))).toBeNull()
    expect(parseTag(enc.encode(`object ${'a'.repeat(40)}\n\n`))).toBeNull()
  })
})

describe('peel (L-01)', () => {
  it('leaves a commit as it is, with no tags', async () => {
    const { s, commit } = repo()
    await expect(peel(s.reader(), commit)).resolves.toEqual({ oid: commit, type: 'commit', tags: [] })
  })

  it('peels an annotated tag to its commit', async () => {
    const { s, commit } = repo()
    const t = tag(s, commit, 'commit', 'v23.1.8')
    const p = await peelToCommit(s.reader(), t)
    expect(p.oid).toBe(commit)
    expect(p.tags.map((x) => x.tag)).toEqual(['v23.1.8'])
  })

  it('peels nested tags (tag → tag → commit), outermost first', async () => {
    const { s, commit } = repo()
    const inner = tag(s, commit, 'commit', 'inner')
    const outer = tag(s, inner, 'tag', 'outer')
    const p = await peelToCommit(s.reader(), outer)
    expect(p.oid).toBe(commit)
    expect(p.tags.map((x) => x.tag)).toEqual(['outer', 'inner'])
  })

  it('peels a tag of a tree to the tree, and refuses it where a commit is needed', async () => {
    const { s, root } = repo()
    const t = tag(s, root, 'tree', 'tree-tag')
    await expect(peel(s.reader(), t)).resolves.toMatchObject({ oid: root, type: 'tree' })
    const e = await peelToCommit(s.reader(), t).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ObjectTypeError)
    expect((e as ObjectTypeError).actual).toBe('tree')
    expect(isPermanentReadError(e)).toBe(true)
  })

  it('peels a tag of a blob to the blob', async () => {
    const { s, blob } = repo()
    const t = tag(s, blob, 'blob', 'key')
    await expect(peel(s.reader(), t)).resolves.toMatchObject({ oid: blob, type: 'blob' })
  })

  it('gives up on a chain longer than the bound instead of reading on', async () => {
    const { s, commit } = repo()
    let at = commit
    for (let i = 0; i <= TAG_PEEL_MAX + 1; i++) at = tag(s, at, i === 0 ? 'commit' : 'tag', `t${i}`)
    await expect(peel(s.reader(), at)).rejects.toThrow(/nested tags/)
  })

  it('without verify, stops at a tag that names a commit (one read per tag)', async () => {
    const { s, commit } = repo()
    const t = tag(s, commit, 'commit', 'v1')
    s.reads.length = 0
    await expect(peel(s.reader(), t, { verify: false })).resolves.toMatchObject({ oid: commit, type: 'commit' })
    expect(s.reads).toEqual([t])
  })
})

describe('the views read through a tag (L-01)', () => {
  it('readCommit, readTree and readBlob say what the object is instead', async () => {
    const { s, commit, root } = repo()
    const t = tag(s, commit, 'commit', 'v1')
    await expect(readCommit(s.reader(), t)).rejects.toThrow(`${t.slice(0, 8)} is a tag, not a commit`)
    await expect(readTree(s.reader(), commit)).rejects.toThrow('is a commit, not a tree')
    await expect(readBlob(s.reader(), root)).rejects.toThrow('is a tree, not a blob')
  })

  it('the root tree of a tag of a commit or of a tree', async () => {
    const { s, commit, root } = repo()
    const r = prefixReader(s)
    expect(await rootTreeOf(r, await resolveTip(r, tag(s, commit, 'commit', 'v1')))).toBe(root)
    expect(await rootTreeOf(r, await resolveTip(r, tag(s, root, 'tree', 't')))).toBe(root)
  })

  it('the zip lists a tagged commit and a tagged tree', async () => {
    const { s, commit, root } = repo()
    expect((await listFiles(s.reader(), tag(s, commit, 'commit', 'v1'))).map((f) => f.path)).toEqual(['README.md'])
    expect((await listFiles(s.reader(), tag(s, root, 'tree', 't'))).map((f) => f.path)).toEqual(['README.md'])
  })

  it('the commit page shows the commit a tag names, and which tag', async () => {
    const { s, commit } = repo()
    const t = tag(s, commit, 'commit', 'v22.0.0')
    const changes = await loadCommitChanges(prefixReader(s), t)
    expect(changes.oid).toBe(commit)
    expect(changes.tags.map((x) => x.tag)).toEqual(['v22.0.0'])
    expect(changes.changes.map((c) => c.path)).toEqual(['README.md'])
  })

  it('the commit page names a tag of a tree for what it is (L-02: not "a file or directory")', async () => {
    const { s, root } = repo()
    const t = tag(s, root, 'tree', 'tree-tag')
    const e = await loadCommitChanges(prefixReader(s), t).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CommitIdError)
    expect((e as Error).message).toBe(`${t} is a tag of a directory in this repo, not a commit`)
  })

  it('the commit page names a blob id as a file', async () => {
    const { s, blob } = repo()
    const e = await loadCommitChanges(prefixReader(s), blob).catch((x: unknown) => x)
    expect((e as Error).message).toBe(`${blob} names a file in this repo, not a commit`)
  })
})

describe('the tip cache', () => {
  it('peels once per id and answers warm views at once', async () => {
    const { s, commit } = repo()
    const t = tag(s, commit, 'commit', 'v1')
    const r = prefixReader(s)
    expect(peekTip(r, t)).toBeUndefined()
    s.reads.length = 0
    await Promise.all([resolveTip(r, t), resolveTip(r, t)])
    expect(s.reads.filter((o) => o === t)).toHaveLength(1)
    expect(peekTip(r, t)?.oid).toBe(commit)
    expect(peeledCommitOf(t)).toBe(commit)
    await resolveTip(r, t)
    expect(s.reads.filter((o) => o === t)).toHaveLength(1)
  })

  it('does not keep an unverified listing answer as the verified one', async () => {
    const { s, commit } = repo()
    const t = tag(s, commit, 'commit', 'v1')
    await peelCached(s.reader(), t, { verify: false })
    expect(peekTip(prefixReader(s), t)).toBeUndefined()
  })
})

describe('short ids in ?ref= (L-32)', () => {
  const ref = (refName: string, oid: string) => ({ refName, refNameHash: 'x', state: { state: 'resolved' as const, oid, author: 'id', createdAt: 1 } })

  it('selects a 4-40 hex param no ref is named as a pinned commit', () => {
    const s = selectRef([ref('refs/heads/main', '1'.repeat(40))], [], 'main', '1deab35186f9c')
    expect(s.pinned).toBe('1deab35186f9c')
    expect(selectedTip(s)).toBe('1deab35186f9c')
    expect(selectRef([], [], 'main', 'abc').pinned).toBeUndefined()
    expect(selectRef([], [], 'main', 'v1.0').pinned).toBeUndefined()
  })

  it('resolves a short id to its commit through the prefix index', async () => {
    const { s, commit } = repo()
    const r = prefixReader(s)
    await expect(resolveTip(r, commit.slice(0, 13))).resolves.toMatchObject({ oid: commit, type: 'commit' })
    expect(peekTip(r, commit.slice(0, 13))?.oid).toBe(commit)
  })

  it('resolves a short id of an annotated tag through to its commit', async () => {
    const { s, commit } = repo()
    const t = tag(s, commit, 'commit', 'v1')
    expect(await resolveCommitOid(prefixReader(s), t.slice(0, 10))).toBe(t)
    await expect(resolveTip(prefixReader(s), t.slice(0, 10))).resolves.toMatchObject({ oid: commit })
  })

  it('says an ambiguous short id is ambiguous, with the candidates, and never retries it', async () => {
    const { s } = repo()
    const a = s.commit(s.tree([]), [], 'a')
    const b = s.commit(s.tree([]), [], 'b')
    const r: PrefixReader = { ...prefixReader(s), findByPrefix: () => [a, b] }
    const e = await resolveTip(r, 'abcd').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CommitIdError)
    expect((e as CommitIdError).kind).toBe('ambiguous')
    expect((e as CommitIdError).candidates).toEqual([a, b])
    expect(isPermanentReadError(e)).toBe(true)
  })

  it('says a short id that matches nothing is not found, which a push can change', async () => {
    const { s } = repo()
    const e = await resolveTip(prefixReader(s), 'ffffff0').catch((x: unknown) => x)
    expect((e as CommitIdError).kind).toBe('not-found')
    expect(isPermanentReadError(e)).toBe(false)
  })
})

describe('review follow-ups', () => {
  it('peels a tag of a large blob by reading only the blob type, not its bytes', async () => {
    const { s } = repo()
    const big = s.blob(new Uint8Array(300 * 1024))
    const t = tag(s, big, 'blob', 'big')
    const inner = s.reader()
    const read: { oid: string; maxBytes: number }[] = []
    const r: ObjectReader = {
      readObject: async (oid, opts) => {
        read.push({ oid, maxBytes: opts?.maxBytes ?? Infinity })
        const obj = await inner.readObject(oid)
        if (obj.bytes.length > (opts?.maxBytes ?? Infinity)) throw new ObjectTooLargeError(obj.bytes.length, opts?.maxBytes ?? 0)
        return obj
      },
      objectType: async (oid) => s.objects.get(oid)?.type ?? null,
    }
    await expect(peel(r, t)).resolves.toMatchObject({ oid: big, type: 'blob' })
    // The blob was only asked for within the bound; no unbounded read of it.
    expect(read.filter((x) => x.oid === big).every((x) => x.maxBytes !== Infinity)).toBe(true)
  })

  it('keeps a listing answer apart: peekDeclared sees it, peekTip and resolveTip never do', async () => {
    const { s, commit } = repo()
    const t = tag(s, commit, 'commit', 'v1')
    await peelCached(s.reader(), t, { verify: false })
    expect(peekDeclared(t)?.oid).toBe(commit)
    expect(peekTip(prefixReader(s), t)).toBeUndefined()
    s.reads.length = 0
    await resolveTip(prefixReader(s), t)
    // The verified resolve read the tag and the commit itself.
    expect(s.reads).toContain(commit)
  })

  it('caches only the oid and type (never a tag name, which a private repo decrypts)', async () => {
    const { s, commit } = repo()
    const t = tag(s, commit, 'commit', 'secret-release-name')
    const tip = await resolveTip(prefixReader(s), t)
    expect(tip).toEqual({ oid: commit, type: 'commit' })
    expect(JSON.stringify(peekTip(prefixReader(s), t))).not.toContain('secret')
  })

  it('says a pinned full id the repo does not hold is "Commit not found", which Try again may fix', async () => {
    const { s } = repo()
    const r: PrefixReader = { ...prefixReader(s), locate: () => null }
    const e = await resolveTip(r, 'f'.repeat(40), { pinned: true }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CommitIdError)
    expect((e as CommitIdError).kind).toBe('not-found')
    expect(isPermanentReadError(e)).toBe(false)
  })

  it('resolves a short pinned id for the About card through the repo it was resolved in', async () => {
    const { s, commit } = repo()
    expect(peeledCommitOf(commit.slice(0, 9), 'repo-1')).toBe(commit.slice(0, 9))
    await resolveTip(prefixReader(s), commit.slice(0, 9), { repoKey: 'repo-1' })
    expect(peeledCommitOf(commit.slice(0, 9), 'repo-1')).toBe(commit)
    expect(peeledCommitOf(commit.slice(0, 9), 'repo-2')).toBe(commit.slice(0, 9))
  })

  it('primes the history memo, so a log from the tip reads no commit again', async () => {
    const { s, commit } = repo()
    const r = prefixReader(s)
    await resolveTip(r, commit)
    s.reads.length = 0
    await logPage(r, commit, { walker: r })
    expect(s.reads).not.toContain(commit)
  })
})

describe('isPermanentReadError (L-63)', () => {
  it('lets a network failure be retried', () => {
    expect(isPermanentReadError(new Error('fetch failed'))).toBe(false)
  })
})

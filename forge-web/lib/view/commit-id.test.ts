/** D-057: short and odd-length commit ids in a commit URL resolve the way git resolves them. */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BrowseReader, MissingObjectError, ObjectLocator, type GitObject, type PackSource } from '../browse'
import { indexPacks, memoryPackSource, serializeLocator } from '../browse/indexer'
import { HAVE_GIT, scratchRepo, writeLiterally } from '../merge/git-oracle'
import { CommitIdError, loadCommitChanges, resolveCommitOid, type PrefixReader } from './commit-log'
import { Store } from './diff-fixtures'

const COMMIT_A = 'ce97e47a1111111111111111111111111111111a'
const COMMIT_B = 'ab12345000000000000000000000000000000001'
const BLOB_B = 'ab12345f00000000000000000000000000000002'
const COMMIT_C1 = '0dd1ce0000000000000000000000000000000001'
const COMMIT_C2 = '0dd1cef000000000000000000000000000000002'

function reader(): PrefixReader {
  const types = new Map<string, GitObject['type']>([
    [COMMIT_A, 'commit'],
    [COMMIT_B, 'commit'],
    [BLOB_B, 'blob'],
    [COMMIT_C1, 'commit'],
    [COMMIT_C2, 'commit'],
  ])
  const locator = ObjectLocator.parse(
    serializeLocator(
      // COMMIT_A is stored in two packs: its rows repeat, the match must not.
      [...types.keys(), COMMIT_A].map((oidHex, i) => ({ oidHex, packRef: i === 5 ? 1 : 0, offset: 12 + i, length: 1, deltaDepth: 0 })),
    ),
  )
  return {
    findByPrefix: (p, limit) => locator.findByPrefix(p, limit),
    locate: (oid) => locator.lookup(Uint8Array.from(oid.match(/../g) ?? [], (h) => parseInt(h, 16))),
    readObject: async (oid) => {
      const type = types.get(oid)
      if (type === undefined) throw new Error(`object not in locator: ${oid}`)
      return { type, bytes: new Uint8Array(0) }
    },
  }
}

describe('ObjectLocator.findByPrefix', () => {
  it('finds the run of OIDs sharing an even or odd-length prefix', () => {
    const r = reader()
    expect(r.findByPrefix?.('ce97e47')).toEqual([COMMIT_A])
    expect(r.findByPrefix?.('CE97E47A')).toEqual([COMMIT_A])
    expect(r.findByPrefix?.('ab12345', 5)).toEqual([COMMIT_B, BLOB_B])
    expect(r.findByPrefix?.('0dd1ce', 5)).toEqual([COMMIT_C1, COMMIT_C2])
    expect(r.findByPrefix?.('ffff')).toEqual([])
    expect(r.findByPrefix?.('zz')).toEqual([])
  })
})

describe('resolveCommitOid', () => {
  it('resolves the 7-character id the UI shows (odd length)', async () => {
    await expect(resolveCommitOid(reader(), 'ce97e47')).resolves.toBe(COMMIT_A)
  })

  it('passes a full id through', async () => {
    await expect(resolveCommitOid(reader(), COMMIT_A.toUpperCase())).resolves.toBe(COMMIT_A)
  })

  it('prefers the one commit when a prefix also matches a blob', async () => {
    await expect(resolveCommitOid(reader(), 'ab12345')).resolves.toBe(COMMIT_B)
  })

  it('reports an ambiguous prefix with the candidates', async () => {
    const e = await resolveCommitOid(reader(), '0dd1ce').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CommitIdError)
    expect((e as CommitIdError).kind).toBe('ambiguous')
    expect((e as CommitIdError).candidates).toEqual([COMMIT_C1, COMMIT_C2])
  })

  it('says not found, and refuses non-hex or too-short ids, without a raw hex error', async () => {
    for (const [input, kind] of [
      ['ffff00', 'not-found'],
      ['zzzz', 'invalid'],
      ['ce9', 'invalid'],
      ['', 'invalid'],
    ] as const) {
      const e = await resolveCommitOid(reader(), input).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(CommitIdError)
      expect((e as CommitIdError).kind).toBe(kind)
      expect((e as Error).message).not.toMatch(/even length/)
    }
  })
})

describe('resolveCommitOid edge cases', () => {
  const base = reader()

  it('does not call a commit missing from a partial clone "not found"', async () => {
    const partial: PrefixReader = { ...base, incomplete: true }
    const e = await resolveCommitOid(partial, 'ffff00').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(MissingObjectError)
    expect((e as Error).message).toMatch(/could not be fetched/)
  })

  it('says a single non-commit match is not a commit, and offers no links to it', async () => {
    const e = await resolveCommitOid(base, 'ab12345f').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CommitIdError)
    expect((e as CommitIdError).kind).toBe('not-a-commit')
    expect((e as CommitIdError).candidates).toEqual([])
  })

  it('reads only entry headers to learn candidate types', async () => {
    const read: string[] = []
    const r: PrefixReader = {
      ...base,
      readObject: async (oid) => {
        read.push(oid)
        return base.readObject(oid)
      },
      objectType: async (oid) => (oid === BLOB_B ? 'blob' : 'commit'),
    }
    await expect(resolveCommitOid(r, 'ab12345')).resolves.toBe(COMMIT_B)
    expect(read).toEqual([])
  })

  it('reports a prefix matching 16 or more objects as ambiguous, not a guess', async () => {
    const many: PrefixReader = {
      ...base,
      findByPrefix: (_p, limit = 2) => Array.from({ length: limit }, (_, i) => `abcd${i.toString(16).padStart(36, '0')}`),
      objectType: async (oid) => (oid.endsWith('f') ? 'commit' : 'blob'),
    }
    const e = await resolveCommitOid(many, 'abcd').catch((x: unknown) => x)
    expect((e as CommitIdError).kind).toBe('ambiguous')
  })

  it('surfaces a read failure rather than calling the id not found', async () => {
    const broken: PrefixReader = { ...base, objectType: async () => Promise.reject(new Error('storage down')) }
    await expect(resolveCommitOid(broken, 'ab12345')).rejects.toThrow('storage down')
  })
})

/** One object of a real pack, as `git verify-pack -v` lists it. */
interface PackedObject {
  readonly oid: string
  readonly type: GitObject['type']
  /** Delta chain depth (0: stored whole). */
  readonly depth: number
}

/**
 * A real pack git wrote of `objects` (`git pack-objects`, deltas searched afresh), and git's own
 * account of how it stored each one. `refDeltas` stores deltas as REF_DELTA rather than OFS_DELTA.
 */
function gitPack(objects: Iterable<GitObject>, oids: readonly string[], refDeltas: boolean): { pack: Uint8Array; stored: PackedObject[] } {
  const { dir, done } = scratchRepo()
  try {
    writeLiterally(dir, objects)
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const flags = ['--window=10', '--depth=10', ...(refDeltas ? ['--no-delta-base-offset'] : [])]
    const made = spawnSync('git', ['pack-objects', '-q', ...flags, 'p'], { cwd: dir, env, input: `${oids.join('\n')}\n` })
    if (made.status !== 0) throw new Error(`git pack-objects failed: ${made.stderr.toString()}`)
    const base = join(dir, `p-${made.stdout.toString().trim()}`)
    const listed = spawnSync('git', ['verify-pack', '-v', `${base}.idx`], { cwd: dir, env })
    const stored: PackedObject[] = []
    for (const line of listed.stdout.toString().split('\n')) {
      const m = /^([0-9a-f]{40}) (commit|tree|blob|tag) +\d+ \d+ \d+(?: (\d+) [0-9a-f]{40})?$/.exec(line)
      if (m) stored.push({ oid: m[1] as string, type: m[2] as GitObject['type'], depth: Number(m[3] ?? 0) })
    }
    return { pack: new Uint8Array(readFileSync(`${base}.pack`)), stored }
  } finally {
    done()
  }
}

/** A pack source that records the length of every range read. */
function recording(inner: PackSource): PackSource & { readonly reads: number[] } {
  const reads: number[] = []
  return {
    reads,
    fetchRange: (packRef, start, end, copy) => {
      reads.push(end - start)
      return inner.fetchRange(packRef, start, end, copy)
    },
  }
}

/**
 * D-1: git stores small, similar commits as deltas of each other (a new repo's first push is
 * exactly that), and a delta entry's header does not say what type it is. A short id of one
 * must still resolve to the commit, reading entry headers only.
 */
describe.skipIf(!HAVE_GIT)('short ids of objects git stored as deltas', () => {
  const s = new Store()
  const body = 'A commit body that every commit here shares, so that git stores them as deltas.\n'.repeat(4)
  // Each version of the file rewrites one more line, with text no other line holds: its
  // nearest delta base is the version before, so git chains them rather than basing all on one.
  let x = 20260930
  const noise = (): string => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    return x.toString(36).padStart(7, '0').repeat(6)
  }
  const lines = Array.from({ length: 40 }, (_, j) => `line ${j} of a file most of which never changes\n`)
  let parents: string[] = []
  for (let i = 0; i < 8; i++) {
    lines[i] = `line ${i} rewritten: ${noise()}\n`
    parents = [s.commit(s.files({ 'notes.txt': lines.join('') }), parents, `change ${i}\n\n${body}`)]
  }

  for (const refDeltas of [false, true]) {
    describe(refDeltas ? 'REF_DELTA' : 'OFS_DELTA', () => {
      const { pack, stored } = gitPack(s.objects.values(), [...s.objects.keys()], refDeltas)
      const source = recording(memoryPackSource([pack]))
      const reader = async (): Promise<BrowseReader> =>
        new BrowseReader(ObjectLocator.parse(serializeLocator(await indexPacks([pack]))), source)
      const deltaCommits = stored.filter((o) => o.type === 'commit' && o.depth > 0)
      const deltaBlobs = stored.filter((o) => o.type === 'blob' && o.depth > 0)

      it('has commits and blobs git stored as deltas, some more than one deep', () => {
        expect(deltaCommits.length).toBeGreaterThan(0)
        expect(deltaBlobs.length).toBeGreaterThan(0)
        expect(Math.max(...stored.map((o) => o.depth))).toBeGreaterThan(1)
      })

      it("resolves a delta commit's 7-character id to it, and opens it", async () => {
        const r = await reader()
        for (const { oid } of deltaCommits) {
          await expect(resolveCommitOid(r, oid.slice(0, 7))).resolves.toBe(oid)
          await expect(loadCommitChanges(r, oid.slice(0, 7))).resolves.toMatchObject({ oid })
        }
      })

      it("reports every object's type from entry headers alone, one per step of its chain", async () => {
        const r = await reader()
        source.reads.length = 0
        for (const o of stored) await expect(r.objectType(o.oid)).resolves.toBe(o.type)
        expect(Math.max(...source.reads)).toBeLessThanOrEqual(32)
        const deepest = stored.reduce((a, b) => (b.depth > a.depth ? b : a))
        source.reads.length = 0
        await r.objectType(deepest.oid)
        expect(source.reads).toHaveLength(deepest.depth + 1)
      })

      it("says a delta blob's short id names a file, not a commit", async () => {
        const blob = deltaBlobs[0] as PackedObject
        const e = await resolveCommitOid(await reader(), blob.oid.slice(0, 7)).catch((x: unknown) => x)
        expect((e as CommitIdError).kind).toBe('not-a-commit')
        expect((e as Error).message).toMatch(/names a file/)
      })
    })
  }
})

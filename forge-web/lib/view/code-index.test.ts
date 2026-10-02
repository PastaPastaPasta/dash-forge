import 'fake-indexeddb/auto'

import { describe, expect, it } from 'vitest'

import { ObjectTooLargeError } from '../browse'
import type { RepoRef } from '../repo/contract'
import { Store } from './diff-fixtures'
import { buildCodeIndex, codeSearchTarget, LARGE_FILES, MAX_FILE_BYTES, planAllowed, planAutoBuilds, planCodeIndex, type CodeIndexPort, type CodeSearchTarget } from './code-index'
import { CodeIndexHost, type CodeIndexRequest, type OpenResult } from './code-index-host'
import { IdbCodeIndexStore, MemoryCodeIndexStore, type CodeIndexRecord } from './code-index-store'
import type { SearchResult } from './code-match'
import type { ObjectReader } from './tree-nav'

let dbs = 0
/** A host over a fresh IndexedDB (fake) and memory store, and a port that counts its requests. */
function setup(budget?: number) {
  const persistent = new IdbCodeIndexStore(`code-search-test-${dbs++}`, budget)
  const host = new CodeIndexHost({ persistent, memory: new MemoryCodeIndexStore() })
  const ops: string[] = []
  const port: CodeIndexPort = { request: <T,>(req: CodeIndexRequest) => (ops.push(req.op), host.handle(req) as Promise<T>) }
  return { host, port, ops, persistent }
}

let repos = 0
const repo = (visibility: 'public' | 'private' = 'public'): RepoRef => ({ repoId: `repo-${repos++}`, ownerId: 'owner', name: 'r', visibility }) as unknown as RepoRef

/** The store's reader, refusing a blob over `maxBytes` as the browse reader does. */
function capped(s: Store): ObjectReader & { reads: string[] } {
  const inner = s.reader()
  const reads: string[] = []
  return {
    reads,
    readObject: async (oid, options) => {
      reads.push(oid)
      const obj = await inner.readObject(oid)
      if (options?.maxBytes !== undefined && obj.bytes.length > options.maxBytes) throw new ObjectTooLargeError(obj.bytes.length, options.maxBytes)
      return obj
    },
  }
}

const search = (port: CodeIndexPort, target: CodeSearchTarget, query: string) => port.request<SearchResult>({ op: 'search', scope: target.scope, tip: target.tip, query, offset: 0, limit: 20 })

describe('code search index', () => {
  it('builds from the reader, searches with no read, and reopens from IndexedDB', async () => {
    const { port, ops, persistent } = setup()
    const s = new Store()
    const tip = s.commit(
      s.files({
        'README.md': '# Demo\nsearch me\n',
        'src/main.rs': 'fn main() {\n    println!("hello");\n}\n',
        'logo.png': 'not read',
      }),
    )
    const reader = capped(s)
    const r = repo()
    const target = codeSearchTarget(r, tip, 'main', true)
    const plan = await planCodeIndex(reader, r, target, { oid: tip, type: 'commit' }, { indexPort: port })
    expect(plan.files.map((f) => f.path)).toEqual(['README.md', 'src/main.rs'])
    expect(plan.skipped).toEqual({ binary: 1, large: 0, symlink: 0 })
    expect(plan.toRead).toHaveLength(2)
    expect(planAutoBuilds(plan)).toBe(true)
    const progress: number[] = []
    const summary = await buildCodeIndex(reader, plan, { indexPort: port, onProgress: (p) => progress.push(p.files) })
    expect(summary.files).toBe(2)
    expect(progress.at(-1)).toBe(2)

    const reads = reader.reads.length
    const hit = await search(port, target, 'println')
    expect(hit.files.map((f) => f.path)).toEqual(['src/main.rs'])
    expect(hit.files[0]?.lines.find((l) => l.ranges.length > 0)?.n).toBe(2)
    expect(reader.reads.length).toBe(reads)

    // Another tab (a fresh worker) opens the kept index with no read at all.
    const fresh = new CodeIndexHost({ persistent, memory: new MemoryCodeIndexStore() })
    const opened = (await fresh.handle({ op: 'open', scope: target.scope, persist: true, tip })) as OpenResult
    expect(opened.state).toBe('ready')
    expect(reader.reads.length).toBe(reads)
    expect(ops).toEqual(['stored', 'add', 'commit', 'search'])
  })

  it('reads only the blobs a new tip changed', async () => {
    const { port } = setup()
    const s = new Store()
    const files: Record<string, string> = {}
    for (let i = 0; i < 10; i++) files[`src/f${i}.c`] = `int f${i}(void) { return ${i}; }\n`
    const tip1 = s.commit(s.files(files))
    const tip2 = s.commit(s.files({ ...files, 'src/f3.c': 'int f3(void) { return 33; }\n', 'src/new.c': 'int fresh;\n' }))
    const r = repo()
    const reader = capped(s)
    const t1 = codeSearchTarget(r, tip1, 'main', true)
    await buildCodeIndex(reader, await planCodeIndex(reader, r, t1, { oid: tip1, type: 'commit' }, { indexPort: port }), { indexPort: port })
    const t2 = codeSearchTarget(r, tip2, 'main', true)
    const plan2 = await planCodeIndex(reader, r, t2, { oid: tip2, type: 'commit' }, { indexPort: port })
    expect(plan2.cached).toBe(9)
    expect(plan2.toRead.map((f) => f.path).sort()).toEqual(['src/f3.c', 'src/new.c'])
    await buildCodeIndex(reader, plan2, { indexPort: port })
    expect((await search(port, t2, 'return 33')).fileCount).toBe(1)
    expect((await search(port, t2, 'fresh')).files.map((f) => f.path)).toEqual(['src/new.c'])
    // The older tip's index is kept too (a small repo keeps a few).
    expect(((await port.request({ op: 'open', scope: t1.scope, persist: true, tip: tip1 })) as OpenResult).state).toBe('ready')
    expect((await port.request<{ tip: string } | null>({ op: 'latest', scope: t1.scope, persist: true, ref: 'main' }))?.tip).toBe(tip2)
  })

  it('leaves out binary and too-large files, and remembers them unread', async () => {
    const { port } = setup()
    const s = new Store()
    const big = 'x'.repeat(MAX_FILE_BYTES + 1)
    const tip = s.commit(s.files({ 'a.txt': 'alpha\n', 'blob.dat2': 'bin\0ary', 'huge.txt': big }))
    const r = repo()
    const reader = capped(s)
    const target = codeSearchTarget(r, tip, 'main', true)
    const plan = await planCodeIndex(reader, r, target, { oid: tip, type: 'commit' }, { indexPort: port })
    const summary = await buildCodeIndex(reader, plan, { indexPort: port })
    expect(summary.files).toBe(1)
    expect(summary.skipped).toEqual({ binary: 1, large: 1, symlink: 0 })
    const again = await planCodeIndex(reader, r, target, { oid: tip, type: 'commit' }, { indexPort: port })
    expect(again.toRead).toEqual([])
    expect(again.skipped).toEqual({ binary: 1, large: 1, symlink: 0 })
  })

  it('stops reading at the text cap and says so', async () => {
    const { port } = setup()
    const s = new Store()
    const tip = s.commit(s.files({ 'a.txt': 'a'.repeat(600), 'b.txt': 'b'.repeat(600) }))
    const r = repo()
    const reader = capped(s)
    const target = codeSearchTarget(r, tip, 'main', true)
    const plan = await planCodeIndex(reader, r, target, { oid: tip, type: 'commit' }, { indexPort: port })
    const summary = await buildCodeIndex(reader, plan, { indexPort: port, maxTextBytes: 1000 })
    expect(summary.capped).toBe(true)
    expect(summary.files).toBe(1)
  })

  it('reads again a kept file that fails its check', async () => {
    const { port, persistent } = setup()
    const s = new Store()
    const tip = s.commit(s.files({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' }))
    const r = repo()
    const reader = capped(s)
    const target = codeSearchTarget(r, tip, 'main', true)
    await buildCodeIndex(reader, await planCodeIndex(reader, r, target, { oid: tip, type: 'commit' }, { indexPort: port }), { indexPort: port })
    const record = (await persistent.getIndex(target.scope, tip)) as CodeIndexRecord
    const aOid = record.files.find((f) => f[0] === 'a.txt')?.[1] as string
    // Tamper with the kept bytes, as a hostile local process or a torn write might.
    await persistent.putBlobs(target.scope, [[aOid, { bytes: new TextEncoder().encode('tampered\n') }]])
    const fresh = new CodeIndexHost({ persistent, memory: new MemoryCodeIndexStore() })
    const opened = (await fresh.handle({ op: 'open', scope: target.scope, persist: true, tip })) as OpenResult
    expect(opened).toEqual({ state: 'incomplete', missing: 1 })
    // The bad bytes were dropped: planning again reads that file alone.
    const freshPort: CodeIndexPort = { request: <T,>(req: CodeIndexRequest) => fresh.handle(req) as Promise<T> }
    const plan = await planCodeIndex(reader, r, target, { oid: tip, type: 'commit' }, { indexPort: freshPort })
    expect(plan.toRead.map((f) => f.oid)).toEqual([aOid])
    const before = reader.reads.length
    await buildCodeIndex(reader, plan, { indexPort: freshPort })
    expect(reader.reads.slice(before)).toEqual([aOid])
    expect((await search(freshPort, target, 'alpha')).fileCount).toBe(1)
    expect((await search(freshPort, target, 'tampered')).fileCount).toBe(0)
  })

  it('keeps a private repo in memory only', async () => {
    const { port, persistent } = setup()
    const s = new Store()
    const tip = s.commit(s.files({ 'secret.txt': 'plans\n' }))
    const r = repo('private')
    const reader = capped(s)
    const target = codeSearchTarget(r, tip, 'main', true)
    expect(target.persist).toBe(false)
    await buildCodeIndex(reader, await planCodeIndex(reader, r, target, { oid: tip, type: 'commit' }, { indexPort: port }), { indexPort: port })
    expect((await search(port, target, 'plans')).fileCount).toBe(1)
    expect(await persistent.getIndex(target.scope, tip)).toBeUndefined()
    await port.request({ op: 'drop', scope: target.scope })
    expect(((await port.request({ op: 'open', scope: target.scope, persist: false, tip })) as OpenResult).state).toBe('none')
  })

  it('refuses a large repo off its default branch', () => {
    const target = (defaultBranch: boolean): CodeSearchTarget => ({ scope: 's', persist: true, tip: 't', ref: 'x', defaultBranch })
    expect(planAllowed({ large: true, tooLarge: false, target: target(true) })).toBe(true)
    expect(planAllowed({ large: true, tooLarge: false, target: target(false) })).toBe(false)
    expect(planAllowed({ large: false, tooLarge: false, target: target(false) })).toBe(true)
    expect(planAllowed({ large: true, tooLarge: true, target: target(true) })).toBe(false)
    expect(LARGE_FILES).toBeGreaterThan(0)
  })
})

describe('code search store', () => {
  const rec = (tip: string, files: [string, string][], ref = 'main'): CodeIndexRecord => ({
    tip,
    commit: tip,
    tree: 'tree',
    ref,
    files,
    skipped: { binary: 0, large: 0, symlink: 0 },
    truncated: false,
    capped: false,
    large: false,
    builtAt: 0,
  })
  const bytes = (n: number) => ({ bytes: new Uint8Array(n).fill(97) })

  for (const [name, make] of [
    ['IndexedDB', (budget: number) => new IdbCodeIndexStore(`code-search-store-${dbs++}`, budget)],
    ['memory', (budget: number) => new MemoryCodeIndexStore(budget)],
  ] as const) {
    it(`${name}: keeps the newest indexes, drops unnamed blobs, and evicts the oldest repo past the budget`, async () => {
      const store = make(1000)
      await store.putBlobs('A', [
        ['o1', bytes(100)],
        ['stray', bytes(100)],
        ['bin', { skip: 'binary' }],
      ])
      await store.putIndex('A', rec('t1', [['a', 'o1']]), 2)
      await store.putBlobs('A', [['o2', bytes(100)]])
      await store.putIndex('A', rec('t2', [['b', 'o2']]), 2)
      await store.putBlobs('A', [['o3', bytes(100)]])
      await store.putIndex('A', rec('t3', [['c', 'o3']]), 2)
      expect(await store.getIndex('A', 't1')).toBeUndefined()
      expect((await store.getIndex('A', 't3'))?.files).toEqual([['c', 'o3']])
      // o1 went with t1's index; the stray (read by a build not finished, maybe another tab's) stays.
      expect([...(await store.stored('A', ['o1', 'o2', 'o3', 'bin', 'stray']))].sort()).toEqual([
        ['bin', 'binary'],
        ['o2', 'text'],
        ['o3', 'text'],
        ['stray', 'text'],
      ])
      // Re-adding a stored blob does not count its bytes twice.
      await store.putBlobs('A', [['o3', bytes(100)]])
      // Scope prefixes do not leak: `A` is not `AB`.
      await store.putBlobs('AB', [['o9', bytes(10)]])
      expect((await store.stored('A', ['o9'])).size).toBe(0)
      await store.putIndex('AB', rec('x', [['z', 'o9']]), 2)
      // Past the budget, the least recently used repo goes whole (never the one just stored).
      await new Promise((r) => setTimeout(r, 5))
      await store.putBlobs('B', [['p1', bytes(900)]])
      await store.putIndex('B', rec('u1', [['q', 'p1']]), 2)
      expect(await store.getIndex('A', 't3')).toBeUndefined()
      expect(await store.getIndex('B', 'u1')).toBeDefined()
      expect((await store.getBlobs('B', ['p1'])).get('p1')?.length).toBe(900)
    })
  }
})

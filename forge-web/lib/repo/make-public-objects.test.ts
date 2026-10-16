/**
 * The private era's code in the tab (dg's work repository): two fixture packs (one with a delta
 * across objects) opened into a store, the full-reachability walk (`git rev-list --objects`), the
 * widened secret scan over deleted history, and the fresh pack and its exact size.
 */

import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { gitOidHex, type GitObject } from '../browse'
import { indexPacks } from '../browse/indexer'
import { T_BLOB, T_OFS_DELTA, copyInsertDelta, objHeader, ofsBase, packFrame } from '../browse/pack-fixtures'
import { writePack } from '../merge/pack-writer'
import { serializeTree } from '../view/git-objects'
import { defaultCodeRefs } from './make-public'
import { MissingCodeError, buildPack, isAncestorIn, packSize, reachable, scanObjects, workStoreOf } from './make-public-objects'

const enc = new TextEncoder()
const obj = (type: GitObject['type'], bytes: Uint8Array): GitObject & { oid: string } => ({ type, bytes, oid: gitOidHex(type, bytes) })
const blob = (text: string) => obj('blob', enc.encode(text))
const tree = (entries: { mode: number; name: string; oid: string }[]) => obj('tree', serializeTree(entries))
const commit = (treeOid: string, parents: string[], when: number, msg: string) =>
  obj('commit', enc.encode(`tree ${treeOid}\n${parents.map((p) => `parent ${p}\n`).join('')}author A <a@example.invalid> ${when} +0000\ncommitter A <a@example.invalid> ${when} +0000\n\n${msg}\n`))
const tag = (target: string, name: string) => obj('tag', enc.encode(`object ${target}\ntype commit\ntag ${name}\ntagger A <a@example.invalid> 1 +0000\n\n${name}\n`))

const FILE = 0o100644
const DIR = 0o40000
const GITLINK = 0o160000

// main: c1 ← c3; a branch deleted while private: c1 ← c2 (with a .env); v1 (annotated) on c1
const b1 = blob('hello\n')
const t1 = tree([{ mode: FILE, name: 'README.md', oid: b1.oid }])
const c1 = commit(t1.oid, [], 100, 'one')
const b2 = blob('API_TOKEN=s3cr3t-value-here\n')
const t2 = tree([
  { mode: FILE, name: 'README.md', oid: b1.oid },
  { mode: FILE, name: '.env', oid: b2.oid },
])
const c2 = commit(t2.oid, [c1.oid], 200, 'a secret')
// b3 is stored as a delta of b1 in the second pack
const b3 = blob('hello\nmore\n')
const b4 = blob('x\n')
const t4 = tree([{ mode: FILE, name: 'file.txt', oid: b4.oid }])
const t3 = tree([
  { mode: FILE, name: 'README.md', oid: b3.oid },
  { mode: DIR, name: 'sub', oid: t4.oid },
  // a submodule: names a commit of another repository, never packed
  { mode: GITLINK, name: 'mod', oid: 'e'.repeat(40) },
])
const c3 = commit(t3.oid, [c1.oid], 300, 'three')
const v1 = tag(c1.oid, 'v1')

/** Pack one: every object but b3, stored whole. Pack two: b1 again, then b3 as an OFS delta on it. */
function fixturePacks(): Uint8Array[] {
  const one = writePack([b1, t1, c1, b2, t2, c2, b4, t4, t3, c3, v1]).bytes
  const base = new Uint8Array([...objHeader(T_BLOB, b1.bytes.length), ...zlibSync(b1.bytes)])
  const delta = copyInsertDelta(b1.bytes.length, b3.bytes.length, b1.bytes.length, enc.encode('more\n'))
  const deltaEntry = new Uint8Array([...objHeader(T_OFS_DELTA, delta.length), ...ofsBase(base.length), ...zlibSync(delta)])
  return [one, packFrame(base, deltaEntry)]
}

describe('the work store and the full-reachability walk', () => {
  it('reaches every commit, tree, blob and tag from the tips, deltas resolved, gitlinks skipped, each object with its first path', async () => {
    const store = await workStoreOf(fixturePacks(), 'o/r')
    expect(store.oids.has(b3.oid)).toBe(true)
    const r = await reachable(store, [c3.oid, v1.oid])
    // commits first, newest first, then each tree depth first
    expect([...r.keys()]).toEqual([v1.oid, c3.oid, c1.oid, t3.oid, b3.oid, t4.oid, b4.oid, t1.oid, b1.oid])
    expect(r.get(b4.oid)).toEqual({ type: 'blob', path: 'sub/file.txt' })
    expect(r.get(t3.oid)).toEqual({ type: 'tree', path: '' })
    expect(r.get(v1.oid)).toEqual({ type: 'tag', path: null })
    expect(r.has('e'.repeat(40))).toBe(false)
    // the deleted branch is not reachable from the live tips
    expect(r.has(c2.oid) || r.has(b2.oid)).toBe(false)
  })

  it('refuses an object the store lacks, or skips it for what is public already; and refuses past its cap', async () => {
    const store = await workStoreOf(fixturePacks(), 'o/r')
    await expect(reachable(store, ['f'.repeat(40)])).rejects.toThrow(MissingCodeError)
    const missing: string[] = []
    expect((await reachable(store, ['f'.repeat(40)], { skipMissing: true, onMissing: (o) => missing.push(o) })).size).toBe(0)
    expect(missing).toEqual(['f'.repeat(40)])
    // a tree whose blob is gone: the rest is walked, the blob told
    const holed = { ...store, oids: new Set([...store.oids].filter((o) => o !== b4.oid)) }
    const told: string[] = []
    const partial = await reachable(holed, [c3.oid], { skipMissing: true, onMissing: (o) => told.push(o) })
    expect(told).toEqual([b4.oid])
    expect(partial.has(t4.oid) && !partial.has(b4.oid)).toBe(true)
    await expect(reachable(holed, [c3.oid])).rejects.toThrow(MissingCodeError)
    await expect(reachable(store, [c3.oid], { cap: 3, label: 'carol/ledger' })).rejects.toThrow(/dg repo make-public carol\/ledger/)
    const empty = await workStoreOf([], 'o/r')
    await expect(reachable(empty, [c1.oid])).rejects.toThrow(MissingCodeError)
  })

  it("gives Code only's default: the default branch and the tags on it", async () => {
    const store = await workStoreOf(fixturePacks(), 'o/r')
    expect(await isAncestorIn(store, v1.oid, c3.oid)).toBe(true)
    expect(await isAncestorIn(store, c2.oid, c3.oid)).toBe(false)
    const all = [
      { name: 'refs/heads/main', oid: c3.oid },
      { name: 'refs/tags/off', oid: c2.oid },
      { name: 'refs/tags/v1', oid: v1.oid },
    ]
    expect((await defaultCodeRefs(all, 'refs/heads/main', (t, tip) => isAncestorIn(store, t, tip))).map((x) => x.name)).toEqual(['refs/heads/main', 'refs/tags/v1'])
  })
})

describe('the secret scan (dg scan_objects)', () => {
  it("reads deleted history only with Everything's widened scan, under the path its own commit gives it", async () => {
    const store = await workStoreOf(fixturePacks(), 'o/r')
    expect(await scanObjects(store, [c3.oid], false)).toEqual([])
    const every = await scanObjects(store, [c3.oid], true)
    const env = every.find((s) => s.place === '.env')
    expect(env).toMatchObject({ rule: 'env_file', refuses: true })
    expect(env?.fingerprint).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('the fresh public pack', () => {
  it('holds every object reachable from the tips, without what is public already; its size is known exactly beforehand', async () => {
    const store = await workStoreOf(fixturePacks(), 'o/r')
    const all = await reachable(store, [c3.oid])
    const size = await packSize(store, all.keys())
    const full = await buildPack(store, [c3.oid], [])
    expect(full?.bytes.length).toBe(size.bytes)
    expect(full?.objectCount).toBe(size.objects)
    expect(size.objects).toBe(8)
    const rows = await indexPacks([full?.bytes as Uint8Array])
    expect(new Set(rows.map((x) => x.oidHex))).toEqual(new Set(all.keys()))
    // c1 public already: its commit, tree and blob are not stored again
    const later = await buildPack(store, [c3.oid], [c1.oid])
    expect(new Set((await indexPacks([later?.bytes as Uint8Array])).map((x) => x.oidHex))).toEqual(new Set([c3.oid, t3.oid, b3.oid, t4.oid, b4.oid]))
    // nothing new: no pack
    expect(await buildPack(store, [c1.oid], [c3.oid])).toBeNull()
    expect(await packSize(store, [])).toEqual({ bytes: 0, objects: 0 })
  })
})

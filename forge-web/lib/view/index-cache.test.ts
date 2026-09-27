/** D-023: the persisted browse-index cache, over a real IndexedDB implementation. */

import 'fake-indexeddb/auto'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'

import { idbArtifactStore, loadIndexArtifact } from './index-cache'

const artifact = (n: number, size = 1000): { bytes: Uint8Array; hash: string } => {
  const bytes = new Uint8Array(size).fill(n)
  return { bytes, hash: bytesToHex(sha256(bytes)) }
}

let db = 0
/** A store over a fresh database, so tests do not share rows or budget. */
function freshStore(budget?: number): NonNullable<ReturnType<typeof idbArtifactStore>> {
  db += 1
  const store = idbArtifactStore(budget, `index-cache-test-${db}`)
  if (store === null) throw new Error('no IndexedDB')
  return store
}

describe('loadIndexArtifact over IndexedDB', () => {
  it('downloads once, then serves the verified copy', async () => {
    const store = freshStore()
    const a = artifact(1)
    const load = vi.fn(async () => a.bytes)
    expect(await loadIndexArtifact(`t${db}`, a.hash, load, store)).toEqual(a.bytes)
    await vi.waitFor(async () => expect(await store.get(`t${db}:${a.hash}`)).toBeDefined())
    expect(await loadIndexArtifact(`t${db}`, a.hash.toUpperCase(), load, store)).toEqual(a.bytes)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('never stores bytes that do not hash to the manifest, and drops a corrupt row', async () => {
    const store = freshStore()
    const a = artifact(2)
    const wrong = vi.fn(async () => new Uint8Array([9, 9, 9]))
    await loadIndexArtifact(`t${db}`, a.hash, wrong, store)
    await new Promise((r) => setTimeout(r, 20))
    expect(await store.get(`t${db}:${a.hash}`)).toBeUndefined()

    await store.put(`t${db}:${a.hash}`, new Uint8Array([1, 2, 3]))
    const good = vi.fn(async () => a.bytes)
    expect(await loadIndexArtifact(`t${db}`, a.hash, good, store)).toEqual(a.bytes)
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('evicts the least recently used past the budget, reading only sizes', async () => {
    const store = freshStore(2500)
    const scope = `t${db}`
    const [a, b, c] = [artifact(3), artifact(4), artifact(5)]
    await store.put(`${scope}:${a.hash}`, a.bytes)
    await new Promise((r) => setTimeout(r, 5))
    await store.put(`${scope}:${b.hash}`, b.bytes)
    await new Promise((r) => setTimeout(r, 5))
    // Reading `a` makes it the most recently used, so `b` goes when `c` pushes past 2,500 bytes.
    expect(await store.get(`${scope}:${a.hash}`)).toBeDefined()
    await new Promise((r) => setTimeout(r, 5))
    await store.put(`${scope}:${c.hash}`, c.bytes)
    expect(await store.get(`${scope}:${b.hash}`)).toBeUndefined()
    expect(await store.get(`${scope}:${a.hash}`)).toBeDefined()
    expect(await store.get(`${scope}:${c.hash}`)).toBeDefined()
  })
})

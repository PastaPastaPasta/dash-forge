/**
 * The About card's facts (F-5): worked out once per commit, published to subscribers, and the file
 * walk shared between the language bar and Go to file (one walk per tip, never a second).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The session-end listeners repo-facts registers, so a test can end a session. */
const sessionEnded = vi.hoisted((): ((id: string) => void)[] => [])
vi.mock('../repo/private-session', () => ({ onPrivateSessionEnded: (l: (id: string) => void) => (sessionEnded.push(l), () => undefined) }))

import { Store } from './diff-fixtures'
import { readTree } from './tree-nav'
import { loadRepoFacts, repoFacts, repoFactsLoading, repoFilesWalk, resetRepoFacts, subscribeRepoFacts, wantRepoFacts } from './repo-facts'

const MIT = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software\n\nThe above copyright notice and this permission notice shall be included in all copies'

function repo(): { s: Store; tip: string; root: string } {
  const s = new Store()
  const root = s.files({ LICENSE: MIT, 'src/main.rs': 'fn main() {}\n'.repeat(20), 'build.sh': '#!/bin/sh\n', 'README.md': '# x\n' })
  const tip = s.commit(root, [], 'one')
  return { s, tip, root }
}
const locateBy = (s: Store) => (oid: string) => {
  const o = s.objects.get(oid)
  return o ? { packRef: 0, offset: 0, length: o.bytes.length, deltaChainSpan: 0, deltaDepth: 0 } : null
}

beforeEach(() => {
  resetRepoFacts()
  // The About card is in view (the gate is tested on its own below).
  wantRepoFacts('r')
})

describe('loadRepoFacts', () => {
  it('publishes the license and the language bar for the tip, and tells subscribers', async () => {
    const { s, tip, root } = repo()
    const reader = s.reader(undefined, locateBy(s))
    let told = 0
    const off = subscribeRepoFacts(() => told++)
    expect(repoFacts('r', tip)).toEqual({ license: undefined, languages: undefined })
    await loadRepoFacts('r', tip, reader, root, await readTree(reader, root))
    off()
    const facts = repoFacts('r', tip)
    expect(facts.license).toEqual({ ids: ['MIT'], file: 'LICENSE' })
    expect(facts.languages?.languages.map((l) => l.name)).toEqual(['Rust', 'Shell'])
    expect(facts.languages?.truncated).toBe(false)
    // The load registering and ending, and each fact published.
    expect(told).toBe(4)
  })

  it('is worked out once per tip: a second load and Go to file read nothing more', async () => {
    const { s, tip, root } = repo()
    const reader = s.reader(undefined, locateBy(s))
    const entries = await readTree(reader, root)
    await loadRepoFacts('r', tip, reader, root, entries)
    const reads = s.reads.length
    await loadRepoFacts('r', tip, reader, root, entries)
    const files = await repoFilesWalk('r', tip, reader, root)
    expect(files.files.map((f) => f.path)).toEqual(['LICENSE', 'README.md', 'build.sh', 'src/main.rs'])
    expect(s.reads.length).toBe(reads)
  })

  it('a directory named license is not a license file', async () => {
    const s = new Store()
    const root = s.files({ 'license/README.md': 'the licenses we use\n', 'a.go': 'package a\n' })
    const tip = s.commit(root)
    const reader = s.reader(undefined, locateBy(s))
    await loadRepoFacts('r', tip, reader, root, await readTree(reader, root))
    expect(repoFacts('r', tip).license).toBeNull()
  })

  it('a failed walk leaves the languages unknown, and the next visit tries again', async () => {
    const { s, tip, root } = repo()
    const good = s.reader(undefined, locateBy(s))
    const entries = await readTree(good, root)
    let fail = true
    const flaky = { ...good, readObject: (oid: string) => (fail && oid !== root ? Promise.reject(new Error('offline')) : good.readObject(oid)) }
    await expect(loadRepoFacts('r', tip, flaky, root, entries)).rejects.toThrow('offline')
    expect(repoFacts('r', tip).languages).toBeUndefined()
    fail = false
    await loadRepoFacts('r', tip, flaky, root, entries)
    expect(repoFacts('r', tip).languages?.languages.map((l) => l.name)).toEqual(['Rust', 'Shell'])
  })

  it('a private repo’s facts and walk go when its session ends', async () => {
    const { s, tip, root } = repo()
    const reader = s.reader(undefined, locateBy(s))
    const key = 'repoId#session7'
    wantRepoFacts(key)
    wantRepoFacts('other#session8')
    await loadRepoFacts(key, tip, reader, root, await readTree(reader, root))
    await loadRepoFacts('other#session8', tip, reader, root, await readTree(reader, root))
    expect(repoFacts(key, tip).languages).toBeDefined()
    const reads = s.reads.length
    for (const l of sessionEnded) l('session7')
    expect(repoFacts(key, tip)).toEqual({ license: undefined, languages: undefined })
    expect(repoFacts('other#session8', tip).languages).toBeDefined()
    // The walk went too: asking again reads the trees again.
    await repoFilesWalk(key, tip, reader, root)
    expect(s.reads.length).toBeGreaterThan(reads)
  })

  it('the shared walk stops at its tree budget however few files it found (a push of empty trees)', async () => {
    const s = new Store()
    let tree = s.files({ 'leaf.rs': 'x' })
    for (let i = 0; i < 40; i++) tree = s.tree([{ name: `d${i}`, oid: tree, mode: 0o040000 }])
    const tip = s.commit(tree)
    const walk = await repoFilesWalk('r', tip, s.reader(undefined, locateBy(s)), tree, { maxTrees: 10 })
    expect(walk.truncated).toBe(true)
    expect(walk.files).toHaveLength(0)
  })

  it('Go to file reaches files under more than 300 directories', async () => {
    const s = new Store()
    const files: Record<string, string> = {}
    for (let i = 0; i < 320; i++) files[`d${String(i).padStart(3, '0')}/f.rs`] = String(i)
    const root = s.files(files)
    const tip = s.commit(root)
    const walk = await repoFilesWalk('r', tip, s.reader(undefined, locateBy(s)), root)
    expect(walk.files).toHaveLength(320)
    expect(walk.truncated).toBe(false)
  })

  it('a license file that cannot be read now stays unknown (tried again), only too large is not placed', async () => {
    const { s, tip, root } = repo()
    const good = s.reader(undefined, locateBy(s))
    const entries = await readTree(good, root)
    const licenseOid = entries.find((e) => e.name === 'LICENSE')?.oid
    let fail = true
    const flaky = { ...good, readObject: (oid: string, o?: { maxBytes?: number }) => (fail && oid === licenseOid ? Promise.reject(new Error('offline')) : good.readObject(oid, o)) }
    await expect(loadRepoFacts('r', tip, flaky, root, entries)).rejects.toThrow('offline')
    expect(repoFacts('r', tip).license).toBeUndefined()
    fail = false
    await loadRepoFacts('r', tip, flaky, root, entries)
    expect(repoFacts('r', tip).license).toEqual({ ids: ['MIT'], file: 'LICENSE' })
  })

  it('reads at most 8 license files at once', async () => {
    const s = new Store()
    const files: Record<string, string> = { 'a.go': 'package a\n' }
    for (let i = 0; i < 30; i++) files[`LICENSE-${i}`] = MIT
    const root = s.files(files)
    const tip = s.commit(root)
    const base = s.reader(undefined, locateBy(s))
    let inFlight = 0
    let most = 0
    const reader = {
      ...base,
      readObject: async (oid: string, o?: { maxBytes?: number }) => {
        inFlight++
        most = Math.max(most, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        try {
          return await base.readObject(oid, o)
        } finally {
          inFlight--
        }
      },
    }
    await loadRepoFacts('r', tip, reader, root, await readTree(base, root))
    expect(repoFacts('r', tip).license?.ids).toEqual(['MIT'])
    expect(most).toBeLessThanOrEqual(8)
  })

  it('reads at most 16 license files in all, however many the root names', async () => {
    const s = new Store()
    const files: Record<string, string> = {}
    // Distinct texts, so each file is its own blob and every read can be counted.
    for (let i = 0; i < 40; i++) files[`LICENSE-${String(i).padStart(2, '0')}`] = `${MIT}\nCopyright ${i}\n`
    const root = s.files(files)
    const tip = s.commit(root)
    const base = s.reader(undefined, locateBy(s))
    const entries = await readTree(base, root)
    const blobs = new Set(entries.map((e) => e.oid))
    const read = new Set<string>()
    const reader = {
      ...base,
      readObject: (oid: string, o?: { maxBytes?: number }) => {
        if (blobs.has(oid)) read.add(oid)
        return base.readObject(oid, o)
      },
    }
    await loadRepoFacts('r', tip, reader, root, entries)
    expect(repoFacts('r', tip).license?.ids).toEqual(['MIT'])
    expect(read.size).toBe(16)
  })

  it('no license file: null, not unknown', async () => {
    const s = new Store()
    const root = s.files({ 'a.go': 'package a\n' })
    const tip = s.commit(root)
    const reader = s.reader(undefined, locateBy(s))
    await loadRepoFacts('r', tip, reader, root, await readTree(reader, root))
    expect(repoFacts('r', tip).license).toBeNull()
  })
})

describe('the facts wait for the About card (S-1)', () => {
  it('reads nothing until the card is in view, then works the facts out', async () => {
    resetRepoFacts()
    const { s, tip, root } = repo()
    const reader = s.reader(undefined, locateBy(s))
    const entries = await readTree(reader, root)
    const before = s.reads.length
    let done = false
    const load = loadRepoFacts('r', tip, reader, root, entries).then(() => (done = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)
    expect(s.reads.length).toBe(before)
    wantRepoFacts('r')
    await load
    expect(repoFacts('r', tip).license).toEqual({ ids: ['MIT'], file: 'LICENSE' })
  })

  it('a home left before the card came into view stops waiting (its signal aborts)', async () => {
    resetRepoFacts()
    const { s, tip, root } = repo()
    const reader = s.reader(undefined, locateBy(s))
    const stop = new AbortController()
    const load = loadRepoFacts('r', tip, reader, root, await readTree(reader, root), stop.signal)
    stop.abort(new Error('left'))
    await expect(load).rejects.toThrow('left')
  })
})

describe('the About card placeholder shows only while a load is registered (review M2)', () => {
  it('no load (a deep link to a file, an empty repo): nothing loading, so no placeholder', () => {
    resetRepoFacts()
    const { tip } = repo()
    expect(repoFactsLoading('r', tip)).toBe(false)
    expect(repoFactsLoading('r', null)).toBe(false)
  })

  it('a load waiting for the card, and reading, is loading; done, it is not', async () => {
    resetRepoFacts()
    const { s, tip, root } = repo()
    const reader = s.reader(undefined, locateBy(s))
    const load = loadRepoFacts('r', tip, reader, root, await readTree(reader, root))
    expect(repoFactsLoading('r', tip)).toBe(true)
    wantRepoFacts('r')
    await load
    expect(repoFactsLoading('r', tip)).toBe(false)
  })

  it('a failed or abandoned load ends the placeholder', async () => {
    resetRepoFacts()
    const { s, tip, root } = repo()
    const reader = s.reader(undefined, locateBy(s))
    const stop = new AbortController()
    const load = loadRepoFacts('r', tip, reader, root, await readTree(reader, root), stop.signal)
    stop.abort(new Error('left'))
    await expect(load).rejects.toThrow('left')
    expect(repoFactsLoading('r', tip)).toBe(false)
    const flaky = { ...reader, readObject: () => Promise.reject(new Error('offline')) } as unknown as typeof reader
    wantRepoFacts('r')
    await expect(loadRepoFacts('r', tip, flaky, root, await readTree(reader, root))).rejects.toThrow('offline')
    expect(repoFactsLoading('r', tip)).toBe(false)
  })
})

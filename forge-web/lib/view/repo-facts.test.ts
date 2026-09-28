/**
 * The About card's facts (F-5): worked out once per commit, published to subscribers, and the file
 * walk shared between the language bar and Go to file (one walk per tip, never a second).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { Store } from './diff-fixtures'
import { readTree } from './tree-nav'
import { loadRepoFacts, repoFacts, repoFilesWalk, resetRepoFacts, subscribeRepoFacts } from './repo-facts'

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

beforeEach(() => resetRepoFacts())

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
    expect(facts.license).toEqual({ ids: ['MIT'], file: 'LICENSE', other: false })
    expect(facts.languages?.languages.map((l) => l.name)).toEqual(['Rust', 'Shell'])
    expect(facts.languages?.truncated).toBe(false)
    expect(told).toBe(2)
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

  it('no license file: null, not unknown', async () => {
    const s = new Store()
    const root = s.files({ 'a.go': 'package a\n' })
    const tip = s.commit(root)
    const reader = s.reader(undefined, locateBy(s))
    await loadRepoFacts('r', tip, reader, root, await readTree(reader, root))
    expect(repoFacts('r', tip).license).toBeNull()
  })
})

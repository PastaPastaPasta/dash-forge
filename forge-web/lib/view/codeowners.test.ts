import { beforeEach, describe, expect, it } from 'vitest'

import { decidingRules, ownersOf } from '../rules/codeowners'
import { changedPaths, clearCodeOwnersCache, readCodeOwners } from './codeowners'
import { Store } from './diff-fixtures'
import type { FileChange } from './commit-log'

beforeEach(clearCodeOwnersCache)

describe('readCodeOwners', () => {
  it('reads the first code owners file of the five places', async () => {
    const s = new Store()
    const tip = s.commit(s.files({ CODEOWNERS: '* @root\n', '.github/CODEOWNERS': '* @github\n', 'docs/CODEOWNERS': '* @docs\n' }))
    const file = await readCodeOwners(s.reader(), tip)
    expect(file?.path).toBe('.github/CODEOWNERS')
    expect(ownersOf(file!.owners, 'x')).toEqual(['@github'])
  })

  it('prefers .forge/ and falls back to .gitlab/', async () => {
    const s = new Store()
    const forge = s.commit(s.files({ '.forge/CODEOWNERS': '* @forge\n', '.github/CODEOWNERS': '* @github\n' }))
    expect((await readCodeOwners(s.reader(), forge))?.path).toBe('.forge/CODEOWNERS')
    const gitlab = s.commit(s.files({ '.gitlab/CODEOWNERS': '[Docs]\n*.md @docs\n' }))
    const file = await readCodeOwners(s.reader(), gitlab)
    expect(file?.path).toBe('.gitlab/CODEOWNERS')
    expect(ownersOf(file!.owners, 'a.md')).toEqual(['@docs'])
  })

  it('is null without a file, for a directory of that name, and for a binary file', async () => {
    const s = new Store()
    expect(await readCodeOwners(s.reader(), s.commit(s.files({ 'README.md': 'hi' })))).toBeNull()
    expect(await readCodeOwners(s.reader(), s.commit(s.files({ 'CODEOWNERS/x': '* @a' })))).toBeNull()
    const binary = s.commit(s.tree([{ name: 'CODEOWNERS', oid: s.blob(new Uint8Array([42, 0, 64])) }]))
    expect(await readCodeOwners(s.reader(), binary)).toBeNull()
  })

  it('reads a commit once', async () => {
    const s = new Store()
    const tip = s.commit(s.files({ CODEOWNERS: '* @a\n' }))
    await readCodeOwners(s.reader(), tip)
    const reads = s.reads.length
    await readCodeOwners(s.reader(), tip)
    expect(s.reads.length).toBe(reads)
  })
})

describe('changedPaths and decidingRules', () => {
  const change = (path: string, status: FileChange['status'], oldPath?: string): FileChange => ({
    path,
    status,
    baseOid: null,
    headOid: null,
    baseMode: null,
    headMode: null,
    oid: '',
    ...(oldPath !== undefined ? { oldPath } : {}),
  })

  it('counts a rename as its old and new path', () => {
    expect(changedPaths([change('b/new.txt', 'renamed', 'a/old.txt'), change('c', 'deleted'), change('c', 'modified')]).sort()).toEqual(['a/old.txt', 'b/new.txt', 'c'])
  })

  it('names the rule of each section that decides a path', async () => {
    const s = new Store()
    const tip = s.commit(s.files({ CODEOWNERS: '* @all\n*.md @docs\n[Backend]\n/src/ @be\n' }))
    const file = await readCodeOwners(s.reader(), tip)
    expect(decidingRules(file!.owners, 'src/a.md').map((r) => r.line)).toEqual([2, 4])
  })
})

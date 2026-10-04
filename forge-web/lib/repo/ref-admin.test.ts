/**
 * Branch and tag administration (P1-4): the pre-checks that refuse before signing what consensus
 * would (roles, protected refs) and what GitHub refuses (the default branch, a protected branch),
 * and the writes: a fresh read first, then one ref update and no pack.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RefState } from '../rules'

const writes: { refName: string; newOid: string; prevOid?: string; intent?: string }[] = []
let stateNow: RefState | null = null
/** The protected patterns the fresh config read answers. */
let patternsNow: string[] = []

vi.mock('./push', async (orig) => ({
  ...(await orig<typeof import('./push')>()),
  writeRefUpdate: vi.fn(async (_sdk: unknown, _auth: unknown, _repo: unknown, input: { refName: string; newOid: string; prevOid?: string }, options: { intent?: string }) => {
    writes.push({ ...input, ...(options.intent !== undefined ? { intent: options.intent } : {}) })
    expect((options as { protectedPatterns?: unknown }).protectedPatterns).toEqual(patternsNow)
    return { documentId: 'd', documentType: 'refUpdate' }
  }),
}))
vi.mock('./config', async (orig) => ({
  ...(await orig<typeof import('./config')>()),
  readConfigBundle: vi.fn(async () => ({ config: { protectedPatterns: patternsNow }, history: [] })),
}))
vi.mock('./refs', async (orig) => ({
  ...(await orig<typeof import('./refs')>()),
  resolveRefByHash: vi.fn(async () => (stateNow === null ? null : { refName: 'x', refNameHash: 'h', state: stateNow })),
}))

const { branchNameProblem, createBranch, deleteBranch, deleteBranchBlock, ensureTag, newTagNameProblem, refWriteBlock } = await import('./ref-admin')

const SDK = {} as never
const AUTH = { identityId: 'me' } as never
const REPO = { repoId: 'R', visibility: 'public' } as never
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const resolved = (oid: string): RefState => ({ state: 'resolved', oid, author: 'x', createdAt: 1 })

beforeEach(() => {
  writes.length = 0
  stateNow = null
  patternsNow = []
})
const M = { role: 'maintainer' as const }
const DEL = { defaultBranch: 'main', role: 'writer' as const }

describe('branch names', () => {
  it('takes the short names git takes, and says why not', () => {
    for (const ok of ['feature/x', 'fix-1', 'v2.0', 'dev']) expect(branchNameProblem(ok), ok).toBeNull()
    expect(branchNameProblem('')).toMatch(/needed/)
    expect(branchNameProblem('refs/heads/x')).toMatch(/short name/)
    expect(branchNameProblem('-x')).toMatch(/start with -/)
    expect(branchNameProblem('HEAD')).toMatch(/not a branch name/)
    for (const bad of ['a..b', 'a b', 'x.lock', 'x/', 'a~1', 'a:b', 'x+y', '.hidden', 'a@{b']) expect(branchNameProblem(bad), bad).toMatch(/not a valid/)
    expect(branchNameProblem('x'.repeat(250))).toMatch(/too long/)
  })

  it('takes the tag names a release takes', () => {
    expect(newTagNameProblem('v1.2.0')).toBeNull()
    expect(newTagNameProblem('-v1')).toMatch(/not a valid/)
    expect(newTagNameProblem('v 1')).toMatch(/not a valid/)
  })
})

describe('who may write a ref', () => {
  it('maintainers and writers; triage and readers are told their role; protected refs are a maintainer’s', () => {
    expect(refWriteBlock('maintainer', 'refs/heads/main', ['refs/heads/main'], 'create this branch')).toBeNull()
    expect(refWriteBlock('writer', 'refs/heads/x', ['refs/heads/main'], 'create this branch')).toBeNull()
    expect(refWriteBlock('writer', 'refs/heads/release/1', ['refs/heads/release/*'], 'create this branch')).toBe(
      'release/1 matches the protected pattern refs/heads/release/*: only maintainers can create this branch.',
    )
    expect(refWriteBlock('triage', 'refs/heads/x', [], 'create branches')).toMatch(/^Your role here is triage/)
    expect(refWriteBlock('reader', 'refs/heads/x', [], 'create branches')).toMatch(/^Your role here is reader/)
    expect(refWriteBlock(null, 'refs/heads/x', [], 'create branches')).toBe('Only maintainers and writers can create branches.')
  })

  it('never the default branch, never a protected one, never a diverged one', () => {
    const base = { defaultBranch: 'main', patterns: ['refs/heads/release/*'], role: 'maintainer' as const, state: 'resolved' as const }
    expect(deleteBranchBlock({ ...base, refName: 'refs/heads/main' })).toMatch(/default branch/)
    expect(deleteBranchBlock({ ...base, refName: 'refs/heads/release/1' })).toMatch(/protected \(refs\/heads\/release\/\*\)/)
    expect(deleteBranchBlock({ ...base, refName: 'refs/heads/x', state: 'diverged' })).toMatch(/diverged/)
    expect(deleteBranchBlock({ ...base, refName: 'refs/heads/x' })).toBeNull()
    expect(deleteBranchBlock({ ...base, refName: 'refs/heads/x', role: 'writer' })).toBeNull()
    expect(deleteBranchBlock({ ...base, refName: 'refs/heads/x', role: 'triage' })).toMatch(/triage/)
  })
})

describe('the writes', () => {
  it('creates a branch at the source tip, with no previous tip; refuses one that exists now', async () => {
    await createBranch(SDK, AUTH, REPO, { name: 'feature/x', target: A, intent: 'i', ...M })
    expect(writes).toEqual([{ refName: 'refs/heads/feature/x', newOid: A, intent: 'i' }])
    stateNow = resolved(B)
    await expect(createBranch(SDK, AUTH, REPO, { name: 'feature/x', target: A, ...M })).rejects.toThrow(/already exists \(at bbbbbbb\)/)
    expect(writes).toHaveLength(1)
  })

  it('creates a deleted branch again', async () => {
    stateNow = { state: 'unborn' }
    await createBranch(SDK, AUTH, REPO, { name: 'gone', target: A, ...M })
    expect(writes).toEqual([{ refName: 'refs/heads/gone', newOid: A }])
  })

  it('deletes from the tip the page showed: the null oid naming it; refuses a moved or gone branch', async () => {
    stateNow = resolved(A)
    await deleteBranch(SDK, AUTH, REPO, { refName: 'refs/heads/x', tip: A, ...DEL })
    expect(writes).toEqual([{ refName: 'refs/heads/x', newOid: '0'.repeat(40), prevOid: A }])
    stateNow = resolved(B)
    await expect(deleteBranch(SDK, AUTH, REPO, { refName: 'refs/heads/x', tip: A, ...DEL })).rejects.toThrow(/moved to bbbbbbb/)
    stateNow = { state: 'unborn' }
    await expect(deleteBranch(SDK, AUTH, REPO, { refName: 'refs/heads/x', tip: A, ...DEL })).rejects.toThrow(/already deleted/)
    stateNow = { state: 'diverged', heads: [] }
    await expect(deleteBranch(SDK, AUTH, REPO, { refName: 'refs/heads/x', tip: A, ...DEL })).rejects.toThrow(/diverged/)
    expect(writes).toHaveLength(1)
  })

  it('refuses against the patterns in force now, not the page’s, and restores over a lagging read', async () => {
    patternsNow = ['refs/heads/release/*']
    await expect(createBranch(SDK, AUTH, REPO, { name: 'release/2', target: A, role: 'writer' })).rejects.toThrow(/only maintainers can create this branch/)
    stateNow = resolved(A)
    await expect(deleteBranch(SDK, AUTH, REPO, { refName: 'refs/heads/release/1', tip: A, ...DEL })).rejects.toThrow(/protected/)
    expect(writes).toEqual([])
    // A node a block behind still shows the deleted branch at the tip being restored: no refusal.
    patternsNow = []
    await createBranch(SDK, AUTH, REPO, { name: 'feature/x', target: A, restoring: true, ...M })
    expect(writes).toEqual([{ refName: 'refs/heads/feature/x', newOid: A }])
    await expect(createBranch(SDK, AUTH, REPO, { name: 'feature/x', target: B, restoring: true, ...M })).rejects.toThrow(/already exists/)
  })

  it('creates a tag once: a retry finds it at the commit and writes nothing; another commit refuses', async () => {
    expect(await ensureTag(SDK, AUTH, REPO, { tag: 'v1.0.0', target: A, intent: 't' })).toBe(true)
    expect(writes).toEqual([{ refName: 'refs/tags/v1.0.0', newOid: A, intent: 't' }])
    stateNow = resolved(A)
    expect(await ensureTag(SDK, AUTH, REPO, { tag: 'v1.0.0', target: A })).toBe(false)
    stateNow = resolved(B)
    await expect(ensureTag(SDK, AUTH, REPO, { tag: 'v1.0.0', target: A })).rejects.toThrow(/already exists at bbbbbbb/)
    expect(writes).toHaveLength(1)
  })
})

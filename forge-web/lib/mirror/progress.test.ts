/**
 * The `/mirror` wizard's progress: what a changed answer invalidates, what a signed-in identity
 * resumes, and the ref fingerprint the wait step compares.
 */

import { describe, expect, it } from 'vitest'

import type { ResolvedRef } from '../repo/refs'
import { EMPTY_PROGRESS, refsFingerprint, resumed, withAnswer, type MirrorProgress } from './progress'
import type { GithubRepo } from './wizard'

const gh = (name: string): GithubRepo => ({ owner: 'alice', name, description: '', defaultBranch: 'main', sizeKib: 1, archived: false, fork: false, htmlUrl: '' })
const DONE: MirrorProgress = {
  github: gh('project'),
  repo: { repoId: 'R1', name: 'project' },
  storage: 'r2-main',
  runnerKey: { keyId: 6, budgetCredits: '1', expiresAt: 1, saved: true },
  refsBefore: '',
  workflowAdded: true,
  startedAt: 100,
  mirroredAt: 200,
}
const DOWNSTREAM = { refsBefore: null, workflowAdded: false, mirroredAt: null }

describe('withAnswer', () => {
  it('keeps everything when an answer is given again unchanged', () => {
    expect(withAnswer(DONE, { github: gh('project') })).toEqual(DONE)
    expect(withAnswer(DONE, { storage: 'r2-main', repo: { repoId: 'R1', name: 'project' } })).toEqual(DONE)
  })

  it('clears the Forge repository, workflow and wait for another GitHub repository', () => {
    expect(withAnswer(DONE, { github: gh('other') })).toEqual({ ...DONE, github: gh('other'), repo: null, ...DOWNSTREAM })
  })

  it('clears the workflow and the wait when the repository, storage or runner key changes', () => {
    expect(withAnswer(DONE, { repo: { repoId: 'R2', name: 'p2' } })).toEqual({ ...DONE, repo: { repoId: 'R2', name: 'p2' }, ...DOWNSTREAM })
    expect(withAnswer(DONE, { storage: 'platform' })).toEqual({ ...DONE, storage: 'platform', ...DOWNSTREAM })
    const key = { keyId: 7, budgetCredits: '1', expiresAt: 1, saved: true }
    expect(withAnswer(DONE, { runnerKey: key })).toEqual({ ...DONE, runnerKey: key, ...DOWNSTREAM })
  })

  it('keeps a baseline the patch states itself (a repository just created has no refs)', () => {
    expect(withAnswer(DONE, { repo: { repoId: 'R2', name: 'p2' }, refsBefore: '' })).toEqual({ ...DONE, repo: { repoId: 'R2', name: 'p2' }, ...DOWNSTREAM, refsBefore: '' })
  })

  it('does not clear anything for the later answers themselves', () => {
    const p = { ...DONE, workflowAdded: false, mirroredAt: null }
    expect(withAnswer(p, { workflowAdded: true })).toEqual({ ...p, workflowAdded: true })
    expect(withAnswer(DONE, { runnerKey: { ...DONE.runnerKey!, saved: true } })).toEqual(DONE)
  })
})

describe('resumed', () => {
  it("starts over for an identity with nothing saved, never carrying another identity's answers", () => {
    expect(resumed(DONE, null, 999)).toEqual({ ...EMPTY_PROGRESS, github: gh('project'), startedAt: 100 })
    expect(resumed(EMPTY_PROGRESS, null, 999)).toEqual({ ...EMPTY_PROGRESS, startedAt: 999 })
  })

  it('resumes the saved record, and a repository checked before signing in wins over it', () => {
    expect(resumed(EMPTY_PROGRESS, DONE, 999)).toBe(DONE)
    expect(resumed({ ...EMPTY_PROGRESS, github: gh('project') }, DONE, 999)).toEqual(DONE)
    expect(resumed({ ...EMPTY_PROGRESS, github: gh('other') }, DONE, 999)).toEqual({ ...DONE, github: gh('other'), repo: null, ...DOWNSTREAM })
  })
})

describe('refsFingerprint', () => {
  const ref = (refName: string, oid: string): ResolvedRef => ({ refName, refNameHash: '', state: { state: 'resolved', oid, author: 'a', createdAt: 0 } }) as ResolvedRef
  it('leaves out refs that are not resolved', () => {
    const unborn = { refName: 'refs/heads/x', refNameHash: '', state: { state: 'unborn' } } as ResolvedRef
    expect(refsFingerprint([unborn, ref('refs/heads/main', 'aa')])).toBe(refsFingerprint([ref('refs/heads/main', 'aa')]))
  })

  it('is the same whatever the order, and changes with any tip', () => {
    const a = refsFingerprint([ref('refs/heads/main', 'aa'), ref('refs/tags/v1', 'bb')])
    expect(refsFingerprint([ref('refs/tags/v1', 'bb'), ref('refs/heads/main', 'aa')])).toBe(a)
    expect(refsFingerprint([ref('refs/heads/main', 'ac'), ref('refs/tags/v1', 'bb')])).not.toBe(a)
    expect(refsFingerprint([])).toBe('')
  })
})

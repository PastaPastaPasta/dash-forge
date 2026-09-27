import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '../repo'
import type { WriteAuth } from '../sdk'
import { BranchStepError, BranchStopped, runBranchCommit, type BranchRunDeps } from './branch-runner'

const calls: string[] = []
const fail = new Set<string>()

vi.mock('../repo/push', () => ({
  writePackManifest: vi.fn(async (_s: unknown, _a: unknown, r: { repoId: string }) => {
    calls.push(`manifest:${r.repoId}`)
    if (fail.has('manifest')) throw new Error('manifest refused')
    return { documentId: 'M1', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
  }),
  writeRefUpdate: vi.fn(async (_s: unknown, _a: unknown, r: { repoId: string }, input: { refName: string; newOid: string; prevOid?: string }) => {
    calls.push(`ref:${r.repoId}:${input.refName}:${input.prevOid}->${input.newOid}`)
    if (fail.has('ref')) throw new Error('40120 not a writer of the fork')
    return { documentId: 'R1', confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null, documentType: 'refUpdate' }
  }),
}))

vi.mock('../repo', () => ({
  postTargetEvent: vi.fn(async (_s: unknown, _a: unknown, r: { repoId: string }, input: { kind: string; payload: { oidHex: string }; isMember: boolean }) => {
    calls.push(`event:${r.repoId}:${input.kind}:${input.payload.oidHex}:${input.isMember ? 'member' : 'author'}`)
    if (fail.has('head')) throw new Error('network dropped')
    return { documentId: 'E1', route: input.isMember ? 'event' : 'authorEvent' }
  }),
}))

const HEAD = 'aa'.repeat(20)
const NEW = 'bb'.repeat(20)
let tip: string | null = HEAD

function deps(extra: Partial<BranchRunDeps> = {}): BranchRunDeps {
  return {
    sdk: {} as EvoSDK,
    auth: { identityId: 'me', network: 'devnet', getSigningKeyWif: () => '' } as WriteAuth,
    repo: { repoId: 'BASE', visibility: 'public' } as RepoRef,
    source: { repoId: 'FORK', visibility: 'public' } as RepoRef,
    pull: { id: 'P', number: 3, author: 'me', headOid: HEAD, sourceRefName: 'refs/heads/feature' },
    isMember: false,
    built: { commit: NEW, pack: { bytes: new Uint8Array([1, 2, 3]), objectCount: 3, packHash: 'cc'.repeat(32) }, files: ['src/a.rs'] },
    upload: async () => {
      calls.push('upload')
      return { storage: 1, chunkCount: 0, uris: ['https://pub/p.pack'] }
    },
    publishIndex: async () => {
      calls.push('index')
      return 'packRef 1'
    },
    readBranchTip: async () => tip,
    intent: 'suggest:x',
    ...extra,
  }
}

beforeEach(() => {
  calls.length = 0
  fail.clear()
  tip = HEAD
})

describe('a commit to the PR branch', () => {
  it('stores the pack in the fork, moves the fork branch from the head, then the PR head (author route)', async () => {
    const run = await runBranchCommit(deps(), null, () => undefined)
    expect(calls).toEqual(['upload', 'manifest:FORK', 'index', `ref:FORK:refs/heads/feature:${HEAD}->${NEW}`, `event:BASE:headUpdate:${NEW}:author`])
    expect(run.done).toEqual(['upload', 'manifest', 'index', 'ref', 'head'])
  })

  it('stops, moving nothing, when the branch moved since the page read it', async () => {
    tip = 'dd'.repeat(20)
    await expect(runBranchCommit(deps(), null, () => undefined)).rejects.toThrow(BranchStopped)
    expect(calls.some((c) => c.startsWith('ref:'))).toBe(false)
  })

  it('resumes after the head update failed, without moving the branch twice', async () => {
    fail.add('head')
    let saved = null
    try {
      await runBranchCommit(deps(), null, () => undefined)
    } catch (e) {
      expect(e).toBeInstanceOf(BranchStepError)
      expect((e as Error).message).toMatch(/branch holds the new commit, but moving the PR head failed/)
      saved = (e as BranchStepError).run
    }
    fail.clear()
    calls.length = 0
    tip = NEW
    const run = await runBranchCommit(deps(), saved, () => undefined)
    expect(calls).toEqual([`event:BASE:headUpdate:${NEW}:author`])
    expect(run.done).toContain('head')
  })

  it('refuses private repos before anything is paid', async () => {
    await expect(runBranchCommit(deps({ source: { repoId: 'FORK', visibility: 'private' } as RepoRef }), null, () => undefined)).rejects.toThrow(/Private repositories/)
    expect(calls).toEqual([])
  })
})

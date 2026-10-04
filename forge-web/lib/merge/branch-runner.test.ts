import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '../repo'
import type { WriteAuth } from '../sdk'
import { BranchStepError, BranchStopped, runBranchCommit, runKeyedBranchCommit, type BranchRunDeps, type BranchRuns } from './branch-runner'
import type { BranchCommit } from './branch-commit'

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
    verifyPack: async () => [],
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
      // The step's own error travels with it (the page routes a budget refusal to its sheet).
      expect(((e as BranchStepError).failure as Error).message).toBe('network dropped')
      saved = (e as BranchStepError).run
    }
    fail.clear()
    calls.length = 0
    tip = NEW
    const run = await runBranchCommit(deps(), saved, () => undefined)
    expect(calls).toEqual([`event:BASE:headUpdate:${NEW}:author`])
    expect(run.done).toContain('head')
  })

  it('checks the pack against the PR head before anything is paid, and stops on a gap', async () => {
    const seen: string[] = []
    const verifyPack = async (_p: Uint8Array, commit: string, have: string): Promise<string[]> => {
      seen.push(`${commit}<-${have}`)
      return ['ee'.repeat(20)]
    }
    await expect(runBranchCommit(deps({ verifyPack }), null, () => undefined)).rejects.toThrow(/1 object unfetchable \(eeeeeeeee\); nothing was written/)
    expect(seen).toEqual([`${NEW}<-${HEAD}`])
    expect(calls).toEqual([])
    // A complete pack goes on; a resumed run past the upload does not check again.
    const ok = await runBranchCommit(deps({ verifyPack: async () => [] }), null, () => undefined)
    expect(ok.done).toEqual(['upload', 'manifest', 'index', 'ref', 'head'])
  })

  it('stops (not a retry loop) when the pack check itself cannot finish', async () => {
    const verifyPack = async (): Promise<string[]> => {
      throw new Error('the pack check stopped at its 200000-read limit')
    }
    await expect(runBranchCommit(deps({ verifyPack }), null, () => undefined)).rejects.toThrow(BranchStopped)
    await expect(runBranchCommit(deps({ verifyPack }), null, () => undefined)).rejects.toThrow(/could not be checked complete .*200000-read limit.*dg pr suggestion apply/)
    expect(calls).toEqual([])
  })

  it('resumes a failed action with the commit it built, and running another action keeps that run', async () => {
    const runs: BranchRuns = new Map()
    let builds = 0
    const build = (commit: string) => async (): Promise<BranchCommit> => {
      builds += 1
      return { ...deps().built, commit }
    }
    const withBuilt = (b: BranchCommit): BranchRunDeps => deps({ built: b })
    // "suggest" fails at the head update: its run is kept with its commit.
    fail.add('head')
    await expect(runKeyedBranchCommit(runs, 'suggest', build(NEW), withBuilt, () => undefined, () => undefined)).rejects.toThrow(BranchStepError)
    expect(runs.get('suggest')?.built.commit).toBe(NEW)
    // "update" runs meanwhile and stops (the branch moved): the suggest run is still there.
    fail.clear()
    tip = 'dd'.repeat(20)
    await expect(runKeyedBranchCommit(runs, 'update', build('ee'.repeat(20)), withBuilt, () => undefined, () => undefined)).rejects.toThrow(BranchStopped)
    expect(runs.has('update')).toBe(false)
    expect(runs.has('suggest')).toBe(true)
    // Retry "suggest": nothing is rebuilt, the branch is not moved again, the head update lands.
    tip = NEW
    calls.length = 0
    builds = 0
    const done = await runKeyedBranchCommit(runs, 'suggest', build('ff'.repeat(20)), withBuilt, () => undefined, () => undefined)
    expect(done.commit).toBe(NEW)
    expect(builds).toBe(0)
    expect(calls).toEqual([`event:BASE:headUpdate:${NEW}:author`])
    expect(runs.size).toBe(0)
  })

  it('refuses private repos before anything is paid', async () => {
    await expect(runBranchCommit(deps({ source: { repoId: 'FORK', visibility: 'private' } as RepoRef }), null, () => undefined)).rejects.toThrow(/Private repositories/)
    expect(calls).toEqual([])
  })
})

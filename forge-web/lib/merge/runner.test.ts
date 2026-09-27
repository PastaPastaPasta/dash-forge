import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepoRef } from '../repo'
import type { WriteAuth } from '../sdk'
import { failureMessage, MergeStepError, MergeStopped, newRun, runFor, runMergeSteps, type MergeRunDeps, type StepEvent } from './runner'

const calls: string[] = []
const fail = new Set<string>()

vi.mock('../repo/push', () => ({
  writePackManifest: vi.fn(async (_s: unknown, _a: unknown, _r: unknown, input: { packHash: string; storage: number; uris: readonly string[] }) => {
    calls.push(`manifest:${input.packHash}:${input.storage}:${input.uris.join(',')}`)
    if (fail.has('manifest')) throw new Error('manifest refused')
    return { documentId: 'M1', confirmed: true, cost: { credits: 0, dash: 0, tokenAmount: 0 }, actualCredits: null }
  }),
  writeRefUpdate: vi.fn(async (_s: unknown, _a: unknown, _r: unknown, input: { refName: string; newOid: string; prevOid?: string }, opts: { protectedPatterns?: readonly string[] }) => {
    calls.push(`ref:${input.refName}:${input.prevOid ?? '-'}->${input.newOid}:${opts.protectedPatterns === undefined ? 'fresh' : 'given'}`)
    if (fail.has('ref')) throw new Error('40120 not a maintainer')
    return { documentId: 'R1', confirmed: true, cost: { credits: 0, dash: 0, tokenAmount: 0 }, actualCredits: null, documentType: 'protectedRefUpdate' }
  }),
}))

vi.mock('../repo', () => ({
  addEvent: vi.fn(async (_s: unknown, _a: unknown, _r: unknown, input: { kind: string; oidHex: string }) => {
    calls.push(`event:${input.kind}:${input.oidHex}`)
    return { documentId: 'E1', confirmed: true, cost: { credits: 0, dash: 0, tokenAmount: 0 }, actualCredits: null }
  }),
}))

const BASE = 'aa'.repeat(20)
const HEAD = 'bb'.repeat(20)
const TIP = 'cc'.repeat(20)
const PACK = new Uint8Array([1, 2, 3])

function deps(extra: Partial<MergeRunDeps> = {}): MergeRunDeps {
  return {
    sdk: {} as EvoSDK,
    auth: { identityId: 'me', network: 'devnet', getSigningKeyWif: () => '' } as WriteAuth,
    repo: { repoId: 'R' } as RepoRef,
    pull: { id: 'P', number: 7, baseRefName: 'refs/heads/main' },
    input: { baseTip: BASE, headOid: HEAD, prNumber: 7, sourceLabel: 'refs/heads/fix', author: { name: 'n', email: 'e@x' }, headInBase: false },
    merge: async (_i, onPhase) => {
      calls.push('worker')
      onPhase('merge')
      onPhase('pack')
      return { kind: 'merge', newTip: TIP, pack: PACK, packHash: 'dd'.repeat(32), objectCount: 2 }
    },
    upload: async (bytes, info) => {
      calls.push(`upload:${bytes.length}:${info.objectCount}`)
      if (fail.has('upload')) throw new Error('403 from r2')
      return { storage: 1, chunkCount: 0, uris: ['https://pub/p.pack'] }
    },
    publishIndex: async (_p, h) => {
      calls.push(`index:${h}`)
      if (fail.has('index')) throw new Error('fragment upload 500')
      return 'packRef 3'
    },
    verifyPack: async () => {
      calls.push('verify')
      return fail.has('verify') ? ['ee'.repeat(20)] : []
    },
    readBaseTip: async () => {
      calls.push('tip')
      return fail.has('moved') ? 'ff'.repeat(20) : BASE
    },
    intent: 'merge:P:bb',
    ...extra,
  }
}

beforeEach(() => {
  calls.length = 0
  fail.clear()
})

describe('merge step runner', () => {
  it('runs every step in order and writes the pack, the protected ref and the merge event', async () => {
    const events: StepEvent[] = []
    const run = await runMergeSteps(deps(), newRun({ baseTip: BASE, headOid: HEAD }), (e) => events.push(e))
    expect(calls).toEqual([
      'worker',
      'verify',
      'upload:3:2',
      `manifest:${'dd'.repeat(32)}:1:https://pub/p.pack`,
      `index:${'dd'.repeat(32)}`,
      'tip',
      `ref:refs/heads/main:${BASE}->${TIP}:fresh`,
      `event:merge:${TIP}`,
    ])
    expect(run.done).toEqual(['fetch', 'merge', 'pack', 'upload', 'manifest', 'index', 'ref', 'event'])
    expect(events.filter((e) => e.state === 'done').map((e) => e.step)).toEqual(run.done)
  })

  it('names what exists when a later step fails, and a retry resumes there without repeating writes', async () => {
    fail.add('ref')
    let err: unknown
    try {
      await runMergeSteps(deps(), newRun({ baseTip: BASE, headOid: HEAD }), () => undefined)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(MergeStepError)
    const e = err as MergeStepError
    expect(e.step).toBe('ref')
    expect(e.message).toBe('Pack stored and manifest written; the ref update failed: 40120 not a maintainer. Retry ref update.')
    fail.clear()
    calls.length = 0
    const run = await runMergeSteps(deps(), e.run, () => undefined)
    expect(calls).toEqual(['tip', `ref:refs/heads/main:${BASE}->${TIP}:fresh`, `event:merge:${TIP}`])
    expect(run.eventId).toBe('E1')
  })

  it('a failed browse index is reported and skipped, never a failed merge', async () => {
    fail.add('index')
    const events: StepEvent[] = []
    const run = await runMergeSteps(deps(), newRun({ baseTip: BASE, headOid: HEAD }), (e) => events.push(e))
    expect(run.eventId).toBe('E1')
    expect(events.find((e) => e.step === 'index' && e.state === 'skipped')?.detail).toMatch(/fragment upload 500/)
  })

  it('says nothing was written when the upload fails', async () => {
    fail.add('upload')
    await expect(runMergeSteps(deps(), newRun({ baseTip: BASE, headOid: HEAD }), () => undefined)).rejects.toThrow('Nothing was written; the upload failed: 403 from r2. Retry upload.')
  })

  it('without an upload function stops at the upload step, having written nothing', async () => {
    await expect(runMergeSteps(deps({ upload: null }), newRun({ baseTip: BASE, headOid: HEAD }), () => undefined)).rejects.toThrow(/Nothing was written; the upload failed: .*dg pr merge/)
    expect(calls).toEqual(['worker', 'verify'])
  })

  it('skips the upload and manifest for a merge that adds no objects', async () => {
    const run = await runMergeSteps(
      deps({ merge: async () => ({ kind: 'fast-forward', newTip: HEAD, pack: new Uint8Array(32), packHash: 'ee'.repeat(32), objectCount: 0 }) }),
      newRun({ baseTip: BASE, headOid: HEAD }),
      () => undefined,
    )
    expect(calls).toEqual(['verify', 'tip', `ref:refs/heads/main:${BASE}->${HEAD}:fresh`, `event:merge:${HEAD}`])
    expect(run.done).toContain('upload')
  })

  it('stops, without retry, on conflicts', async () => {
    await expect(
      runMergeSteps(deps({ merge: async () => ({ kind: 'conflict', paths: ['a.txt'] }) }), newRun({ baseTip: BASE, headOid: HEAD }), () => undefined),
    ).rejects.toThrow(/both sides changed the same paths \(a\.txt\); merge with `dg pr merge`/)
  })

  it('never builds on a stale run: a changed base tip or head starts over, and a moved branch stops before the ref', async () => {
    fail.add('ref')
    let partial: MergeStepError | null = null
    try {
      await runMergeSteps(deps(), newRun({ baseTip: BASE, headOid: HEAD }), () => undefined)
    } catch (e) {
      partial = e as MergeStepError
    }
    expect(partial?.run.result?.newTip).toBe(TIP)
    // The page reloads with a new base tip: the old run is dropped, not resumed.
    const moved = 'ab'.repeat(20)
    expect(runFor(partial?.run ?? null, { baseTip: moved, headOid: HEAD }).done).toEqual([])
    expect(runFor(partial?.run ?? null, { baseTip: BASE, headOid: HEAD }).result?.newTip).toBe(TIP)
    // Resuming a run with inputs that changed underneath it is refused outright.
    await expect(runMergeSteps(deps({ input: { ...deps().input, baseTip: moved } }), partial!.run, () => undefined)).rejects.toBeInstanceOf(MergeStopped)
    // The branch moved on chain after the pack was built: stop before writing the ref.
    fail.clear()
    fail.add('moved')
    calls.length = 0
    await expect(runMergeSteps(deps(), partial!.run, () => undefined)).rejects.toThrow(/base branch moved/)
    expect(calls).toEqual(['tip'])
  })

  it('a pack that misses part of the closure stops the merge before anything is paid for', async () => {
    fail.add('verify')
    await expect(runMergeSteps(deps(), newRun({ baseTip: BASE, headOid: HEAD }), () => undefined)).rejects.toThrow(/unfetchable/)
    expect(calls).toEqual(['worker', 'verify'])
  })

  it('reports a worker failure against the phase it happened in', async () => {
    const d = deps({
      merge: async (_i, onPhase) => {
        onPhase('merge')
        throw new Error('the worker blew up')
      },
    })
    await expect(runMergeSteps(d, newRun({ baseTip: BASE, headOid: HEAD }), () => undefined)).rejects.toMatchObject({ step: 'merge' })
  })

  it('H2: refuses a base that is not a plain existing branch, or a bad head, before any work', async () => {
    for (const d of [
      deps({ pull: { id: 'P', number: 7, baseRefName: 'refs/tags/v1' } }),
      deps({ pull: { id: 'P', number: 7, baseRefName: 'refs/heads/a..b' } }),
      deps({ input: { ...deps().input, headOid: 'x'.repeat(40) } }),
    ]) {
      calls.length = 0
      await expect(runMergeSteps(d, newRun(d.input), () => undefined)).rejects.toBeInstanceOf(MergeStopped)
      expect(calls).toEqual([])
    }
  })

  it('phrases partial states', () => {
    expect(failureMessage({ ...newRun({ baseTip: BASE, headOid: HEAD }), done: ['fetch', 'merge', 'pack', 'upload'] }, 'manifest', 'x')).toBe('Pack stored; the pack manifest failed: x. Retry manifest.')
    expect(failureMessage({ ...newRun({ baseTip: BASE, headOid: HEAD }), done: ['upload', 'manifest', 'ref'] }, 'event', 'y')).toBe('Pack stored, manifest written and base branch moved; the merge event failed: y. Retry merge event.')
  })
})

/**
 * The RC1 client rules that have no shared vector yet: required checks pinned to a source
 * (R-08, `checksState`), a check run's `outcome` (O-07), and the write chokepoint's layout and
 * stamp check (`rc1WriteProblem`).
 */

import { describe, expect, it } from 'vitest'

import { rc1WriteProblem } from '../layout'
import { checkRunOutcome, checksState, type CheckRunRow } from './parity'
import { RoleOracle } from './v2'

const HEAD = 'ab'.repeat(20)
const RUNNER = 'runner-a'
const OTHER_RUNNER = 'runner-b'
const MAINT = 'maint'
const run = (id: string, name: string, reporter: string, conclusion: string, createdAt: number): CheckRunRow => ({
  id,
  headOid: HEAD,
  name,
  status: 'completed',
  conclusion,
  reporter,
  createdAt,
})
const oracle = new RoleOracle([{ identity: MAINT, role: 'maintainer', createdAt: 0 }])
const runners = new Set([RUNNER, OTHER_RUNNER])

describe('checksState with pinned sources (RC1 R-08)', () => {
  it('counts only the pinned source for a pinned check', () => {
    // The pinned runner failed; another trusted runner's newer success does not stand in for it.
    const runs = [run('1', 'build', RUNNER, 'failure', 1), run('2', 'build', OTHER_RUNNER, 'success', 2)]
    const pinned = checksState(runs, HEAD, oracle, runners, { requiredChecks: ['build'], requiredCheckSources: [RUNNER] })
    expect(pinned.required).toEqual([{ name: 'build', state: 'failing', runId: '1' }])
    expect(pinned.met).toBe(false)
    // Unpinned, the newest trusted run decides.
    expect(checksState(runs, HEAD, oracle, runners, { requiredChecks: ['build'] }).met).toBe(true)
  })

  it('a pinned check its source never reported is missing', () => {
    const runs = [run('1', 'lint', OTHER_RUNNER, 'success', 1)]
    const s = checksState(runs, HEAD, oracle, runners, { requiredChecks: ['build', 'lint'], requiredCheckSources: [RUNNER, MAINT] })
    expect(s.required.map((c) => [c.name, c.state])).toEqual([['build', 'missing'], ['lint', 'missing']])
  })

  it('ignores sources not paired one for one with the names (what the contract refuses)', () => {
    const runs = [run('1', 'build', OTHER_RUNNER, 'success', 1)]
    expect(checksState(runs, HEAD, oracle, runners, { requiredChecks: ['build', 'lint'], requiredCheckSources: [RUNNER] }).required[0]?.state).toBe('passed')
  })
})

describe('checkRunOutcome (RC1 O-07)', () => {
  it('0 until completed, 1 for a passing conclusion, 2 otherwise', () => {
    expect(checkRunOutcome('queued', null)).toBe(0)
    expect(checkRunOutcome('in_progress', null)).toBe(0)
    expect(['success', 'neutral', 'skipped'].map((c) => checkRunOutcome('completed', c))).toEqual([1, 1, 1])
    expect(['failure', 'cancelled', 'timed_out', 'action_required', 'stale'].map((c) => checkRunOutcome('completed', c))).toEqual([2, 2, 2, 2, 2])
  })
})

describe('rc1WriteProblem: the write chokepoint', () => {
  const forge = { core: 'CORE', collab: 'COLLAB', community: 'COMMUNITY', group: 'G' }

  it('refuses a type sent to the wrong contract, or to none', () => {
    expect(rc1WriteProblem(forge, 'COLLAB', 'event', { kind: 4 })).toMatch(/forge-community/)
    expect(rc1WriteProblem(forge, 'CORE', 'repoKey', {})).toMatch(/forge-collab/)
    expect(rc1WriteProblem(forge, 'CORE', 'manifestPart', {})).toMatch(/no Forge contract/)
    expect(rc1WriteProblem(forge, 'COMMUNITY', 'event', { kind: 4 })).toBeNull()
  })

  it('refuses a stamped type without its vis, and a public-only type stamped private', () => {
    expect(rc1WriteProblem(forge, 'COLLAB', 'issue', { number: 1 })).toMatch(/vis/)
    expect(rc1WriteProblem(forge, 'COLLAB', 'issue', { number: 1, vis: 'internal' })).toMatch(/vis/)
    expect(rc1WriteProblem(forge, 'COLLAB', 'issue', { number: 1, vis: 'private' })).toBeNull()
    expect(rc1WriteProblem(forge, 'CORE', 'topic', { name: 'x', vis: 'private' })).toMatch(/public/)
    expect(rc1WriteProblem(forge, 'CORE', 'label', { name: 'x' })).toBeNull()
  })

  it("judges nothing written to a contract that isn't Forge's (DPNS, the key exchange)", () => {
    expect(rc1WriteProblem(forge, 'DPNS', 'domain', {})).toBeNull()
    expect(rc1WriteProblem(null, 'CORE', 'issue', {})).toBeNull()
  })
})

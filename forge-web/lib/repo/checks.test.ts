import { describe, expect, it } from 'vitest'

import { checksPhrase, newestCheckRuns, summarizeChecks, untrustedWords } from './checks'

const doc = (id: string, name: string, owner: string, at: number, status: string, conclusion = '') => ({ $id: id, $ownerId: owner, $createdAt: at, name, status, conclusion })

describe('check runs on a head', () => {
  it('newest per name; a revoked reporter is listed, labelled, and not counted', () => {
    const runs = newestCheckRuns(
      [doc('1', 'build', 'm', 1, 'completed', 'failure'), doc('2', 'build', 'm', 2, 'completed', 'success'), doc('3', 'lint', 'gone', 3, 'completed', 'failure')],
      (who) => who === 'm',
    )
    expect(runs.map((r) => [r.name, r.conclusion, r.trusted])).toEqual([
      ['build', 'success', true],
      ['lint', 'failure', false],
    ])
    const s = summarizeChecks(runs, true)
    expect(s).toEqual({ passed: 1, failing: 0, pending: 0, total: 1, untrusted: 1, membersKnown: true })
    expect(checksPhrase(s)).toBe('1 passed (1 not counted: reporter no longer a member)')
  })

  it('says "unknown" rather than "no checks" when the members could not be read', () => {
    const runs = newestCheckRuns([doc('1', 'build', 'm', 1, 'completed', 'success')], () => false)
    const s = summarizeChecks(runs, false)
    expect(checksPhrase(s)).toBe("Couldn't read the members, so which checks count is unknown")
    expect(checksPhrase(summarizeChecks([], true))).toBe('No checks reported')
  })
})

describe('an uncounted run says why', () => {
  it('a revoked reporter only when the members are known; otherwise that they could not be read', () => {
    expect(untrustedWords({ membersKnown: true })).toBe('reporter is no longer a member: not counted')
    expect(untrustedWords({ membersKnown: false })).toBe('members could not be read: not counted until they are')
  })
})

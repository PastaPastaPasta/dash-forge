import { describe, expect, it } from 'vitest'

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { checksPhrase, fetchVerifiedLog, newestCheckRuns, runDuration, safeLogUrl, summarizeChecks, untrustedWords } from './checks'

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
    expect(checksPhrase(s)).toBe('1 passed (1 not counted: reporter no longer a member or runner)')
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
    expect(untrustedWords({ membersKnown: true })).toBe('reporter is no longer a member or runner: not counted')
    expect(untrustedWords({ membersKnown: false })).toBe('members could not be read: not counted until they are')
  })
})

describe("a run's log is checked against the SHA-256 it records", () => {
  const log = new TextEncoder().encode('step 1 ok\nstep 2 ok\n')
  const hash = bytesToHex(sha256(log))
  const serve = (body: Uint8Array) => (async () => new Response(body as BodyInit)) as unknown as typeof fetch

  it('verifies bytes that hash to logSha256, and flags bytes that do not', async () => {
    const good = await fetchVerifiedLog({ logUrl: 'https://logs.example/l.txt', logSha256: hash }, serve(log))
    expect(good).toMatchObject({ verified: true, bytes: log.length, text: 'step 1 ok\nstep 2 ok\n' })
    const bad = await fetchVerifiedLog({ logUrl: 'https://logs.example/l.txt', logSha256: hash }, serve(new TextEncoder().encode('tampered')))
    expect(bad.verified).toBe(false)
  })

  it('reads only https, or http on this machine', async () => {
    expect(safeLogUrl('https://x/y')).toBe('https://x/y')
    expect(safeLogUrl('http://127.0.0.1:9000/b/k')).toBe('http://127.0.0.1:9000/b/k')
    expect(safeLogUrl('http://evil.example/k')).toBeNull()
    expect(safeLogUrl('javascript:alert(1)')).toBeNull()
    await expect(fetchVerifiedLog({ logUrl: '', logSha256: hash }, serve(log))).rejects.toThrow(/no log/)
  })

  it("a runner's run carries its timings and log", () => {
    const [r] = newestCheckRuns(
      [{ $id: '1', $ownerId: 'runner', $createdAt: 1, name: 'ci', status: 'completed', conclusion: 'success', startedAt: 1000, completedAt: 66_000, logUrl: 'https://l', logSha256: new Uint8Array(32).fill(1) }],
      (who) => who === 'runner',
    )
    expect(r).toMatchObject({ trusted: true, logUrl: 'https://l', logSha256: '01'.repeat(32) })
    expect(runDuration(r!)).toBe('1m 5s')
    expect(runDuration({ startedAt: 0, completedAt: 5 })).toBe('')
  })
})

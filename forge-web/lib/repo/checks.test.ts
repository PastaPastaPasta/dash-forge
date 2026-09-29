import { describe, expect, it } from 'vitest'

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { LOG_MAX_BYTES, checksPhrase, fetchVerifiedLog, newestCheckRuns, runDuration, safeLogUrl, summarizeChecks, untrustedWords } from './checks'

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
    const good = await fetchVerifiedLog({ logUrl: 'https://logs.example/l.txt', logSha256: hash }, serve(log), 'forge.dashhq.org')
    expect(good).toMatchObject({ verified: true, bytes: log.length, text: 'step 1 ok\nstep 2 ok\n' })
    const bad = await fetchVerifiedLog({ logUrl: 'https://logs.example/l.txt', logSha256: hash }, serve(new TextEncoder().encode('tampered')), 'forge.dashhq.org')
    expect(bad.verified).toBe(false)
  })

  it('reads only https, or loopback http from a page on this machine', async () => {
    expect(safeLogUrl('https://x/y', 'forge.dashhq.org')).toBe('https://x/y')
    expect(safeLogUrl('http://127.0.0.1:9000/b/k', '127.0.0.1')).toBe('http://127.0.0.1:9000/b/k')
    expect(safeLogUrl('http://127.0.0.1:9000/b/k', 'forge.dashhq.org')).toBeNull()
    expect(safeLogUrl('http://evil.example/k', '127.0.0.1')).toBeNull()
    expect(safeLogUrl('javascript:alert(1)', '127.0.0.1')).toBeNull()
    await expect(fetchVerifiedLog({ logUrl: '', logSha256: hash }, serve(log), 'forge.dashhq.org')).rejects.toThrow(/no log/)
  })

  it('sends no credentials or referrer, and refuses more than 32 MiB up front or while streaming', async () => {
    let init: RequestInit | undefined
    const spy = (async (_: unknown, i?: RequestInit) => {
      init = i
      return new Response(log as BodyInit)
    }) as unknown as typeof fetch
    await fetchVerifiedLog({ logUrl: 'https://l/x', logSha256: hash }, spy, 'forge.dashhq.org')
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const declared = (async () => new Response('x', { headers: { 'content-length': String(LOG_MAX_BYTES + 1) } })) as unknown as typeof fetch
    await expect(fetchVerifiedLog({ logUrl: 'https://l/x', logSha256: hash }, declared, 'forge.dashhq.org')).rejects.toThrow(/32 MiB/)
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const endless = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            sent += 1
            c.enqueue(chunk)
          },
        }),
      )) as unknown as typeof fetch
    await expect(fetchVerifiedLog({ logUrl: 'https://l/x', logSha256: hash }, endless, 'forge.dashhq.org')).rejects.toThrow(/32 MiB/)
    expect(sent).toBeLessThan(40)
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

describe('the newest trusted run decides (parity: forge-core newest_check_runs / checks_state)', () => {
  it('a stranger\'s newer run never shadows a trusted one, and is shown only when nothing trusted exists', () => {
    const runs = newestCheckRuns(
      [doc('1', 'build', 'r', 1, 'completed', 'failure'), doc('2', 'build', 'stranger', 2, 'completed', 'success'), doc('3', 'lint', 'stranger', 3, 'completed', 'success')],
      (who) => who === 'r',
    )
    expect(runs.map((r) => [r.name, r.conclusion, r.trusted])).toEqual([
      ['build', 'failure', true],
      ['lint', 'success', false],
    ])
  })
})

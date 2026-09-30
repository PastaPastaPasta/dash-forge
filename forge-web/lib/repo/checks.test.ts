import { describe, expect, it } from 'vitest'

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { LOG_MAX_BYTES, checksPhrase, expectedChecks, fetchVerifiedLog, newestCheckRuns, requiredSources, runDuration, safeLogUrl, summarizeChecks, untrustedWords } from './checks'

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
    expect(s).toEqual({ passed: 1, failing: 0, pending: 0, total: 1, untrusted: 1, offSource: 0, membersKnown: true })
    expect(checksPhrase(s)).toBe('1 passed (1 not counted: reporter no longer a member or runner)')
  })

  it("reads a run's artifacts in the release-asset shape dg records", () => {
    const artifacts = JSON.stringify([
      { name: 'dist.zip', sha256: 'A'.repeat(64), sizeBytes: 248, uris: ['https://b.example/ci/packs/x.pack'] },
      { name: 'bad' },
    ])
    const [run] = newestCheckRuns([{ ...doc('1', 'ci / build', 'm', 1, 'completed', 'success'), artifacts }], () => true)
    expect(run?.artifacts).toEqual([{ name: 'dist.zip', sha256: 'a'.repeat(64), size: 248, uris: ['https://b.example/ci/packs/x.pack'] }])
    expect(newestCheckRuns([doc('2', 'lint', 'm', 1, 'queued')], () => true)[0]?.artifacts).toEqual([])
  })

  it('says "unknown" rather than "no checks" when the members could not be read', () => {
    const runs = newestCheckRuns([doc('1', 'build', 'm', 1, 'completed', 'success')], () => false)
    const s = summarizeChecks(runs, false)
    expect(checksPhrase(s)).toBe("Couldn't read the members, so which checks count is unknown")
    expect(checksPhrase(summarizeChecks([], true))).toBe('No checks reported')
  })
})

describe('required check sources (RC1 R-08)', () => {
  const policy = { requiredChecks: ['build', 'lint'], requiredCheckSources: ['ci', 'm'] }

  it('pairs each name with its source only when the lists pair one for one', () => {
    expect([...requiredSources(policy)]).toEqual([
      ['build', 'ci'],
      ['lint', 'm'],
    ])
    expect(requiredSources({ requiredChecks: ['build', 'lint'], requiredCheckSources: ['ci'] }).size).toBe(0)
    expect(requiredSources({ requiredChecks: ['build'] }).size).toBe(0)
    expect(requiredSources(null).size).toBe(0)
  })

  it("lists a pinned check's source run over a newer run by another member, which is marked and not counted", () => {
    const trusted = (who: string) => who === 'ci' || who === 'm' || who === 'w'
    const runs = newestCheckRuns(
      [
        doc('1', 'build', 'ci', 1, 'completed', 'failure'),
        doc('2', 'build', 'w', 2, 'completed', 'success'),
        doc('3', 'lint', 'w', 3, 'completed', 'success'),
        doc('4', 'test', 'w', 4, 'completed', 'success'),
      ],
      trusted,
      requiredSources(policy),
    )
    expect(runs.map((r) => [r.name, r.reporter, r.requiredSource, r.fromRequiredSource])).toEqual([
      // The source's own (failing) run decides build, as `checksState` counts it.
      ['build', 'ci', 'ci', true],
      // lint has no run from its source: the writer's is shown, not from the required source.
      ['lint', 'w', 'm', false],
      ['test', 'w', null, true],
    ])
    const s = summarizeChecks(runs, true)
    expect(s).toMatchObject({ passed: 1, failing: 1, total: 2, untrusted: 0, offSource: 1 })
    expect(checksPhrase(s)).toBe('1 passed, 1 failing (1 not from the required source)')
  })

  it('lists the required checks nothing reported yet, with their sources', () => {
    expect(expectedChecks([{ name: 'build' }], { ...policy, requiredChecks: ['build', 'lint'] })).toEqual([{ name: 'lint', source: 'm' }])
    expect(expectedChecks([], { requiredChecks: ['build'] })).toEqual([{ name: 'build', source: null }])
    expect(expectedChecks([], null)).toEqual([])
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

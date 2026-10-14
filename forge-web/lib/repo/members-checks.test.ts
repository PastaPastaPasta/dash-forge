/**
 * Check runs on members-only branches as a member reads them (`members-checks.ts`, private-repos.md
 * §19.9): an opaque-named run on a blind the session verified resolves to its real name by opening
 * its log; an outsider, a log moved to another run or commit, or bytes that fail their hash keep the
 * opaque name.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import { blind as blindOf } from '../private/blind'
import { bytesToHex } from '../private/bytes'
import { CheckKeys } from '../private/members-check'
import type { OpenContext } from '../private'
import { blindBook } from './members-blinds'
import { openMembersRun, resolveMembersRuns, type MembersRunInput } from './members-checks'

const SALT = new Uint8Array(32).fill(0x5a)
const OTHER_SALT = new Uint8Array(32).fill(0x6b)
const REAL = new Uint8Array(20).fill(0x0c)
const OTHER_REAL = new Uint8Array(20).fill(0x0d)
const HOST = 'forge.dashhq.org'

/** A fetch serving `logs` by URL; anything else is a 404. */
function serving(logs: Record<string, Uint8Array>): typeof fetch {
  return (async (url: string) => (url in logs ? new Response(logs[url] as BodyInit) : new Response(null, { status: 404 }))) as unknown as typeof fetch
}

/** A member session's context whose blinds hold `REAL` under `SALT`. */
async function memberCtx(): Promise<{ ctx: OpenContext; blind: string }> {
  const ctx = {} as OpenContext
  const b = (await blindOf(SALT, REAL)) as Uint8Array
  expect(await blindBook(ctx).learn(b, REAL, SALT)).toBe(true)
  return { ctx, blind: bytesToHex(b) }
}

/** The run `name` on `blind` (under `salt`, of `real`), its log sealed at `url`. */
async function sealedRun(id: string, name: string, blind: string, url: string, salt = SALT, real = REAL): Promise<{ run: MembersRunInput; sealed: Uint8Array }> {
  const keys = await CheckKeys.of(salt)
  const blindBytes = (await blindOf(salt, real)) as Uint8Array
  const sealed = await keys.sealLog(blindBytes, name, real, new TextEncoder().encode(`${name}: ok\n`))
  return { run: { id, name: await keys.opaqueName(name), headOid: blind, logUrl: url, logSha256: bytesToHex(sha256(sealed)) }, sealed }
}

describe('a members-only check run', () => {
  it('resolves to its real name and log for a member whose session verified the blind', async () => {
    const { ctx, blind } = await memberCtx()
    const { run, sealed } = await sealedRun('r1', 'ci / build', blind, 'https://logs.example/1')
    const got = await resolveMembersRuns(ctx, [run], serving({ 'https://logs.example/1': sealed }), HOST)
    expect(got.get('r1')).toEqual({ name: 'ci / build', log: 'ci / build: ok\n', bytes: sealed.length })
  })

  it('stays opaque for an outsider: no verified blind, nothing is fetched', async () => {
    const { blind } = await memberCtx()
    const { run, sealed } = await sealedRun('r1', 'ci / build', blind, 'https://logs.example/1')
    let fetched = 0
    const spy = (async (url: string) => {
      fetched += 1
      return serving({ 'https://logs.example/1': sealed })(url)
    }) as unknown as typeof fetch
    const got = await resolveMembersRuns({} as OpenContext, [run], spy, HOST)
    expect(got.size).toBe(0)
    expect(fetched).toBe(0)
  })

  it('leaves public runs alone: a plain name, or a run on a commit that is not a verified blind', async () => {
    const { ctx, blind } = await memberCtx()
    const plain: MembersRunInput = { id: 'p', name: 'build', headOid: blind, logUrl: 'https://logs.example/p', logSha256: 'aa'.repeat(32) }
    const onReal: MembersRunInput = { id: 'q', name: 'abcdefghijklmnop', headOid: bytesToHex(REAL), logUrl: 'https://logs.example/q', logSha256: 'aa'.repeat(32) }
    expect((await resolveMembersRuns(ctx, [plain, onReal], serving({}), HOST)).size).toBe(0)
  })

  it('is refused when its log was moved from another run or another commit', async () => {
    const { ctx, blind } = await memberCtx()
    const lint = await sealedRun('r2', 'lint', blind, 'https://logs.example/lint')
    const build = await sealedRun('r1', 'build', blind, 'https://logs.example/build')
    // build's run names lint's log (its hash too): the header's check does not hash to build's name
    const moved = { ...build.run, logUrl: lint.run.logUrl, logSha256: lint.run.logSha256 }
    // a log of another commit (its own blind and salt), recorded on this blind
    const other = await sealedRun('r3', 'build', bytesToHex((await blindOf(OTHER_SALT, OTHER_REAL)) as Uint8Array), 'https://logs.example/other', OTHER_SALT, OTHER_REAL)
    const elsewhere = { ...other.run, headOid: blind }
    const got = await resolveMembersRuns(ctx, [moved, elsewhere], serving({ 'https://logs.example/lint': lint.sealed, 'https://logs.example/other': other.sealed }), HOST)
    expect(got.get('r1')).toBeNull()
    expect(got.get('r3')).toBeNull()
  })

  it("is refused when the log's bytes do not hash to logSha256, or there is no log", async () => {
    const { blind } = await memberCtx()
    const { run, sealed } = await sealedRun('r1', 'build', blind, 'https://logs.example/1')
    const tampered = new Uint8Array(sealed)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1
    expect(await openMembersRun(run, SALT, serving({ 'https://logs.example/1': tampered }), HOST)).toBeNull()
    expect(await openMembersRun({ ...run, logSha256: bytesToHex(sha256(tampered)) }, SALT, serving({ 'https://logs.example/1': tampered }), HOST)).toBeNull()
    expect(await openMembersRun(run, SALT, serving({}), HOST)).toBeNull()
    expect(await openMembersRun({ ...run, logUrl: 'ipfs://bafy' }, SALT, serving({}), HOST)).toBeNull()
    expect(await openMembersRun(run, SALT, serving({ 'https://logs.example/1': sealed }), HOST)).toMatchObject({ name: 'build' })
  })

  it('reads again after a failure, and keeps an opened run for the session', async () => {
    const { ctx, blind } = await memberCtx()
    const { run, sealed } = await sealedRun('r1', 'build', blind, 'https://logs.example/1')
    let calls = 0
    let up = false
    const flaky = (async (url: string) => {
      calls += 1
      return up ? serving({ 'https://logs.example/1': sealed })(url) : new Response(null, { status: 503 })
    }) as unknown as typeof fetch
    expect((await resolveMembersRuns(ctx, [run], flaky, HOST)).get('r1')).toBeNull()
    up = true
    expect((await resolveMembersRuns(ctx, [run], flaky, HOST)).get('r1')?.name).toBe('build')
    expect((await resolveMembersRuns(ctx, [run], flaky, HOST)).get('r1')?.name).toBe('build')
    expect(calls).toBe(2)
  })
})

describe("a session's blinds keep their salts", () => {
  it('maps a real commit to its verified blinds, each with its salt', async () => {
    const { ctx, blind } = await memberCtx()
    const book = blindBook(ctx)
    expect(book.blindsOf(bytesToHex(REAL).toUpperCase())).toEqual([blind])
    expect(book.saltOf(blind.toUpperCase())).toEqual(SALT)
    expect(book.blindsOf(bytesToHex(OTHER_REAL))).toEqual([])
    expect(book.saltOf(bytesToHex(REAL))).toBeUndefined()
  })
})

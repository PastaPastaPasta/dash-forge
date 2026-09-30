/**
 * Start a test only while the devnet's quorum-key list is in step with the chain. A stopgap for
 * an infra fault: remove it once the quorum service keeps up
 * (https://github.com/PastaPastaPasta/dash-forge/issues/212).
 *
 * The app checks every proof against quorum keys it takes from ONE source, the devnet's quorum
 * list service (`quorums.<devnet>.networks.dash.org`; lib/sdk/service.ts). On bonsia that service
 * lists a new quorum about 50 s after DAPI does (measured 2026-09-30, at 5 s resolution: a quorum
 * based at core height H is on DAPI from H + 11, when its DKG commitment is mined, and on the
 * service from about H + 16). A new quorum comes every 24 core blocks, about every 4 minutes.
 * DAPI signs each block with one of its current quorums in turn, so in that window about one read
 * in four is signed by a quorum the app has no key for. It fails with "Quorum not found in
 * cache", the app reconnects, gets the same stale list, and backs off until the service
 * catches up. A test that starts in the window reads the outage, not the page: extra requests
 * past a budget, a 45 s wait that runs out, a "Partly verified" card.
 *
 * {@link quorumGuard} (a `beforeEach` of the specs that count a page's requests or assert its
 * Verification state, nothing else) polls in Node, so none of it counts in a page's requests,
 * until the service lists every quorum DAPI lists and the next new quorum is at least
 * {@link MARGIN_BLOCKS} away. This is a wait on a known infra outage, not a retry of a failure:
 * the test still fails on its own merits. It gives up waiting (and lets the test run) after
 * {@link MAX_WAIT_MS}, or at once when either source cannot be asked, and logs every wait.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { test } from '@playwright/test'

import { E2E_DEVNET } from './seed-summary'

/** Blocks between a quorum's base height and DAPI listing it (the DKG mining window; measured). */
const DKG_MINED_AFTER = 11
/**
 * Fewer blocks than this (about 10 s each) before the next quorum appears, and the test waits for
 * it to settle: most guarded tests run well within it ({@link quorumGuardLong} for those that
 * do not).
 */
const MARGIN_BLOCKS = 4
/** {@link quorumGuardLong}'s margin: for a test that runs a minute or more (still well inside the ~19 clean blocks after a rotation settles). */
const LONG_MARGIN_BLOCKS = 10
/** The longest a test waits: one quorum interval at bonsia's pace, past the lag plus the margin. */
const MAX_WAIT_MS = 4 * 60_000
const POLL_MS = 3_000
const ASK_MS = 6_000

interface Deployment {
  readonly quorumBaseUrl?: string
  readonly dapiAddresses: readonly string[]
}

const deployment = (): Deployment =>
  JSON.parse(readFileSync(join(resolve(__dirname, '../..'), `forge-contracts/deployments/devnet-${E2E_DEVNET}.json`), 'utf8')) as Deployment

function varint(b: Uint8Array, at: number): [number, number] {
  let v = 0
  let shift = 0
  for (;;) {
    const x = b[at++] as number
    v += (x & 0x7f) * 2 ** shift
    shift += 7
    if ((x & 0x80) === 0) return [v, at]
  }
}

/** Top-level protobuf fields: `[number, varint | bytes]`; fixed-width fields are skipped. */
function fields(b: Uint8Array): [number, number | Uint8Array][] {
  const out: [number, number | Uint8Array][] = []
  let at = 0
  while (at < b.length) {
    let key: number
    ;[key, at] = varint(b, at)
    const wire = key & 7
    if (wire === 0) {
      let v: number
      ;[v, at] = varint(b, at)
      out.push([key >>> 3, v])
    } else if (wire === 2) {
      let len: number
      ;[len, at] = varint(b, at)
      out.push([key >>> 3, b.subarray(at, at + len)])
      at += len
    } else if (wire === 1) at += 8
    else if (wire === 5) at += 4
    else break
  }
  return out
}

const bytesAt = (f: [number, number | Uint8Array][], n: number): Uint8Array | undefined => {
  const v = f.find(([k]) => k === n)?.[1]
  return v instanceof Uint8Array ? v : undefined
}
const intAt = (f: [number, number | Uint8Array][], n: number): number | undefined => {
  const v = f.find(([k]) => k === n)?.[1]
  return typeof v === 'number' ? v : undefined
}

/**
 * One DAPI node's current quorums (their base heights) and its core chain-locked height:
 * `GetCurrentQuorumsInfoResponse.v0` = validator_sets 3 (`core_height` 2), metadata 5
 * (`core_chain_locked_height` 2).
 */
async function dapiQuorums(address: string): Promise<{ heights: number[]; core: number }> {
  const res = await fetch(`${address.replace(/\/+$/, '')}/org.dash.platform.dapi.v0.Platform/getCurrentQuorumsInfo`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: new Uint8Array([0, 0, 0, 0, 2, 0x0a, 0x00]),
    signal: AbortSignal.timeout(ASK_MS),
  })
  const body = new Uint8Array(await res.arrayBuffer())
  const len = ((body[1] as number) << 24) | ((body[2] as number) << 16) | ((body[3] as number) << 8) | (body[4] as number)
  const v0 = bytesAt(fields(body.subarray(5, 5 + len)), 1)
  if (v0 === undefined) throw new Error('no v0 body')
  const top = fields(v0)
  const heights = top.filter(([n, v]) => n === 3 && v instanceof Uint8Array).map(([, v]) => intAt(fields(v as Uint8Array), 2) ?? 0)
  const core = intAt(fields(bytesAt(top, 5) ?? new Uint8Array()), 2) ?? 0
  if (heights.length === 0 || core === 0) throw new Error('no validator sets')
  return { heights, core }
}

async function serviceQuorums(base: string): Promise<number[]> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/quorums`, { signal: AbortSignal.timeout(ASK_MS) })
  const json = (await res.json()) as { data?: { height?: number }[] }
  return (json.data ?? []).map((q) => q.height ?? 0)
}

/** Why a test should not start yet, or null when it may. Null too when a source cannot be asked. */
export async function quorumWait(margin = MARGIN_BLOCKS, dep: Deployment = deployment()): Promise<string | null> {
  if (!dep.quorumBaseUrl || dep.dapiAddresses.length === 0) return null
  const addresses = [...dep.dapiAddresses].sort(() => Math.random() - 0.5).slice(0, 2)
  let chain: { heights: number[]; core: number } | null = null
  for (const a of addresses) {
    chain = await dapiQuorums(a).catch(() => null)
    if (chain !== null) break
  }
  const listed = await serviceQuorums(dep.quorumBaseUrl).catch(() => null)
  if (chain === null || listed === null || listed.length === 0) return null
  const missing = chain.heights.filter((h) => !listed.includes(h))
  if (missing.length > 0) return `the quorum service does not list DAPI's quorum ${missing.join(', ')} yet`
  // Quorums come at a fixed interval; the next one is listed once its commitment is mined.
  const sorted = [...chain.heights].sort((a, b) => b - a)
  const interval = sorted.length > 1 ? (sorted[0] as number) - (sorted[1] as number) : 0
  if (interval > 0) {
    const ahead = (sorted[0] as number) + interval + DKG_MINED_AFTER - chain.core
    if (ahead < margin) return `a new quorum is due in ${ahead} block(s)`
  }
  return null
}

/** Wait until {@link quorumWait} lets a test start (at most {@link MAX_WAIT_MS}); returns what was waited for. */
async function waitForQuorumsInSync(margin: number): Promise<string | null> {
  const started = Date.now()
  let first: string | null = null
  for (;;) {
    const why = await quorumWait(margin)
    if (why === null) return first === null ? null : `${first} (waited ${Math.round((Date.now() - started) / 1000)} s)`
    first ??= why
    if (Date.now() - started > MAX_WAIT_MS) return `${first} (gave up after ${Math.round(MAX_WAIT_MS / 1000)} s)`
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

/**
 * `test.beforeEach(quorumGuard)`: hold the test until {@link quorumWait} lets it start. The wait
 * is added to the test's timeout, and logged (and annotated on the test) whenever it happens. (A
 * `test.setTimeout` in the test's body counts from its start, the wait included.)
 */
export const quorumGuard = (): Promise<void> => guard(MARGIN_BLOCKS)
/** {@link quorumGuard} for a spec whose tests run a minute or more. */
export const quorumGuardLong = (): Promise<void> => guard(LONG_MARGIN_BLOCKS)

async function guard(margin: number): Promise<void> {
  const info = test.info()
  const timeout = info.timeout
  const started = Date.now()
  info.setTimeout(timeout + MAX_WAIT_MS + ASK_MS * 3)
  const waited = await waitForQuorumsInSync(margin)
  info.setTimeout(timeout + (Date.now() - started))
  if (waited === null) return
  info.annotations.push({ type: 'quorum-wait', description: waited })
  // eslint-disable-next-line no-console -- the run log says when and why a test was held (#212)
  console.log(`[e2e] quorum guard held "${info.title}": ${waited}`)
}

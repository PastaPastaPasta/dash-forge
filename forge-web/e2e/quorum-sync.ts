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
 * The opposite gap, seen on sakura (nightly 37119328376, 2026-10-03): the service follows the
 * core chain tip, so it drops the oldest quorum as soon as a new one is mined (its `/previous`
 * list trails the tip by only a few blocks), while every proof DAPI serves is still signed by the
 * quorum that signed Platform's LATEST block. On an idle devnet Platform makes a block only every
 * few minutes, so for as long as the dropped quorum signed the last one, EVERY read fails its
 * proof check: about four and a half minutes there, the whole time showing "Waiting for the
 * network's new quorum…", until the next block, signed by a listed quorum, ended it. DAPI's own
 * quorum list had moved on two minutes earlier; only a proof's signer shows it.
 *
 * {@link quorumGuard} (a `beforeEach` of the specs that count a page's requests, assert its
 * Verification state, or wait for a page's Platform content within a fixed time) polls in Node,
 * so none of it counts in a page's requests, until the service lists every quorum DAPI lists,
 * DAPI's proofs are signed by a quorum the service still lists, and the next new quorum is at
 * least {@link MARGIN_BLOCKS} away. This is a wait on a known infra outage, not a retry of a failure:
 * the test still fails on its own merits. It never fails a test itself: it lets the test run at
 * once when either source cannot be asked, after {@link MAX_WAIT_MS}, and for the rest of the run
 * once a wait has run out (the service is stuck, not lagging). It logs every wait.
 */

import { test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { decodeCurrentQuorumsInfo, grpcWebMessage, parseQuorumService, protoFields, QUORUMS_INFO_REQUEST } from '../lib/view/quorum-check'
import { E2E_DEVNET } from './seed-summary'

/** Core blocks between two quorums of the platform quorum type on bonsia (its DKG interval). */
const QUORUM_INTERVAL = 24
/** Blocks between a quorum's base height and DAPI listing it (its DKG commitment mined; measured). */
const DKG_MINED_AFTER = 11
/**
 * Fewer blocks than this (about 10 s each) before the next quorum appears, and the test waits for
 * it to settle: most guarded tests run well within it ({@link quorumGuardLong} for those that do
 * not).
 */
const MARGIN_BLOCKS = 4
/** {@link quorumGuardLong}'s margin, for tests that run a minute or more (still well inside the ~19 clean blocks after a rotation settles). */
const LONG_MARGIN_BLOCKS = 10
/**
 * The longest one test waits: past bonsia's lag plus the margin (one quorum interval, about 4
 * minutes), and past sakura's measured 4.5-minute wait for a block signed by a listed quorum.
 */
const MAX_WAIT_MS = 6 * 60_000
const POLL_MS = 3_000
const ASK_MS = 6_000

/** A wait ran out: the service is stuck rather than lagging, and later tests do not wait on it. */
let givenUp = false
/** How long the current test was held (a body's `test.setTimeout` adds it: {@link quorumHeldMs}). */
let heldMs = 0

interface Deployment {
  readonly quorumBaseUrl?: string
  readonly dapiAddresses: readonly string[]
}

const deployment = (): Deployment =>
  JSON.parse(readFileSync(join(resolve(__dirname, '../..'), `forge-contracts/deployments/devnet-${E2E_DEVNET}.json`), 'utf8')) as Deployment

/** One grpc-web call to a DAPI node: the response's message. */
async function dapiCall(address: string, method: string, body: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const res = await fetch(`${address.replace(/\/+$/, '')}/org.dash.platform.dapi.v0.Platform/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body,
    signal: AbortSignal.timeout(ASK_MS),
  })
  return grpcWebMessage(new Uint8Array(await res.arrayBuffer()))
}

/**
 * The grpc-web body of `GetEpochsInfoRequest{v0:{count:1, prove:true}}`: the cheapest proved read,
 * asked only for its proof's signer.
 */
const PROVED_EPOCH_REQUEST = new Uint8Array([0, 0, 0, 0, 6, 0x0a, 0x04, 0x10, 0x01, 0x20, 0x01])

/**
 * One DAPI node's current quorums (the app's own decoder), its core chain-locked height
 * (`GetCurrentQuorumsInfoResponse.v0.metadata`, field 5, `core_chain_locked_height` 2), and the
 * quorum that signs its proofs now, Platform's latest block's (`GetEpochsInfoResponse.v0.proof`,
 * field 2, `quorum_hash` 2), or null when the node sent no proof.
 */
async function dapiQuorums(address: string): Promise<{ hashes: string[]; heights: number[]; core: number; signer: string | null }> {
  const message = await dapiCall(address, 'getCurrentQuorumsInfo', QUORUMS_INFO_REQUEST)
  const keys = decodeCurrentQuorumsInfo(message)
  const v0 = protoFields(message).find((f) => f.no === 1)?.bytes
  const metadata = v0 === undefined ? undefined : protoFields(v0).find((f) => f.no === 5)?.bytes
  const core = metadata === undefined ? 0 : protoFields(metadata).find((f) => f.no === 2)?.int ?? 0
  if (keys.length === 0 || core === 0) throw new Error('no validator sets')
  const signer = await proofSigner(address).catch(() => null)
  return { hashes: keys.map((k) => k.hash), heights: keys.map((k) => k.height), core, signer }
}

async function proofSigner(address: string): Promise<string | null> {
  const v0 = protoFields(await dapiCall(address, 'getEpochsInfo', PROVED_EPOCH_REQUEST)).find((f) => f.no === 1)?.bytes
  const proof = v0 === undefined ? undefined : protoFields(v0).find((f) => f.no === 2)?.bytes
  const signed = proof === undefined ? undefined : protoFields(proof).find((f) => f.no === 2)?.bytes
  return signed === undefined || signed.length !== 32 ? null : Buffer.from(signed).toString('hex')
}

async function serviceQuorums(base: string): Promise<string[]> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/quorums`, { signal: AbortSignal.timeout(ASK_MS) })
  return parseQuorumService(await res.json()).map((q) => q.hash)
}

/** Why a test should not start yet, or null when it may (null too when a source cannot be asked). */
async function quorumWait(margin: number, dep: Deployment): Promise<string | null> {
  if (!dep.quorumBaseUrl || dep.dapiAddresses.length === 0) return null
  let chain: Awaited<ReturnType<typeof dapiQuorums>> | null = null
  for (const address of [...dep.dapiAddresses].sort(() => Math.random() - 0.5).slice(0, 2)) {
    chain = await dapiQuorums(address).catch(() => null)
    if (chain !== null) break
  }
  const listed = await serviceQuorums(dep.quorumBaseUrl).catch(() => null)
  if (chain === null || listed === null || listed.length === 0) return null
  const { hashes, heights, core, signer } = chain
  const missing = heights.filter((_, i) => !listed.includes(hashes[i] as string))
  if (missing.length > 0) return `the quorum service does not list DAPI's quorum ${missing.join(', ')} yet`
  // Not `/previous` too, though the SDK reads it: it trails the tip by a minute at most, so a
  // signer only it still lists is gone from it before an idle Platform's next block.
  if (signer !== null && !listed.includes(signer)) {
    return `DAPI's proofs are still signed by quorum ${signer.slice(0, 12)}…, which the quorum service no longer lists (no Platform block since the rotation)`
  }
  // The next quorum is listed once its commitment is mined. One already late (a slow or failed
  // DKG: `ahead` below 0) is not about to appear on a schedule, so it holds nothing.
  const ahead = Math.max(...heights) + QUORUM_INTERVAL + DKG_MINED_AFTER - core
  if (ahead >= 0 && ahead < margin) return `a new quorum is due in ${ahead} block(s)`
  return null
}

/** Wait until {@link quorumWait} lets a test start; what was waited for, or null. */
async function waitForQuorumsInSync(margin: number): Promise<string | null> {
  const dep = deployment()
  const started = Date.now()
  let first: string | null = null
  for (;;) {
    const why = await quorumWait(margin, dep)
    const secs = Math.round((Date.now() - started) / 1000)
    if (why === null) return first === null ? null : `${first} (held ${secs} s)`
    first ??= why
    if (Date.now() - started > MAX_WAIT_MS) {
      givenUp = true
      return `${first} (gave up after ${secs} s; no more waits this run)`
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

/**
 * `test.beforeEach(quorumGuard)`: hold the test until the quorum list is in step (see the module
 * comment). The time held is added to the test's timeout (a disabled timeout stays disabled), and
 * logged and annotated on the test whenever it happens. A test whose body sets its own timeout
 * adds {@link quorumHeldMs} to it: `test.setTimeout` counts from the start, the hold included.
 */
export const quorumGuard = (): Promise<void> => guard(MARGIN_BLOCKS)
/** {@link quorumGuard} for a spec whose tests run a minute or more. */
export const quorumGuardLong = (): Promise<void> => guard(LONG_MARGIN_BLOCKS)

/** How long {@link quorumGuard} held the current test. */
export const quorumHeldMs = (): number => heldMs

async function guard(margin: number): Promise<void> {
  heldMs = 0
  if (givenUp) return
  const info = test.info()
  const timeout = info.timeout
  const started = Date.now()
  if (timeout > 0) info.setTimeout(timeout + MAX_WAIT_MS + POLL_MS + ASK_MS * 3)
  const waited = await waitForQuorumsInSync(margin)
  heldMs = Date.now() - started
  if (timeout > 0) info.setTimeout(timeout + heldMs)
  if (waited === null) return
  info.annotations.push({ type: 'quorum-wait', description: waited })
  // eslint-disable-next-line no-console -- the run log says when and why a test was held (#212)
  console.log(`[e2e] quorum guard held "${info.title}": ${waited}`)
}

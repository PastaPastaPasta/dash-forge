/**
 * Live writes on devnet moutai through the web engine, on the pinned wasm-sdk (4.2.0-beta.6,
 * vendored: docs/dev/sdk-vendoring.md) — SKIPPED by default (network, WASM, ~0.01 DASH).
 *
 * Run with two identities minted for the run (never the shared fixtures):
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=moutai \
 *     E2E_SDK_WRITER=<identity.json> E2E_SDK_OTHER=<identity.json> \
 *     pnpm exec vitest run lib/repo/sdk-beta6.live.test.ts
 *
 * WRITER creates a throwaway repo, opens an issue and comments on it; the thread reads back
 * through the page's own loader. Then two refusals, each checked against the identity's balance
 * (read until it moves, as the engine's `balanceAfter` does, after a settled read before):
 * - WRITER edits the issue title past the contract's limits: a replace the node refuses at the
 *   broadcast check. From beta.6 that refusal carries its code on a `Protocol` error
 *   (platform#5112); it must read as not charged, and the balance must not move;
 * - OTHER (no member) labels the issue: forge-collab's membership gate refuses it (40120). The
 *   charge the engine reports must match what the balance did.
 *
 * Never gates CI.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseIdentityFileText } from '../auth'
import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { ConsensusRefusal, GATE_REFUSED_CODE, evoSdkService, type WriteAuth } from '../sdk'
import { loadIssueThread } from '../view'
import type { RepoRef } from './contract'
import { updateTarget } from './review-writes'
import { addEvent, createComment, createIssue, createRepo } from './writes'

const WRITER_FILE = process.env['E2E_SDK_WRITER'] ?? ''
const OTHER_FILE = process.env['E2E_SDK_OTHER'] ?? ''
const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet' && WRITER_FILE !== '' && OTHER_FILE !== ''

/** The balance once it has settled: re-read until two reads a second apart agree (at most ~10 s). */
async function settledBalance(read: () => Promise<bigint | undefined>): Promise<bigint | undefined> {
  let last = await read().catch(() => undefined)
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const now = await read().catch(() => undefined)
    if (now !== undefined && now === last) return now
    last = now
  }
  return last
}

/** A balance read until it moves off `before`, like the engine's `balanceAfter` (8 reads, 1 s apart). */
async function balanceAfter(read: () => Promise<bigint | undefined>, before: bigint | undefined): Promise<bigint | undefined> {
  let now: bigint | undefined
  for (let i = 0; i < 8; i++) {
    now = await read().catch(() => undefined)
    if (now !== undefined && now !== before) return now
    await new Promise((r) => setTimeout(r, 1000))
  }
  return now
}

function authOf(file: string): WriteAuth {
  const parsed = parseIdentityFileText(readFileSync(file, 'utf8'))
  return { identityId: parsed.identityId, network: 'devnet', getSigningKeyWif: () => parsed.signingKeyWif }
}

describe.skipIf(!LIVE)('live writes on wasm-sdk 4.2.0-beta.6 (moutai)', () => {
  it(
    'creates a repo, an issue and a comment, and reads a gate refusal with its code',
    async () => {
      const forge = NETWORKS.devnet.v2
      if (forge === null) throw new Error('no forge-v2 deployment for the devnet')
      await evoSdkService.initialize({ network: 'devnet', contractIds: [forge.core, forge.collab], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const version = (sdk as unknown as { version(): number }).version()
      expect(version).toBe(14)

      const [WRITER, OTHER] = [authOf(WRITER_FILE), authOf(OTHER_FILE)]
      const name = `sdk-b6-${Date.now().toString(36)}`
      const created = await createRepo(sdk, WRITER, forge, { name, description: 'wasm-sdk 4.2.0-beta.6 live smoke' })
      const repo: RepoRef = { forge, repoId: created.repoId, ownerId: WRITER.identityId, name, visibility: 'public' }

      const issue = await createIssue(sdk, WRITER, repo, { title: `beta.6 smoke ${name}`, body: 'Written by the web engine on the vendored SDK.' })
      expect(issue.confirmed).toBe(true)
      expect(issue.number).toBe(1)
      const comment = await createComment(sdk, WRITER, repo, { targetId: issue.documentId, body: 'A comment on the vendored SDK.' })
      expect(comment.confirmed).toBe(true)

      const thread = await loadIssueThread(sdk, repo, issue.number, 'devnet')
      expect(thread?.issue.title).toBe(`beta.6 smoke ${name}`)
      const comments = thread?.timeline.filter((t) => t.kind === 'comment') ?? []
      expect(comments.map((c) => (c.kind === 'comment' ? c.comment.body : ''))).toContain('A comment on the vendored SDK.')

      const identities = (sdk as unknown as { identities: { balance(id: string): Promise<bigint | undefined> } }).identities
      const balanceOf = (id: string) => () => identities.balance(id)

      // A replace refused at the broadcast check: coded, not charged, the balance unchanged.
      const writerBefore = await settledBalance(balanceOf(WRITER.identityId))
      const tooLong = await updateTarget(sdk, WRITER, repo, { type: 'issue', id: issue.documentId, title: 'x'.repeat(2000) }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(tooLong).toBeInstanceOf(ConsensusRefusal)
      const t = tooLong as ConsensusRefusal
      expect(t.code, t.message).toBeGreaterThan(10000)
      expect(t.feeCharged, t.message).toBe(false)
      const writerAfter = await balanceAfter(balanceOf(WRITER.identityId), writerBefore)
      expect(writerAfter, `balance ${writerBefore} → ${writerAfter}: ${t.message}`).toBe(writerBefore)

      // A gate refusal: what the engine reports must match what the balance did.
      const before = await settledBalance(balanceOf(OTHER.identityId))
      const refusal = await addEvent(sdk, OTHER, repo, { target: { id: issue.documentId, number: issue.number }, kind: 'labelAdd', value: 'triaged' }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(refusal).toBeInstanceOf(ConsensusRefusal)
      const r = refusal as ConsensusRefusal
      expect(r.code, r.message).toBe(GATE_REFUSED_CODE)
      const after = await balanceAfter(balanceOf(OTHER.identityId), before)
      const paid = before !== undefined && after !== undefined && after < before
      expect(r.feeCharged, `balance ${before} → ${after}: ${r.message}`).toBe(paid)
      // eslint-disable-next-line no-console
      console.log(
        `sdk-b6 live: repo ${repo.repoId} (${name}), issue #${issue.number} ${issue.documentId}, comment ${comment.documentId}; ` +
          `replace refusal ${t.code} charged=${t.charged} (${writerBefore} → ${writerAfter}); gate refusal ${r.code} charged=${r.charged} paid=${paid} (${before} → ${after})`,
      )
    },
    600_000,
  )
})

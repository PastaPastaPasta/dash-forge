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
 * through the page's own loader. OTHER (no member) then labels the issue: forge-collab's
 * membership gate refuses it (40120), and that refusal must come back as the node's code with
 * the right charge. beta.6 carries the code on a refusal at the broadcast check too
 * (platform#5112), which an older decoder read as a block's verdict and so as charged.
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
import { addEvent, createComment, createIssue, createRepo } from './writes'

const WRITER_FILE = process.env['E2E_SDK_WRITER'] ?? ''
const OTHER_FILE = process.env['E2E_SDK_OTHER'] ?? ''
const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet' && WRITER_FILE !== '' && OTHER_FILE !== ''

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
      const before = await identities.balance(OTHER.identityId)
      const refusal = await addEvent(sdk, OTHER, repo, { target: { id: issue.documentId, number: issue.number }, kind: 'labelAdd', value: 'triaged' }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(refusal).toBeInstanceOf(ConsensusRefusal)
      const r = refusal as ConsensusRefusal
      expect(r.code, r.message).toBe(GATE_REFUSED_CODE)
      const after = await identities.balance(OTHER.identityId)
      // Whatever path it took, what the engine reports must match the balance.
      const paid = before !== undefined && after !== undefined && after < before
      expect(r.feeCharged, `balance ${before} → ${after}: ${r.message}`).toBe(paid)
      // eslint-disable-next-line no-console
      console.log(`sdk-b6 live: repo ${repo.repoId} (${name}), issue #${issue.number} ${issue.documentId}, comment ${comment.documentId}; refusal ${r.code} charged=${r.charged} paid=${paid} (${before} → ${after})`)
    },
    600_000,
  )
})

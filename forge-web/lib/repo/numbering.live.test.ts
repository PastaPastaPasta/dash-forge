/**
 * Live dense numbering and transitions on devnet moutai, fresh beta.7 registration only
 * (forge-v2.md §6, STATE-COUNTS §2–§4) — SKIPPED by default (network, WASM, about 0.01 DASH).
 * WIPE-PLAN §3 step 9 runs it once the three contracts are registered.
 *
 * Run with:
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=moutai \
 *     E2E_NUMBERING_OWNER=<identity.json> E2E_NUMBERING_STRANGER=<identity.json> \
 *     pnpm exec vitest run lib/repo/numbering.live.test.ts
 *
 * A throwaway repo (never a fixture):
 * 1. OWNER opens an issue (#1), STRANGER a PR (#2), OWNER an issue (#3): one sequence.
 * 2. A number that is not the dense next one is refused by the `dense` rule (10422).
 * 3. STRANGER closes and reopens their own PR as its author; a second close in a row is
 *    refused by `c1_closedAfter`. OWNER (maintainer) merges it; a reopen is refused.
 * 4. The proved counts read issues 2 open, PR 1 merged, from three requests.
 *
 * Never gates CI.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { decodeIdentifier } from '../auth/base58'
import { parseIdentityFileText } from '../auth'
import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { ConsensusRefusal, createDocumentIdempotent, evoSdkService, type WriteAuth } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { readRepoCounts } from './transitions'
import { createIssue, createPatch, createRepo, setTargetState } from './writes'

const OWNER_FILE = process.env['E2E_NUMBERING_OWNER'] ?? ''
const STRANGER_FILE = process.env['E2E_NUMBERING_STRANGER'] ?? ''
const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet' && OWNER_FILE !== '' && STRANGER_FILE !== ''

function authOf(file: string): WriteAuth {
  const parsed = parseIdentityFileText(readFileSync(file, 'utf8'))
  return { identityId: parsed.identityId, network: 'devnet', getSigningKeyWif: () => parsed.signingKeyWif }
}

async function liveSdk() {
  const forge = NETWORKS.devnet.v2
  if (forge === null) throw new Error('no forge-v2 deployment for the devnet')
  await evoSdkService.initialize({ network: 'devnet', contractIds: [forge.core, forge.collab], timeoutMs: 30000 })
  return { sdk: evoSdkService.getSdk(), forge }
}

describe.skipIf(!LIVE)('live dense numbering and transitions (moutai, fresh registration)', () => {
  it(
    'numbers issues and PRs in one sequence and moves state only by legal transitions',
    async () => {
      const { sdk, forge } = await liveSdk()
      const [OWNER, STRANGER] = [authOf(OWNER_FILE), authOf(STRANGER_FILE)]
      const name = `numbering-live-${Date.now().toString(36)}`
      const created = await createRepo(sdk, OWNER, forge, { name })
      const repo: RepoRef = { forge, repoId: created.repoId, ownerId: OWNER.identityId, name, visibility: 'public' }

      const first = await createIssue(sdk, OWNER, repo, { title: 'first', body: '' })
      const head = 'ab'.repeat(20)
      const pr = await createPatch(sdk, STRANGER, repo, { title: 'a PR', body: '', baseRefName: 'refs/heads/main', sourceRepoId: repo.repoId, sourceRefName: 'refs/heads/x', headOid: head })
      const third = await createIssue(sdk, OWNER, repo, { title: 'third', body: '' })
      expect([first.number, pr.number, third.number]).toEqual([1, 2, 3])

      // Not the dense next number: refused by the `dense` rule.
      const skip = createDocumentIdempotent(sdk, OWNER, {
        contractId: forge.collab,
        documentType: DOC.issue,
        data: { repoId: decodeIdentifier(repo.repoId), number: 9, tk: 0, title: 'skips' },
      })
      await expect(skip).rejects.toSatisfy((e: unknown) => e instanceof ConsensusRefusal && e.code === 10422 && /"dense"/.test(e.message))

      const target = { id: pr.documentId, number: pr.number, type: 'patch' as const, author: STRANGER.identityId }
      await setTargetState(sdk, STRANGER, repo, { target, action: 'close', isMember: false })
      await setTargetState(sdk, STRANGER, repo, { target, action: 'reopen', isMember: false })
      await setTargetState(sdk, OWNER, repo, { target, action: 'merge', isMember: true, oidHex: head })
      await expect(setTargetState(sdk, STRANGER, repo, { target, action: 'reopen', isMember: false })).rejects.toThrow(/merged/)

      const counts = await readRepoCounts(sdk, repo)
      expect(counts).toMatchObject({ issues: 2, patches: 1, issuesOpen: 2, prsMerged: 1, prsOpen: 0 })
    },
    300_000,
  )
})

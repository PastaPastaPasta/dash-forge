/**
 * Live issue numbering on devnet moutai (forge-v2.md §6 trusted numbers) — SKIPPED by default
 * (network, WASM, about 0.01 DASH of spend).
 *
 * Run with:
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=moutai \
 *     E2E_NUMBERING_OWNER=<identity.json> E2E_NUMBERING_STRANGER=<identity.json> \
 *     pnpm exec vitest run lib/repo/numbering.live.test.ts
 *
 * 1. Read only: the dashpay/dash showcase mirror (`unofficial-dashpay-dash-mirror.dash/dash`)
 *    holds a recent window of upstream issues (#2142 … #7761). The next number is the owner's
 *    largest + 1, not #1 or #2: the imported numbers are trusted, not squatters.
 * 2. A throwaway repo (never a fixture): OWNER writes an "imported" #5000; STRANGER (never a
 *    member) squats #9000 and #5001. `createIssue` as STRANGER then claims #5002: the owner's
 *    number is trusted, the stranger's far squatter is not, and the one right above the base
 *    is stepped over.
 *
 * Never gates CI.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { decodeIdentifier } from '../auth/base58'
import { parseIdentityFileText } from '../auth'
import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { createDocumentIdempotent, evoSdkService, queryDocumentsWithProof, type WriteAuth } from '../sdk'
import { DOC, type RepoRef } from './contract'
import { resolveAnyRepo } from './resolveRepo'
import { repoSource } from './source'
import { createIssue, createRepo, nextNumber } from './writes'

const OWNER_FILE = process.env['E2E_NUMBERING_OWNER'] ?? ''
const STRANGER_FILE = process.env['E2E_NUMBERING_STRANGER'] ?? ''
const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet'

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

describe.skipIf(!LIVE)('live issue numbering (moutai)', () => {
  it('continues the dash mirror’s upstream numbering (read only)', async () => {
    const { sdk } = await liveSdk()
    const resolved = await resolveAnyRepo(sdk, { network: 'devnet', owner: 'unofficial-dashpay-dash-mirror', name: 'dash' })
    if (resolved === null) throw new Error('the dash showcase mirror does not resolve on moutai')
    const repo = resolved.repo
    // Issues and PRs number independently; both continue after the owner's largest.
    for (const type of ['issue', 'patch'] as const) {
      const { documents } = await queryDocumentsWithProof(sdk, {
        ...repoSource(repo).targetQuery(DOC[type]),
        where: [['$ownerId', '==', repo.ownerId], ['repoId', '==', repo.repoId]],
        orderBy: [['number', 'desc']],
        limit: 1,
      })
      const ownersMax = Number(documents[0]?.['number'] ?? 0)
      expect(ownersMax).toBeGreaterThan(1000)
      const next = await nextNumber(sdk, repo, type)
      expect(next, `dash mirror ${repo.repoId}: the owner's largest ${type} is #${ownersMax}`).toBe(ownersMax + 1)
    }
  }, 120_000)

  it.skipIf(OWNER_FILE === '' || STRANGER_FILE === '')(
    'trusts the owner’s imported number and steps over a stranger’s squatters (throwaway repo)',
    async () => {
      const { sdk, forge } = await liveSdk()
      const [OWNER, STRANGER] = [authOf(OWNER_FILE), authOf(STRANGER_FILE)]
      const name = `numbering-live-${Date.now().toString(36)}`
      const created = await createRepo(sdk, OWNER, forge, { name })
      const repo: RepoRef = { forge, repoId: created.repoId, ownerId: OWNER.identityId, name, visibility: 'public' }
      const issueAt = (auth: WriteAuth, number: number, title: string, imported?: Record<string, unknown>) =>
        createDocumentIdempotent(sdk, auth, {
          contractId: forge.collab,
          documentType: DOC.issue,
          data: { repoId: decodeIdentifier(repo.repoId), number, title, ...(imported ? { imported } : {}) },
        })
      await issueAt(OWNER, 5000, 'imported upstream #5000', { author: 'upstream', createdAt: 1_700_000_000_000, url: 'https://github.com/o/r/issues/5000' })
      await issueAt(STRANGER, 9000, 'far squatter')
      await issueAt(STRANGER, 5001, 'squatter right above the base')
      // Count 3 → ceiling 106: without trust every number is a squatter and the next is #1.
      const { number } = await createIssue(sdk, STRANGER, repo, { title: 'a new issue after the import', body: '' })
      expect(number, `throwaway ${name} (${repo.repoId})`).toBe(5002)
    },
    300_000,
  )
})

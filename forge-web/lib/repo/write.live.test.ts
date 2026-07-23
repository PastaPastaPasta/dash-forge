/**
 * Live testnet WRITE smoke test — SKIPPED by default (needs network + WASM + real spend).
 *
 * Run with:
 *   FORGE_LIVE=1 pnpm exec vitest run lib/repo/write.live.test.ts
 *
 * Proves the browser signing path interoperates with the CLI-created world: it loads the
 * DEPLOYER testnet identity, connects via `testnetTrusted()`, creates an `issue` on the m1 repo
 * through the WriteEngine (build → sign HIGH key → broadcast-only → poll), reads it back and
 * folds its state, then stars the m1 repo listing in the registry and confirms the star landed.
 *
 * Spend is a few cents (two ungated document creates). Never gates CI.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { NETWORKS } from '../constants'
import { bytesToBase64, evoSdkService, queryDocumentsWithProof, type WriteAuth } from '../sdk'
import { decodeIdentifier, parseIdentityFileText } from '../auth'
import { REGISTRY_DOC, type RepoRef } from './contract'
import { createIssue, starRepo } from './writes'
import { fetchContractOwner, listIssues } from './index'

const LIVE = process.env['FORGE_LIVE'] === '1'
const M1_REPO_CONTRACT = '5rrwgjjVUqMghnessfiXPXubpiM2QLNNXH142Hv4PDyX'
const IDENTITY_FILE = join(homedir(), '.config/dash-forge/test-identities/DEPLOYER.identity.json')

describe.skipIf(!LIVE)('live testnet browser-path writes', () => {
  it(
    'creates an issue, reads it back, and stars the repo',
    async () => {
      // 1. Load the DEPLOYER identity file the way the browser login would (bridge format).
      const parsed = parseIdentityFileText(readFileSync(IDENTITY_FILE, 'utf8'))
      const auth: WriteAuth = {
        identityId: parsed.identityId,
        network: 'testnet',
        getSigningKeyWif: () => parsed.signingKeyWif,
      }

      const registryId = NETWORKS.testnet.registryContractId as string
      await evoSdkService.initialize({
        network: 'testnet',
        contractIds: [registryId, M1_REPO_CONTRACT],
        timeoutMs: 20000,
      })
      const sdk = evoSdkService.getSdk()
      const repo: RepoRef = { contractId: M1_REPO_CONTRACT, ownerId: parsed.identityId }

      // 2. Create an issue via the browser write path.
      const title = `web-path smoke ${new Date().toISOString()}`
      const created = await createIssue(sdk, auth, repo, {
        title,
        body: 'Created by forge-web WriteEngine (browser signing path).',
      })
      // eslint-disable-next-line no-console
      console.log('issue created:', {
        documentId: created.documentId,
        number: created.number,
        confirmed: created.confirmed,
        costDash: created.cost.dash,
      })
      expect(created.documentId.length).toBeGreaterThan(0)

      // 3. Read it back and fold its state — proves a web-created doc is readable + folds.
      const issues = await listIssues(sdk, repo, undefined, 50)
      const mine = issues.find((i) => i.id === created.documentId)
      expect(mine, 'the web-created issue should be listable').toBeDefined()
      expect(mine?.title).toBe(title)
      expect(mine?.author).toBe(parsed.identityId)
      expect(mine?.state.open).toBe(true)
      // eslint-disable-next-line no-console
      console.log('issue read back + folded:', { number: mine?.number, open: mine?.state.open })

      // 4. Resolve the m1 listing id (repoContractId is not indexed on repoListing, so query by
      //    the repo owner via the ownerName index and match the contract id client-side), then star it.
      const repoOwner = await fetchContractOwner(sdk, M1_REPO_CONTRACT)
      expect(repoOwner, 'm1 repo contract must have an owner').not.toBeNull()
      const { documents } = await queryDocumentsWithProof(sdk, {
        dataContractId: registryId,
        documentTypeName: REGISTRY_DOC.repoListing,
        where: [['$ownerId', '==', repoOwner as string]],
        orderBy: [['$ownerId', 'asc'], ['normalizedName', 'asc']],
        limit: 100,
      })
      // repoListing.repoContractId is a byteArray field (returns base64), not a platform
      // identifier, so match on the base64-encoded contract id.
      const m1Base64 = bytesToBase64(decodeIdentifier(M1_REPO_CONTRACT))
      const listing = documents.find((d) => d['repoContractId'] === m1Base64)
      expect(listing, 'm1 repo must have a registry listing').toBeDefined()
      const listingId = listing?.['$id'] as string

      // The deployed registry's `star.listing` index is a compound (listingId, $createdAt)
      // countable index, so the O(1) count-tree (readStarCount) is rejected by the proof helper
      // (documented in forge-core star_count). Count star rows directly instead.
      const countStars = async (): Promise<number> => {
        const { documents: stars } = await queryDocumentsWithProof(sdk, {
          dataContractId: registryId,
          documentTypeName: REGISTRY_DOC.star,
          where: [['listingId', '==', listingId]],
          orderBy: [['listingId', 'asc'], ['$createdAt', 'desc']],
          limit: 100,
        })
        return stars.length
      }
      const before = await countStars()
      const star = await starRepo(sdk, auth, listingId)
      const after = await countStars()
      // eslint-disable-next-line no-console
      console.log('star:', { listingId, documentId: star.documentId, confirmed: star.confirmed, before, after })
      // Idempotent: a fresh star increments; a re-star leaves the count unchanged (already ours).
      expect(star.documentId.length).toBeGreaterThan(0)
      expect(after).toBeGreaterThanOrEqual(before)
      expect(after).toBeGreaterThanOrEqual(1)
    },
    180000,
  )
})

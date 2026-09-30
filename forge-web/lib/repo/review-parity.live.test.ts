/**
 * Live review-parity writes and folds on devnet bonsia — SKIPPED by default (network, WASM,
 * about 0.01 DASH of spend).
 *
 * Run with:
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=bonsia \
 *     pnpm exec vitest run lib/repo/review-parity.live.test.ts
 *
 * Through the web's own writers (`review-writes.ts`, `replaceDocumentIdempotent`) and readers
 * (`readPull`, `readReviews`, the thread view), with the devnet's test identities: OWNER creates
 * a scratch repo (maintainer) with COLLAB as writer; CONTRIB (not a member) opens a draft PR;
 * the author marks it ready and moves its head; OWNER requests COLLAB as a reviewer; COLLAB submits a pending review (request changes + a single-line, a range and a
 * file-level comment) as one review and three `reviewId` comments; CONTRIB replies and resolves
 * the range thread; OWNER dismisses the review; OWNER sets a policy; CONTRIB edits the PR title
 * and a comment; COLLAB deletes the review and edits an orphaned comment (dropping `reviewId`). Every step is read back through the folds: head, draft, requested reviewers,
 * resolved threads, dismissals (the dismissed request for changes no longer blocks), anchors,
 * the review's comment group, `meetsPolicy`, "edited" markers.
 * Never gates CI.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseIdentityFileText } from '../auth'
import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { anchorOf, countApprovals, foldPrReviewV2, groupReviewComments, meetsPolicy, RoleOracle } from '../rules/v2'
import { createHash } from 'node:crypto'

import { decodeIdentifier } from '../auth/base58'
import { createDocumentIdempotent, deleteDocumentIdempotent, evoSdkService, queryAllDocuments, queryDocumentsWithProof, type WriteAuth } from '../sdk'
import { DOC, str, type RepoRef } from './contract'
import { readPull, readReviews, readTargetLog } from './issues'
import { retryWhileMissing } from '../view/retry'
import { readMemberships } from './members'
import { repoSource } from './source'
import {
  postComment,
  postTargetEvent,
  saveReviewDraft,
  setPolicy,
  submitReviewDraft,
  updateComment,
  updateTarget,
  type ReviewDraft,
} from './review-writes'
import { createRepo, grantMember, nextNumber, setTargetState } from './writes'

const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet'
const ID_DIR = join(homedir(), '.config/dash-forge/test-identities', NETWORKS[DEFAULT_NETWORK].key)
// The fixture's history (forge-contracts/scripts/seed-v2-fixture.mjs): c2 then c3.
const C2 = 'b35c50122cd51b2cc0345760721e6398fa0c31f5'
const C3 = '3a1300eb2441ef94fd927dbfc7548d34fbb8edc5'

function authOf(name: string): WriteAuth {
  const parsed = parseIdentityFileText(readFileSync(join(ID_DIR, `${name}.identity.json`), 'utf8'))
  return { identityId: parsed.identityId, network: 'devnet', getSigningKeyWif: () => parsed.signingKeyWif }
}

describe.skipIf(!LIVE)('live review parity (bonsia)', () => {
  it(
    'writes every review-parity document through the web writers and folds it back',
    async () => {
      const forge = NETWORKS.devnet.v2
      if (forge === null) throw new Error('no forge-v2 deployment for the devnet')
      await evoSdkService.initialize({ network: 'devnet', contractIds: [forge.core, forge.collab], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const [OWNER, COLLAB, CONTRIB] = [authOf('OWNER'), authOf('COLLAB'), authOf('CONTRIB')]

      // --- scratch repo: OWNER maintains, COLLAB writes -------------------------------------
      const name = `review-live-${Date.now().toString(36)}`
      const created = await createRepo(sdk, OWNER, forge, { name })
      const repo: RepoRef = { forge, repoId: created.repoId, ownerId: OWNER.identityId, name, visibility: 'public' }
      await grantMember(sdk, OWNER, repo, COLLAB.identityId, 'writer')

      // --- CONTRIB opens a draft PR --------------------------------------------------------
      // The patch as forge-core `patch_props` writes it (dense number, `tk` 1), then its
      // author's draft transition (kind 14).
      const sha = (s: string) => new Uint8Array(createHash('sha256').update(s).digest())
      const number = (await nextNumber(sdk, repo)) ?? 1
      const opened = await createDocumentIdempotent(sdk, CONTRIB, {
        contractId: forge.collab,
        documentType: DOC.patch,
        data: {
          repoId: decodeIdentifier(repo.repoId),
          number,
          title: 'Greet by name',
          body: 'first',
          baseRefNameHash: sha('refs/heads/main'),
          baseRefName: 'refs/heads/main',
          sourceRepoId: decodeIdentifier(repo.repoId),
          sourceRefNameHash: sha('refs/heads/feature/greeting'),
          sourceRefName: 'refs/heads/feature/greeting',
          headOid: Buffer.from(C2, 'hex'),
          tk: 1,
        },
      })
      const pr = { documentId: opened.documentId, number }
      const target = { id: pr.documentId, number: pr.number }
      const stateTarget = { ...target, type: 'patch' as const, author: CONTRIB.identityId }
      await setTargetState(sdk, CONTRIB, repo, { target: stateTarget, action: 'draft', isMember: false })
      // A node one block behind may not show a write the wait proved yet: retry briefly.
      const docOf = async () => {
        const read = async () =>
          (await queryDocumentsWithProof(sdk, repoSource(repo).repoQuery(DOC.patch, { where: [['number', '==', pr.number]], limit: 1 }))).documents[0] ?? null
        const d = await retryWhileMissing(read, 10)
        if (d === null) throw new Error('the PR is not readable')
        return d
      }
      let pull = await readPull(sdk, repo, await docOf())
      expect(pull.state.draft).toBe(true)
      expect(pull.headOid).toBe(C2)

      // the author (not a member) marks it ready and moves the head
      const author = { author: CONTRIB.identityId, isMember: false }
      await setTargetState(sdk, CONTRIB, repo, { target: stateTarget, action: 'ready', isMember: false })
      await postTargetEvent(sdk, CONTRIB, repo, { target, kind: 'headUpdate', ...author, payload: { oidHex: C3 } })
      pull = await readPull(sdk, repo, await docOf())
      expect(pull.state.draft).toBe(false)
      expect(pull.initialHeadOid).toBe(C2)
      expect(pull.headOid).toBe(C3)
      expect(pull.review.headUpdates.map((h) => h.oid)).toEqual([C3])

      // OWNER requests COLLAB as a reviewer
      await postTargetEvent(sdk, OWNER, repo, { target, kind: 'reviewRequest', author: CONTRIB.identityId, isMember: true, payload: { refId: COLLAB.identityId } })

      // --- COLLAB submits a pending review: request changes + 3 inline comments -------------
      const draft: ReviewDraft = {
        draftId: `live-${Date.now().toString(36)}`,
        network: 'devnet',
        identity: COLLAB.identityId,
        repoId: repo.repoId,
        prId: pr.documentId,
        headOid: pull.headOid,
        verdict: 'requestChanges',
        summary: 'Two small things.',
        comments: [
          { localId: 'single', anchor: { path: 'src/main.rs', line: 3, side: 1 }, body: 'Print the name once.' },
          { localId: 'range', anchor: { path: 'src/main.rs', startLine: 2, line: 3, side: 1 }, body: '```suggestion\n    let name = arg();\n```' },
          { localId: 'file', anchor: { path: 'README.md' }, body: 'Mention the flag.' },
        ],
        startedAt: Date.now(),
      }
      await saveReviewDraft(draft)
      // COLLAB is a writer of this scratch repo (granted above): a member's post.
      const submitted = await submitReviewDraft(sdk, COLLAB, repo, draft, { isMember: true, locked: false })
      expect(submitted.commentIds).toHaveLength(3)

      // CONTRIB replies to the range thread and resolves it; OWNER dismisses the review
      const rangeRoot = submitted.commentIds[1] as string
      const reply = await postComment(sdk, CONTRIB, repo, { targetId: pr.documentId, body: 'Done.', replyTo: rangeRoot })
      await postTargetEvent(sdk, CONTRIB, repo, { target, kind: 'threadResolve', ...author, payload: { refId: rangeRoot } })
      await postTargetEvent(sdk, OWNER, repo, { target, kind: 'reviewDismiss', author: CONTRIB.identityId, isMember: true, payload: { refId: submitted.reviewId, value: 'addressed in the reply' } })
      await setPolicy(sdk, OWNER, repo, { requiredApprovals: 1, approverRole: 0 })

      // --- read everything back through the folds -------------------------------------------
      const log = await readTargetLog(sdk, repo, pr.documentId)
      const comments = await queryAllDocuments(sdk, {
        dataContractId: forge.collab,
        documentTypeName: DOC.comment,
        where: [['targetId', '==', pr.documentId]],
        orderBy: [['targetId', 'asc'], ['$createdAt', 'asc']],
      })
      const roots = new Set(comments.filter((c) => c['replyTo'] === undefined).map((c) => str(c, '$id')))
      const review = foldPrReviewV2(log.events, log.authorEvents, CONTRIB.identityId, C2, roots)
      expect(review.head).toBe(C3)
      expect(review.requestedReviewers.map((r) => r.identity)).toEqual([COLLAB.identityId])
      expect(review.resolvedThreads).toEqual([rangeRoot])
      expect(review.dismissedReviews).toEqual([expect.objectContaining({ reviewId: submitted.reviewId, reason: 'addressed in the reply', actor: OWNER.identityId })])

      const byId = new Map(comments.map((c) => [str(c, '$id'), c]))
      const anchorAt = (id: string) => {
        const c = byId.get(id) ?? {}
        const hex = (v: unknown) => (typeof v === 'string' ? Buffer.from(v, 'base64').toString('hex') : '')
        return anchorOf({ path: c['path'] as string, line: c['line'] as number, startLine: c['startLine'] as number, side: c['side'] as number, commitOid: hex(c['commitOid']) })
      }
      expect(anchorAt(submitted.commentIds[0] as string)).toMatchObject({ path: 'src/main.rs', line: 3, startLine: 3, side: 1, commitOid: C3 })
      expect(anchorAt(rangeRoot)).toMatchObject({ startLine: 2, line: 3 })
      expect(anchorAt(submitted.commentIds[2] as string)).toMatchObject({ path: 'README.md', line: null })

      const reviews = await readReviews(sdk, repo, pr.documentId)
      expect(reviews).toHaveLength(1)
      expect(reviews[0]?.commentCount).toBe(3)
      const group = groupReviewComments(
        submitted.reviewId,
        COLLAB.identityId,
        reviews[0]?.commentCount,
        comments.map((c) => ({ id: str(c, '$id'), owner: str(c, '$ownerId'), reviewId: typeof c['reviewId'] === 'string' ? c['reviewId'] : null, createdAt: Number(c['$createdAt']) })),
      )
      expect(group).toEqual({ comments: submitted.commentIds, landed: 3, expected: 3 })

      // the dismissed request for changes no longer counts; the policy is not met
      const memberships = await readMemberships(sdk, repo)
      const oracle = new RoleOracle(memberships.map((m) => ({ identity: m.identity, role: m.role, createdAt: m.createdAt })))
      const dismissed = new Set(review.dismissedReviews.map((d) => d.reviewId))
      const rules = reviews.map((r) => ({ id: r.id, reviewer: r.reviewer, verdict: r.verdictCode, commitOid: r.commitOid, createdAt: r.createdAt }))
      expect(countApprovals(rules, oracle, review.head, new Set(), CONTRIB.identityId)).toEqual({ approvers: [], changesRequested: [COLLAB.identityId] })
      const approvals = countApprovals(rules, oracle, review.head, dismissed, CONTRIB.identityId)
      expect(approvals).toEqual({ approvers: [], changesRequested: [] })
      expect(meetsPolicy(approvals, oracle, { requiredApprovals: 1, approverRole: 0 })).toEqual({ met: false, have: 0, need: 1 })

      // --- edits: CONTRIB edits the title and the reply ------------------------------------
      const edited = await updateTarget(sdk, CONTRIB, repo, { type: 'patch', id: pr.documentId, title: 'Greet by name (edited)' })
      expect(edited.revision).toBe(2n)
      await updateComment(sdk, CONTRIB, repo, { id: reply.documentId, body: 'Done, thanks.' })
      const after = await docOf()
      expect(after['title']).toBe('Greet by name (edited)')
      expect(Number(after['$updatedAt'])).toBeGreaterThan(Number(after['$createdAt']))
      // A second identical edit signs nothing.
      expect((await updateTarget(sdk, CONTRIB, repo, { type: 'patch', id: pr.documentId, title: 'Greet by name (edited)' })).actualCredits).toBe(0)
      // COLLAB cannot edit CONTRIB's PR (refused before signing).
      await expect(updateTarget(sdk, COLLAB, repo, { type: 'patch', id: pr.documentId, title: 'hijacked' })).rejects.toThrow(/author/)

      // --- a deleted review orphans its comments: an edit must drop the dead reviewId -------
      await deleteDocumentIdempotent(sdk, COLLAB, { contractId: forge.collab, documentType: DOC.review, documentId: submitted.reviewId, repo: repo.repoId })
      const orphan = submitted.commentIds[0] as string
      // Every replace re-validates reviewId: keeping it is refused at consensus.
      await expect(updateComment(sdk, COLLAB, repo, { id: orphan, body: 'still here' })).rejects.toMatchObject({ code: 40120 })
      await updateComment(sdk, COLLAB, repo, { id: orphan, body: 'still here', dropReviewId: true })
      // A node a block behind may still serve the old revision: read until the edit shows.
      const json = await retryWhileMissing(async () => {
        const j = (await sdk.documents.get(forge.collab, DOC.comment, orphan))?.toJSON(14) as Record<string, unknown> | undefined
        return j?.['body'] === 'still here' ? j : null
      }, 10)
      expect(json?.['body']).toBe('still here')
      expect(json?.['reviewId']).toBeUndefined()
      expect(json?.['path']).toBe('src/main.rs')
    },
    600000,
  )
})

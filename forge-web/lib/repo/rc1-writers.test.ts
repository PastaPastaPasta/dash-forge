/**
 * Every document forge-web writes is RC1-valid: each writer runs against a scripted write engine,
 * and every create it makes is judged by the RC1 contracts offline (`lib/sdk/rc1-validate.ts`:
 * the JSON schema and every `propertyConstraints` rule that reads no total, time or height, as
 * the node's basic validation does), routed to the contract the RC1 layout names. The rules that
 * read state (dense numbers, transition sums, lock gates, the release ledger, topic caps) are
 * the live suite's; the writers' own pre-checks for them are tested next to each writer.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Create = { signer: string; contractId: string; documentType: string; data: Record<string, unknown> }
const creates: Create[] = []
/** The document types a proved query finds one row of (e.g. the invitee's `consent`). */
const present = new Set<string>()
/** The tags with a live release (their `perTag` delta sum is 1). */
const liveTags: string[] = []
/** The member documents (`maintainer` / `writer` / `runner` → member ids) the complete reads find. */
const held: Record<string, string[]> = {}
/** A refusal the next create meets (then cleared). */
let refuseNext: Error | null = null
/** How many more `consent` reads answer "none" first (a node that has not indexed it yet). */
let consentLag = 0

const ALICE = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
const BOB = 'CJao2MVHL4x3f2Ko2xTUibnZ8G1t9exTPtvJnCbHAgDH'
const NEW_ID = '8rSFEyS7gidGdS4r8m22YtMEc519otpDNQ242Zw9c1Gb'

// A lag retry waits about a block: no real time in tests.
vi.mock('../sdk/facade', async (orig) => ({ ...(await orig<typeof import('../sdk/facade')>()), sleep: () => Promise.resolve() }))
vi.mock('../sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('../sdk')>()
  return {
    ...real,
    createDocumentIdempotent: vi.fn(async (_sdk: unknown, a: { identityId: string }, p: Omit<Create, 'signer'>) => {
      if (refuseNext !== null) {
        const e = refuseNext
        refuseNext = null
        throw e
      }
      creates.push({ signer: a.identityId, contractId: p.contractId, documentType: p.documentType, data: p.data })
      return { documentId: NEW_ID, confirmed: true, cost: { credits: 0, dash: 0 }, actualCredits: null }
    }),
    queryDocumentsWithProof: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) => {
      if (q.documentTypeName === 'consent' && consentLag > 0) {
        consentLag -= 1
        return { documents: [] }
      }
      return { documents: present.has(q.documentTypeName) ? [{ $id: NEW_ID, $ownerId: BOB }] : [] }
    }),
    queryAllDocuments: vi.fn(async (_sdk: unknown, q: { documentTypeName: string }) =>
      (held[q.documentTypeName] ?? []).map((memberId, i) => ({ $id: `${q.documentTypeName}${i}`, $ownerId: ALICE, $createdAt: 1, memberId })),
    ),
    countDocuments: vi.fn(async () => 0),
    sumDocumentsGrouped: vi.fn(async () => new Map(liveTags.map((t) => [t, 1]))),
  }
})

import { resetMemoryStores } from '../idb'
import { listParticipation } from '../view/participation'
import type { WriteAuth } from '../sdk'
import { expectRc1Valid, rc1Contracts } from '../sdk/rc1-validate'
import type { RepoRef } from './contract'
import { defineLabel } from './labels'
import { putPlatformChunks, writePackManifest, writeRefUpdate } from './push'
import { postTargetEvent, setAssignee, setLabel, setMilestone, setPolicy, setThreadFlag, submitReviewDraft, type ReviewDraft } from './review-writes'
import { syncTopicDocs, updateConfig } from './settings'
import { contractOf } from './source'
import { repoKeyData } from './private-members'
import { decodeIdentifier } from '../auth/base58'
import { EpochKeys } from '../private/keys'
import { sealWrap } from '../private/wrap'
import { commentEditDrops, type CommentView } from '../view/issues-view'
import type { ReleaseList } from './releases'
import type { SealedReleaseEnv } from './sealed-release'
import {
  CONSENT_LAG_RETRIES,
  ConsentMissingError,
  acceptInvite,
  createComment,
  createIssue,
  createPatch,
  createRelease,
  createRepo,
  createReview,
  followRelation,
  grantMember,
  membershipData,
  setLock,
  setTargetState,
  starRelation,
  watchRelation,
} from './writes'

const FORGE = {
  core: 'A2KL77ngVM1ft1t1em2XKt1rWCBZANdAJMyfWrDGCcd1',
  collab: 'C1zHeeG7EUudXdB5ZyDQnXVU35hrCfvd1fRCybXEqaPS',
  community: 'E24SPCssqYzFQmjcQ1hNmiLXrzz1o9AqTv54tuWNkgHz',
  group: '6dV3kMBWHGR7pLKrHToMBQgbTpjqeE2VAyCEWmLbrkWC',
}
const REPO: RepoRef = { forge: FORGE, repoId: '8H5JaQm8Z765UunuttoUuVsVMCmDoy2EBKgmGKYpdB2z', ownerId: ALICE, name: 'demo', visibility: 'public' }
const PR = 'Ehyw8VygZh5LjjYHUbKqgyJamgetiVPLFnJewrfmgQUs'
const ISSUE = 'EA8HsynH63cw1i8xQLoARwk43sDf74HrKut1D4RV3L35'
const HEAD = 'ab'.repeat(20)
/** The raw documents facade the index-only reads use: nothing held yet. */
const sdk = { documents: { query: async () => new Map() } } as unknown as EvoSDK
const auth = (identityId: string): WriteAuth => ({ identityId, network: 'devnet', getSigningKeyWif: () => 'x' })

/** Every create since the last call: routed by the RC1 layout and RC1-valid as its signer made it. */
async function judged(): Promise<Create[]> {
  const made = creates.splice(0)
  expect(made.length).toBeGreaterThan(0)
  for (const c of made) {
    expect(c.contractId, `${c.documentType} contract`).toBe(contractOf(FORGE, c.documentType))
    await expectRc1Valid(c.documentType, c.data, c.signer)
  }
  return made
}

const types = (made: readonly Create[]): string[] => made.map((c) => c.documentType)

beforeEach(() => {
  creates.length = 0
  present.clear()
  liveTags.length = 0
  for (const k of Object.keys(held)) delete held[k]
  refuseNext = null
  consentLag = 0
  resetMemoryStores()
})

describe('forge-core writers are RC1-valid', () => {
  it('a new repo: the repo, the owner self-enrolled (no consent), the first config, all stamped', async () => {
    await createRepo(sdk, auth(ALICE), FORGE, { name: 'demo', description: 'd', defaultBranch: 'main' })
    const made = await judged()
    expect(types(made)).toEqual(['repo', 'maintainer', 'config'])
    expect(made[1]?.data).toMatchObject({ vis: 'public' })
    expect(made[1]?.data['consentBy']).toBeUndefined()
    expect(made[2]?.data).toMatchObject({ vis: 'public', defaultBranch: 'main' })
  })

  it('refuses a default branch the contract refuses, before anything is written', async () => {
    await expect(createRepo(sdk, auth(ALICE), FORGE, { name: 'demo', defaultBranch: '-main' })).rejects.toThrow(/branch name/)
    expect(creates).toHaveLength(0)
  })

  it('a member is added with their consent: consentBy names them', async () => {
    present.add('consent')
    await grantMember(sdk, auth(ALICE), REPO, BOB, 'writer')
    const [w] = await judged()
    expect(w?.documentType).toBe('writer')
    expect(w?.data).toMatchObject({ vis: 'public' })
    expect(w?.data['consentBy']).toEqual(w?.data['memberId'])
  })

  it('a private repo member document carries vis private, and still validates', async () => {
    await expectRc1Valid('maintainer', membershipData({ ...REPO, visibility: 'private' }, BOB), ALICE)
    await expectRc1Valid('maintainer', membershipData({ ...REPO, visibility: 'private' }, ALICE), ALICE)
  })

  it("the invitee's consent", async () => {
    await acceptInvite(sdk, auth(BOB), REPO)
    expect(types(await judged())).toEqual(['consent'])
  })

  it('a push: its chunk, its manifest (packHash an identifier, no offsetIndexParts) and the ref update', async () => {
    const bytes = new Uint8Array(20_000).fill(7)
    const hash = 'cd'.repeat(32)
    const { chunkCount, locator } = await putPlatformChunks(sdk, auth(BOB), REPO, bytes, hash)
    await writePackManifest(sdk, auth(BOB), REPO, { packHash: hash, kind: 0, sizeBytes: bytes.length, objectCount: 3, chunkCount, storage: 0, uris: [locator] })
    await writeRefUpdate(sdk, auth(BOB), REPO, { refName: 'refs/heads/main', newOid: HEAD, prevOid: 'cd'.repeat(20) }, { protectedPatterns: [] })
    await writeRefUpdate(sdk, auth(ALICE), REPO, { refName: 'refs/heads/main', newOid: HEAD }, { protectedPatterns: ['refs/heads/main'] })
    const made = await judged()
    expect(types(made)).toEqual(['chunk', 'chunk', 'packManifest', 'refUpdate', 'protectedRefUpdate'])
    expect(made[2]?.data['offsetIndexParts']).toBeUndefined()
  })

  it('a release: delta +1 for a tag with no live release', async () => {
    const r = await createRelease(sdk, auth(ALICE), REPO, { tagName: 'v1.0.0', name: 'One', notes: 'n' })
    expect(r.confirmed).toBe(true)
    const [rel] = await judged()
    expect(rel?.data).toMatchObject({ vis: 'public', delta: 1 })
  })

  it('topics, a label and a config change', async () => {
    await syncTopicDocs(sdk, auth(ALICE), REPO, ['web-dev', 'rust'])
    await defineLabel(sdk, auth(ALICE), REPO, { name: 'good first issue', color: '#00ff00', description: 'd' })
    await updateConfig(sdk, auth(ALICE), REPO, null, { addPattern: 'refs/heads/main' }, undefined, async () => null)
    const made = await judged()
    expect(types(made)).toEqual(['topic', 'topic', 'label', 'config'])
    expect(made[0]?.data).toMatchObject({ vis: 'public' })
  })
})

describe('forge-collab writers are RC1-valid', () => {
  it('an issue and a draft PR (the patch, then its kind-14 transition)', async () => {
    await createIssue(sdk, auth(BOB), REPO, { title: 'A bug', body: 'text' })
    await createPatch(sdk, auth(BOB), REPO, {
      title: 'A fix', body: '', baseRefName: 'refs/heads/main', sourceRepoId: REPO.repoId, sourceRefName: 'refs/heads/fix', headOid: HEAD, draft: true,
    })
    const made = await judged()
    expect(types(made)).toEqual(['issue', 'patch', 'transition'])
    expect(made[0]?.data).toMatchObject({ vis: 'public', number: 1 })
    expect(made[2]?.data).toMatchObject({ kind: 14, delta: 8 })
  })

  it('comments: plain, a reply to a root, and a member on a locked thread (with the proof)', async () => {
    await createComment(sdk, auth(BOB), REPO, { targetId: ISSUE, body: 'hi' })
    await createComment(sdk, auth(BOB), REPO, { targetId: ISSUE, body: 'reply', replyTo: PR })
    await createComment(sdk, auth(BOB), REPO, { targetId: ISSUE, body: 'locked', post: { isMember: true, locked: true } })
    const made = await judged()
    expect(made.map((c) => c.data['asMember'] !== undefined)).toEqual([false, false, true])
    await expect(createComment(sdk, auth(BOB), REPO, { targetId: ISSUE, body: 'x', post: { isMember: false, locked: true } })).rejects.toThrow(/locked/)
  })

  it('reviews: a member approve proves membership (1), a non-member approve is 4 and request changes 5', async () => {
    await createReview(sdk, auth(BOB), REPO, { patchId: PR, verdict: 'approve', commitOid: HEAD, post: { isMember: true } })
    await createReview(sdk, auth(BOB), REPO, { patchId: PR, verdict: 'approve', commitOid: HEAD, post: { isMember: false } })
    await createReview(sdk, auth(BOB), REPO, { patchId: PR, verdict: 'requestChanges', commitOid: HEAD, body: 'no', post: { isMember: false } })
    await createReview(sdk, auth(BOB), REPO, { patchId: PR, verdict: 'comment', commitOid: HEAD, body: 'hm', post: { isMember: true } })
    const made = await judged()
    expect(made.map((c) => [c.data['verdict'], c.data['asMember'] !== undefined])).toEqual([[1, true], [4, false], [5, false], [3, false]])
    // QW2-009: the inbox follows a PR its reviewer reviewed (no index finds a review by author).
    await vi.waitFor(async () => expect(await listParticipation('devnet', BOB)).toEqual([expect.objectContaining({ targetId: PR, reason: 'reviewed' })]))
  })

  it('a pending review: the review and its anchored comments', async () => {
    const draft: ReviewDraft = {
      draftId: 'd', network: 'devnet', identity: BOB, repoId: REPO.repoId, prId: PR, headOid: HEAD, verdict: 'requestChanges', summary: 'two things', startedAt: 0,
      comments: [{ localId: 'a', anchor: { path: 'src/a.ts', line: 7, startLine: 5, side: 1 }, body: 'nit' }],
    }
    await submitReviewDraft(sdk, auth(BOB), REPO, draft, { isMember: true, locked: true }, undefined, { reviews: async () => [], comments: async () => [] })
    const made = await judged()
    expect(types(made)).toEqual(['review', 'comment'])
    expect(made.every((c) => c.data['asMember'] !== undefined)).toBe(true)
  })

  it('state and lock transitions, by a member and by the author', async () => {
    await setTargetState(sdk, auth(BOB), REPO, { target: { id: ISSUE, number: 1, type: 'issue', author: BOB }, action: 'close', isMember: false })
    await setTargetState(sdk, auth(ALICE), REPO, { target: { id: PR, number: 2, type: 'patch', author: BOB }, action: 'merge', isMember: true, oidHex: HEAD })
    await setLock(sdk, auth(ALICE), REPO, { target: { id: ISSUE, number: 1, type: 'issue', author: BOB }, lock: true, isMember: true })
    await setLock(sdk, auth(ALICE), REPO, { target: { id: PR, number: 2, type: 'patch', author: BOB }, lock: true, isMember: true })
    const made = await judged()
    expect(made.map((c) => [c.data['kind'], c.data['delta'], c.data['asAuthor']])).toEqual([[1, 1, 1], [13, 2, 0], [3, 16, 0], [18, 16, 0]])
  })
})

describe('forge-community writers are RC1-valid', () => {
  it('member and author events: labels, assignees, milestones, pins, review requests, head updates', async () => {
    const target = { id: PR, number: 2 }
    await setLabel(sdk, auth(ALICE), REPO, { target, label: 'bug', add: true })
    await setAssignee(sdk, auth(ALICE), REPO, { target, assignee: BOB, assign: true })
    await setMilestone(sdk, auth(ALICE), REPO, { target, title: 'v1' })
    await setThreadFlag(sdk, auth(ALICE), REPO, { target, on: true })
    await postTargetEvent(sdk, auth(ALICE), REPO, { target, kind: 'reviewRequest', author: BOB, isMember: true, payload: { refId: BOB } })
    await postTargetEvent(sdk, auth(BOB), REPO, { target, kind: 'headUpdate', author: BOB, isMember: false, payload: { oidHex: HEAD } })
    const made = await judged()
    expect(types(made)).toEqual(['event', 'event', 'event', 'event', 'event', 'authorEvent'])
  })

  it('a branch policy: the existing switches with no sources, and named checks paired with their sources', async () => {
    held['maintainer'] = [ALICE]
    held['runner'] = [BOB]
    await setPolicy(sdk, auth(ALICE), REPO, { requiredApprovals: 1, approverRole: 0, requireChecks: true, mergeMethods: 15 })
    await setPolicy(sdk, auth(ALICE), REPO, { requiredApprovals: 0, requiredChecks: ['build', 'lint'], requiredCheckSources: [BOB, ALICE] })
    await judged()
    await expect(setPolicy(sdk, auth(ALICE), REPO, { requiredApprovals: 0, requiredChecks: ['build', 'lint'], requiredCheckSources: [BOB] })).rejects.toThrow(/source/)
    await expect(setPolicy(sdk, auth(ALICE), REPO, { requiredApprovals: 0, mergeMethods: 16 })).rejects.toThrow(/0-15/)
    // A pinned source removed since (no longer a runner or maintainer): said before signing.
    held['runner'] = []
    await expect(setPolicy(sdk, auth(ALICE), REPO, { requiredApprovals: 0, requiredChecks: ['build'], requiredCheckSources: [BOB] })).rejects.toThrow(/no longer a runner or maintainer/)
    expect(creates).toHaveLength(0)
  })

  it('a star with its trending beat (repoOwner, vis public), a watch and a follow', async () => {
    await starRelation(sdk, auth(BOB), BOB, REPO, true).add()
    await watchRelation(sdk, auth(BOB), BOB, REPO).add()
    await followRelation(sdk, auth(BOB), BOB, FORGE, ALICE).add()
    const made = await judged()
    expect(types(made)).toEqual(['star', 'starBeat', 'watch', 'follow'])
    expect(made[1]?.data).toMatchObject({ vis: 'public' })
  })

  it('no trending beat on your own repo or a private one (consensus refuses both)', async () => {
    await starRelation(sdk, auth(ALICE), ALICE, REPO, true).add()
    await starRelation(sdk, auth(BOB), BOB, { ...REPO, visibility: 'private' }, true).add()
    expect(types(await judged())).toEqual(['star', 'star'])
  })
})

describe('what the writers refuse or adjust before signing', () => {
  it('an invite the member has not accepted is pending, and nothing is signed', async () => {
    vi.useFakeTimers()
    try {
      const refused = expect(grantMember(sdk, auth(ALICE), REPO, BOB, 'maintainer')).rejects.toBeInstanceOf(ConsentMissingError)
      await vi.runAllTimersAsync()
      await refused
    } finally {
      vi.useRealTimers()
    }
    expect(creates).toHaveLength(0)
  })

  it("a consent the owner's node has not indexed yet is re-read, not refused (D-10)", async () => {
    present.add('consent')
    consentLag = CONSENT_LAG_RETRIES
    vi.useFakeTimers()
    try {
      const granted = grantMember(sdk, auth(ALICE), REPO, BOB, 'writer')
      await vi.runAllTimersAsync()
      await granted
    } finally {
      vi.useRealTimers()
    }
    expect(types(await judged())).toEqual(['writer'])
  })

  it('an edit, a yank or a re-publish of a live tag is delta 0', async () => {
    liveTags.push('v1.0.0')
    await createRelease(sdk, auth(ALICE), REPO, { tagName: 'v1.0.0', yanked: true })
    const [rel] = await judged()
    expect(rel?.data).toMatchObject({ delta: 0, yanked: true })
    await expect(createRelease(sdk, auth(ALICE), REPO, { tagName: 'v1@{0}' })).rejects.toThrow(/tag name/)
    // The sealed-only flags, and plaintext assets on a private repo, are refused before signing.
    await expect(createRelease(sdk, auth(ALICE), REPO, { tagName: 'v2', draft: true })).rejects.toThrow(/sealed release/)
    await expect(
      createRelease(sdk, auth(ALICE), { ...REPO, visibility: 'private' }, { tagName: 'v2', assets: [{ name: 'a', sha256: 'ab'.repeat(32), sizeBytes: 1, uris: ['https://x.example/a'] }] }),
    ).rejects.toThrow(/sealed files/)
    expect(creates).toHaveLength(0)
  })

  it("an edit drops a reply's dead parent and a lapsed member's proof, never an import's", () => {
    const c = (id: string, extra: Partial<CommentView> = {}): CommentView => ({ id, author: BOB, body: 'b', createdAt: 1, replyTo: null, anchor: null, reviewId: null, imported: false, ...extra })
    const reply = c('r', { replyTo: 'gone', proved: true })
    expect(commentEditDrops(reply, [reply], { isMember: false, allReadable: true })).toEqual({ dropReplyTo: true, dropProof: true })
    expect(commentEditDrops(reply, [reply, c('gone')], { isMember: true, allReadable: true })).toEqual({})
    // A parent hidden by a key this reader lacks is not taken for a deleted one.
    expect(commentEditDrops(reply, [reply], { isMember: true, allReadable: false })).toEqual({})
    expect(commentEditDrops(c('i', { proved: true, imported: true }), [], { isMember: false, allReadable: true })).toEqual({})
  })
})

describe('the review fixes', () => {
  it('a verdict read as a non-member is checked again, uncached, before it is written as 4/5', async () => {
    held['writer'] = [BOB]
    await createReview(sdk, auth(BOB), REPO, { patchId: PR, verdict: 'approve', commitOid: HEAD, post: { isMember: false } })
    const [r] = await judged()
    expect(r?.data['verdict']).toBe(1)
    expect(r?.data['asMember']).toBeDefined()
  })

  it('a member read as a non-member on a locked PR: re-read, then the review and its comments all carry the proof', async () => {
    held['writer'] = [BOB]
    const draft: ReviewDraft = {
      draftId: 'l', network: 'devnet', identity: BOB, repoId: REPO.repoId, prId: PR, headOid: HEAD, verdict: 'comment', summary: 's', startedAt: 0,
      comments: [{ localId: 'a', anchor: { path: 'f', line: 1, side: 1 }, body: 'one' }],
    }
    await submitReviewDraft(sdk, auth(BOB), REPO, draft, { isMember: false, locked: true }, undefined, { reviews: async () => [], comments: async () => [] })
    const made = await judged()
    expect(types(made)).toEqual(['review', 'comment'])
    expect(made.every((c) => c.data['asMember'] !== undefined)).toBe(true)
    await createReview(sdk, auth(BOB), REPO, { patchId: PR, verdict: 'approve', commitOid: HEAD, post: { isMember: false, locked: true } })
    expect((await judged())[0]?.data).toMatchObject({ verdict: 1 })
  })

  it('a release refused by oneLive (a stale live total) is read again and retried once', async () => {
    const { ConsensusRefusal } = await import('../sdk')
    refuseNext = new ConsensusRefusal(10422, 'breaks its propertyConstraints rule "oneLive": NotMet')
    await createRelease(sdk, auth(ALICE), REPO, { tagName: 'v3' })
    expect(types(await judged())).toEqual(['release'])
  })
})

describe('private writers are RC1-valid', () => {
  // Key pairs the Rust wrap tests use (crates/forge-core/src/platform/wrap.rs).
  const SENDER = { priv: '840fa5c84d8f6ecf5c27fd778356ba94480b9b35f264e7690933dcf1676f9ac0', pub: '03f3d414f81ac96cea14d3ec25685430f04c47c8b0559fff0ffe77113d8ada7948' }
  const RECIPIENT_PUB = '035bf470bf1fbffac4b0b01c0ae8480b0b56d6695482bb116286c62e99af15e337'

  it('a repoKey: a wrap the SDK seals, addressed as postWrap addresses it', async () => {
    const evo = await import('@dashevo/evo-sdk')
    await evo.EvoSDK.getLatestVersionNumber()
    const dataContract = evo.DataContract.fromJSON(rc1Contracts()['forge-collab'] as Parameters<typeof evo.DataContract.fromJSON>[0], true, 14)
    const key = (hex: string) =>
      new evo.IdentityPublicKey({ keyId: 4, purpose: 'encryption', securityLevel: 'medium', keyType: 'ecdsa_secp256k1', data: Uint8Array.from(Buffer.from(hex, 'hex')) })
    const raw = new Uint8Array(32).fill(0x5a)
    for (const epoch of [0, 3]) {
      const keys = await EpochKeys.import(decodeIdentifier(REPO.repoId), epoch, raw)
      const props = await sealWrap(new evo.EvoSDK().encryptedFor, keys, raw, {
        dataContract,
        senderKey: key(SENDER.pub),
        senderPrivateKey: evo.PrivateKey.fromHex(SENDER.priv, 'testnet'),
        recipientKey: key(RECIPIENT_PUB),
      })
      await expectRc1Valid('repoKey', repoKeyData(REPO.repoId, BOB, epoch, props), ALICE)
    }
  })

  /**
   * A sealed release (§16): its sealed file and asset list stored on the publisher's storage (a
   * scripted store here), the kind-4 `packManifest` that records the list, and the release itself,
   * all judged by the RC1 contracts as the signer made them.
   */
  describe('a sealed release', () => {
    const PRIVATE: RepoRef = { ...REPO, visibility: 'private' }
    const stored: Uint8Array[] = []
    let list: ReleaseList = { current: [], previous: [] }
    const envFor = async (epoch = 0): Promise<SealedReleaseEnv> => {
      const keys = await EpochKeys.import(decodeIdentifier(REPO.repoId), epoch, new Uint8Array(32).fill(0x5a))
      return {
        requireMaintainer: async () => undefined,
        writeKeys: async () => keys,
        releases: async () => ({ list, keys: new Map([[epoch, keys]]) }),
        openManifest: async () => {
          throw new Error('no asset list in this test')
        },
        storedLists: async () => [],
        storedHeader: async () => {
          throw new Error('no stored file in this test')
        },
        store: async (sealed, sha256Hex) => {
          stored.push(sealed)
          const h = Buffer.from(await crypto.subtle.digest('SHA-256', sealed as BufferSource)).toString('hex')
          expect(sha256Hex).toBe(h)
          return { sha256: h, sizeBytes: sealed.length, uris: [`https://pub.example/rel/packs/${h}.pack`], confirmed: ['r2'], failures: [] }
        },
      }
    }
    const file = (name: string, text: string) => ({ name, size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer })

    beforeEach(() => {
      stored.length = 0
      list = { current: [], previous: [] }
    })

    it('a publish with a file: the kind-4 packManifest (objectCount 0, no tips, no supersedes), then the release with exactly its sealed props', async () => {
      const r = await createRelease(sdk, auth(ALICE), PRIVATE, { tagName: 'v1.0.0', name: 'One', notes: 'first', draft: true }, { env: await envFor(), files: [file('app.tar.gz', 'bytes')] })
      const made = await judged()
      expect(types(made)).toEqual(['packManifest', 'release'])
      const [manifest, release] = made
      expect(manifest?.data).toMatchObject({ kind: 4, objectCount: 0, chunkCount: 0, storage: 1 })
      expect(manifest?.data['tips']).toBeUndefined()
      expect(manifest?.data['supersedes']).toBeUndefined()
      // The sealed file and the list, each stored under its own (sealed) hash.
      expect(stored).toHaveLength(2)
      expect(Object.keys(release?.data ?? {}).sort()).toEqual(['delta', 'enc', 'epoch', 'repoId', 'tagName', 'vis'])
      expect(release?.data).toMatchObject({ vis: 'private', delta: 0, epoch: 0 })
      expect(release?.data['tagName']).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(r.sealed?.resolved.fields).toMatchObject({ tag: 'v1.0.0', name: 'One', notes: 'first', draft: true })
      expect(r.sealed?.resolved.fields.assetManifest).toBe(Buffer.from(manifest?.data['packHash'] as Uint8Array).toString('hex'))
    })

    it('a yank of nothing else: one release document, nothing stored, and a revision under epoch 3 is as valid', async () => {
      await createRelease(sdk, auth(ALICE), PRIVATE, { tagName: 'v1.0.0', yanked: true }, { env: await envFor(3) })
      const made = await judged()
      expect(types(made)).toEqual(['release'])
      expect(made[0]?.data).toMatchObject({ vis: 'private', delta: 0, epoch: 3 })
      expect(stored).toHaveLength(0)
    })

    it('notes over the budget continue in a list of no assets: a kind-4 manifest still, and the release', async () => {
      const r = await createRelease(sdk, auth(ALICE), PRIVATE, { tagName: 'v2', notes: 'n'.repeat(3000) }, { env: await envFor() })
      expect(types(await judged())).toEqual(['packManifest', 'release'])
      expect(r.sealed?.resolved.fields).toMatchObject({ notesContinue: true })
      expect(r.sealed?.resolved.assets).toEqual([])
    })
  })
})

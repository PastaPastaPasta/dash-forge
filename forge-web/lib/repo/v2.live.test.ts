/**
 * Live forge-v2 read smoke — SKIPPED by default (needs network + WASM).
 *
 * Run with:
 *   FORGE_LIVE=1 NEXT_PUBLIC_NETWORK=devnet NEXT_PUBLIC_DEVNET_NAME=bonsia \
 *     pnpm exec vitest run lib/repo/v2.live.test.ts
 *
 * Reads the forge-v2 fixture `forge-contracts/scripts/seed-v2-fixture.mjs` seeds on bonsia
 * end to end through the same functions the pages use: resolution by `(owner, name)` and by
 * DPNS-less id, refs, config, membership, the issue/PR folds over `event` + `authorEvent`,
 * approvals, and the browse plane (locator + Platform chunks, hash-checked objects).
 *
 * The second test is the review-parity contract (`docs/design/review-parity-spec.md` §3), with
 * the devnet's test identities in `~/.config/dash-forge/test-identities/devnet-<name>/` (a few
 * cents of spend):
 *
 * 1. The fixture's review-parity PR (`loadSeedPulls().reviewParity`; issues and PRs share one
 *    dense per-repo number sequence, forge-v2.md §6.2, so it is no longer the small constant 3)
 *    holds one document of every changed or new type, read back with proofs: a draft state (a
 *    kind-14 `transition`, `PR_DRAFT`; `patch` itself carries no `draft` field), the author's
 *    `headUpdate` / `threadResolve` (`authorEvent` kinds 16, 11), a member's `reviewRequest` /
 *    `reviewDismiss` (`event` kinds 13, 15 with `refId`), a `review` with `commentCount`, a
 *    multi-line `comment` attached by `reviewId`, and a `policy`. The new indexes answer:
 *    `sourceRef`, `reply`, `addressee`, and the review and comment counts per PR.
 * 2. In a scratch repo (the read fixture is left as its seeder wrote it), what the spec says
 *    is refused is refused: a `comment` naming another reviewer's review
 *    (the `$ownerId` agreement, 40127), a `policy` by a writer (maintainer gate, 40120), an
 *    `authorEvent` by a non-author (40120), and an author's merge, label or dismissal (the
 *    `kind` enum; the SDK runs the node's document schema check before broadcasting, so this
 *    one never reaches the chain).
 * 3. The author's replace of the title and body succeeds and moves `$updatedAt` and
 *    `$updatedAtBlockHeight`; a replace moving `headOid` is refused (immutable, 40128).
 *
 * Never gates CI.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadSeedPulls, seedRepo } from '../../e2e/seed-summary'
import { DEFAULT_NETWORK, NETWORKS } from '../constants'
import { PR_DRAFT } from '../rules/v2'
import { asConsensusRefusal, evoSdkService } from '../sdk'
import { commitRootTree, loadBrowseContext, loadIssueThread, loadPullThread, loadRepoHome, readTree } from '../view'
import { listRecentRepos, listReposByOwner } from '../view/discovery'
import { queryIssues, queryPulls, readMemberships } from './index'
import { readTargetCounts } from './social'

const LIVE = process.env['FORGE_LIVE'] === '1' && DEFAULT_NETWORK === 'devnet'

const ID_DIR = join(homedir(), '.config/dash-forge/test-identities', NETWORKS[DEFAULT_NETWORK].key)
/** An identity id from the devnet's fixture pool, or '' when the file is not here (not LIVE). */
const poolId = (role: string): string => {
  const file = join(ID_DIR, `${role}.identity.json`)
  return existsSync(file) ? String((JSON.parse(readFileSync(file, 'utf8')) as { identityId: string }).identityId) : ''
}
// The fixture's seeders, as the committed seed summary records them (OWNER seeds forge-v2-demo,
// MAINTAINER forge-v2-empty); COLLAB is the pool's writer.
const OWNER = seedRepo('demo')?.owner ?? ''
const MAINTAINER = seedRepo('empty')?.owner ?? ''
const COLLAB = poolId('COLLAB')
const MAIN_TIP = 'b35c50122cd51b2cc0345760721e6398fa0c31f5'
const C2 = 'b35c50122cd51b2cc0345760721e6398fa0c31f5'
const C3 = '3a1300eb2441ef94fd927dbfc7548d34fbb8edc5'

interface KeyRecord {
  readonly id: number
  readonly purpose: string
  readonly securityLevel: string
  readonly privateKeyWif: string
  readonly publicKeyHex: string
}
interface IdentityRecord {
  readonly identityId: string
  readonly identityKeys: readonly KeyRecord[]
}

type Evo = typeof import('@dashevo/evo-sdk')

const hex = (v: unknown): string => {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex')
  if (typeof v === 'string') return Buffer.from(v, 'base64').toString('hex')
  throw new TypeError('not bytes')
}

describe.skipIf(!LIVE)('live forge-v2 reads (bonsia fixture)', () => {
  it(
    'resolves, folds and browses the fixture repo',
    async () => {
      const pulls = loadSeedPulls()
      await evoSdkService.initialize({ network: 'devnet', contractIds: [], timeoutMs: 20000 })
      const sdk = evoSdkService.getSdk()

      const home = await loadRepoHome(sdk, { network: 'devnet', owner: OWNER, name: 'forge-v2-demo' })
      if (home === null) throw new Error('forge-v2-demo did not resolve')
      expect(home.defaultBranch).toBe('main')
      expect(home.starCount).toBe(1)
      const main = home.branches.find((b) => b.refName === 'refs/heads/main')
      expect(main?.state).toMatchObject({ state: 'resolved', oid: MAIN_TIP })
      expect(home.tags.map((t) => t.refName)).toEqual(['refs/tags/v0.1.0'])

      // `?repo=` pin resolves the same repo; a wrong owner does not.
      const pinned = await loadRepoHome(sdk, {
        network: 'devnet',
        owner: OWNER,
        name: 'ignored',
        repoId: home.repo.repoId,
      })
      expect(pinned?.repo.repoId).toBe(home.repo.repoId)
      expect(
        await loadRepoHome(sdk, { network: 'devnet', owner: MAINTAINER, name: 'x', repoId: home.repo.repoId }),
      ).toBeNull()

      const members = await readMemberships(sdk, home.repo)
      expect(members.map((m) => `${m.role}:${m.identity}`).sort()).toEqual(
        [`maintainer:${OWNER}`, `maintainer:${MAINTAINER}`, `writer:${COLLAB}`].sort(),
      )

      const issues = (await queryIssues(sdk, home.repo, { state: 'all', labels: [], author: null, assignee: null, mentions: null, sort: 'newest', text: '', page: 1, pageSize: 100 } as const, null)).rows
      const byNumber = new Map(issues.map((i) => [i.number, i]))
      expect(byNumber.get(1)?.state).toMatchObject({ open: true, labels: ['question'] })
      expect(byNumber.get(2)?.state.open).toBe(false) // the author's own authorEvent close
      expect(byNumber.get(3)?.state).toMatchObject({ open: false, labels: ['docs'] })

      const prList = (await queryPulls(sdk, home.repo, { state: 'all', labels: [], author: null, assignee: null, sort: 'newest', text: '', page: 1, pageSize: 100 } as const, null)).rows
      const pr = new Map(prList.map((p) => [p.number, p]))
      expect(pr.get(pulls.approved)?.state).toMatchObject({ open: true, merged: false })
      expect(pr.get(pulls.merged)?.state.merged).toBe(true)
      expect(pr.get(pulls.approved)?.sourceId).toBe(home.repo.repoId)

      const thread = await loadPullThread(sdk, home.repo, pulls.approved)
      expect(thread?.approvals?.approvers).toEqual([MAINTAINER])
      const issue2 = await loadIssueThread(sdk, home.repo, 2)
      expect(issue2?.timeline.some((t) => t.kind === 'event' && t.byAuthor === true)).toBe(true)

      const browse = await loadBrowseContext(sdk, home.repo)
      expect(browse.kind).toBe('ready')
      if (browse.kind !== 'ready') throw new Error('unreachable')
      const { tree } = await commitRootTree(browse.context.reader, MAIN_TIP)
      const names = (await readTree(browse.context.reader, tree)).map((e) => e.name).sort()
      expect(names).toEqual(['README.md', 'docs', 'lib', 'src'])

      // The feed's composite read (a page of repos + star and issue counts under one proof).
      // Other suites create many repos on the devnet, so the fixture is not on its first page;
      // its provable counts are read directly (the same countable indexes).
      const feed = await listRecentRepos(sdk, { network: 'devnet', limit: 100 })
      expect(feed.length).toBeGreaterThan(0)
      expect(await readTargetCounts(sdk, home.repo.forge, home.repo.repoId)).toEqual({ issues: 4, pulls: 3 })

      const profile = await listReposByOwner(sdk, MAINTAINER, { network: 'devnet' })
      expect(profile.owned.map((r) => r.slug)).toContain('forge-v2-empty')
      expect(profile.member.map((r) => r.slug)).toContain('forge-v2-demo')
    },
    180000,
  )

  it(
    'reads every changed type from the fixture and refuses what the spec refuses',
    async () => {
      const pulls = loadSeedPulls()
      const ids = NETWORKS.devnet.v2
      if (ids === null) throw new Error('no forge-v2 deployment for the devnet')
      const evo: Evo = await import('@dashevo/evo-sdk')
      await evoSdkService.initialize({ network: 'devnet', contractIds: [ids.core, ids.collab], timeoutMs: 30000 })
      const sdk = evoSdkService.getSdk()
      const version = sdk.version()

      const signerOf = (name: string) => {
        const rec: IdentityRecord = JSON.parse(readFileSync(join(ID_DIR, `${name}.identity.json`), 'utf8'))
        const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'HIGH')
        if (k === undefined) throw new Error(`${name} has no HIGH authentication key`)
        const identityKey = new evo.IdentityPublicKey({
          keyId: k.id,
          purpose: 'authentication',
          securityLevel: 'high',
          keyType: 'ecdsa_secp256k1',
          data: Buffer.from(k.publicKeyHex, 'hex'),
        })
        const signer = new evo.IdentitySigner()
        signer.addKey(evo.PrivateKey.fromWIF(k.privateKeyWif))
        return { id: rec.identityId, identityKey, signer }
      }
      const COLLAB = signerOf('COLLAB')
      const CONTRIB = signerOf('CONTRIB')
      const MAINTAINER = signerOf('MAINTAINER')

      type Where = readonly (readonly [string, string, unknown])[]
      const query = async (type: string, where: Where, orderBy?: readonly (readonly [string, string])[]) => {
        const res = await sdk.documents.query({
          dataContractId: ids.collab,
          documentTypeName: type,
          where: where as never,
          ...(orderBy ? { orderBy: orderBy as never } : {}),
          limit: 100,
        })
        return [...res.values()].filter((d) => d !== undefined).map((d) => d!.toJSON(14) as Record<string, unknown>)
      }
      const count = async (type: string, where: Where): Promise<bigint> => {
        const res = await sdk.documents.count({ dataContractId: ids.collab, documentTypeName: type, where: where as never })
        let n = 0n
        for (const v of res.values()) n += v
        return n
      }
      const create = async (who: ReturnType<typeof signerOf>, type: string, data: Record<string, unknown>) => {
        const base = new evo.Document({ properties: {}, documentTypeName: type, dataContractId: ids.collab, ownerId: who.id })
        const document = evo.Document.fromObject({ ...base.toObject(), ...data }, version)
        const created = await sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer })
        return created.id.toBase58()
      }
      /**
       * The write is refused: a consensus code from the node, or, for a document the schema
       * itself refuses, rs-dpp's JSON-schema error. The SDK runs the same document schema
       * validation a node's basic validation runs before it broadcasts, so a schema refusal
       * never reaches the chain from this SDK; it is reported as code 0.
       */
      const refused = async (label: string, write: () => Promise<unknown>): Promise<number> => {
        try {
          await write()
        } catch (e) {
          const refusal = asConsensusRefusal(e)
          if (refusal !== null) return refusal.code
          let message = ''
          try {
            message = String((e as { message?: unknown }).message ?? e)
          } catch {
            /* a freed wasm object */
          }
          if (/JsonSchemaError/.test(message)) return 0
          throw new Error(`${label}: failed without a consensus code or schema error: ${message}`)
        }
        throw new Error(`${label}: consensus accepted it`)
      }

      // --- 1. the fixture ---------------------------------------------------------------
      const repoRes = await sdk.documents.query({
        dataContractId: ids.core,
        documentTypeName: 'repo',
        where: [['$ownerId', '==', OWNER], ['name', '==', 'forge-v2-demo']],
        limit: 1,
      })
      const repo = [...repoRes.values()][0]?.toJSON(14) as Record<string, unknown> | undefined
      if (repo === undefined) throw new Error('forge-v2-demo not found')
      const repoId = String(repo['$id'])
      const [pr] = await query('patch', [['repoId', '==', repoId], ['number', '==', pulls.reviewParity]])
      if (pr === undefined) throw new Error(`fixture review-parity PR #${pulls.reviewParity} not found: run seed-v2-fixture.mjs`)
      const prId = String(pr['$id'])
      // `patch` itself no longer carries a `draft` field: draft is folded from `transition`s
      // (kind 14 = PR_DRAFT, docs/contracts/forge-v2.md §3).
      const draftTransitions = await query('transition', [['targetId', '==', prId], ['kind', '==', PR_DRAFT]])
      expect(draftTransitions.length).toBeGreaterThan(0)
      expect(hex(pr['headOid'])).toBe(C2)
      expect(pr['$updatedAt']).toBeDefined()

      const authorEvents = await query('authorEvent', [['targetId', '==', prId]], [['$createdAt', 'asc']])
      const byKind = new Map(authorEvents.map((e) => [Number(e['kind']), e]))
      expect(hex(byKind.get(16)?.['oid'])).toBe(C3)
      const resolvedRoot = String(byKind.get(11)?.['refId'])
      const events = await query('event', [['targetId', '==', prId]], [['$createdAt', 'asc']])
      const request = events.find((e) => Number(e['kind']) === 13)
      const dismissal = events.find((e) => Number(e['kind']) === 15)
      expect(request?.['refId']).toBe(MAINTAINER.id)
      expect(dismissal?.['value']).toBe('the author answered the suggestion')

      const [review] = await query('review', [['patchId', '==', prId]], [['$createdAt', 'asc']])
      expect(review?.['commentCount']).toBe(1)
      expect(dismissal?.['refId']).toBe(review?.['$id'])
      const comments = await query('comment', [['targetId', '==', prId]], [['$createdAt', 'asc']])
      const anchored = comments.find((c) => c['reviewId'] !== undefined)
      expect(anchored).toMatchObject({ reviewId: review?.['$id'], startLine: 2, line: 3, side: 1, path: 'src/main.rs' })
      expect(anchored?.['$id']).toBe(resolvedRoot)

      const [policy] = await query('policy', [['repoId', '==', repoId]], [['$createdAt', 'asc']])
      expect(policy).toMatchObject({ requiredApprovals: 1, approverRole: 1, mergeMethods: 3 })

      // the new indexes
      const fromBranch = await query('patch', [
        ['sourceRepoId', '==', repoId],
        ['sourceRefNameHash', '==', pr['sourceRefNameHash']],
      ])
      expect(fromBranch.map((p) => p['number'])).toContain(pulls.reviewParity)
      const replies = await query('comment', [['replyTo', '==', resolvedRoot]])
      expect(replies.map((c) => c['$ownerId'])).toEqual([CONTRIB.id])
      const addressed = await query('event', [['refId', '==', MAINTAINER.id]])
      expect(addressed.some((e) => e['$id'] === request?.['$id'])).toBe(true)
      expect(await count('review', [['patchId', '==', prId]])).toBe(1n)
      expect(await count('comment', [['targetId', '==', prId]])).toBe(BigInt(comments.length))

      // --- 2. writes, in a scratch repo so the read fixture stays as its seeder left it ---------
      // (e2e/helpers.ts: only the seeder writes the fixture). OWNER owns and maintains the scratch
      // repo, COLLAB is its writer, CONTRIB authors its PR and MAINTAINER reviews it.
      const OWNER_W = signerOf('OWNER')
      const createIn = async (contractId: string, who: ReturnType<typeof signerOf>, type: string, data: Record<string, unknown>) => {
        const base = new evo.Document({ properties: {}, documentTypeName: type, dataContractId: contractId, ownerId: who.id })
        const document = evo.Document.fromObject({ ...base.toObject(), ...data }, version)
        const created = await sdk.documents.create({ document, identityKey: who.identityKey, signer: who.signer })
        return created.id.toBase58()
      }
      const bytesOf = (id: string) => evo.Identifier.fromBase58(id).toBytes()
      const scratch = await createIn(ids.core, OWNER_W, 'repo', { name: `review-parity-${Date.now().toString(36)}`, visibility: 'public' })
      const R = bytesOf(scratch)
      await createIn(ids.core, OWNER_W, 'maintainer', { repoId: R, memberId: bytesOf(OWNER_W.id) })
      await createIn(ids.core, OWNER_W, 'writer', { repoId: R, memberId: bytesOf(COLLAB.id) })
      const sha = (name: string) => new Uint8Array(createHash('sha256').update(name).digest())
      const scratchPr = await create(CONTRIB, 'patch', {
        repoId: R,
        number: 1,
        title: 'Scratch PR',
        body: 'first',
        baseRefNameHash: sha('refs/heads/main'),
        baseRefName: 'refs/heads/main',
        sourceRepoId: R,
        headOid: Buffer.from(C2, 'hex'),
      })
      const P = bytesOf(scratchPr)
      const scratchReview = await create(MAINTAINER, 'review', {
        repoId: R,
        patchId: P,
        verdict: 3,
        commitOid: Buffer.from(C2, 'hex'),
        commentCount: 1,
      })
      const reviewBytes = bytesOf(scratchReview)
      // the reviewer attaches a comment to their own review: accepted
      await create(MAINTAINER, 'comment', { repoId: R, targetId: P, reviewId: reviewBytes, body: 'mine', path: 'a', line: 1, side: 1 })
      // COLLAB attaching a comment to MAINTAINER's review: the $ownerId agreement (40127)
      expect(
        await refused('comment on another reviewer’s review', () =>
          create(COLLAB, 'comment', { repoId: R, targetId: P, reviewId: reviewBytes, body: 'not mine to attach' }),
        ),
      ).toBe(40127)
      // the author may not merge, label or dismiss: the schema's kind enum (a schema refusal)
      for (const kind of [3, 4, 15]) {
        expect(
          await refused(`authorEvent kind ${kind}`, () =>
            create(CONTRIB, 'authorEvent', { repoId: R, targetId: P, targetNumber: 1, kind, refId: reviewBytes }),
          ),
        ).toBe(0)
      }
      // the author may resolve and move the head
      await create(CONTRIB, 'authorEvent', { repoId: R, targetId: P, targetNumber: 1, kind: 16, oid: Buffer.from(C3, 'hex') })
      // a writer may not set the policy (maintainer-only gate); the maintainer may
      expect(
        await refused('policy by a writer', () => create(COLLAB, 'policy', { repoId: R, requiredApprovals: 0 })),
      ).toBe(40120)
      await create(OWNER_W, 'policy', { repoId: R, requiredApprovals: 1 })
      // someone other than the author may not post an authorEvent
      expect(
        await refused('authorEvent by a non-author', () =>
          create(COLLAB, 'authorEvent', { repoId: R, targetId: P, targetNumber: 1, kind: 16, oid: Buffer.from(C2, 'hex') }),
        ),
      ).toBe(40120)

      // --- 3. replace: the author edits title and body; headOid is frozen ---------------------
      const fetched = await sdk.documents.get(ids.collab, 'patch', scratchPr)
      if (fetched === undefined) throw new Error('the scratch PR is not readable')
      const before = fetched.toJSON(14) as Record<string, unknown>
      const replaceWith = async (props: Record<string, unknown>) => {
        const doc = evo.Document.fromObject(
          { ...fetched.toObject(), ...props, $revision: BigInt(fetched.revision ?? 1n) + 1n },
          version,
        )
        await sdk.documents.replace({ document: doc, identityKey: CONTRIB.identityKey, signer: CONTRIB.signer })
      }
      expect(
        await refused('moving headOid by replace', () => replaceWith({ headOid: Buffer.from(C3, 'hex') })),
      ).toBe(40128)
      await replaceWith({ title: 'Scratch PR, edited', body: 'second' })
      const [edited] = await query('patch', [['repoId', '==', scratch], ['number', '==', 1]])
      expect(edited).toMatchObject({ title: 'Scratch PR, edited', body: 'second' })
      expect(Number(edited?.['$updatedAt'])).toBeGreaterThan(Number(before['$updatedAt']))
      expect(Number(edited?.['$updatedAtBlockHeight'])).toBeGreaterThan(Number(before['$updatedAtBlockHeight']))
      expect(hex(edited?.['headOid'])).toBe(C2)
    },
    300000,
  )
})

/**
 * A maintainer makes other people's members-only posts public with a make-public bundle
 * (mixed-visibility DESIGN §4.6, D5, §3.5, §10; the format is `lib/private/bundle.ts`, the reader
 * `made-public.ts`, the CLI's twin forge-core `Collab::bundle_plan` / `write_bundle`). Each post's
 * current revision (and with "Also publish earlier edits", an issue's earlier members-only
 * revisions) gets one entry: its per-object key `K_obj`, derived under the members key the post
 * was sealed with, or for a message to specific people unwrapped from the maintainer's own slot.
 * The bundle is stored on Platform chunks (every reader, anonymous and the gateway included, must
 * find it) with a kind-7 `packManifest`.
 *
 * Everything is checked before anything is signed: the repo is public, the signer a current
 * maintainer or the owner (read now), and each post is left out, with the reason, when it is
 * public already, unreadable to the signer, a message not sent to them, continued in a separate
 * members-only long-body artifact (decision P2B-D4), or a pull request's own text (phase 3).
 *
 * Keys: {@link planMakePublicBundle} derives each key only to check it and wipes it at once; the
 * write ({@link writeMakePublicBundle}) derives them again, encodes the bundle, stores it and
 * wipes every key and the encoded bytes when done. No key is logged or kept.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { encryptionOps, fetchIdentityKeys, withLetterReader } from '../auth/encryption-key'
import { PACK_KIND } from '../constants'
import { ownerKeysOf } from '../env/sources'
import {
  MAX_DOC_ENTRIES,
  V3,
  V4,
  encodeDocBundle,
  entryKind,
  letterObjKey,
  membersObjKey,
  openContent,
  openLetter,
  type DocBundleEntry,
  type DocFields,
  type StoredPrivateDoc,
} from '../private'
import { parseLongBody } from '../rules/long-body'
import { queryDocumentsWithProof, type PlainDocument, type WriteAuth, type WriteResult } from '../sdk'
import { estimateChunkCredits } from '../sdk/cost'
import { storeArtifact } from '../storage/upload'
import { asIdentifierString, withoutSessions, type RepoRef } from './contract'
import { invalidateRepoFeed } from './issues'
import { LONG_BODY_MANIFEST_CREDITS } from './long-body'
import { MakePublicRefusedError } from './make-public-writes'
import { bundledFields, invalidateRepoBundles, readDocumentHistory } from './made-public'
import { readMaintainers } from './members'
import { forgetMembersTexts } from './members-texts'
import { forgetStoredDoc, noteAudience } from './members-writes'
import { isSealedDoc, storedPrivateDoc } from './private-content'
import { loadPrivateSessionUncached, sessionUnwrapper, type PrivateSession } from './private-session'
import { writePackManifest } from './push'
import { contractOf } from './source'

/** What a bundle is asked to make public: a post of a public repo, by type and id. */
export interface BundleRequest {
  readonly type: 'issue' | 'patch' | 'comment' | 'review'
  readonly id: string
}

/** The kinds a bundle publishes. */
export type BundledKind = 'issue' | 'comment' | 'review'

/** Why a post asked for is left out of a bundle (forge-core `LeftOutWhy`). */
export type LeftOutWhy = 'alreadyPublic' | 'unreadable' | 'notSent' | 'longBody' | 'pullRequest'

/** A post left out, and why. */
export interface LeftOutPost {
  readonly type: BundleRequest['type']
  readonly id: string
  /** Its author (base58). */
  readonly author: string
  readonly why: LeftOutWhy
}

/** A post a bundle makes public. */
export interface BundledPost {
  readonly type: BundledKind
  readonly id: string
  /** Its author (base58): whose words become public. */
  readonly author: string
  /** An issue's number. */
  readonly number: number | null
  /** The revisions published, its current one last. */
  readonly revisions: readonly number[]
  /** A message to specific people: how many people it was sent to (the sender included); null for members-only. */
  readonly recipients: number | null
  /** Its text as it reads now (an issue's title and body), for the quote check. */
  readonly text: string
  /** Earlier members-only revisions of an issue the signer can open and nobody published yet. */
  readonly earlier: number
}

/** What a maintainer's bundle will publish, checked before anything is signed. */
export interface BundlePlan {
  readonly posts: readonly BundledPost[]
  readonly leftOut: readonly LeftOutPost[]
  /** How many entries (post revisions) the bundle carries. */
  readonly entries: number
  /** Earlier members-only revisions "Also publish earlier edits" would add (0: no checkbox). */
  readonly earlier: number
}

/** The bundle's size in bytes: the 7-byte header and 69 bytes per entry, no note. */
export function bundleBytes(entries: number): number {
  return 7 + 69 * entries
}

/**
 * What storing a bundle of `entries` costs, as the composer quotes a long body's artifact: the
 * manifest priced as the repo's first of its kind, and its bytes as Platform chunks. An upper
 * bound (S6 measured 0.00224 DASH for two entries).
 */
export function bundleCredits(entries: number): number {
  return LONG_BODY_MANIFEST_CREDITS + estimateChunkCredits(bundleBytes(entries))
}

const NOT_MAINTAINER = "Only maintainers can make other people's posts public. Ask a maintainer"

/** The stored `type` document `id` of `repo`, read now (one proof-checked read), or null. */
async function readNow(sdk: EvoSDK, repo: RepoRef, type: string, id: string): Promise<PlainDocument | null> {
  const { documents } = await queryDocumentsWithProof(sdk, { dataContractId: contractOf(repo.forge, type), documentTypeName: type, where: [['$id', '==', id]], limit: 1 })
  const doc = documents[0]
  return doc !== undefined && asIdentifierString(doc['repoId']) === repo.repoId ? doc : null
}

/** A document's `$revision` (1 when not recorded). */
function revisionOf(doc: PlainDocument): number {
  const r = doc['$revision']
  return typeof r === 'number' && r > 0 ? r : typeof r === 'bigint' ? Number(r) : 1
}

/** Whether opened `fields` carry a text that continues in a separate artifact (a long body's trailer). */
function continued(fields: DocFields): boolean {
  return fields.body !== undefined && parseLongBody(fields.body).kind !== 'plain'
}

/**
 * Refuse, before signing, a bundle from anyone but a current maintainer or the owner of public
 * `repo` (read now): other people's words go public only through a maintainer (DESIGN §3.5);
 * readers ignore anyone else's bundle, and on mainnet consensus refuses it (C3).
 */
async function requireBundleWriter(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef): Promise<void> {
  if (repo.visibility !== 'public') throw new MakePublicRefusedError("This repo is private: its posts can't be made public one at a time")
  if (auth.identityId === repo.ownerId) return
  if (!(await readMaintainers(sdk, repo)).includes(auth.identityId)) throw new MakePublicRefusedError(NOT_MAINTAINER)
}

/** Whether `identity` may write a bundle in `repo` now: the owner or a current maintainer (read now). */
export async function canMakeOthersPublic(sdk: EvoSDK, repo: RepoRef, identity: string | null): Promise<boolean> {
  if (identity === null || repo.visibility !== 'public') return false
  return identity === repo.ownerId || (await readMaintainers(sdk, repo)).includes(identity)
}

/** The signer's members-key session (null: no encryption key in this browser). Closed by the caller. */
async function keySession(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef): Promise<PrivateSession | null> {
  const ops = await encryptionOps(sdk, auth.network, auth.identityId, repo.forge.collab)
  if (ops === null) return null
  return loadPrivateSessionUncached(sdk, withoutSessions(repo), auth.network, auth.identityId, sessionUnwrapper(ops))
}

/** A post's key as the signer reads it, and its text; or why it is left out. */
type PostKey = { readonly key: Uint8Array; readonly fields: DocFields; readonly recipients: number | null } | { readonly why: LeftOutWhy }

/**
 * The per-object key of the signer's view of sealed post `stored` (forge-core `post_key`): a
 * members-only post opened with the members key, a message to specific people from the signer's
 * own slot, after the whole letter reader rule.
 */
async function postKey(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, session: PrivateSession | null, stored: StoredPrivateDoc): Promise<PostKey> {
  if (stored.enc[0] === V3) {
    if (session === null) return { why: 'unreadable' }
    const opened = await openContent(stored, session.ctx)
    if (opened.status !== 'readable') return { why: 'unreadable' }
    if (continued(opened.fields)) return { why: 'longBody' }
    const keys = session.resolution.keys.get(stored.epoch)
    const key = keys === undefined ? null : await membersObjKey(keys, stored, stored.enc)
    return key === null ? { why: 'unreadable' } : { key, fields: opened.fields, recipients: null }
  }
  if (stored.enc[0] === V4) {
    const ownerKeys = ownerKeysOf((await fetchIdentityKeys(sdk, base58Encode(stored.ownerId))) ?? [])
    const repoId = decodeIdentifier(repo.repoId)
    return withLetterReader(auth.network, auth.identityId, async (reader) => {
      const opened = await openLetter(repoId, stored, ownerKeys, reader)
      if (opened.status !== 'readable') return { why: 'notSent' as const }
      if (continued(opened.fields)) return { why: 'longBody' as const }
      const key = await letterObjKey(repoId, stored, ownerKeys, reader)
      return key === null ? { why: 'notSent' as const } : { key, fields: opened.fields, recipients: opened.recipients.length }
    }).catch(() => ({ why: 'notSent' as const }))
  }
  return { why: 'unreadable' }
}

/**
 * Plan (and, with `keep`, collect the entries of) a maintainer's bundle making `requests` public.
 * The caller wipes every collected key.
 */
async function plan(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  requests: readonly BundleRequest[],
  history: boolean,
  keep: DocBundleEntry[] | null,
): Promise<BundlePlan> {
  await requireBundleWriter(sdk, auth, repo)
  const session = await keySession(sdk, auth, repo).catch(() => null)
  const posts: BundledPost[] = []
  const leftOut: LeftOutPost[] = []
  let entries = 0
  let earlierTotal = 0
  const take = (e: DocBundleEntry): void => {
    entries += 1
    if (keep !== null) keep.push(e)
    else e.key.fill(0)
  }
  try {
    const seen = new Set<string>()
    for (const r of requests) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      const doc = await readNow(sdk, repo, r.type, r.id)
      if (doc === null) throw new MakePublicRefusedError(`A ${r.type === 'patch' ? 'pull request' : r.type} asked for could not be read; try again in a moment`)
      const author = asIdentifierString(doc['$ownerId'])
      const leave = (why: LeftOutWhy): void => {
        leftOut.push({ type: r.type, id: r.id, author, why })
      }
      if (!isSealedDoc(doc)) {
        leave('alreadyPublic')
        continue
      }
      // A pull request's own text is phase 3 (its comments and reviews are bundled).
      if (r.type === 'patch') {
        leave('pullRequest')
        continue
      }
      const kind = entryKind(r.type) as number
      if ((await bundledFields(sdk, repo, r.type, doc)) !== null) {
        leave('alreadyPublic')
        continue
      }
      const stored = storedPrivateDoc(r.type, doc, 'public')
      if (stored === null || stored.id === undefined) {
        leave('unreadable')
        continue
      }
      const got = await postKey(sdk, auth, repo, session, stored)
      if ('why' in got) {
        leave(got.why)
        continue
      }
      const revisions: number[] = []
      let earlier = 0
      // An issue's earlier members-only revisions (Platform keeps an issue's history; a letter's
      // revisions are not read).
      if (r.type === 'issue' && got.recipients === null && session !== null) {
        const old = (await readDocumentHistory(sdk, repo, 'issue', r.id).catch(() => [] as PlainDocument[])).filter(
          (h) => revisionOf(h) < revisionOf(doc) && isSealedDoc(h),
        )
        for (const h of old) {
          const row: PlainDocument = { ...doc, ...h, $id: doc['$id'], $ownerId: doc['$ownerId'], $revision: revisionOf(h) }
          if ((await bundledFields(sdk, repo, 'issue', row)) !== null) continue
          const s = storedPrivateDoc('issue', row, 'public')
          const keys = s === null ? undefined : session.resolution.keys.get(s.epoch)
          const key = s === null || keys === undefined ? null : await membersObjKey(keys, s, s.enc)
          if (key === null) continue
          earlier += 1
          if (history) {
            take({ kind, target: stored.id, revision: revisionOf(h), key })
            revisions.push(revisionOf(h))
          } else key.fill(0)
        }
      }
      take({ kind, target: stored.id, revision: revisionOf(doc), key: got.key })
      revisions.push(revisionOf(doc))
      earlierTotal += earlier
      posts.push({
        type: r.type,
        id: r.id,
        author,
        number: typeof doc['number'] === 'number' ? doc['number'] : null,
        revisions,
        recipients: got.recipients,
        text: [got.fields.title, got.fields.body].filter((t): t is string => t !== undefined && t !== '').join('\n'),
        earlier,
      })
    }
  } finally {
    session?.close()
  }
  if (entries > MAX_DOC_ENTRIES) {
    throw new MakePublicRefusedError(`That is ${entries} posts and earlier versions; at most ${MAX_DOC_ENTRIES} can be made public at once. Make fewer posts public at a time`)
  }
  return { posts, leftOut, entries, earlier: earlierTotal }
}

/**
 * What making `requests` public in `repo` would publish, read and checked now for the dialog: the
 * posts (with their authors and texts), those left out and why, and how many earlier versions
 * "Also publish earlier edits" would add. Refused, before anything is signed, unless the signer
 * is a current maintainer or the owner of a public repo. Keeps no key.
 */
export function planMakePublicBundle(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  requests: readonly BundleRequest[],
  options: { readonly history?: boolean } = {},
): Promise<BundlePlan> {
  return plan(sdk, auth, repo, requests, options.history === true, null)
}

/**
 * Make `requests` public in `repo` with one maintainer's bundle (module docs): checked again from
 * scratch, each key derived again, the bundle stored on Platform with a kind-7 manifest, every key
 * and the encoded bytes wiped after. Refused before anything is stored when nothing is left to
 * publish. Then this tab reads the repo's bundles again and treats every published post as public.
 */
export async function writeMakePublicBundle(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  requests: readonly BundleRequest[],
  options: { readonly history?: boolean; readonly intent?: string } = {},
): Promise<{ readonly plan: BundlePlan; readonly result: WriteResult }> {
  const entries: DocBundleEntry[] = []
  let bytes: Uint8Array | null = null
  try {
    const planned = await plan(sdk, auth, repo, requests, options.history === true, entries)
    if (planned.posts.length === 0) throw new MakePublicRefusedError('There is nothing to make public')
    bytes = encodeDocBundle(entries)
    // Platform only: every reader, anonymous and the gateway included, must find it.
    const stored = await storeArtifact(sdk, auth, repo, bytes, { policy: null, profiles: [], confirmPlatform: async () => true })
    const { packHash, sizeBytes, chunkCount, storage, uris } = stored
    const result = await writePackManifest(
      sdk,
      auth,
      repo,
      { kind: PACK_KIND.MAKE_PUBLIC, objectCount: 0, packHash, sizeBytes, chunkCount, storage, uris },
      options.intent ? `${options.intent}:make-public:${packHash}` : undefined,
    )
    invalidateRepoBundles(repo)
    // Public now: quoting them leaks nothing.
    forgetMembersTexts(repo.repoId, planned.posts.map((p) => p.id))
    for (const p of planned.posts) {
      forgetStoredDoc(repo, p.type, p.id)
      noteAudience(repo, p.id, 'public')
    }
    return { plan: planned, result }
  } finally {
    for (const e of entries) e.key.fill(0)
    bytes?.fill(0)
    invalidateRepoFeed(repo, { counts: false })
  }
}

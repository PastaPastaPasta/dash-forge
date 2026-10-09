/**
 * An author makes their own members-only post public (mixed-visibility DESIGN §4.6, D5; the rules
 * are `lib/rules/make-public.ts`, the CLI's `dg make-public`). An issue, PR or comment is replaced
 * with its text as it reads now in plaintext, dropping `enc` and `epoch`; a review, which cannot
 * be replaced, gets a public comment attached to it that carries its text. Everything is checked
 * before anything is stored or signed: the post is the signer's, sealed, in a public repo, not
 * imported, and (for a comment or review) in a conversation that is public.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import type { DocFields } from '../private/tlv'
import { audienceEdit, blank, makePublicChanges } from '../rules/make-public'
import { precheckEdit, replaceDocumentIdempotent, type ReplaceResult, type WriteAuth, type WriteResult } from '../sdk'
import { DOC, asIdentifierString, contentDocOf, type RepoRef } from './contract'
import { longBodyField } from './long-body'
import { childAudience, forgetStoredDoc, noteAudience, storedAudience } from './members-writes'
import { invalidateRepoFeed } from './issues'
import { PrivateWriteError } from './private-writes'
import { postComment } from './review-writes'
import { contractFor, type PostContext } from './writes'

const PRIVATE_REPO = "This repo is private: its posts can't be made public one at a time"
const NOT_AUTHOR = 'Only its author can make this post public'
const ALREADY_PUBLIC = 'It is already public'

/** Why a post cannot be made public, in words for the person asking. */
export class MakePublicRefusedError extends PrivateWriteError {
  constructor(message: string) {
    super(`${message}; nothing was written`)
    this.name = 'MakePublicRefusedError'
  }
}

/** A post to make public: what it is, and its text as the page opened it. */
export interface MakePublicInput {
  readonly type: 'issue' | 'patch' | 'comment'
  readonly id: string
  /** The opened text (an issue's title and body, a comment's body and inline path, import provenance). */
  readonly opened: DocFields
  /** The revision the page read it at. */
  readonly expectedRevision?: bigint
  /** Drop the membership proof: the signer is no longer a member (the replace re-checks it). */
  readonly dropProof?: boolean
  readonly intent?: string
}

/**
 * Make the signer's own members-only issue, PR or comment `input.id` of public `repo` public: a
 * replace that sets its text in plaintext and removes `enc` and `epoch` (DESIGN §4.6). A long body
 * is stored as a public artifact first. Refused before anything is stored when it is someone
 * else's, already public, in a private repo, imported, or a comment in a members-only conversation.
 */
export async function makePostPublic(sdk: EvoSDK, auth: WriteAuth, repo: RepoRef, input: MakePublicInput): Promise<ReplaceResult> {
  if (repo.visibility !== 'public') throw new MakePublicRefusedError(PRIVATE_REPO)
  // A members-only PR's branch names are sealed and immutable: phase 3 builds it.
  if (input.type === 'patch') throw new MakePublicRefusedError("A pull request can't be made public this way yet")
  const { audience, doc: stored } = await storedAudience(sdk, repo, input.type, input.id)
  const author = asIdentifierString(stored['$ownerId'])
  if (author !== auth.identityId) throw new MakePublicRefusedError(NOT_AUTHOR)
  if (audience === 'public') throw new MakePublicRefusedError(ALREADY_PUBLIC)
  if (stored['vis'] === 'private') throw new MakePublicRefusedError('Posts from before this repo was public can be made public by a maintainer')
  const plan = makePublicChanges(input.type, input.opened)
  if ('error' in plan) {
    throw new MakePublicRefusedError(
      plan.error === 'imported'
        ? "This post was imported, and its original author's name can't be made public"
        : 'This post has no text to make public',
    )
  }
  if (input.type === 'comment') {
    const replyTo = asIdentifierString(stored['replyTo'])
    await publicConversation(sdk, repo, asIdentifierString(stored['targetId']), replyTo === '' ? undefined : replyTo)
  }
  await precheckEdit(sdk, auth, { contractId: contractFor(repo, input.type), documentType: input.type, documentId: input.id, expectRepoId: repo.repoId, expectedRevision: input.expectedRevision })
  const changes: Record<string, unknown> = { ...plan.set }
  for (const f of plan.remove) changes[f] = undefined
  if (input.dropProof) changes['asMember'] = undefined
  // Checked before a long body's public artifact is stored: nothing is stored for a refused replace.
  const outcome = audienceEdit(repo.visibility, contentDocOf(input.type, stored), contentDocOf(input.type, { ...stored, ...changes }), author, auth.identityId)
  if (outcome !== 'makesPublic') throw new MakePublicRefusedError(`This ${input.type} can't be made public as it reads now`)
  const body = plan.set['body']
  if (body !== undefined) {
    const others = plan.set['title'] === undefined ? {} : { title: plan.set['title'] }
    changes['body'] = await longBodyField(sdk, auth, repo, input.type, body, others, input.intent, 'public', { type: input.type, id: input.id })
  }
  try {
    const result = await replaceDocumentIdempotent(sdk, auth, {
      contractId: contractFor(repo, input.type),
      documentType: input.type,
      documentId: input.id,
      changes,
      repo: repo.repoId,
      expectRepoId: repo.repoId,
      expectedRevision: input.expectedRevision,
    })
    // Replies to it may be public now (DESIGN §4.6: a made-public thread takes public replies):
    // this tab must not keep reading it as members-only.
    forgetStoredDoc(repo, input.type, input.id)
    noteAudience(repo, input.id, 'public')
    return result
  } finally {
    invalidateRepoFeed(repo, { counts: false })
  }
}

/**
 * Make the text of the signer's own members-only review `reviewId` (on PR `patchId`) public: a
 * public comment attached to the review, with no anchor, carrying `text` (DESIGN §4.6). Consensus
 * admits a `reviewId` comment from the review's author only.
 */
export async function makeReviewTextPublic(
  sdk: EvoSDK,
  auth: WriteAuth,
  repo: RepoRef,
  input: {
    readonly reviewId: string
    readonly patchId: string
    readonly text: string
    /** Whether the signer is a member and the PR locked: a member's comment on a locked PR carries the proof. */
    readonly post?: PostContext
    readonly intent?: string
  },
): Promise<WriteResult> {
  if (repo.visibility !== 'public') throw new MakePublicRefusedError(PRIVATE_REPO)
  const { audience, doc } = await storedAudience(sdk, repo, DOC.review, input.reviewId)
  if (asIdentifierString(doc['$ownerId']) !== auth.identityId) throw new MakePublicRefusedError(NOT_AUTHOR)
  if (asIdentifierString(doc['patchId']) !== input.patchId) throw new MakePublicRefusedError('This review is not on this pull request')
  if (audience === 'public') throw new MakePublicRefusedError(ALREADY_PUBLIC)
  if (blank(input.text)) throw new MakePublicRefusedError('This review has no text to make public')
  await publicConversation(sdk, repo, input.patchId, undefined)
  const body = await longBodyField(sdk, auth, repo, 'comment', input.text, {}, input.intent, 'public')
  return postComment(sdk, auth, repo, {
    targetId: input.patchId,
    body,
    reviewId: input.reviewId,
    audience: 'public',
    ...(input.post ? { post: input.post } : {}),
    ...(input.intent ? { intent: input.intent } : {}),
  })
}

/** Refuse, before signing, making a post public inside a conversation that is still members-only. */
async function publicConversation(sdk: EvoSDK, repo: RepoRef, targetId: string, replyTo: string | undefined): Promise<void> {
  try {
    await childAudience(sdk, repo, { targetId, ...(replyTo !== undefined ? { replyTo } : {}), requested: 'public' })
  } catch (e) {
    if (e instanceof Error && /members-only/.test(e.message)) {
      throw new MakePublicRefusedError("This conversation is members-only, so a post in it can't be made public")
    }
    throw e
  }
}

/** An imported post's provenance as the make-public replace reads it (the replace refuses it: it can't be published). */
export function provenanceOf(raw: Readonly<Record<string, unknown>> | null | undefined): { importedAuthor?: string; importedUrl?: string } {
  if (raw == null) return {}
  return {
    ...(typeof raw['author'] === 'string' && raw['author'] !== '' ? { importedAuthor: raw['author'] } : {}),
    ...(typeof raw['url'] === 'string' && raw['url'] !== '' ? { importedUrl: raw['url'] } : {}),
  }
}

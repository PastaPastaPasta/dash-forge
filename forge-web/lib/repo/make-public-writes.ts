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
import { audienceEdit, makePublicChanges } from '../rules/make-public'
import { precheckEdit, replaceDocumentIdempotent, type ReplaceResult, type WriteAuth, type WriteResult } from '../sdk'
import { DOC, asIdentifierString, contentDocOf, type RepoRef } from './contract'
import { longBodyField } from './long-body'
import { childAudience, noteAudience, storedAudience } from './members-writes'
import { invalidateRepoFeed } from './issues'
import { PrivateWriteError } from './private-writes'
import { postComment } from './review-writes'
import { contractFor } from './writes'

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
  if (repo.visibility !== 'public') throw new MakePublicRefusedError("this repo is private: its posts can't be made public one at a time")
  const { audience, doc: stored } = await storedAudience(sdk, repo, input.type, input.id)
  if (asIdentifierString(stored['$ownerId']) !== auth.identityId) throw new MakePublicRefusedError("only maintainers can make other people's posts public")
  if (audience === 'public') throw new MakePublicRefusedError('it is already public')
  const plan = makePublicChanges(input.type, input.opened)
  if ('error' in plan) {
    throw new MakePublicRefusedError(
      plan.error === 'imported'
        ? "this post was imported, and its original author's name can't be made public"
        : 'this post has no text to make public',
    )
  }
  if (input.type === 'comment') {
    const replyTo = asIdentifierString(stored['replyTo'])
    await publicConversation(sdk, repo, asIdentifierString(stored['targetId']), replyTo === '' ? undefined : replyTo)
  }
  await precheckEdit(sdk, auth, { contractId: contractFor(repo, input.type), documentType: input.type, documentId: input.id, expectRepoId: repo.repoId, expectedRevision: input.expectedRevision })
  const changes: Record<string, unknown> = { ...plan.set }
  const body = plan.set['body']
  if (body !== undefined) {
    const others = plan.set['title'] === undefined ? {} : { title: plan.set['title'] }
    changes['body'] = await longBodyField(sdk, auth, repo, input.type, body, others, input.intent, 'public', { type: input.type, id: input.id })
  }
  for (const f of plan.remove) changes[f] = undefined
  if (input.dropProof) changes['asMember'] = undefined
  const outcome = audienceEdit(repo.visibility, contentDocOf(input.type, stored), contentDocOf(input.type, { ...stored, ...changes }), asIdentifierString(stored['$ownerId']), auth.identityId)
  if (outcome !== 'makesPublic') throw new MakePublicRefusedError(`this ${input.type} can't be made public as it reads now`)
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
    // Replies to it may be public now (DESIGN §4.6: a made-public thread takes public replies).
    if (input.type !== 'comment') noteAudience(repo, input.id, 'public')
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
  input: { readonly reviewId: string; readonly patchId: string; readonly text: string; readonly intent?: string },
): Promise<WriteResult> {
  if (repo.visibility !== 'public') throw new MakePublicRefusedError("this repo is private: its posts can't be made public one at a time")
  const { audience, doc } = await storedAudience(sdk, repo, DOC.review, input.reviewId)
  if (asIdentifierString(doc['$ownerId']) !== auth.identityId) throw new MakePublicRefusedError("only maintainers can make other people's posts public")
  if (audience === 'public') throw new MakePublicRefusedError('it is already public')
  if (input.text.trim() === '') throw new MakePublicRefusedError('this review has no text to make public')
  await publicConversation(sdk, repo, input.patchId, undefined)
  const body = await longBodyField(sdk, auth, repo, 'comment', input.text, {}, input.intent, 'public')
  return postComment(sdk, auth, repo, { targetId: input.patchId, body, reviewId: input.reviewId, audience: 'public', ...(input.intent ? { intent: input.intent } : {}) })
}

/** Refuse, before signing, making a post public inside a conversation that is still members-only. */
async function publicConversation(sdk: EvoSDK, repo: RepoRef, targetId: string, replyTo: string | undefined): Promise<void> {
  try {
    await childAudience(sdk, repo, { targetId, ...(replyTo !== undefined ? { replyTo } : {}), requested: 'public' })
  } catch (e) {
    if (e instanceof Error && /members-only/.test(e.message)) {
      throw new MakePublicRefusedError("this conversation is members-only, so a post in it can't be made public")
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

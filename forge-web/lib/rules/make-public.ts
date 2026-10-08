/**
 * Making members-only discussion public by its author (mixed-visibility DESIGN §4.6, D5, §2.4;
 * forge-core `rules::make_public`). A document's audience is fixed when it is written, with one
 * exception: its author may make their own members-only or letter issue, PR or comment public, by
 * a replace that drops `enc` and `epoch` and sets the plaintext fields. A review cannot be
 * replaced, so its author makes its text public with a public comment attached to it
 * (`reviewId`, no anchor).
 *
 * Until the mainnet contract the clients allow exactly this change and refuse every other before
 * signing. On the live contracts `comment.path`, `patch.baseRefName`/`sourceRefName` and
 * `imported` are immutable, so a made-public inline comment keeps no file name (`lost`) and an
 * item whose import provenance is sealed cannot be made public. Pure; the `make_public__*`
 * vectors are shared with forge-core.
 */

import type { DocFields } from '../private/tlv'
import { audienceOf, editKeepsAudience, gitPlaneWellFormed, type ContentDoc, type ContentKind, type Visibility } from './v2'

/** What an edit does to the audience of the document it replaces. */
export type AudienceEdit = 'keeps' | 'makesPublic' | 'notAuthor' | 'fixed' | 'malformed'

/**
 * What an edit of `stored` (written by `author`) into `edited`, signed by `signer`, does to the
 * document's audience in a repository of `visibility` (forge-core `audience_edit`).
 */
export function audienceEdit(visibility: Visibility, stored: ContentDoc, edited: ContentDoc, author: string, signer: string): AudienceEdit {
  if (author !== signer) return 'notAuthor'
  const was = audienceOf(stored)
  const now = audienceOf(edited)
  if (was === now) return editKeepsAudience(stored, edited) ? 'keeps' : 'malformed'
  if (was === 'public' || now !== 'public' || visibility !== 'public') return 'fixed'
  return edited.epoch == null && gitPlaneWellFormed(edited) ? 'makesPublic' : 'malformed'
}

/** Why a document cannot be made public by its author's edit. */
export type MakePublicRefusal = 'imported' | 'empty' | 'notEditable'

/** The replace that makes a sealed document public (forge-core `MadePublic`). */
export interface MadePublic {
  /** Plaintext content fields to set, by property name. */
  readonly set: Readonly<Record<string, string>>
  /** Properties to remove: always `enc` and `epoch`. */
  readonly remove: readonly string[]
  /** Sealed fields the live contracts cannot take (an inline comment's `path`): lost for everyone. */
  readonly lost: readonly string[]
}

/** The replace that makes a sealed `kind` document public from its opened content, or why not. */
export function makePublicChanges(kind: ContentKind, opened: DocFields): MadePublic | { readonly error: MakePublicRefusal } {
  if (opened.importedAuthor !== undefined || opened.importedUrl !== undefined) return { error: 'imported' }
  const text = (v: string | undefined): string | null => (v !== undefined && v.trim() !== '' ? v : null)
  const set: Record<string, string> = {}
  const lost: string[] = []
  if (kind === 'issue' || kind === 'patch') {
    if (kind === 'patch') {
      if (opened.baseRefName !== undefined) lost.push('baseRefName')
      if (opened.sourceRefName !== undefined) lost.push('sourceRefName')
    }
    const title = text(opened.title)
    if (title === null) return { error: 'empty' }
    const body = text(opened.body)
    if (body !== null) set['body'] = body
    set['title'] = title
  } else if (kind === 'comment') {
    if (opened.path !== undefined) lost.push('path')
    const body = text(opened.body)
    if (body === null) return { error: 'empty' }
    set['body'] = body
  } else {
    return { error: 'notEditable' }
  }
  return { set, remove: ['enc', 'epoch'], lost }
}

/** A review, as {@link reviewTextCarriers} takes it. */
export interface CarrierReview {
  readonly id: string
  readonly reviewer: string
  /** It carries `enc` (members-only or a letter). */
  readonly sealed?: boolean
}

/** A comment, as {@link reviewTextCarriers} takes it. */
export interface CarrierComment {
  readonly id: string
  readonly owner: string
  readonly reviewId?: string | null
  readonly replyTo?: string | null
  readonly path?: string | null
  readonly line?: number | null
  readonly commitOid?: string | null
  readonly sealed?: boolean
  readonly createdAt: number
}

const none = (s: string | null | undefined): boolean => s == null || s === ''

/** Whether a comment carries a review's text: public, attached to a review, no anchor or thread. */
function carriesText(c: CarrierComment): boolean {
  return c.sealed !== true && c.reviewId != null && none(c.path) && c.line == null && none(c.replyTo) && none(c.commitOid)
}

/**
 * The public comment that carries each sealed review's text, by review id (forge-core
 * `review_text_carriers`): the review's author's, attached to it with no anchor; the newest by
 * `(createdAt, id)` wins.
 */
export function reviewTextCarriers(reviews: readonly CarrierReview[], comments: readonly CarrierComment[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of reviews) {
    if (r.sealed !== true) continue
    let best: CarrierComment | null = null
    for (const c of comments) {
      if (!carriesText(c) || c.reviewId !== r.id || c.owner !== r.reviewer) continue
      if (best === null || c.createdAt > best.createdAt || (c.createdAt === best.createdAt && c.id > best.id)) best = c
    }
    if (best !== null) out[r.id] = best.id
  }
  return out
}

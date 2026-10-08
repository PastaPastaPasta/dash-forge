/**
 * The members-only text this tab has opened, per public repo (product H8, DESIGN §3.3): every
 * public composer of the repo checks what it posts against all of it, not only against what its
 * own page shows (a comment past the first page, another issue read earlier in this tab).
 *
 * Filled by the session gate as it opens each members-only document (`private-session.ts`). In
 * this tab's memory only: never written anywhere, and cleared when every session closes (lock,
 * sign-out, an encryption key or identity change: `closePrivateSessions`). A session replaced on
 * its timer leaves the text in place: the reader still saw it. Another repo's text, and text
 * opened only in another tab, are not covered (a stated limit).
 */

import type { PlainDocument } from '../sdk'
import { quotesMembersText } from '../view/quote-check'
import { asIdentifierString, type RepoRef } from './contract'
import { admittedAudience } from './private-content'

/** What a members-only text was posted as. */
export type MembersPostKind = 'issue' | 'pull request' | 'comment' | 'review'

/** Who posted a members-only text, and as what (for "Your comment quotes @bob's members-only comment"). */
export interface MembersPostMeta {
  readonly author: string
  readonly kind: MembersPostKind
}

const byRepo = new Map<string, Map<string, readonly string[]>>()
/** Each opened document's author and kind, by repo then document id. */
const metaByRepo = new Map<string, Map<string, MembersPostMeta>>()
/** Each repo's texts as one list, rebuilt only after a change (a stable snapshot for React). */
const lists = new Map<string, readonly string[]>()
const listeners = new Set<() => void>()
let notifying = false

const NONE: readonly string[] = []

function changed(repoId: string | null): void {
  if (repoId === null) lists.clear()
  else lists.delete(repoId)
  if (notifying) return
  notifying = true
  // One notice for a page's worth of documents opened together.
  queueMicrotask(() => {
    notifying = false
    for (const l of [...listeners]) l()
  })
}

/** `repoId`'s map in `byRepoId`, created on first use. */
function perRepo<V>(byRepoId: Map<string, Map<string, V>>, repoId: string): Map<string, V> {
  let docs = byRepoId.get(repoId)
  if (docs === undefined) {
    docs = new Map()
    byRepoId.set(repoId, docs)
  }
  return docs
}

/** Remember the text fields of members-only document `docId` of `repoId`, opened in this tab. */
export function noteMembersText(repoId: string, docId: string, fields: readonly unknown[], meta?: MembersPostMeta): void {
  const texts = fields.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
  if (texts.length === 0 || repoId === '' || docId === '') return
  if (meta !== undefined) perRepo(metaByRepo, repoId).set(docId, meta)
  const docs = perRepo(byRepo, repoId)
  const had = docs.get(docId)
  if (had !== undefined && had.length === texts.length && had.every((t, i) => t === texts[i])) return
  docs.set(docId, texts)
  changed(repoId)
}

/**
 * Remember `doc` if it is a members-only document of public repo `repo` a session just opened
 * (its title and body): what the session gate calls for every document it admits.
 */
export function noteOpenedDoc(repo: Pick<RepoRef, 'repoId' | 'visibility'>, doc: PlainDocument): void {
  if (repo.visibility !== 'public' || admittedAudience(doc) !== 'members') return
  const author = asIdentifierString(doc['$ownerId'])
  const meta = author === '' ? undefined : { author, kind: postKindOf(doc) }
  noteMembersText(repo.repoId, asIdentifierString(doc['$id']), [doc['title'], doc['body']], meta)
}

/** What kind of post an opened document is, from the fields only that type carries. */
function postKindOf(doc: PlainDocument): MembersPostKind {
  if (doc['verdict'] !== undefined) return 'review'
  if (doc['targetId'] !== undefined) return 'comment'
  return doc['baseRefNameHash'] !== undefined || doc['headOid'] !== undefined ? 'pull request' : 'issue'
}

/**
 * The first members-only post of `repoId` this tab has opened, written by someone other than
 * `author`, that `text` quotes (DESIGN §4.6, §12 item 15): what the make-public dialog warns about.
 * The author's own members-only words are theirs to publish. Null when it quotes none.
 */
export function quotedMembersPost(repoId: string, text: string, author: string): MembersPostMeta | null {
  const docs = byRepo.get(repoId)
  const metas = metaByRepo.get(repoId)
  if (docs === undefined || metas === undefined || text.trim() === '') return null
  for (const [docId, texts] of docs) {
    const meta = metas.get(docId)
    if (meta === undefined || meta.author === author) continue
    if (quotesMembersText(text, texts)) return meta
  }
  return null
}

/** Every members-only text of `repoId` this tab has opened (the same list until one is added). */
export function openedMembersTexts(repoId: string): readonly string[] {
  const hit = lists.get(repoId)
  if (hit !== undefined) return hit
  const docs = byRepo.get(repoId)
  const list = docs === undefined ? NONE : [...docs.values()].flat()
  lists.set(repoId, list)
  return list
}

/** Be told when texts are added or cleared. Returns an unsubscribe function. */
export function subscribeMembersTexts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Forget every opened members-only text (every session closed). */
export function clearMembersTexts(): void {
  if (byRepo.size === 0) return
  byRepo.clear()
  metaByRepo.clear()
  changed(null)
}

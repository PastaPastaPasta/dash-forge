/**
 * The inbox's "made your post public" items (mixed-visibility DESIGN §4.6: authors are notified
 * when a maintainer makes their words public). One feed per public repo I belong to, any role:
 * the kind-7 `packManifest` rows of the repo after the feed's cursor (the contract's `kind`
 * index), each a maintainer's make-public bundle. A bundle by anyone but a current maintainer or
 * the owner is never read (readers ignore it), and my own bundles never become items.
 *
 * For each bundle: its bytes (hash-checked, as any stored artifact's), its comment, issue and
 * review entries (at most {@link MAX_TARGETS} posts read per bundle), and the posts among them that
 * are mine and that the entry's key really opens (its current revision, as every reader checks
 * it: a lying entry tells nobody). One item per bundle: "made your comment public", "made 3 of
 * your posts public", linking to the thread of the first. A read that fails fails the page, so
 * the feed's cursor stays and the bundle is read again on the next poll.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { ENTRY_COMMENT, ENTRY_ISSUE, ENTRY_REVIEW, parseBundle, readRevision, type Bundle, type BundleEntry } from '../private'
import { DOC, asIdentifierString, type RepoRef } from '../repo/contract'
import { revisionOf } from '../repo/made-public'
import { readMaintainers } from '../repo/members'
import { toManifest } from '../repo/packs'
import { storedPrivateDoc } from '../repo/private-content'
import { contractOf } from '../repo/source'
import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { readTargetsByIds, type RepoLite } from './mine'
import type { InboxItem } from './inbox'

/** The most posts of one bundle read to find mine (a whole thread is rarely more). */
export const MAX_TARGETS = 100

/** The repo of a feed as the readers take it. */
function repoOf(forge: ForgeIds, repo: RepoLite): RepoRef {
  return { forge, repoId: repo.id, ownerId: repo.ownerId, name: repo.name, visibility: repo.private ? 'private' : 'public' }
}

const NOUN: Readonly<Record<number, { readonly type: 'comment' | 'issue' | 'review'; readonly noun: string }>> = {
  [ENTRY_COMMENT]: { type: DOC.comment, noun: 'comment' },
  [ENTRY_ISSUE]: { type: DOC.issue, noun: 'issue' },
  [ENTRY_REVIEW]: { type: DOC.review, noun: 'review' },
}

/** One post a bundle names, read: its type, its author and the thread it is on. */
interface NamedPost {
  readonly noun: string
  readonly author: string
  /** The issue or PR it is on (itself for an issue). */
  readonly thread: string
}

/**
 * Post `e.target` of `repo` when it is `me`'s and `e`'s key opens its current revision (the
 * bundle's author `by`), or null. A read that fails throws.
 */
async function myPost(sdk: EvoSDK, forge: ForgeIds, repo: RepoLite, e: BundleEntry, by: Uint8Array, me: string): Promise<NamedPost | null> {
  const n = NOUN[e.kind]
  if (n === undefined) return null
  const id = base58Encode(e.target)
  const { documents } = await queryDocumentsWithProof(sdk, { dataContractId: contractOf(forge, n.type), documentTypeName: n.type, where: [['$id', '==', id]], limit: 1 })
  const d: PlainDocument | undefined = documents[0]
  if (d === undefined || asIdentifierString(d['repoId']) !== repo.id || asIdentifierString(d['$ownerId']) !== me) return null
  const stored = storedPrivateDoc(n.type, d, 'public')
  if (stored === null) return null
  const { read } = await readRevision(decodeIdentifier(repo.id), stored, revisionOf(d), stored.enc, [{ by, revision: e.revision, key: e.key }])
  if (read.state !== 'public') return null
  const thread = n.type === DOC.issue ? id : asIdentifierString(d[n.type === DOC.review ? 'patchId' : 'targetId'])
  return { noun: n.noun, author: me, thread }
}

/**
 * The items `docs` (a page of the repo's kind-7 manifests) make for `me` (module docs). A bundle
 * that cannot be read, or names none of my posts, makes none.
 */
export async function madePublicItems(sdk: EvoSDK, forge: ForgeIds, repo: RepoLite, docs: readonly PlainDocument[], me: string): Promise<InboxItem[]> {
  const theirs = docs.map(toManifest).filter((m) => m.uploader !== me && m.documentId !== '')
  if (theirs.length === 0 || repo.private) return []
  const honoured = new Set([...(await readMaintainers(sdk, repoOf(forge, repo))), repo.ownerId])
  const { loadStoredArtifactBytes } = await import('./browse-source')
  const out: InboxItem[] = []
  for (const m of theirs.filter((x) => honoured.has(x.uploader))) {
    const bytes = await loadStoredArtifactBytes(sdk, repoOf(forge, repo), m)
    let bundle: Bundle
    try {
      bundle = parseBundle(bytes)
    } catch {
      continue // not a bundle: it makes nothing public
    }
    // Each post's newest entry in the bundle (its current revision is the one published).
    const named = new Map<string, BundleEntry>()
    for (const e of bundle.entries) {
      if (NOUN[e.kind] === undefined) continue
      const k = base58Encode(e.target)
      if (!named.has(k) && named.size >= MAX_TARGETS) continue
      if ((named.get(k)?.revision ?? -1) < e.revision) named.set(k, e)
    }
    const by = decodeIdentifier(m.uploader)
    const mine: NamedPost[] = []
    for (const e of named.values()) {
      const post = await myPost(sdk, forge, repo, e, by, me)
      if (post !== null) mine.push(post)
    }
    const first = mine[0]
    if (first === undefined) continue
    const target = [...(await readTargetsByIds(sdk, forge, [first.thread])).values()][0]
    out.push({
      id: m.documentId,
      kind: 'madePublic',
      repo,
      what: mine.length === 1 ? `made your ${first.noun} public` : `made ${mine.length} of your posts public`,
      actor: m.uploader,
      at: m.createdAt,
      read: false,
      ...(target !== undefined ? { target: { kind: target.kind, number: target.number, title: target.title } } : {}),
    })
  }
  return out
}

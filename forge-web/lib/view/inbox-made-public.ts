/**
 * The inbox's "made your post public" items (mixed-visibility DESIGN §4.6: authors are notified
 * when a maintainer makes their words public). One feed per public repo I belong to, any role:
 * the kind-7 `packManifest` rows of the repo after the feed's cursor (the contract's `kind`
 * index), each a maintainer's make-public bundle. A bundle by anyone but a current maintainer or
 * the owner is never read (readers ignore it), and my own bundles never become items.
 *
 * For each bundle: its bytes (hash-checked, as any stored artifact's), its comment, issue and
 * review entries (at most {@link MAX_TARGETS} posts read per bundle), and the posts among them that
 * are mine. One item per bundle: "made your comment public", "made 3 of your posts public",
 * linking to the thread of the first.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode } from '../auth/base58'
import type { ForgeIds } from '../deployments'
import { ENTRY_COMMENT, ENTRY_ISSUE, ENTRY_REVIEW, parseBundle, type Bundle } from '../private'
import { DOC, asIdentifierString, type RepoRef } from '../repo/contract'
import { readMaintainers } from '../repo/members'
import { toManifest } from '../repo/packs'
import { contractOf } from '../repo/source'
import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { readTargetsByIds, type RepoLite } from './mine'
import type { InboxItem } from './inbox'

/** The most posts of one bundle read to find mine (a whole thread is rarely more). */
export const MAX_TARGETS = 20

/** The repo of a feed as the readers take it. */
function repoOf(forge: ForgeIds, repo: RepoLite): RepoRef {
  return { forge, repoId: repo.id, ownerId: repo.ownerId, name: repo.name, visibility: repo.private ? 'private' : 'public' }
}

const NOUN: Readonly<Record<number, { readonly type: string; readonly noun: string }>> = {
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

async function readPost(sdk: EvoSDK, forge: ForgeIds, repo: RepoLite, kind: number, id: string): Promise<NamedPost | null> {
  const n = NOUN[kind]
  if (n === undefined) return null
  const { documents } = await queryDocumentsWithProof(sdk, { dataContractId: contractOf(forge, n.type), documentTypeName: n.type, where: [['$id', '==', id]], limit: 1 })
  const d: PlainDocument | undefined = documents[0]
  if (d === undefined || asIdentifierString(d['repoId']) !== repo.id) return null
  const thread = n.type === DOC.issue ? id : asIdentifierString(d[n.type === DOC.review ? 'patchId' : 'targetId'])
  return { noun: n.noun, author: asIdentifierString(d['$ownerId']), thread }
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
    let bundle: Bundle
    try {
      bundle = parseBundle(await loadStoredArtifactBytes(sdk, repoOf(forge, repo), m))
    } catch {
      continue
    }
    const named = new Map<string, number>()
    for (const e of bundle.entries) if (NOUN[e.kind] !== undefined && named.size < MAX_TARGETS) named.set(base58Encode(e.target), e.kind)
    const mine: NamedPost[] = []
    for (const [id, kind] of named) {
      const post = await readPost(sdk, forge, repo, kind, id).catch(() => null)
      if (post !== null && post.author === me) mine.push(post)
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

/**
 * Posts a maintainer made public (mixed-visibility DESIGN §4.6, D5, §3.5; the format and the
 * reader rule are `lib/private/bundle.ts`, forge-core `collab::v2::bundles`). A maintainer
 * publishes the per-object key `K_obj` of each post revision in a make-public bundle (a kind-7
 * artifact on Platform); every reader opens a bundled post with that key alone and shows it as
 * public, members included, so everyone sees the same thing.
 *
 * - Readers honour a bundle only in a public repo, only by a current maintainer or the owner
 *   (anyone else's is never downloaded), and only a key that commits to the revision it names: a
 *   lying entry is an alert ({@link BundleAlert}), said once per page, and is ignored.
 * - A repo's bundles are read once per page load ({@link repoBundleEntries}, a memoised promise,
 *   dropped after this tab writes one or changes the repo's members), and only when a page meets
 *   a sealed post in a public repo: a repo without members-only content never reads them.
 * - {@link withBundles} puts them in front of any content gate: a bundled post comes back as
 *   public with {@link MADE_PUBLIC_BY}; a post its author sealed again afterwards carries
 *   {@link EDITED_AFTER_PUBLIC} (an issue is shown as the version made public, read from
 *   Platform's history of it; comments and reviews keep none). A thread page also lists an issue's
 *   earlier versions made public ({@link PUBLISHED_EARLIER}).
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { base58Encode, decodeIdentifier } from '../auth/base58'
import { bundlesKind, docEntries, readRevision, type DocEntries, type DocEntry, type EntryMismatch, type PrivateDocType } from '../private'
import { normalizeDocument, type PlainDocument } from '../sdk'
import { asIdentifierString, type RepoRef } from './contract'
import { readMakePublicBundles } from './converted'
import { onMembersInvalidated, readMaintainers } from './members'
import { noteMembersKey } from './members-key-cache'
import {
  EDITED_AFTER_PUBLIC,
  MADE_PUBLIC_BY,
  PUBLISHED_EARLIER,
  asPlaintext,
  gateFor,
  isSealedDoc,
  storedPrivateDoc,
  wellFormedAs,
  type Admission,
  type BundleAlert,
  type ContentGate,
  type PublishedVersion,
} from './private-content'
import { contractOf } from './source'

/** How long a repo's bundles serve page views before they are read again (as a session). */
const BUNDLES_TTL_MS = 5 * 60_000
/** The most revisions of one issue read from its history (Drive pages them by ten). */
export const MAX_HISTORY = 100
const HISTORY_PAGE = 10

const NONE: DocEntries = { size: 0, ofDoc: () => [] }

const cache = new Map<string, { at: number; promise: Promise<DocEntries> }>()

const keyOf = (repo: RepoRef): string => `${repo.forge.core}:${repo.repoId}`

/**
 * The honoured document entries of public `repo`'s make-public bundles (none for a private
 * repo): read once per page load, the bundles of its current maintainers and its owner only. A
 * read that fails honours nothing and never fails a page (it is tried again on the next read).
 */
export function repoBundleEntries(sdk: EvoSDK, repo: RepoRef): Promise<DocEntries> {
  if (repo.visibility !== 'public') return Promise.resolve(NONE)
  const key = keyOf(repo)
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < BUNDLES_TTL_MS) return hit.promise
  const read = (async () => {
    const maintainers = new Set([...(await readMaintainers(sdk, repo)), repo.ownerId])
    const bundles = await readMakePublicBundles(sdk, repo, maintainers)
    return docEntries(true, [...maintainers].map((m) => decodeIdentifier(m)), bundles)
  })()
  // Every caller, the concurrent ones included, gets the promise that never rejects.
  const promise = read.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
    return NONE
  })
  cache.set(key, { at: Date.now(), promise })
  return promise
}

/** Forget `repo`'s bundles (this tab wrote one, or changed its members): the next read reads them again. */
export function invalidateRepoBundles(repo: Pick<RepoRef, 'forge' | 'repoId'>): void {
  cache.delete(`${repo.forge.core}:${repo.repoId}`)
}

// A maintainer removed through this tab: their bundles stop counting at once.
onMembersInvalidated(invalidateRepoBundles)

/** A document's `$revision` (1 when not recorded). */
function revisionOf(doc: PlainDocument): number {
  const r = doc['$revision']
  return typeof r === 'number' && r > 0 ? r : typeof r === 'bigint' ? Number(r) : 1
}

/**
 * Every stored revision of the `type` document `id` of `repo`, oldest first (Platform's
 * `getDocumentHistory`, proved): only a type that keeps history (an issue, a PR) has more than its
 * current revision. At most {@link MAX_HISTORY}.
 */
export async function readDocumentHistory(sdk: EvoSDK, repo: RepoRef, type: 'issue' | 'patch', id: string): Promise<PlainDocument[]> {
  const out: PlainDocument[] = []
  for (let offset = 0; out.length < MAX_HISTORY; offset += HISTORY_PAGE) {
    const page = await sdk.documents.history({
      dataContractId: contractOf(repo.forge, type),
      documentTypeName: type,
      documentId: id,
      limit: HISTORY_PAGE,
      ...(offset > 0 ? { offset } : {}),
    })
    for (const [at, d] of page) {
      const doc = normalizeDocument(d)
      // A revision's time is the history entry's key when the document carries none.
      out.push(typeof doc['$updatedAt'] === 'number' || typeof doc['$createdAt'] === 'number' ? doc : { ...doc, $updatedAt: Number(at) })
    }
    if (page.size < HISTORY_PAGE) break
  }
  return out.slice(0, MAX_HISTORY).sort((a, b) => revisionOf(a) - revisionOf(b))
}

/** What the honoured entries make of one stored revision of a sealed post. */
type Outcome =
  | { readonly state: 'public'; readonly doc: PlainDocument; readonly by: string }
  | { readonly state: 'editedAfter'; readonly by: string; readonly publishedRevision: number }
  | { readonly state: 'none' }

/** The lying entries `found` among `doc`'s, as alerts. */
function alertsOf(doc: PlainDocument, found: readonly EntryMismatch[]): BundleAlert[] {
  const id = asIdentifierString(doc['$id'])
  const author = asIdentifierString(doc['$ownerId'])
  return found.map((m) => ({ id, revision: m.revision, by: base58Encode(m.by), author }))
}

/** The sealed `type` post `doc` (one stored revision of it) of `repo` through its honoured `entries`. */
async function outcomeOf(
  repo: RepoRef,
  type: PrivateDocType,
  doc: PlainDocument,
  entries: readonly DocEntry[],
  alerts: BundleAlert[],
): Promise<Outcome> {
  const stored = storedPrivateDoc(type, doc, 'public')
  if (stored === null) return { state: 'none' }
  const { read, alerts: found } = await readRevision(decodeIdentifier(repo.repoId), stored, revisionOf(doc), stored.enc, entries)
  alerts.push(...alertsOf(doc, found))
  switch (read.state) {
    case 'public':
      return { state: 'public', doc: { ...asPlaintext(doc, read.fields), [MADE_PUBLIC_BY]: base58Encode(read.by) }, by: base58Encode(read.by) }
    case 'editedAfter':
      return { state: 'editedAfter', by: base58Encode(read.by), publishedRevision: read.publishedRevision }
    default:
      return { state: 'none' }
  }
}

/** How {@link withBundles} reads. */
export interface BundleGateOptions {
  /**
   * Read an issue's history for its earlier versions made public ({@link PUBLISHED_EARLIER}): a
   * thread page does, a list does not. The version an issue is shown as when its author sealed it
   * again is read either way.
   */
  readonly history?: boolean
}

/**
 * `inner` (any content gate of public `repo`) with the maintainers' bundles in front of it, read
 * through `sdk` (module docs): a sealed issue, comment or review whose current revision an
 * honoured entry opens is admitted as public with {@link MADE_PUBLIC_BY}; one its author sealed
 * again afterwards carries {@link EDITED_AFTER_PUBLIC} (an issue is admitted as the version made
 * public; a comment or review is `inner`'s admission); anything else is `inner`'s. Lying entries
 * ride on the admission ({@link Admission.alerts}). A private repo's gate is `inner` itself.
 */
export function withBundles(sdk: EvoSDK, repo: RepoRef, inner: ContentGate, options: BundleGateOptions = {}): ContentGate {
  if (repo.visibility !== 'public') return inner
  return {
    visibility: inner.visibility,
    async admit(type, doc): Promise<Admission> {
      if (!bundlesKind(type) || !isSealedDoc(doc) || !wellFormedAs(repo, type, doc)) return inner.admit(type, doc)
      const entries = await repoBundleEntries(sdk, repo)
      const id = storedPrivateDoc(type, doc, 'public')?.id
      const mine = id === undefined ? [] : entries.ofDoc(type, id)
      if (mine.length === 0) return inner.admit(type, doc)
      // Sealed content here: the repo's writes check their parents from now on.
      noteMembersKey(repo.repoId)
      const alerts: BundleAlert[] = []
      const current = revisionOf(doc)
      const outcome = await outcomeOf(repo, type, doc, mine, alerts)
      const earlierNamed = type === 'issue' && mine.some((e) => e.revision < current)
      const history = earlierNamed && (outcome.state === 'editedAfter' || options.history === true) ? await publishedHistory(sdk, repo, doc, mine, alerts) : null
      const withAlerts = (a: Admission): Admission => (alerts.length === 0 ? a : { ...a, alerts })
      if (outcome.state === 'public') {
        const earlier = history ?? []
        return withAlerts({ ok: true, doc: earlier.length === 0 ? outcome.doc : { ...outcome.doc, [PUBLISHED_EARLIER]: earlier } })
      }
      if (outcome.state === 'editedAfter') {
        // An issue is shown as the version made public, for everyone (DESIGN §4.6).
        const shown = history?.find((v) => v.revision === outcome.publishedRevision)
        if (shown !== undefined) {
          const rest = (history ?? []).filter((v) => v.revision !== shown.revision)
          const fields = { title: shown.title, ...(shown.body === '' ? {} : { body: shown.body }) }
          const out: PlainDocument = { ...asPlaintext(doc, fields), [MADE_PUBLIC_BY]: shown.by, [EDITED_AFTER_PUBLIC]: outcome.by }
          return withAlerts({ ok: true, doc: rest.length === 0 ? out : { ...out, [PUBLISHED_EARLIER]: rest } })
        }
        const a = await inner.admit(type, doc)
        if (a.ok) return withAlerts({ ...a, doc: { ...a.doc, [EDITED_AFTER_PUBLIC]: outcome.by } })
        return withAlerts(a.placeholder === undefined ? a : { ...a, placeholder: { ...a.placeholder, editedAfterBy: outcome.by } })
      }
      return withAlerts(await inner.admit(type, doc))
    },
  }
}

/**
 * The earlier versions of sealed issue `doc` maintainers made public, oldest first, from
 * Platform's history of it (the current revision left out). A read that fails lists none.
 */
async function publishedHistory(sdk: EvoSDK, repo: RepoRef, doc: PlainDocument, entries: readonly DocEntry[], alerts: BundleAlert[]): Promise<PublishedVersion[]> {
  const current = revisionOf(doc)
  let history: PlainDocument[]
  try {
    history = await readDocumentHistory(sdk, repo, 'issue', asIdentifierString(doc['$id']))
  } catch {
    return []
  }
  const out: PublishedVersion[] = []
  for (const h of history) {
    const revision = revisionOf(h)
    if (revision >= current || !isSealedDoc(h) || !entries.some((e) => e.revision === revision)) continue
    // A history row lacks the current document's system fields: the stored ones stand in.
    const row: PlainDocument = { ...doc, ...h, $id: doc['$id'], $ownerId: doc['$ownerId'], $revision: revision }
    const o = await outcomeOf(repo, 'issue', row, entries, alerts)
    if (o.state !== 'public') continue
    const at = typeof h['$updatedAt'] === 'number' ? h['$updatedAt'] : typeof h['$createdAt'] === 'number' ? h['$createdAt'] : 0
    out.push({ revision, title: String(o.doc['title'] ?? ''), body: String(o.doc['body'] ?? ''), at, by: o.by })
  }
  return out
}

/**
 * The content gate a read of `repo` goes through ({@link gateFor}: the reader's session, or the
 * public rule), with the maintainers' bundles in front of it in a public repo.
 */
export function contentGate(sdk: EvoSDK, repo: RepoRef, options: BundleGateOptions = {}): ContentGate {
  return withBundles(sdk, repo, gateFor(repo), options)
}

/**
 * The maintainer (base58) whose honoured entry opens the current revision of the signer's sealed
 * `type` post `doc` of public `repo` (its key checked as every reader checks it), or null: an
 * edit of it is then written as Public (DESIGN §4.6, "after a bundle"; forge-core
 * `Collab::bundle_covers`). A lying entry covers nothing, so it can never turn an author's
 * members-only edit public; nor does a bundle of an earlier revision the author sealed again.
 */
export async function bundleCovers(sdk: EvoSDK, repo: RepoRef, type: PrivateDocType, doc: PlainDocument): Promise<string | null> {
  if (repo.visibility !== 'public' || !bundlesKind(type) || !isSealedDoc(doc)) return null
  const id = storedPrivateDoc(type, doc, 'public')?.id
  if (id === undefined) return null
  const o = await outcomeOf(repo, type, doc, (await repoBundleEntries(sdk, repo)).ofDoc(type, id), [])
  return o.state === 'public' ? o.by : null
}

/**
 * The opened content of revision `doc` of a sealed `type` post through the honoured entries (its
 * current revision's key), or null: what a bundle made public, for an author with no key of their
 * own to edit from.
 */
export async function bundledFields(sdk: EvoSDK, repo: RepoRef, type: PrivateDocType, doc: PlainDocument): Promise<PlainDocument | null> {
  const id = storedPrivateDoc(type, doc, 'public')?.id
  if (id === undefined) return null
  const o = await outcomeOf(repo, type, doc, (await repoBundleEntries(sdk, repo)).ofDoc(type, id), [])
  return o.state === 'public' ? o.doc : null
}

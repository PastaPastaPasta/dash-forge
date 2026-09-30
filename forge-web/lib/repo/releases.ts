/**
 * Release reads (`ux-dx-spec.md` §5.9; parity with forge-core `ReleaseService::releases`).
 *
 * `release` is newest-wins per `(repoId, tagName)`: the newest revision of each tag is the
 * release, older ones are listed as "previous" (a revoked maintainer can delete theirs, so
 * readers fall back). The publisher (`$ownerId`) is always named. Assets are a JSON string
 * written by two clients: forge-web `{name, sha256, size, uri}` and the CLI
 * `{name, sha256, sizeBytes, uris}` (older CLIs `size_bytes`); both parse here.
 */

import { releasePublishedOf, type ReleasePublished } from './provenance'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { z } from 'zod'

import {
  bytesToHex,
  foldReleases,
  openRelease,
  releaseStatusOf,
  type FoldRevision,
  type OpenContext,
  type ReleaseFields,
  type ReleaseOpenResult,
  type StoredRelease,
} from '../private'
import { queryAllDocuments, sumDocumentsGrouped, type PlainDocument } from '../sdk'
import { DOC, num, str, type RepoRef } from './contract'
import { bytesField, idField } from './private-content'
import { contractOf, repoSource } from './source'
import { isPrerelease } from './ref-order'

export { compareRefNames, compareTagNames, isPrerelease, naturalRuns, tagVersion, type TagVersion } from './ref-order'

/** One downloadable asset of a release. */
export interface ReleaseAssetView {
  readonly name: string
  /**
   * Lowercase hex SHA-256 the download must match; `''` when the release records none (see
   * {@link assetVerifiable}): such an asset is listed but never downloaded (D-517).
   */
  readonly sha256: string
  /** Size in bytes, or null when the publisher did not record it. */
  readonly size: number | null
  /** Every place the asset is stored (`https://`, `ipfs://`, …). */
  readonly uris: readonly string[]
}

export interface ReleaseView {
  readonly id: string
  readonly tagName: string
  readonly name: string
  readonly notes: string
  readonly yanked: boolean
  /** RC1 `delta`: +1 a publish, 0 an edit or yank, −1 an unpublish (0 when absent: a pre-RC1 document). */
  readonly delta: number
  readonly assets: readonly ReleaseAssetView[]
  /** Assets that could not be parsed (shown as a count, never guessed at). */
  readonly badAssets: number
  /**
   * The notes without the importer's footer ({@link omittedAssets}), for display. `notes` stays
   * as stored, so a re-publish that keeps the notes keeps the footer too.
   */
  readonly notesBody: string
  /** Assets of the source release that are not mirrored here (forge-import's footer), or null. */
  readonly omitted: OmittedAssets | null
  /**
   * Who published the source release and when, for an imported one (the line forge-import opens
   * its notes with), or null. A release is written by a maintainer, so this is the repo's own
   * account of its origin; `notesBody` leaves the line out.
   */
  readonly published: ReleasePublished | null
  readonly publisher: string
  readonly createdAt: number
  /**
   * A private repo's sealed revision (`private-repos.md` §16): its key epoch and every field it
   * states. Absent on a public release.
   */
  readonly sealed?: SealedReleaseInfo
}

/** What a sealed revision states besides the fields {@link ReleaseView} flattens. */
export interface SealedReleaseInfo {
  readonly epoch: number
  /** The opened TLV: tag, flags, target, provenance and the asset manifest's hash. */
  readonly fields: ReleaseFields
}

export interface ReleaseList {
  /** The newest revision per tag, newest first. */
  readonly current: readonly ReleaseView[]
  /** Superseded revisions, newest first. */
  readonly previous: readonly ReleaseView[]
  /**
   * Release revisions that could not be read (§16.3 "n release revisions could not be read");
   * on a public repo, any carrying `enc`. Absent: none.
   */
  readonly hidden?: number
  /**
   * Of `hidden`, revisions sealed under an earlier use of their epoch number: "sealed under a key
   * this repository no longer uses", not tampering (§16.3). Absent: none.
   */
  readonly earlierUse?: number
  /** Tags whose newest revision could not be read: their state is unknown (§16.3). */
  readonly unknownTags?: readonly string[]
  /** Newer revisions are under a key this reader does not hold yet (§16.3). */
  readonly stale?: boolean
  /**
   * A private repo read without its keys (signed out, or not a member): nothing is listed, and
   * nothing is ever named by its keyed hash.
   */
  readonly locked?: boolean
}

/** A draft: a sealed-only label, never access control (§16.3). */
export function isDraft(r: ReleaseView): boolean {
  return r.sealed?.fields.draft === true
}

/**
 * Whether `r` is a pre-release: its tag has a pre-release suffix, or a sealed revision sets the
 * flag (§16.2: never less of a pre-release than the public rule makes it).
 */
export function isPrereleaseView(r: ReleaseView): boolean {
  return r.sealed?.fields.prerelease === true || isPrerelease(r.tagName)
}

/** The releases count: live tags whose release is not a draft; a yanked one counts (§16.3). */
export function releaseCountOf(list: ReleaseList): number {
  return list.current.filter((r) => !isDraft(r)).length
}

/** What forge-import says it left out of an imported release (see {@link omittedAssets}). */
export interface OmittedAssets {
  /** Assets not listed here. */
  readonly count: number
  /** Assets the source release has. */
  readonly total: number
  /** The source release's page (an https URL), or null when the importer knew none. */
  readonly sourceUrl: string | null
}

/**
 * The line forge-import ends an imported release's notes with when the source release has more
 * assets than the 4,096-byte `assets` field lists (`model::assets_footer`):
 * `---` then `_forge-import: N of M assets are not mirrored here (…). Download them from the
 * [source release](https://…)._`. Only a footer at the very end counts, so text quoted in the
 * notes is never taken for it.
 */
const OMITTED_FOOTER =
  /\n\n---\n_forge-import: (\d+) of (\d+) assets are not mirrored here \([^)]*\)\.(?: Download them from the \[source release\]\((https:\/\/[^\s)]+)\)\.)?_\s*$/

/** Split forge-import's omitted-assets footer off `notes`. */
export function omittedAssets(notes: string): { body: string; omitted: OmittedAssets | null } {
  const m = OMITTED_FOOTER.exec(notes)
  if (m === null) return { body: notes, omitted: null }
  const count = Number(m[1])
  const total = Number(m[2])
  if (count === 0 || total < count) return { body: notes, omitted: null }
  return { body: notes.slice(0, m.index), omitted: { count, total, sourceUrl: m[3] ?? null } }
}

const SHA256 = /^[0-9a-fA-F]{64}$/

/**
 * Whether `asset` records a SHA-256 its download can be checked against. Releases mirrored by
 * forge-import before it hashed assets record `""` (D-517): listed, never downloaded.
 */
export function assetVerifiable(asset: { readonly sha256: string }): boolean {
  return SHA256.test(asset.sha256)
}

/**
 * Why an asset with no recorded hash offers no download here, addressed to whoever is reading
 * the page (L-50): this page has nothing to check a copy against, and — unlike an {@link
 * importedAssetUrl imported} asset, which at least names a known source host — it cannot point
 * at one it trusts either. The second sentence is for a maintainer who can actually fix the
 * missing hash.
 */
export const UNVERIFIABLE_ASSET =
  'no SHA-256 is recorded for this asset, so this page can’t verify a copy of it and won’t link to one it can’t vouch for. A maintainer fixes this by re-running the import with a current forge-import (it hashes each asset) or by publishing the release again with the file.'

/**
 * Whether `url` is a release download on the forge an import copies from (GitHub's
 * `/<o>/<r>/releases/download/…`, GitLab's `/-/releases/<tag>/downloads/…` or `/uploads/…`).
 * forge-import references assets there; a release published here stores them in its owner's
 * storage instead, so such a URL marks an imported asset.
 */
export function importedAssetUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.hostname === 'github.com') return /^\/[^/]+\/[^/]+\/releases\/download\//.test(u.pathname)
  return /\/-\/releases\/[^/]+\/downloads\/|\/uploads\/[0-9a-f]{32}\//.test(u.pathname)
}

/** An imported asset the import has not hashed yet (its hashing budget ran out): the original is linked. */
export const NOT_VERIFIED_YET =
  'Not verified yet: the import has not recorded this file’s SHA-256, so this page can’t check it. Get it from the source; a later import run records the hash.'

const size = z.number().int().nonnegative()
const Asset = z
  .object({
    name: z.string().min(1).max(255),
    // An empty hash is kept (and shown as unverifiable); any other non-hex value is unreadable.
    sha256: z.union([z.literal(''), z.string().regex(SHA256)]),
    size: size.optional(),
    sizeBytes: size.optional(),
    size_bytes: size.optional(),
    uri: z.string().min(1).optional(),
    uris: z.array(z.string().min(1)).max(8).optional(),
  })
  .passthrough()

/** Parse a release's `assets` JSON string. Unreadable entries are counted, not dropped silently. */
export function parseReleaseAssets(raw: string): { assets: ReleaseAssetView[]; bad: number } {
  if (raw.trim() === '') return { assets: [], bad: 0 }
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    return { assets: [], bad: 1 }
  }
  if (!Array.isArray(list)) return { assets: [], bad: 1 }
  const assets: ReleaseAssetView[] = []
  let bad = 0
  for (const item of list) {
    const parsed = Asset.safeParse(item)
    if (!parsed.success) {
      bad += 1
      continue
    }
    const a = parsed.data
    const uris = [...(a.uris ?? []), ...(a.uri !== undefined && !(a.uris ?? []).includes(a.uri) ? [a.uri] : [])]
    assets.push({
      name: a.name,
      sha256: a.sha256.toLowerCase(),
      // 0 is "not recorded" (GitLab release links carry no size), as dg treats it.
      size: a.sizeBytes || a.size || a.size_bytes || null,
      uris,
    })
  }
  return { assets, bad }
}

function toRelease(doc: PlainDocument): ReleaseView {
  const { assets, bad } = parseReleaseAssets(str(doc, 'assets'))
  const created = doc['$createdAt']
  const notes = str(doc, 'notes')
  const { published, rest } = releasePublishedOf(notes)
  const { body, omitted } = omittedAssets(rest)
  return {
    id: str(doc, '$id'),
    tagName: str(doc, 'tagName'),
    name: str(doc, 'name'),
    notes,
    notesBody: body,
    omitted,
    published,
    yanked: doc['yanked'] === true,
    delta: typeof doc['delta'] === 'number' ? doc['delta'] : 0,
    assets,
    badAssets: bad,
    publisher: str(doc, '$ownerId'),
    createdAt: typeof created === 'number' ? created : 0,
  }
}

const newestFirst = (a: ReleaseView, b: ReleaseView): number =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/**
 * When a release actually went out: an imported release's `published.at` (from its notes'
 * `Published on … on YYYY-MM-DD` line — the source's real date), or, for one made here, when it
 * was created, since that *is* when it was published. Never `$createdAt` for an imported release:
 * an importer writes a repo's whole history in one run, so `$createdAt` says when a release was
 * mirrored, not when it was originally published.
 */
function publishedAt(r: ReleaseView): number {
  return r.published?.at ?? r.createdAt
}

/**
 * The releases page's order (L-78): newest published first, matching GitHub's releases page (not
 * the tags/ref-switcher's version order — {@link compareTagNames} — which sorts *names*, not
 * dated documents, and stays version-first because a tag has no date of its own). Ties (same
 * day, or two releases made here without one) fall back to {@link newestFirst}.
 *
 * This intentionally diverges from forge-core's `release_order` (version-highest-first), which
 * forge-core keeps for its own callers; forge-web reads the raw `release` documents and computes
 * this list's display order itself, so the two are free to disagree, and here the real publish
 * date is available and is what GitHub itself sorts by.
 */
export function releaseOrder(a: ReleaseView, b: ReleaseView): number {
  return publishedAt(b) - publishedAt(a) || newestFirst(a, b)
}

/**
 * The repo's latest release, as GitHub picks it: the first in {@link releaseOrder} that is not a
 * pre-release or yanked. A draft is never the latest (§16.3).
 */
export function latestRelease(list: ReleaseList): ReleaseView | undefined {
  const candidates = list.current.filter((r) => !r.yanked && !isDraft(r))
  return candidates.find((r) => !isPrereleaseView(r)) ?? candidates[0]
}

/** Split revisions into the newest per tag and the rest (forge-core `newest_per_tag`). */
export function newestPerTag(all: readonly ReleaseView[]): ReleaseList {
  const byTag = new Map<string, ReleaseView[]>()
  for (const r of all) byTag.set(r.tagName, [...(byTag.get(r.tagName) ?? []), r])
  const current: ReleaseView[] = []
  const previous: ReleaseView[] = []
  for (const revs of byTag.values()) {
    const [head, ...rest] = [...revs].sort(newestFirst)
    // An unpublish (RC1 `delta` −1) takes the tag's release down; its revisions stay history.
    if (head !== undefined && head.delta !== -1) current.push(head)
    else if (head !== undefined) previous.push(head)
    previous.push(...rest)
  }
  return { current: current.sort(releaseOrder), previous: previous.sort(newestFirst) }
}

/**
 * Every release of a repo (proof-checked, complete), folded newest per tag.
 *
 * A private repo's revisions are opened with the reader's session and folded by their decrypted
 * tag (§16.3, {@link sealedReleases}); without a session nothing is read or listed. Every read
 * lists the repo through `created` (`repoId, $createdAt`) and filters locally: nothing queries a
 * keyed `tagName`, which would show the answering node which hashes across epochs are one tag.
 */
export async function readReleases(sdk: EvoSDK, repo: RepoRef): Promise<ReleaseList> {
  if (repo.visibility === 'private' && repo.session === undefined) return { current: [], previous: [], locked: true }
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).repoQuery(DOC.release, { orderBy: [['$createdAt', 'asc']] }),
  )
  if (repo.visibility === 'private' && repo.session !== undefined) return sealedReleases(docs, repo.session.ctx)
  // A public reader holds no key: a revision carrying `enc` is malformed (§16.2), never a release
  // named by its hash.
  const plain = docs.filter((d) => d['enc'] == null)
  return { ...newestPerTag(plain.map(toRelease).filter((r) => r.tagName !== '')), hidden: docs.length - plain.length }
}

/** The plaintext fields of a `release` document, as {@link openRelease} judges them. */
function storedRelease(doc: PlainDocument): StoredRelease | null {
  const ownerId = idField(doc, '$ownerId')
  if (ownerId === undefined) return null
  const epoch = doc['epoch'] == null ? undefined : num(doc, 'epoch')
  const enc = bytesField(doc, 'enc')
  return {
    ownerId,
    ...(epoch !== undefined ? { epoch } : {}),
    tagName: str(doc, 'tagName'),
    vis: str(doc, 'vis'),
    delta: num(doc, 'delta'),
    ...(enc !== undefined ? { enc } : {}),
    // `noPlain`'s fields, and `yanked` / `imported`, which a writer never puts next to `enc`
    hasPlaintextContent: ['name', 'notes', 'assets', 'assetManifest', 'yanked', 'imported'].some((k) => doc[k] !== undefined && doc[k] !== null),
  }
}

/** A sealed revision that opened to `fields`, as a {@link ReleaseView}. */
function sealedView(doc: PlainDocument, epoch: number, fields: ReleaseFields): ReleaseView {
  const created = doc['$createdAt']
  const notes = fields.notes ?? ''
  // The importer's provenance, sealed in TLV 13, 14 and 20: the web orders by the source's date.
  let published: ReleasePublished | null = null
  if (fields.importedUrl !== undefined && fields.importedCreatedAt !== undefined) {
    let host = ''
    try {
      host = new URL(fields.importedUrl).host
    } catch {
      // not a URL: no host
    }
    published = { host, author: fields.importedAuthor ?? '', at: fields.importedCreatedAt }
  }
  return {
    id: str(doc, '$id'),
    tagName: fields.tag,
    name: fields.name ?? '',
    notes,
    notesBody: notes,
    omitted: null,
    published,
    yanked: fields.yanked === true,
    delta: 0,
    // the asset list is in the sealed kind-4 manifest `fields.assetManifest` names (§16.5)
    assets: [],
    badAssets: 0,
    publisher: str(doc, '$ownerId'),
    createdAt: typeof created === 'number' ? created : 0,
    sealed: { epoch, fields },
  }
}

type SealedRow = FoldRevision & { readonly doc: PlainDocument }

/**
 * A private repo's releases (§16.3): every revision opened with the reader's keys, then folded
 * by its decrypted tag across epochs. Unreadable revisions are counted and replays ignored.
 */
export async function sealedReleases(docs: readonly PlainDocument[], ctx: OpenContext): Promise<ReleaseList> {
  const rows = await Promise.all(
    docs.map(async (doc): Promise<SealedRow> => {
      const stored = storedRelease(doc)
      const opened: ReleaseOpenResult = stored === null ? { status: 'malformed' } : await openRelease(ctx, stored)
      const createdAt = typeof doc['$createdAt'] === 'number' ? doc['$createdAt'] : 0
      return {
        doc,
        id: idField(doc, '$id') ?? new Uint8Array(0),
        createdAt,
        epoch: stored?.epoch ?? -1,
        tagName: str(doc, 'tagName'),
        status: releaseStatusOf(opened, stored?.epoch, createdAt, ctx),
        enc: bytesToHex(bytesField(doc, 'enc') ?? new Uint8Array(0)),
        ...(opened.status === 'readable' ? { fields: opened.fields } : {}),
      }
    }),
  )
  const fold = foldReleases(rows)
  const view = (r: SealedRow): ReleaseView => sealedView(r.doc, r.epoch, r.fields as ReleaseFields)
  return {
    current: fold.live.map(view).sort(releaseOrder),
    previous: fold.history.map(view),
    hidden: fold.hidden,
    earlierUse: rows.filter((r) => r.status === 'earlierUse').length,
    unknownTags: fold.unknownTags,
    stale: fold.stale,
  }
}

/**
 * How many tags have a live (published) release: GitHub's "Releases N". One proved sum of
 * `release.delta` on `perTag` (`(repoId, tagName)`, `summable: "delta"`, `rangeSummable`; RC1
 * O-04): a publish adds 1, an edit or yank 0, an unpublish takes 1 away, so each tag totals 1 or 0.
 *
 * The shape is Drive's carrier `AggregateSumOnRange` (`repoId in [R]` grouped by `repoId`, with
 * `tagName > ""`, which ranges over every tag since a tag name is never empty). `perTag` is not
 * `summable`-covered by `repoId` alone, and the plain range shape (`repoId == R`, no `groupBy`)
 * proves its path key by existence only: for a repo that never had a release the proof fails to
 * verify. The carrier proves an absent `R` as absent, an empty map: 0.
 */
export async function readReleaseCount(sdk: EvoSDK, repo: RepoRef): Promise<number> {
  const sums = await sumDocumentsGrouped(
    sdk,
    {
      dataContractId: contractOf(repo.forge, DOC.release),
      documentTypeName: DOC.release,
      where: [['repoId', 'in', [repo.repoId]], ['tagName', '>', '']],
      orderBy: [['repoId', 'asc']],
      groupBy: ['repoId'],
    },
    'delta',
  )
  return [...sums.values()].reduce((a, b) => a + b, 0)
}

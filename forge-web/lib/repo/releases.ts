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

import { queryAllDocuments, type PlainDocument } from '../sdk'
import { DOC, str, type RepoRef } from './contract'
import { repoSource } from './source'
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
}

export interface ReleaseList {
  /** The newest revision per tag, newest first. */
  readonly current: readonly ReleaseView[]
  /** Superseded revisions, newest first. */
  readonly previous: readonly ReleaseView[]
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

/** The repo's latest release, as GitHub picks it: the first in {@link releaseOrder} that is not a pre-release or yanked. */
export function latestRelease(list: ReleaseList): ReleaseView | undefined {
  return list.current.find((r) => !r.yanked && !isPrerelease(r.tagName)) ?? list.current.find((r) => !r.yanked)
}

/** Split revisions into the newest per tag and the rest (forge-core `newest_per_tag`). */
export function newestPerTag(all: readonly ReleaseView[]): ReleaseList {
  const byTag = new Map<string, ReleaseView[]>()
  for (const r of all) byTag.set(r.tagName, [...(byTag.get(r.tagName) ?? []), r])
  const current: ReleaseView[] = []
  const previous: ReleaseView[] = []
  for (const revs of byTag.values()) {
    const [head, ...rest] = [...revs].sort(newestFirst)
    if (head !== undefined) current.push(head)
    previous.push(...rest)
  }
  return { current: current.sort(releaseOrder), previous: previous.sort(newestFirst) }
}

/** Every release of a repo (proof-checked, complete), folded newest per tag. */
export async function readReleases(sdk: EvoSDK, repo: RepoRef): Promise<ReleaseList> {
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).repoQuery(DOC.release, { orderBy: [['$createdAt', 'asc']] }),
  )
  return newestPerTag(docs.map(toRelease).filter((r) => r.tagName !== ''))
}

/**
 * Release reads (`ux-dx-spec.md` §5.9; parity with forge-core `ReleaseService::releases`).
 *
 * `release` is newest-wins per `(repoId, tagName)`: the newest revision of each tag is the
 * release, older ones are listed as "previous" (a revoked maintainer can delete theirs, so
 * readers fall back). The publisher (`$ownerId`) is always named. Assets are a JSON string
 * written by two clients: forge-web `{name, sha256, size, uri}` and the CLI
 * `{name, sha256, sizeBytes, uris}` (older CLIs `size_bytes`); both parse here.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import { z } from 'zod'

import { queryAllDocuments, type PlainDocument } from '../sdk'
import { DOC, str, type RepoRef } from './contract'
import { repoSource } from './source'

/** One downloadable asset of a release. */
export interface ReleaseAssetView {
  readonly name: string
  /** Lowercase hex SHA-256 the download must match. */
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
  readonly publisher: string
  readonly createdAt: number
}

export interface ReleaseList {
  /** The newest revision per tag, newest first. */
  readonly current: readonly ReleaseView[]
  /** Superseded revisions, newest first. */
  readonly previous: readonly ReleaseView[]
}

const size = z.number().int().nonnegative()
const Asset = z
  .object({
    name: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
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
      size: a.sizeBytes ?? a.size ?? a.size_bytes ?? null,
      uris,
    })
  }
  return { assets, bad }
}

function toRelease(doc: PlainDocument): ReleaseView {
  const { assets, bad } = parseReleaseAssets(str(doc, 'assets'))
  const created = doc['$createdAt']
  return {
    id: str(doc, '$id'),
    tagName: str(doc, 'tagName'),
    name: str(doc, 'name'),
    notes: str(doc, 'notes'),
    yanked: doc['yanked'] === true,
    assets,
    badAssets: bad,
    publisher: str(doc, '$ownerId'),
    createdAt: typeof created === 'number' ? created : 0,
  }
}

const newestFirst = (a: ReleaseView, b: ReleaseView): number =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

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
  return { current: current.sort(newestFirst), previous: previous.sort(newestFirst) }
}

/** Every release of a repo (proof-checked, complete), folded newest per tag. */
export async function readReleases(sdk: EvoSDK, repo: RepoRef): Promise<ReleaseList> {
  const docs = await queryAllDocuments(
    sdk,
    repoSource(repo).repoQuery(DOC.release, { orderBy: [['$createdAt', 'asc']] }),
  )
  return newestPerTag(docs.map(toRelease).filter((r) => r.tagName !== ''))
}

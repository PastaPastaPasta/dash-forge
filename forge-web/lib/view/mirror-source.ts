/**
 * Where a mirror's issues and PRs came from. A mirror holds only what its import copied
 * (often a recent window), and its numbers are the source's, so the lists say where the full
 * history is and the New issue form warns that a number taken here may be one the source
 * will use (`docs/guides/mirror-a-github-repo.md`).
 *
 * Only what the repo's owner or a current maintainer wrote is believed (the trust set of
 * `forge-v2.md` §6 numbering): the `repo` description forge-import writes when it creates the
 * mirror (`Mirror of github.com/o/r`, `… (mirror of github.com/o/r)`), else the `imported.url`
 * of their newest issue or PR (`https://github.com/o/r/issues/12`,
 * `https://gitlab.example.com/g/p/-/merge_requests/3`). Anyone may post an issue with any
 * `imported` record, so a stranger's never names the source. The import records no upstream
 * total, so no "N of M" is claimed.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'

import { DEFAULT_NETWORK, type Network } from '../constants'
import { DOC, readNumberTrust, repoKey, repoSource, type RepoRef } from '../repo'
import { queryDocumentsWithProof, type PlainDocument } from '../sdk'
import { mapPooled } from './pool'

/** A mirror's source repository and its full list of the given kind. */
export interface MirrorSource {
  /** `github.com`. */
  readonly host: string
  /** `github.com/dashpay/dash`. */
  readonly label: string
  /** The source's own list, e.g. `https://github.com/dashpay/dash/issues`. */
  readonly listUrl: string
}

export type MirrorKind = 'issue' | 'pull'

const GITHUB = 'github.com'
const GITHUB_ITEM = /^\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+\/?$/
const GITLAB_ITEM = /^\/(.+?)\/-\/(?:issues|merge_requests)\/\d+\/?$/
/** What forge-import's repo description ends with: `Mirror of <host>/<path>` or `(mirror of …)`. */
const DESCRIPTION = /(?:^Mirror of |\(mirror of )([a-z0-9.-]+(?::\d+)?)\/([^\s()]+)\)?$/

/** `host/repo`'s list of `kind`: GitHub's layout on github.com, GitLab's anywhere else. */
function sourceAt(host: string, repo: string, kind: MirrorKind): MirrorSource {
  const list = host === GITHUB ? (kind === 'issue' ? 'issues' : 'pulls') : kind === 'issue' ? '-/issues' : '-/merge_requests'
  return { host, label: `${host}/${repo}`, listUrl: `https://${host}/${repo}/${list}` }
}

/**
 * The source of one imported item's URL: an https GitHub item on github.com itself, or a
 * GitLab item (gitlab.com, or a self-hosted GitLab when `anyGitlabHost`). Null otherwise.
 */
export function mirrorSourceOf(url: string, kind: MirrorKind, anyGitlabHost = false): MirrorSource | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null
  const host = parsed.host
  const github = host === GITHUB ? GITHUB_ITEM.exec(parsed.pathname)?.[1] : undefined
  if (github !== undefined) return sourceAt(host, github, kind)
  const gitlab = host === 'gitlab.com' || (anyGitlabHost && host !== GITHUB) ? GITLAB_ITEM.exec(parsed.pathname)?.[1] : undefined
  if (gitlab !== undefined) return sourceAt(host, gitlab, kind)
  return null
}

/** The source forge-import's description names (`Mirror of github.com/o/r`), or null. */
export function mirrorSourceOfDescription(description: string, kind: MirrorKind): MirrorSource | null {
  const m = DESCRIPTION.exec(description.trim())
  if (m === null) return null
  const [, host, repo] = m as unknown as [string, string, string]
  if (host === GITHUB && !/^[^/]+\/[^/]+$/.test(repo)) return null
  return sourceAt(host, repo, kind)
}

/** The source an `imported` record names, from a trusted author's row. */
function sourceOfRow(doc: PlainDocument, kind: MirrorKind): MirrorSource | null {
  const imported = doc['imported']
  const url = typeof imported === 'object' && imported !== null ? (imported as PlainDocument)['url'] : undefined
  return typeof url === 'string' ? mirrorSourceOf(url, kind, true) : null
}

/** Rows read per trusted author: a native issue or two on top of the import is skipped over. */
const ROWS_PER_AUTHOR = 10

/**
 * The repo's mirror source, or null when it is not a mirror: the owner-written description
 * first (no read), else the newest `imported` issue or PR by the owner or a maintainer (one
 * `author`-index read each).
 */
export async function readMirrorSource(
  sdk: EvoSDK,
  repo: RepoRef,
  description: string,
  kind: MirrorKind,
  network: Network = DEFAULT_NETWORK,
): Promise<MirrorSource | null> {
  const described = mirrorSourceOfDescription(description, kind)
  if (described !== null) return described
  const trusted = await readNumberTrust(sdk, repo, network)
  const type = kind === 'issue' ? DOC.issue : DOC.patch
  const found = await mapPooled(trusted, 8, async (author) => {
    const { documents } = await queryDocumentsWithProof(sdk, {
      ...repoSource(repo).targetQuery(type),
      where: [['$ownerId', '==', author], ['repoId', '==', repo.repoId]],
      orderBy: [['number', 'desc']],
      limit: ROWS_PER_AUTHOR,
    })
    for (const d of documents) {
      const source = sourceOfRow(d, kind)
      if (source !== null) return source
    }
    return null
  })
  return found.find((s) => s !== null) ?? null
}

// A repo's mirror source changes only when its owner re-describes it or imports again; the
// lists and the compose form share one read per repo and kind. A failed read is not cached.
const TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; promise: Promise<MirrorSource | null> }>()

/** {@link readMirrorSource} through a per-session cache. */
export function readMirrorSourceCached(
  sdk: EvoSDK,
  repo: RepoRef,
  description: string,
  kind: MirrorKind,
  network: Network = DEFAULT_NETWORK,
): Promise<MirrorSource | null> {
  const key = `${network}:${repoKey(repo)}:${kind}:${description}`
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.promise
  const promise = readMirrorSource(sdk, repo, description, kind, network)
  cache.set(key, { at: Date.now(), promise })
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
  return promise
}

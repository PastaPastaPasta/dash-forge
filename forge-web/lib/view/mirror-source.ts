/**
 * Where a mirror's issues or PRs came from, from their `imported.url` (forge-import writes
 * the source item's web URL there: `https://github.com/o/r/issues/12`,
 * `https://gitlab.com/g/p/-/merge_requests/3`). A mirror holds only what its import copied,
 * often a recent window, so the lists say so and link to the source's full list. The import
 * records no upstream total, so no "N of M" is claimed.
 */

/** A mirror's source repository and its full list of the given kind. */
export interface MirrorSource {
  /** `github.com`. */
  readonly host: string
  /** `github.com/dashpay/dash`. */
  readonly label: string
  /** The source's own list, e.g. `https://github.com/dashpay/dash/issues`. */
  readonly listUrl: string
}

const GITHUB_ITEM = /^\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+\/?$/
const GITLAB_ITEM = /^\/(.+?)\/-\/(?:issues|merge_requests)\/\d+\/?$/

/** The source of one imported item's URL, or null when it is not a GitHub or GitLab item URL. */
export function mirrorSourceOf(url: string, kind: 'issue' | 'pull'): MirrorSource | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  const source = (repo: string, list: string): MirrorSource => ({
    host: parsed.host,
    label: `${parsed.host}/${repo}`,
    listUrl: `${parsed.origin}/${repo}/${list}`,
  })
  const github = GITHUB_ITEM.exec(parsed.pathname)?.[1]
  if (github !== undefined) return source(github, kind === 'issue' ? 'issues' : 'pulls')
  const gitlab = GITLAB_ITEM.exec(parsed.pathname)?.[1]
  if (gitlab !== undefined) return source(gitlab, kind === 'issue' ? '-/issues' : '-/merge_requests')
  return null
}

/** The source the first imported row of a list names, or null when none is imported. */
export function mirrorSourceOfRows(urls: readonly string[], kind: 'issue' | 'pull'): MirrorSource | null {
  for (const url of urls) {
    const source = mirrorSourceOf(url, kind)
    if (source !== null) return source
  }
  return null
}

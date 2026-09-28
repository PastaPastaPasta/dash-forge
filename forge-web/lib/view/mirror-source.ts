/**
 * Where a mirror's issues or PRs came from, from their `imported.url` (forge-import writes
 * the source item's web URL there: `https://github.com/o/r/issues/12`,
 * `https://gitlab.com/g/p/-/merge_requests/3`). A mirror holds only what its import copied,
 * often a recent window, so the lists say so and link to the source's full list. The import
 * records no upstream total, so no "N of M" is claimed.
 */

/** A mirror's source repository and its full list of the given kind. */
export interface MirrorSource {
  /** `github.com/dashpay/dash`. */
  readonly label: string
  /** The source's own list, e.g. `https://github.com/dashpay/dash/issues`. */
  readonly listUrl: string
}

const LIST_PATH: Readonly<Record<'issue' | 'pull', { readonly github: string; readonly gitlab: string }>> = {
  issue: { github: 'issues', gitlab: '-/issues' },
  pull: { github: 'pulls', gitlab: '-/merge_requests' },
}

/** The source of one imported item's URL, or null when it is not a GitHub or GitLab item URL. */
export function mirrorSourceOf(url: string, kind: 'issue' | 'pull'): MirrorSource | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  const path = parsed.pathname
  const github = /^\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+\/?$/.exec(path)
  const gitlab = /^\/(.+?)\/-\/(?:issues|merge_requests)\/\d+\/?$/.exec(path)
  const repo = github?.[1] ?? gitlab?.[1]
  if (repo === undefined) return null
  const list = github ? LIST_PATH[kind].github : LIST_PATH[kind].gitlab
  return { label: `${parsed.host}/${repo}`, listUrl: `${parsed.origin}/${repo}/${list}` }
}

/** The source the first imported row of a list names, or null when none is imported. */
export function mirrorSourceOfRows(urls: readonly (string | null | undefined)[], kind: 'issue' | 'pull'): MirrorSource | null {
  for (const url of urls) {
    const source = url ? mirrorSourceOf(url, kind) : null
    if (source !== null) return source
  }
  return null
}

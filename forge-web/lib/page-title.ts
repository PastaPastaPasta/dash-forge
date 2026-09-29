/**
 * Per-page `<title>` (L-59). The static export ships one `<title>` for every route, so the title
 * is set on the client from the route and its query: GitHub's shapes, e.g.
 * `Issues · alice/project`, `src/main.rs at main · alice/project`, `alice · Dash Forge`.
 *
 * Pure: {@link pageTitle} maps a pathname and query (and an owner's display name, when known) to
 * the title; the header's `DocumentTitle` applies it.
 */

export const SITE_TITLE = 'Dash Forge'

/** An owner shown in a title: the DPNS name when resolved, else the first 8 chars of the id. */
function ownerLabel(owner: string, ownerName?: string | null): string {
  if (ownerName) return ownerName
  return /^[1-9A-HJ-NP-Za-km-z]{42,44}$/.test(owner) ? `${owner.slice(0, 8)}…` : owner
}

/** Route (no trailing slash) → how its title reads. `repo` is `owner/name`. */
const REPO_TITLES: Readonly<Record<string, (q: URLSearchParams, repo: string) => string>> = {
  '/repo': (q, repo) => (q.get('ref') ? `${repo} at ${q.get('ref')}` : repo),
  '/repo/tree': (q, repo) => `${q.get('path') || '/'}${q.get('ref') ? ` at ${q.get('ref')}` : ''} · ${repo}`,
  '/repo/blob': (q, repo) => `${q.get('path') || 'File'}${q.get('ref') ? ` at ${q.get('ref')}` : ''} · ${repo}`,
  '/repo/blame': (q, repo) => `Blame ${q.get('path') ?? ''} · ${repo}`,
  '/repo/commits': (q, repo) => (q.get('path') ? `History for ${q.get('path')} · ${repo}` : `Commits · ${repo}`),
  '/repo/commit': (q, repo) => `Commit ${(q.get('oid') ?? '').slice(0, 7)} · ${repo}`,
  '/repo/issues': (_q, repo) => `Issues · ${repo}`,
  '/repo/issue': (q, repo) => `Issue #${q.get('number') ?? ''} · ${repo}`,
  '/repo/pulls': (_q, repo) => `Pull requests · ${repo}`,
  '/repo/pulls/new': (_q, repo) => `New pull request · ${repo}`,
  '/repo/pull': (q, repo) => `Pull request #${q.get('number') ?? ''} · ${repo}`,
  '/repo/releases': (_q, repo) => `Releases · ${repo}`,
  '/repo/release': (q, repo) => `${q.get('tag') ?? 'Release'} · ${repo}`,
  '/repo/branches': (_q, repo) => `Branches · ${repo}`,
  '/repo/tags': (_q, repo) => `Tags · ${repo}`,
  '/repo/stargazers': (_q, repo) => `Stargazers · ${repo}`,
  '/repo/settings': (_q, repo) => `Settings · ${repo}`,
}

const SITE_TITLES: Readonly<Record<string, string>> = {
  '/': SITE_TITLE,
  '/explore': 'Explore',
  '/new': 'New repository',
  '/notifications': 'Notifications',
  '/settings': 'Settings',
  '/settings/storage': 'Storage settings',
  '/login': 'Sign in',
}

/**
 * The title for `pathname` + `query`. A private repo's sealed paths and refs (`~` tokens,
 * `lib/view/private-nav.ts`) are left out: the title is then the repo alone.
 */
export function pageTitle(pathname: string, query: URLSearchParams, ownerName?: string | null): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const withSite = (t: string): string => (t === SITE_TITLE ? t : `${t} · ${SITE_TITLE}`)
  const route = REPO_TITLES[path]
  const owner = query.get('owner') ?? ''
  const name = query.get('name') ?? ''
  if (route !== undefined && owner !== '' && name !== '') {
    const repo = `${ownerLabel(owner, ownerName)}/${name}`
    // A private repo's path, ref and oid travel as `~…` tokens: never shown, even as tokens.
    const sealed = ['path', 'ref', 'oid'].some((k) => query.get(k)?.startsWith('~'))
    return withSite(sealed ? repo : route(query, repo))
  }
  if (path === '/u' || path === '/u/followers' || path === '/u/following') {
    const who = query.get('name')
    if (who) {
      const label = ownerLabel(who, ownerName)
      return withSite(path === '/u' ? label : `${path === '/u/followers' ? 'Followers' : 'Following'} · ${label}`)
    }
  }
  if (path === '/explore' && query.get('q')) return withSite(`Search “${query.get('q')}”`)
  return withSite(SITE_TITLES[path] ?? SITE_TITLE)
}

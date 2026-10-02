/**
 * Per-page `<title>` (L-59). The static export ships one `<title>` for every route, so the title
 * is set on the client from the route and its query: GitHub's shapes, e.g.
 * `Issues · alice/project`, `src/main.rs at main · alice/project`, `alice · Dash Forge`.
 *
 * Pure: {@link pageTitle} maps a pathname and query (and an owner's display name, when known) to
 * the title; the header's `DocumentTitle` applies it.
 */

import { isIdentityId } from './utils'

export const SITE_TITLE = 'Dash Forge'

/** A route without the static export's trailing slash (`/repo/issues/` → `/repo/issues`). */
export function bareRoute(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** An owner as people read it: the DPNS name when resolved, else a shortened identity id. */
export function ownerLabel(owner: string, ownerName?: string | null): string {
  if (ownerName) return ownerName
  return isIdentityId(owner) ? `${owner.slice(0, 8)}…` : owner
}

/** The query's params (a `URLSearchParams`, or Next's read-only one). */
type Query = Pick<URLSearchParams, 'get'>

/** ` at <ref>` when the query names one. */
const at = (q: Query): string => (q.get('ref') ? ` at ${q.get('ref')}` : '')

/** Route (no trailing slash) → how its title reads. `repo` is `owner/name`. */
const REPO_TITLES: Readonly<Record<string, (q: Query, repo: string) => string>> = {
  '/repo': (q, repo) => `${repo}${at(q)}`,
  '/repo/tree': (q, repo) => `${q.get('path') || '/'}${at(q)} · ${repo}`,
  '/repo/blob': (q, repo) => `${q.get('path') || 'File'}${at(q)} · ${repo}`,
  '/repo/blame': (q, repo) => `Blame ${q.get('path') ?? ''} · ${repo}`,
  '/repo/search': (q, repo) => (q.get('query') ? `${q.get('query')} · Code search · ${repo}` : `Code search · ${repo}`),
  '/repo/commits': (q, repo) => (q.get('path') ? `History for ${q.get('path')} · ${repo}` : `Commits · ${repo}`),
  '/repo/commit': (q, repo) => `Commit ${(q.get('oid') ?? '').slice(0, 7)} · ${repo}`,
  '/repo/compare': (q, repo) => (q.get('head') ? `Comparing ${q.get('base') ?? ''}...${q.get('head')} · ${repo}` : `Compare · ${repo}`),
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
  '/repo/labels': (_q, repo) => `Labels · ${repo}`,
  '/repo/milestones': (_q, repo) => `Milestones · ${repo}`,
  '/repo/settings': (_q, repo) => `Settings · ${repo}`,
}

const SITE_TITLES: Readonly<Record<string, string>> = {
  '/': SITE_TITLE,
  '/explore': 'Explore',
  '/new': 'New repository',
  '/mirror': 'Mirror a GitHub repository',
  '/notifications': 'Notifications',
  '/settings': 'Settings',
  '/settings/storage': 'Storage settings',
  '/login': 'Sign in',
  '/start': 'Getting started',
}

const PROFILE_TITLES: Readonly<Record<string, (label: string) => string>> = {
  '/u': (label) => label,
  '/u/followers': (label) => `Followers · ${label}`,
  '/u/following': (label) => `Following · ${label}`,
}

const withSite = (t: string): string => (t === SITE_TITLE ? t : `${t} · ${SITE_TITLE}`)

/**
 * The title for `pathname` + `query`. A private repo's sealed paths and refs (`~` tokens,
 * `lib/view/private-nav.ts`) are left out: the title is then the repo name alone.
 */
export function pageTitle(pathname: string, query: Query, ownerName?: string | null): string {
  const path = bareRoute(pathname)
  const route = REPO_TITLES[path]
  const owner = query.get('owner') ?? ''
  const name = query.get('name') ?? ''
  if (route !== undefined && owner !== '' && name !== '') {
    // A private repo's path, ref and oid travel as `~…` tokens: its title is the repo name
    // alone, with no view, path, ref or owner (a tab title ends up in history and screen shares).
    const sealed = ['path', 'ref', 'oid', 'query'].some((k) => query.get(k)?.startsWith('~'))
    return withSite(sealed ? name : route(query, `${ownerLabel(owner, ownerName)}/${name}`))
  }
  const profile = PROFILE_TITLES[path]
  const who = query.get('name')
  if (profile !== undefined && who) return withSite(profile(ownerLabel(who, ownerName)))
  if (path === '/explore' && query.get('q')) return withSite(`Search “${query.get('q')}”`)
  return withSite(SITE_TITLES[path] ?? SITE_TITLE)
}

/**
 * The in-app docs hub (`/docs/…`): which of the repository's Markdown documents the web app renders,
 * at which route, under which sidebar section. The text itself stays in `docs/` and is read at
 * build time (lib/docs/source.ts); this file only names it, so it is safe to import in the browser.
 *
 * A link inside a rendered document resolves through {@link resolveDocHref}: to another listed
 * document, an in-app route; to any other file of the repository, its page on GitHub.
 */

import { REPO_URL } from '../build-info'
import { resolveRepoPath, splitHref } from '../view/markdown-links'

export interface DocPage {
  /** The route segment (`/docs/<slug>/`); '' is the hub's index. */
  readonly slug: string
  /** The Markdown file, from the repository root. */
  readonly path: string
  /** The sidebar label. */
  readonly title: string
}

export interface DocSection {
  readonly title: string
  readonly pages: readonly DocPage[]
}

const guide = (slug: string, title: string): DocPage => ({ slug, path: `docs/guides/${slug}.md`, title })

export const DOCS_INDEX: DocPage = { slug: '', path: 'docs/guides/README.md', title: 'All guides' }

export const DOC_SECTIONS: readonly DocSection[] = [
  {
    title: 'Get started',
    pages: [
      DOCS_INDEX,
      guide('quick-start', 'Quick start'),
      { slug: 'install', path: 'docs/INSTALL.md', title: 'Install dg and the Dash remote' },
      guide('identity-and-keys', 'Sign-in, identity and keys'),
      guide('costs', 'What things cost'),
      guide('first-push-troubleshooting', 'My first push failed'),
    ],
  },
  {
    title: 'Bring your code',
    pages: [
      guide('moving-from-github', 'Moving from GitHub or GitLab'),
      guide('mirror-a-github-repo', 'Mirror a GitHub repository'),
      guide('mirror-a-gitlab-project', 'Mirror a GitLab project'),
      guide('devnet-move', 'The move to testnet'),
    ],
  },
  {
    title: 'Storage',
    pages: [
      guide('bring-your-own-storage', 'Bring your own storage'),
      guide('home-nas-storage', 'Storage on your home NAS'),
      guide('run-your-own-ipfs-node', 'Run your own IPFS node'),
      guide('self-host-backend', 'Run your own backend'),
    ],
  },
  {
    title: 'Collaborate',
    pages: [
      guide('collaborating', 'Collaborating'),
      { slug: 'audiences', path: 'docs/security/audiences.md', title: 'Who can read what' },
      guide('boards', 'Boards'),
      guide('bots', 'Bots and agents'),
      guide('environments', 'Environments'),
      guide('ci', 'CI and check runs'),
      guide('self-host-runner', 'Self-host a CI runner'),
    ],
  },
  {
    title: 'Trust and safety',
    pages: [
      guide('verify-forge', "Check that Forge isn't lying"),
      guide('verify-the-app', 'Verify the app you loaded'),
      guide('revoke-keys', 'If Forge says revoke keys'),
      { slug: 'hosted-curation', path: 'docs/hosted-curation.md', title: 'Hosted curation' },
    ],
  },
  {
    title: 'Reference',
    pages: [
      { slug: 'faq', path: 'docs/FAQ.md', title: 'FAQ' },
      { slug: 'limits', path: 'docs/limits.md', title: 'Limits' },
      { slug: 'errors', path: 'docs/errors.md', title: 'Error codes' },
      { slug: 'networks', path: 'docs/networks.md', title: 'Networks' },
      { slug: 'building', path: 'docs/BUILDING.md', title: 'Building from source' },
    ],
  },
]

export const DOC_PAGES: readonly DocPage[] = DOC_SECTIONS.flatMap((s) => s.pages)

const BY_PATH = new Map(DOC_PAGES.map((p) => [p.path, p]))
const BY_SLUG = new Map(DOC_PAGES.map((p) => [p.slug, p]))

/** The listed document at `slug`, or undefined. */
export function docBySlug(slug: string): DocPage | undefined {
  return BY_SLUG.get(slug)
}

/** The in-app route of a listed document, with an optional `#fragment`. */
export function docRoute(page: DocPage, fragment = ''): string {
  const base = page.slug === '' ? '/docs/' : `/docs/${page.slug}/`
  return fragment === '' ? base : `${base}#${fragment}`
}

/** The document's source on GitHub (the "View on GitHub" link). */
export function docSourceUrl(page: DocPage): string {
  return `${REPO_URL}/blob/master/${page.path}`
}

export type DocHref = { readonly internal: string } | { readonly external: string }

/**
 * Where a link written in `from` goes: a relative or `/`-rooted path to a listed document becomes
 * its in-app route; one to any other file of the repository, that file on GitHub. Null for hrefs
 * that are not repository paths (absolute URLs, `mailto:`, in-page `#anchors`): the renderer's
 * own handling applies to them.
 */
export function resolveDocHref(from: DocPage, href: string): DocHref | null {
  if (href === '' || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  const { path, fragment } = splitHref(href)
  const dir = from.path.includes('/') ? from.path.slice(0, from.path.lastIndexOf('/')) : ''
  const target = resolveRepoPath(path.startsWith('/') ? '' : dir, path.replace(/^\/+/, ''))
  if (target === null) return null
  const page = BY_PATH.get(target)
  if (page !== undefined) return { internal: docRoute(page, fragment) }
  const clean = target.replace(/\/$/, '')
  const kind = clean === '' || path.endsWith('/') ? 'tree' : 'blob'
  return { external: `${REPO_URL}/${kind}/master/${clean}${fragment === '' ? '' : `#${fragment}`}` }
}

/**
 * Short URLs both ways: the app's `shortRepoPath` and the 404.html shim that expands them.
 * The shim is tested by executing the exact source string the page inlines.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  canonicalOfShort,
  expandShortPath,
  hasShortUrl,
  RESERVED_SEGMENTS,
  sameRoute,
  SHORT_URL_EXPAND_SOURCE,
  shortRepoPath,
  shortRepoUrl,
  shortRouteFor,
  shortUrlShimScript,
  upstreamAliasPath,
  type ShortTarget,
} from './short-url'

type Expand = (pathname: string, base: string, reserved: readonly string[]) => string | null
// The shim is plain JS in a string; evaluate it as the page does.
const expandFn = new Function(`return (${SHORT_URL_EXPAND_SOURCE})`)() as Expand
const expand = (path: string, base = ''): string | null => expandFn(path, base, RESERVED_SEGMENTS)

const REPO = { owner: 'alice', name: 'project' }

describe('shortRepoPath → shim → canonical route', () => {
  const cases: [ShortTarget, string, string][] = [
    [{ kind: 'home' }, '/alice/project', '/repo/?owner=alice&name=project'],
    [{ kind: 'tree', ref: 'main', path: 'src' }, '/alice/project/tree/main/src', '/repo/tree/?owner=alice&name=project&ref=main&path=src'],
    [{ kind: 'tree', ref: 'main' }, '/alice/project/tree/main', '/repo/tree/?owner=alice&name=project&ref=main'],
    [
      { kind: 'blob', ref: 'feature/x', path: 'src/a b.rs' },
      '/alice/project/blob/feature%2Fx/src/a%20b.rs',
      '/repo/blob/?owner=alice&name=project&ref=feature%2Fx&path=src%2Fa%20b.rs',
    ],
    [{ kind: 'commits' }, '/alice/project/commits', '/repo/commits/?owner=alice&name=project'],
    [{ kind: 'commits', ref: 'dev' }, '/alice/project/commits/dev', '/repo/commits/?owner=alice&name=project&ref=dev'],
    // F-5: a path's History and Blame, as GitHub writes them.
    [{ kind: 'commits', ref: 'dev', path: 'src/a.rs' }, '/alice/project/commits/dev/src/a.rs', '/repo/commits/?owner=alice&name=project&ref=dev&path=src%2Fa.rs'],
    [{ kind: 'commits', path: 'src' }, '/alice/project/commits/HEAD/src', '/repo/commits/?owner=alice&name=project&path=src'],
    [{ kind: 'blame', ref: 'main', path: 'src/a.rs' }, '/alice/project/blame/main/src/a.rs', '/repo/blame/?owner=alice&name=project&ref=main&path=src%2Fa.rs'],
    [{ kind: 'issues' }, '/alice/project/issues', '/repo/issues/?owner=alice&name=project'],
    [{ kind: 'issue', number: 42 }, '/alice/project/issues/42', '/repo/issue/?owner=alice&name=project&number=42'],
    // QW3-063: GitHub's New issue URL opens the composer.
    [{ kind: 'newIssue' }, '/alice/project/issues/new', '/repo/issues/?owner=alice&name=project&new=1'],
    [{ kind: 'pulls' }, '/alice/project/pulls', '/repo/pulls/?owner=alice&name=project'],
    [{ kind: 'pull', number: 7 }, '/alice/project/pull/7', '/repo/pull/?owner=alice&name=project&number=7'],
    [{ kind: 'pull', number: 7, tab: 'files' }, '/alice/project/pull/7/files', '/repo/pull/?owner=alice&name=project&number=7&tab=files'],
    [{ kind: 'pull', number: 7, tab: 'commits' }, '/alice/project/pull/7/commits', '/repo/pull/?owner=alice&name=project&number=7&tab=commits'],
    [{ kind: 'pull', number: 7, tab: 'checks' }, '/alice/project/pull/7/checks', '/repo/pull/?owner=alice&name=project&number=7&tab=checks'],
    [{ kind: 'releases' }, '/alice/project/releases', '/repo/releases/?owner=alice&name=project'],
    [{ kind: 'release', tag: 'v1.2' }, '/alice/project/releases/v1.2', '/repo/release/?owner=alice&name=project&tag=v1.2'],
    // L-27: the GitHub pages that had no short URL.
    [{ kind: 'branches' }, '/alice/project/branches', '/repo/branches/?owner=alice&name=project'],
    [{ kind: 'tags' }, '/alice/project/tags', '/repo/tags/?owner=alice&name=project'],
    [{ kind: 'stargazers' }, '/alice/project/stargazers', '/repo/stargazers/?owner=alice&name=project'],
    [{ kind: 'labels' }, '/alice/project/labels', '/repo/labels/?owner=alice&name=project'],
    [{ kind: 'milestones' }, '/alice/project/milestones', '/repo/milestones/?owner=alice&name=project'],
    [
      { kind: 'commit', oid: '0123456789abcdef0123456789abcdef01234567' },
      '/alice/project/commit/0123456789abcdef0123456789abcdef01234567',
      '/repo/commit/?owner=alice&name=project&oid=0123456789abcdef0123456789abcdef01234567',
    ],
    // QW-058: GitHub's compare, three dots, and a head alone against the default branch.
    [{ kind: 'compare', base: 'v22.0.0', head: 'v23.0.0' }, '/alice/project/compare/v22.0.0...v23.0.0', '/repo/compare/?owner=alice&name=project&base=v22.0.0&head=v23.0.0'],
    [{ kind: 'compare', base: 'main', head: 'feature/x' }, '/alice/project/compare/main...feature%2Fx', '/repo/compare/?owner=alice&name=project&base=main&head=feature%2Fx'],
    [{ kind: 'compare', head: 'develop' }, '/alice/project/compare/develop', '/repo/compare/?owner=alice&name=project&head=develop'],
  ]
  it.each(cases)('%j', (target, short, canonical) => {
    expect(shortRepoPath(REPO, target)).toBe(short)
    expect(expand(short)).toBe(canonical)
  })

  it('accepts a trailing slash and an identity id owner', () => {
    expect(expand('/alice/project/')).toBe('/repo/?owner=alice&name=project')
    const id = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
    expect(expand(`/${id}/forge-v2-demo`)).toBe(`/repo/?owner=${id}&name=forge-v2-demo`)
  })

  it('drops one trailing .git from the repo name, as a pasted clone URL has it', () => {
    expect(expand('/alice/project.git')).toBe('/repo/?owner=alice&name=project')
    expect(expand('/alice/project.git/')).toBe('/repo/?owner=alice&name=project')
    expect(expand('/alice/project.GIT')).toBe('/repo/?owner=alice&name=project')
    expect(expand('/alice/project.git/issues/7')).toBe('/repo/issue/?owner=alice&name=project&number=7')
    expect(expand('/dash-forge/alice/project.git', '/dash-forge')).toBe('/dash-forge/repo/?owner=alice&name=project')
    // Only one, and only at the end: a name has none (`nameNotDotGit`), so ".git" alone is no repo.
    expect(expand('/alice/project.git.git')).toBe('/repo/?owner=alice&name=project.git')
    expect(expand('/alice/my.gitx')).toBe('/repo/?owner=alice&name=my.gitx')
    expect(expand('/alice/.git')).toBeNull()
    // The GitHub alias already did this to the repo; its owner segment is left alone.
    expect(expand('/gh/a/b.git')).toBe('/github.com/?owner=a&name=b')
    expect(expand('/gh/a/b.GIT')).toBe('/github.com/?owner=a&name=b')
    expect(expand('/github.com/a/b.Git/issues/3')).toBe('/github.com/?owner=a&name=b&rest=issues%2F3')
  })

  it('honors the base path both ways', () => {
    expect(expand('/dash-forge/alice/project/pull/7', '/dash-forge')).toBe('/dash-forge/repo/pull/?owner=alice&name=project&number=7')
    // The base path alone is not a repo, and a path outside the base is not ours.
    expect(expand('/dash-forge/', '/dash-forge')).toBeNull()
    expect(expand('/alice/project', '/dash-forge')).toBeNull()
  })
})

describe('GitHub compare URLs (QW-058)', () => {
  it.each([
    // Two dots, as GitHub also accepts; the compare view shows base...head either way.
    ['/alice/project/compare/v1..v2', '/repo/compare/?owner=alice&name=project&base=v1&head=v2'],
    // A ref with an unencoded slash, as GitHub writes it.
    ['/alice/project/compare/main...feature/x', '/repo/compare/?owner=alice&name=project&base=main&head=feature%2Fx'],
    ['/alice/project/compare/release/1.0...feature/y', '/repo/compare/?owner=alice&name=project&base=release%2F1.0&head=feature%2Fy'],
    // A commit range.
    ['/alice/project/compare/0a1b2c3...4d5e6f7', '/repo/compare/?owner=alice&name=project&base=0a1b2c3&head=4d5e6f7'],
  ])('%s', (short, canonical) => {
    expect(expand(short)).toBe(canonical)
  })

  it.each(['/alice/project/compare/...v2', '/alice/project/compare/v1...'])('refuses an empty side: %s', (short) => {
    expect(expand(short)).toBeNull()
  })

  it('opens the compare form with no refs', () => {
    expect(expand('/alice/project/compare')).toBe('/repo/compare/?owner=alice&name=project')
  })
})

describe('GitHub URLs that map onto an existing page (L-27)', () => {
  it.each([
    ['/alice/project/branches/', '/repo/branches/?owner=alice&name=project'],
    ['/alice/project/tags', '/repo/tags/?owner=alice&name=project'],
    ['/alice/project/stargazers', '/repo/stargazers/?owner=alice&name=project'],
    ['/alice/project/labels', '/repo/labels/?owner=alice&name=project'],
    ['/alice/project/milestones', '/repo/milestones/?owner=alice&name=project'],
    // A short commit id, in any case, opens the commit page (which resolves prefixes).
    ['/alice/project/commit/ABCDEF1', '/repo/commit/?owner=alice&name=project&oid=abcdef1'],
    // GitHub's release permalink.
    ['/alice/project/releases/tag/v1.2.3', '/repo/release/?owner=alice&name=project&tag=v1.2.3'],
    ['/alice/project/releases/tag/rel%2F1', '/repo/release/?owner=alice&name=project&tag=rel%2F1'],
    // A tag literally named "tag" keeps its old URL.
    ['/alice/project/releases/tag', '/repo/release/?owner=alice&name=project&tag=tag'],
    // HEAD is the default branch (GitHub's own links use it): no ref param.
    ['/alice/project/blob/HEAD/src/a.rs', '/repo/blob/?owner=alice&name=project&path=src%2Fa.rs'],
    ['/alice/project/blame/HEAD/src/a.rs', '/repo/blame/?owner=alice&name=project&path=src%2Fa.rs'],
    ['/alice/project/commits/HEAD', '/repo/commits/?owner=alice&name=project'],
    // Already served: tree/blob with a path, the PR tabs, the issues search (its `?q=` rides along).
    ['/alice/project/tree/main/src/lib', '/repo/tree/?owner=alice&name=project&ref=main&path=src%2Flib'],
    ['/alice/project/pull/7/files', '/repo/pull/?owner=alice&name=project&number=7&tab=files'],
    ['/alice/project/issues', '/repo/issues/?owner=alice&name=project'],
  ])('%s', (path, canonical) => {
    expect(expand(path)).toBe(canonical)
  })

  it('carries a query string such as ?q= through the rewrite', () => {
    const script = shortUrlShimScript('')
    const replaced: string[] = []
    const location = { pathname: '/alice/project/issues', search: '?q=is%3Aclosed+label%3Abug', hash: '#top', replace: (to: string) => replaced.push(to) }
    const documentElement = { setAttribute: () => undefined }
    new Function('location', 'document', script)(location, { documentElement })
    expect(replaced).toEqual(['/repo/issues/?owner=alice&name=project&q=is%3Aclosed+label%3Abug#top'])
  })

  it.each(['/alice/project/commit/xyz', '/alice/project/commit/abc', '/alice/project/commit', '/alice/project/branches/main', '/alice/project/stargazers/x', '/alice/project/releases/tag/a/b'])(
    'refuses %s',
    (path) => {
      expect(expand(path)).toBeNull()
    },
  )
})

describe('the GitHub alias: /github.com/<owner>/<repo> (CJ-3)', () => {
  it('opens the mirror finder for a GitHub repo', () => {
    expect(expand('/github.com/dashpay/dash')).toBe('/github.com/?owner=dashpay&name=dash')
    expect(expand('/gh/dashpay/dash/')).toBe('/github.com/?owner=dashpay&name=dash')
    expect(expand('/GitHub.com/DashPay/Dash.git')).toBe('/github.com/?owner=DashPay&name=Dash')
  })
  it('carries the rest of a GitHub path, to open the same view of the mirror', () => {
    expect(expand('/github.com/dashpay/dash/issues/12')).toBe('/github.com/?owner=dashpay&name=dash&rest=issues%2F12')
    expect(expand('/github.com/dashpay/dash/tree/develop/src')).toBe('/github.com/?owner=dashpay&name=dash&rest=tree%2Fdevelop%2Fsrc')
  })
  it('honors the base path', () => {
    expect(expand('/dash-forge/github.com/a/b', '/dash-forge')).toBe('/dash-forge/github.com/?owner=a&name=b')
  })
  it('leaves an owner-only or malformed alias alone', () => {
    expect(expand('/github.com/dashpay')).toBeNull()
    expect(expand('/github.com/.hidden/x')).toBeNull()
  })
  it('matches the page link the app builds', () => {
    expect(upstreamAliasPath('dashpay', 'dash')).toBe('/github.com/?owner=dashpay&name=dash')
    expect(upstreamAliasPath('dashpay', 'dash', 'issues/12')).toBe(expand('/github.com/dashpay/dash/issues/12'))
  })
})

describe('the shim leaves everything else alone', () => {
  it.each([
    '/',
    '/alice',
    '/repo/tree',
    '/settings/storage',
    '/_next/static/chunks/x.js',
    '/u/whatever',
    '/new/repo',
    '/explore/recent',
    '/notifications/x',
    '/mirror/github',
    '/login/x',
    '/alice/project/wiki',
    '/alice/project/issues/abc',
    '/alice/project/issues/0',
    '/alice/project/issues/4/extra',
    '/alice/project/pull/7/other',
    '/alice/project/pull/7/files/x',
    '/alice/project/tree',
    '/al%ZZce/project',
    '/alice/pro%2Fject',
    '/-x/project',
  ])('%s', (path) => {
    expect(expand(path)).toBeNull()
  })

  it('reserves every real top-level route', () => {
    // Every directory under app/ is a route, and every entry in public/ a file the host serves:
    // a short URL must never shadow either (a missing `/icons/x.png` must stay a 404).
    const routes = readdirSync(join(__dirname, '..', 'app'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    const files = readdirSync(join(__dirname, '..', 'public'))
    expect(routes.length).toBeGreaterThan(5)
    for (const r of [...routes, ...files, '_next']) expect(RESERVED_SEGMENTS).toContain(r)
  })
})

describe('hasShortUrl', () => {
  it('is true exactly for the addresses the shim expands back to the same repo', () => {
    const cases = [
      { owner: 'alice', name: 'project' },
      { owner: 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr', name: 'forge-v2-demo' },
      { owner: 'alice', name: 'my.repo_1' },
      { owner: 'alice.dash', name: 'project' },
      { owner: 'alice', name: '.hidden' },
      { owner: 'repo', name: 'x' },
      { owner: 'Explore', name: 'x' },
      // The IPFS variant's base path prefixes.
      { owner: 'ipfs', name: 'x' },
      { owner: 'IPNS', name: 'x' },
    ]
    for (const repo of cases) {
      const expanded = expand(shortRepoPath(repo))
      expect(hasShortUrl(repo), JSON.stringify(repo)).toBe(expanded === `/repo/?owner=${encodeURIComponent(repo.owner)}&name=${encodeURIComponent(repo.name)}`)
    }
  })

  it('is false for a repo pinned by id (the short form cannot carry `?repo=`)', () => {
    expect(hasShortUrl({ owner: 'alice', name: 'project', repoId: 'R' })).toBe(false)
  })

  it('pins blob and tree to a commit id: the 40-hex ref and the path survive the shim', () => {
    const oid = 'ABCDEF0123456789abcdef0123456789abcdef01'
    expect(expand(shortRepoPath(REPO, { kind: 'blob', ref: oid, path: 'src/main.rs' }))).toBe(
      `/repo/blob/?owner=alice&name=project&ref=${oid}&path=src%2Fmain.rs`,
    )
  })
})

describe('shortUrlShimScript', () => {
  it('is one self-contained statement carrying the base path', () => {
    const script = shortUrlShimScript('/dash-forge')
    expect(script).toContain('"/dash-forge"')
    expect(script).not.toContain('</script')
    // It parses as a script.
    expect(() => new Function(script)).not.toThrow()
  })
})

describe('Copy link and DPNS-form short URLs (L-55, L-82)', () => {
  it('expands an owner written as a full DPNS name', () => {
    expect(expand('/unofficial-dashpay-dash-mirror.dash/dash')).toBe('/repo/?owner=unofficial-dashpay-dash-mirror.dash&name=dash')
    expect(expand('/alice.dash/project/issues/3')).toBe('/repo/issue/?owner=alice.dash&name=project&number=3')
  })

  it('keeps the repo pin as the short URL’s query, which the shim carries through', () => {
    const id = 'Bdx8pb9VYHqoeWDoY96HNNrjoQyZvaoBjSqZJ5fajRDB'
    const url = shortRepoUrl({ owner: id, name: 'dash', repoId: 'R1' })
    expect(url).toBe(`/${id}/dash?repo=R1`)
    // The page does `location.replace(expanded + '&' + search)`.
    const [path, search] = url.split('?') as [string, string]
    expect(`${expand(path)}&${search}`).toBe(`/repo/?owner=${id}&name=dash&repo=R1`)
    expect(shortRepoUrl({ owner: 'alice', name: 'p', repoId: 'R1' }, { kind: 'issue', number: 4 })).toBe('/alice/p/issues/4?repo=R1')
  })

  it('falls back to the canonical route when the owner or name has no short form', () => {
    expect(shortRepoUrl({ owner: 'repo', name: 'x' })).toBe('/repo/?owner=repo&name=x')
    expect(shortRepoUrl({ owner: 'alice', name: '.hidden', repoId: 'R' }, { kind: 'pull', number: 2, tab: 'files' })).toBe(
      '/repo/pull/?owner=alice&name=.hidden&repo=R&number=2&tab=files',
    )
  })
})

describe('expandShortPath: the shim in TypeScript (CJ-6)', () => {
  // Every path the cases above try, the app's short paths for every target, and odd ones.
  const targets: ShortTarget[] = [
    { kind: 'home' },
    { kind: 'tree', ref: 'feature/x', path: 'src/a b/ü.rs' },
    { kind: 'blob', ref: 'HEAD', path: 'README.md' },
    { kind: 'blame', ref: 'v1.0', path: 'a/b' },
    { kind: 'commits' },
    { kind: 'commits', ref: 'dev' },
    { kind: 'commits', path: 'docs' },
    { kind: 'issues' },
    { kind: 'newIssue' },
    { kind: 'issue', number: 9 },
    { kind: 'pulls' },
    { kind: 'pull', number: 3, tab: 'checks' },
    { kind: 'releases' },
    { kind: 'release', tag: 'rel/1' },
    { kind: 'branches' },
    { kind: 'commit', oid: 'ABCDEF1' },
    { kind: 'compare', base: 'main', head: 'feature/x' },
    { kind: 'compare', head: 'dev' },
  ]
  const owners = ['alice', 'alice.dash', 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr', 'repo', 'Explore', '-x']
  const paths = [
    ...owners.flatMap((owner) => targets.map((t) => shortRepoPath({ owner, name: 'project' }, t))),
    '/', '/alice', '/alice/project/', '/alice/project/wiki', '/alice/project/issues/0', '/alice/project/issues/abc', '/alice/project/pull/7/files/x',
    '/alice/project/releases/tag/v1', '/alice/project/releases/tag', '/alice/project/compare/v1..v2', '/alice/project/compare/...v2', '/alice/project/compare/a...b/c',
    '/alice/project/commit/xyz', '/al%ZZce/project', '/alice/pro%2Fject', '/alice/project/tree/%E0%A4', '/github.com/dashpay/dash/issues/12', '/gh/a/b.git', '/gh/a/b.GIT', '/github.com/a/b.Git/issues/3', '/alice/project.git', '/alice/project.git/', '/alice/project.git.git', '/alice/.git', '/alice/a.git/issues/7', '/dash-forge/alice/project.git',
    '/github.com/dashpay', '/dash-forge/alice/project/pull/7', '/dash-forge/', '/dash-forge/github.com/a/b', '/alice/project/blob/HEAD',
  ]
  // A seeded walk over segments that exercise every branch of the shim.
  const pieces = ['alice', 'project', 'project.git', 'issues', 'pull', 'pulls', 'tree', 'blob', 'blame', 'commits', 'commit', 'compare', 'releases', 'tag', 'new', 'HEAD', '7', '0', 'files', 'x%2Fy', 'a...b', '..', 'abc123', '%E2%9C%93', '%ZZ', '']
  let seed = 7
  const next = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
  for (let i = 0; i < 2000; i++) paths.push(`/${Array.from({ length: 1 + next(6) }, () => pieces[next(pieces.length)]).join('/')}`)

  it('gives the shim’s answer for every path, with and without a base path', () => {
    for (const path of paths) {
      expect(expandShortPath(path, ''), path).toBe(expand(path))
      expect(expandShortPath(path, '/dash-forge'), path).toBe(expand(path, '/dash-forge'))
    }
  })

  it('opens a short path and its query as the shim does, and nothing outside a repo', () => {
    expect(canonicalOfShort('/alice/project/issues', 'q=is%3Aclosed')).toBe('/repo/issues/?owner=alice&name=project&q=is%3Aclosed')
    expect(canonicalOfShort('/alice/project/issues/7', '')).toBe('/repo/issue/?owner=alice&name=project&number=7')
    expect(canonicalOfShort('/repo/issue/', 'owner=alice&name=project')).toBeNull()
    expect(canonicalOfShort('/github.com/dashpay/dash', '')).toBeNull()
  })
})

describe('shortRouteFor: the address bar’s short URL (CJ-6)', () => {
  /** The canonical route `href` and the short URL the shim opens it from: the round trip. */
  const roundTrip = (href: string, ownerName?: string): string | null => {
    const [path, search = ''] = href.split('?') as [string, string?]
    const short = shortRouteFor(path, search, ownerName)
    if (short !== null) {
      const [sp, sq = ''] = short.split('?') as [string, string?]
      const back = new URL(canonicalOfShort(sp, sq)!, 'http://n')
      const want = new URL(href, 'http://n')
      if (ownerName === undefined) {
        expect(back.pathname).toBe(want.pathname)
        expect([...back.searchParams].sort()).toEqual([...want.searchParams].sort())
      }
    }
    return short
  }

  it.each([
    ['/repo/', 'owner=alice&name=project', '/alice/project'],
    ['/repo/tree/', 'owner=alice&name=project&ref=feature%2Fx&path=src%2Fa+b', '/alice/project/tree/feature%2Fx/src/a%20b'],
    ['/repo/tree/', 'owner=alice&name=project', '/alice/project/tree/HEAD'],
    ['/repo/blob/', 'owner=alice&name=project&ref=main&path=docs%2F%C3%BC%E6%96%87.md', '/alice/project/blob/main/docs/%C3%BC%E6%96%87.md'],
    ['/repo/blob/', 'owner=alice&name=project&path=README.md', '/alice/project/blob/HEAD/README.md'],
    ['/repo/blame/', 'owner=alice&name=project&ref=v1&path=a.rs', '/alice/project/blame/v1/a.rs'],
    ['/repo/commits/', 'owner=alice&name=project', '/alice/project/commits'],
    ['/repo/commits/', 'owner=alice&name=project&ref=dev&pages=3', '/alice/project/commits/dev?pages=3'],
    ['/repo/commits/', 'owner=alice&name=project&path=src', '/alice/project/commits/HEAD/src'],
    ['/repo/issues/', 'owner=alice&name=project&q=is%3Aclosed+label%3Abug&page=2', '/alice/project/issues?q=is%3Aclosed+label%3Abug&page=2'],
    ['/repo/issues/', 'owner=alice&name=project&new=1', '/alice/project/issues/new'],
    ['/repo/issue/', 'owner=alice&name=project&number=7', '/alice/project/issues/7'],
    ['/repo/pulls/', 'owner=alice&name=project&state=closed', '/alice/project/pulls?state=closed'],
    ['/repo/pull/', 'owner=alice&name=project&number=7&tab=files', '/alice/project/pull/7/files'],
    // A tab with no short path stays in the query.
    ['/repo/pull/', 'owner=alice&name=project&number=7&tab=conversation', '/alice/project/pull/7?tab=conversation'],
    ['/repo/releases/', 'owner=alice&name=project', '/alice/project/releases'],
    ['/repo/release/', 'owner=alice&name=project&tag=rel%2F1', '/alice/project/releases/rel%2F1'],
    ['/repo/branches/', 'owner=alice&name=project', '/alice/project/branches'],
    ['/repo/tags/', 'owner=alice&name=project', '/alice/project/tags'],
    ['/repo/stargazers/', 'owner=alice&name=project', '/alice/project/stargazers'],
    ['/repo/labels/', 'owner=alice&name=project', '/alice/project/labels'],
    ['/repo/milestones/', 'owner=alice&name=project', '/alice/project/milestones'],
    ['/repo/commit/', 'owner=alice&name=project&oid=abcdef0', '/alice/project/commit/abcdef0'],
    ['/repo/compare/', 'owner=alice&name=project&base=main&head=feature%2Fx', '/alice/project/compare/main...feature%2Fx'],
    ['/repo/compare/', 'owner=alice&name=project&head=dev', '/alice/project/compare/dev'],
    // The repo pin rides in the query, as Copy link writes it.
    ['/repo/issue/', 'owner=alice&name=project&repo=R1&number=4', '/alice/project/issues/4?repo=R1'],
  ])('%s?%s → %s', (path, search, short) => {
    expect(roundTrip(`${path}?${search}`)).toBe(short)
  })

  it.each([
    // No short form for the route, or for its owner or name.
    '/repo/settings/?owner=alice&name=project',
    '/repo/search/?owner=alice&name=project&query=x',
    '/repo/pulls/new/?owner=alice&name=project',
    '/repo/number/?owner=alice&name=project&number=3',
    '/repo/?owner=repo&name=x',
    '/repo/?owner=Explore&name=x',
    '/repo/?owner=alice&name=.hidden',
    '/repo/?owner=alice',
    // The shim would open another page, or drop a param.
    '/repo/commit/?owner=alice&name=project&oid=ABCDEF0',
    '/repo/commit/?owner=alice&name=project&oid=xyz',
    '/repo/issue/?owner=alice&name=project&number=007',
    '/repo/issue/?owner=alice&name=project&number=x',
    '/repo/tree/?owner=alice&name=project&ref=HEAD',
    '/repo/tree/?owner=alice&name=project&ref=main&path=a%2F%2Fb',
    '/repo/blob/?owner=alice&name=project&ref=main&path=..%2Fsecret',
    '/repo/blob/?owner=alice&name=project&ref=main&path=a%2F.%2Fb',
    '/repo/compare/?owner=alice&name=project&base=a...b&head=c',
    '/repo/compare/?owner=alice&name=project',
    '/repo/release/?owner=alice&name=project&tag=',
    '/repo/tree/?owner=alice&name=project&ref=',
  ])('keeps %s', (href) => {
    expect(roundTrip(href)).toBeNull()
  })

  it('writes the owner by DPNS name when the page knows it, the bare label for a .dash name', () => {
    const id = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
    expect(roundTrip(`/repo/issue/?owner=${id}&name=project&number=7`)).toBe(`/${id}/project/issues/7`)
    expect(roundTrip(`/repo/issue/?owner=${id}&name=project&number=7`, 'alice.dash')).toBe('/alice/project/issues/7')
    expect(roundTrip(`/repo/?owner=${id}&name=project&repo=R1`, 'Alice.dash')).toBe('/Alice/project?repo=R1')
    // A label that is one of the app's routes keeps its full name; a name with no short form, the id.
    expect(roundTrip(`/repo/?owner=${id}&name=project`, 'explore.dash')).toBe('/explore.dash/project')
    expect(roundTrip(`/repo/?owner=${id}&name=project`, '-bad.dash')).toBe(`/${id}/project`)
  })

  it('never writes the owner as a label that is itself an identity id (it would open that identity)', () => {
    const id = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'
    const other = '9qy5ZgYUH5ZrZzS2MuSDThCGaZrz9qiDLE9ZyLGFNRWr'
    // The full name opens by name; the bare label would be read as the id `other`.
    expect(roundTrip(`/repo/?owner=${id}&name=project`, `${other}.dash`)).toBe(`/${other}.dash/project`)
    expect(roundTrip(`/repo/?owner=${id}&name=project`, other)).toBe(`/${id}/project`)
  })
})

describe('Copy link writes the owner as the address bar does', () => {
  const id = 'HwhCv9N5BHsbGNLzDR4tnZnqJ6VxtwJSLsM4aUWn2Tnr'

  it('by DPNS name once read, else by the route’s owner', () => {
    expect(shortRepoUrl({ owner: id, name: 'project' }, { kind: 'issue', number: 7 }, 'alice.dash')).toBe('/alice/project/issues/7')
    expect(shortRepoUrl({ owner: id, name: 'project', repoId: 'R1' }, undefined, 'alice.dash')).toBe('/alice/project?repo=R1')
    expect(shortRepoUrl({ owner: id, name: 'project' }, undefined, 'explore.dash')).toBe('/explore.dash/project')
    expect(shortRepoUrl({ owner: id, name: 'project' }, undefined, null)).toBe(`/${id}/project`)
    expect(shortRepoUrl({ owner: id, name: 'project' }, undefined, '9qy5ZgYUH5ZrZzS2MuSDThCGaZrz9qiDLE9ZyLGFNRWr')).toBe(`/${id}/project`)
    // A name with no short form changes nothing: the id's short URL, or the canonical route.
    expect(shortRepoUrl({ owner: id, name: '.hidden' }, undefined, 'alice.dash')).toBe(`/repo/?owner=${id}&name=.hidden`)
  })

  it('and the bar’s short URL for the same page agrees', () => {
    expect(shortRouteFor('/repo/issue/', `owner=${id}&name=project&number=7`, 'alice.dash')).toBe(
      shortRepoUrl({ owner: id, name: 'project' }, { kind: 'issue', number: 7 }, 'alice.dash'),
    )
  })
})

describe('sameRoute', () => {
  it('is the same page: a trailing slash and the order of params do not matter', () => {
    expect(sameRoute('/repo/issues/?owner=a&name=p&q=x', '/repo/issues?q=x&name=p&owner=a')).toBe(true)
    expect(sameRoute('/repo/', '/repo')).toBe(true)
    expect(sameRoute('/repo/issues/?owner=a&name=p', '/repo/issues/?owner=a&name=p&q=x')).toBe(false)
    expect(sameRoute('/repo/issues/?owner=a&name=p', '/repo/pulls/?owner=a&name=p')).toBe(false)
  })
})

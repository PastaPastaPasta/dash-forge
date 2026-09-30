/**
 * Short URLs both ways: the app's `shortRepoPath` and the 404.html shim that expands them.
 * The shim is tested by executing the exact source string the page inlines.
 */

import { describe, expect, it } from 'vitest'

import { hasShortUrl, RESERVED_SEGMENTS, SHORT_URL_EXPAND_SOURCE, shortRepoPath, shortRepoUrl, shortUrlShimScript, type ShortTarget } from './short-url'

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
    for (const r of ['repo', 'settings', 'new', 'login', 'u', 'explore', 'notifications', 'mirror', '_next']) {
      expect(RESERVED_SEGMENTS).toContain(r)
    }
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

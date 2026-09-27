/**
 * Short URLs both ways: the app's `shortRepoPath` and the 404.html shim that expands them.
 * The shim is tested by executing the exact source string the page inlines.
 */

import { describe, expect, it } from 'vitest'

import { RESERVED_SEGMENTS, SHORT_URL_EXPAND_SOURCE, shortRepoPath, shortUrlShimScript, type ShortTarget } from './short-url'

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
    [{ kind: 'issues' }, '/alice/project/issues', '/repo/issues/?owner=alice&name=project'],
    [{ kind: 'issue', number: 42 }, '/alice/project/issues/42', '/repo/issue/?owner=alice&name=project&number=42'],
    [{ kind: 'pulls' }, '/alice/project/pulls', '/repo/pulls/?owner=alice&name=project'],
    [{ kind: 'pull', number: 7 }, '/alice/project/pull/7', '/repo/pull/?owner=alice&name=project&number=7'],
    [{ kind: 'releases' }, '/alice/project/releases', '/repo/releases/?owner=alice&name=project'],
    [{ kind: 'release', tag: 'v1.2' }, '/alice/project/releases/v1.2', '/repo/release/?owner=alice&name=project&tag=v1.2'],
  ]
  it.each(cases)('%j', (target, short, canonical) => {
    expect(shortRepoPath(REPO, target)).toBe(short)
    expect(expand(short)).toBe(canonical)
  })

  it('accepts a trailing slash and an identity id owner', () => {
    expect(expand('/alice/project/')).toBe('/repo/?owner=alice&name=project')
    const id = '5999iJiaZLMEb6KbjXYFDDYjwGWssatToUTJbXvXhxBp'
    expect(expand(`/${id}/forge-v2-demo`)).toBe(`/repo/?owner=${id}&name=forge-v2-demo`)
  })

  it('honors the base path both ways', () => {
    expect(expand('/dash-forge/alice/project/pull/7', '/dash-forge')).toBe('/dash-forge/repo/pull/?owner=alice&name=project&number=7')
    // The base path alone is not a repo, and a path outside the base is not ours.
    expect(expand('/dash-forge/', '/dash-forge')).toBeNull()
    expect(expand('/alice/project', '/dash-forge')).toBeNull()
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

describe('shortUrlShimScript', () => {
  it('is one self-contained statement carrying the base path', () => {
    const script = shortUrlShimScript('/dash-forge')
    expect(script).toContain('"/dash-forge"')
    expect(script).not.toContain('</script')
    // It parses as a script.
    expect(() => new Function(script)).not.toThrow()
  })
})
